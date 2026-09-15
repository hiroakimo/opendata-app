#!/usr/bin/env python3
"""
港区「町丁別年齢5歳階級別人口表」（dataset_key: minato_5y）を D1 / R2 に載せる
SQL と実行スクリプトを生成する。このスクリプト自体は D1 / R2 に接続しない。

前提
  - migrations/0006_age5_unified.sql 適用済み
  - pipeline/wards/minato/web5y/parse.py が成功し work/minato/web5y/parsed/ がある
  - 港区CKAN系列（minato_noage）が取り込み済み（町丁目 areas と、系列間の検算に使う）

使い方（リポジトリ直下で）
  python pipeline/wards/minato/web5y/build_load.py

生成物（work/minato/web5y/load/）
  r2_upload.ps1       原本を R2 raw/{sha256} に置く
  00_meta.sql         datasets / dataset_traits / dataset_sources / area_aliases /
                      source_files / data_anomalies
  obs_YYYY-MM-DD.sql  基準日ごとに DELETE → INSERT（冪等）
  99_verify.sql       取込後の検算（1行のSELECT）
  verify.ps1          検算だけを流す
  run_load.ps1        上記を順に流す。途中で失敗したら止まる
"""
import csv
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MASTER = HERE.parent / "towns.json"
FETCH = Path("work/minato/web5y/fetch")
PARSED = Path("work/minato/web5y/parsed")
OUT = Path("work/minato/web5y/load")

DB = "tokyo-population"
BUCKET = "opendata-lake"
MUNI = "131032"
DATASET_KEY = "minato_5y"
SOURCE_DATASET = "minato_web:chocho_nenrei_5y"
GRAN = "age5"
PAGE_URL = "https://www.city.minato.tokyo.jp/toukeichousa/kuse/toke/jinko/chocho/nenrei/20220401.html"
N_TOWNS = 117
N_NAT, N_AGE, N_SEX = 2, 22, 4
BATCH = 200
MAX_STMT_BYTES = 90_000
FULLWIDTH = str.maketrans("0123456789", "０１２３４５６７８９")


def q(v):
    if v is None or v == "":
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def read_csv(p):
    with open(p, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def insert_batches(table, cols, rows, verb="INSERT"):
    out = []
    for i in range(0, len(rows), BATCH):
        vals = ",\n".join("(" + ",".join(q(v) for v in r) + ")" for r in rows[i:i + BATCH])
        stmt = f"{verb} INTO {table} ({', '.join(cols)}) VALUES\n{vals};"
        if len(stmt.encode("utf-8")) > MAX_STMT_BYTES:
            sys.exit(f"中止: 1文が {MAX_STMT_BYTES} バイトを超える（BATCH を下げる）")
        out.append(stmt)
    return out


def filename_date(name):
    """20220401.pdf → 2022-04-01 / r080401.xlsb → 2026-04-01"""
    m = re.match(r"^(\d{4})(\d{2})(\d{2})\.", name)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.match(r"^r(\d{2})(\d{2})(\d{2})\.", name)
    if m:
        return f"{2018 + int(m.group(1)):04d}-{m.group(2)}-{m.group(3)}"
    return None


def main():
    towns = json.loads(MASTER.read_text(encoding="utf-8"))["towns"]
    keys = {t["key_code"] for t in towns}
    manifest = json.loads((FETCH / "manifest.json").read_text(encoding="utf-8"))
    by_sha = {f["sha256"]: f for f in manifest["files"]}
    obs = read_csv(PARSED / "observations.csv")
    anomalies = read_csv(PARSED / "anomalies.csv")
    files = read_csv(PARSED / "files.csv")

    # ---- 事前チェック
    errs = []
    if len(towns) != N_TOWNS or not all(t.get("key_code") for t in towns):
        errs.append("towns.json が 117件・key_code 付与済みでない")
    shas = {f["sha256"] for f in files}
    if {o["source_sha256"] for o in obs} != shas:
        errs.append("observations.csv と files.csv の sha256 集合が一致しない")
    for f in files:
        if f["sha256"] not in by_sha:
            errs.append(f"manifest にない: {f['asof']}")
        elif not (FETCH / "raw" / f["sha256"]).exists():
            errs.append(f"原本ファイルがない: {f['sha256']}")
        fd = filename_date(f["url"].rsplit("/", 1)[-1])
        if fd != f["asof"]:
            errs.append(f"ファイル名の日付 {fd} とリンクの日付 {f['asof']} が不一致")
    bad_keys = {o["key_code"] for o in obs} - keys
    if bad_keys:
        errs.append(f"マスタにない key_code: {sorted(bad_keys)[:5]}")
    if any(o["dataset_key"] != DATASET_KEY for o in obs):
        errs.append("dataset_key が minato_5y でない行がある")
    blank_cells = sum(1 for a in anomalies if a["kind"] == "blank_cell")
    expected = len(files) * N_TOWNS * N_NAT * N_AGE * N_SEX - blank_cells
    if len(obs) != expected:
        errs.append(f"行数 {len(obs)} が想定 {expected} と不一致")
    if errs:
        sys.exit("中止:\n  " + "\n  ".join(errs))

    OUT.mkdir(parents=True, exist_ok=True)
    for p in OUT.glob("*"):
        p.unlink()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    dates = sorted({f["asof"] for f in files})
    rows_by_sha = Counter(o["source_sha256"] for o in obs)

    # ---- 00_meta.sql
    S = [f"-- 生成: build_load.py {now}", "-- 港区 町丁別年齢5歳階級別人口表（minato_5y）", ""]
    S.append(
        "INSERT OR REPLACE INTO datasets (dataset_key, muni_code, muni_name, domain, title, granularity,"
        " grain_label, source_site, source_url, license, attribution, is_public, notes, license_url) VALUES ("
        + ", ".join(q(v) for v in [
            DATASET_KEY, MUNI, "港区", "population", "町丁別 年齢5歳階級別人口（日本人・外国人別）", GRAN,
            "5歳階級（100歳以上まで）", "港区ホームページ", PAGE_URL, None, None, 0,
            f"{dates[0]}以降、毎年1月1日・4月1日時点。令和6年4月まではPDF、令和7年1月からExcel(.xlsb)。"
            "CKAN系列（minato_noage）と町丁目×男女×総数が一致することを取込時に検証済み。"
            "利用条件を確認するまで license は NULL。Final Stage 終了まで is_public=0。",
            None]) + ");")
    S.append("INSERT OR REPLACE INTO dataset_traits (dataset_key, age_top_lo, nationality_semantics,"
             " time_pattern, notes) VALUES "
             f"({q(DATASET_KEY)}, 100, 'partition', 'semiannual_0101_0401',"
             " '日本人+外国人=総数。年齢不詳の区分あり。性別不明は総数−男−女で導出'),"
             " ('minato_noage', NULL, 'none', 'monthly', '年齢・国籍の区分なし');")
    S.append(f"INSERT OR REPLACE INTO dataset_sources (dataset_key, dataset, granularity, role) "
             f"VALUES ({q(DATASET_KEY)}, {q(SOURCE_DATASET)}, {q(GRAN)}, 'archive');")
    S.append("")

    # 表記の別名（原本は全角数字：赤坂１丁目）
    alias_rows = []
    for t in towns:
        fw = t["area_name"].translate(FULLWIDTH)
        if fw != t["area_name"]:
            assert unicodedata.normalize("NFKC", fw) == t["area_name"]
            alias_rows.append((MUNI, fw, t["key_code"], "nfkc_normalize", dates[0], dates[-1]))
    S += insert_batches("area_aliases", ["muni_code", "alias_name", "key_code", "resolved_by",
                                         "first_seen", "last_seen"], alias_rows, "INSERT OR REPLACE")
    S.append("")

    for f in sorted(files, key=lambda x: x["asof"]):
        m = by_sha[f["sha256"]]
        vals = dict(
            sha256=f["sha256"], r2_key=f"raw/{f['sha256']}", dataset=SOURCE_DATASET,
            source_file=f["url"].rsplit("/", 1)[-1], muni_code=MUNI, granularity=GRAN,
            reference_date=f["asof"], content_bytes=int(f["bytes"]), status="ingested",
            skip_reason=None, row_count=rows_by_sha[f["sha256"]], ingested_at=now,
            granularity_source="parser", distributable=1, hold_reason=None, resource_id=None,
            source_last_modified=m.get("http_last_modified"), supersedes=None, is_current=1,
            filename_date=filename_date(f["url"].rsplit("/", 1)[-1]), date_source="sheet")
        cols = list(vals)
        upd = ", ".join(f"{c} = excluded.{c}" for c in cols if c not in ("sha256", "ingested_at"))
        S.append(f"INSERT INTO source_files ({', '.join(cols)}) VALUES ("
                 + ", ".join(q(vals[c]) for c in cols)
                 + f")\n  ON CONFLICT(sha256) DO UPDATE SET {upd};")
        # 同じ基準日の旧世代（差し替えがあった場合）は現行から外す
        S.append(f"UPDATE source_files SET is_current = 0 WHERE dataset = {q(SOURCE_DATASET)}"
                 f" AND reference_date = {q(f['asof'])} AND sha256 <> {q(f['sha256'])};")
    S.append("")

    S.append(f"DELETE FROM data_anomalies WHERE dataset_key = {q(DATASET_KEY)};")
    if anomalies:
        S += insert_batches(
            "data_anomalies",
            ["anomaly_id", "dataset_key", "key_code", "reference_date", "kind", "treatment",
             "reported", "note", "source_sha256"],
            [(a["anomaly_id"], DATASET_KEY, a["key_code"], a["reference_date"], a["kind"],
              a["treatment"],
              json.dumps({"nationality": a["nationality"], "age_class": a["age_class"],
                          **json.loads(a["reported"])}, ensure_ascii=False),
              a["note"] + (f" 推定値: {a['implied']}（CKAN系列と小計の双方から一致）" if a["implied"] else ""),
              a["source_sha256"]) for a in anomalies])
    (OUT / "00_meta.sql").write_text("\n".join(S) + "\n", encoding="utf-8")

    # ---- obs_YYYY-MM-DD.sql
    cols = ["dataset_key", "key_code", "muni_code", "reference_date", "measure", "nationality",
            "age_class", "sex", "value", "is_derived", "anomaly_id", "source_sha256"]
    by_date = defaultdict(list)
    for o in obs:
        by_date[o["reference_date"]].append(tuple(
            (int(o[c]) if o[c] != "" else None) if c in ("value", "is_derived") else (o[c] or None)
            for c in cols))
    obs_files = []
    for d in dates:
        body = [f"-- {d} {len(by_date[d])}行",
                f"DELETE FROM observations_age5 WHERE dataset_key = {q(DATASET_KEY)}"
                f" AND reference_date = {q(d)};"]
        body += insert_batches("observations_age5", cols, by_date[d])
        name = f"obs_{d}.sql"
        (OUT / name).write_text("\n".join(body) + "\n", encoding="utf-8")
        obs_files.append(name)

    # ---- 99_verify.sql（1行のSELECT）
    DK, M = q(DATASET_KEY), q(MUNI)
    per_date = N_TOWNS * N_NAT * N_AGE * N_SEX
    checks = [
        ("rows", f"SELECT COUNT(*) FROM observations_age5 WHERE dataset_key = {DK}", len(obs)),
        ("dates", f"SELECT COUNT(DISTINCT reference_date) FROM observations_age5 WHERE dataset_key = {DK}", len(dates)),
        ("bad_date_rows", f"SELECT COUNT(*) FROM (SELECT reference_date, COUNT(*) AS n FROM observations_age5"
                          f" WHERE dataset_key = {DK} GROUP BY reference_date) WHERE n NOT IN ({per_date}, {per_date - blank_cells})", 0),
        ("towns", f"SELECT COUNT(DISTINCT key_code) FROM observations_age5 WHERE dataset_key = {DK}", N_TOWNS),
        ("files", f"SELECT COUNT(*) FROM source_files WHERE dataset = {q(SOURCE_DATASET)} AND is_current = 1", len(files)),
        ("anomalies", f"SELECT COUNT(*) FROM data_anomalies WHERE dataset_key = {DK}", len(anomalies)),
        ("orphan_keys", f"SELECT COUNT(*) FROM (SELECT DISTINCT key_code FROM observations_age5 WHERE dataset_key = {DK})"
                        f" o LEFT JOIN areas a ON a.key_code = o.key_code WHERE a.key_code IS NULL", 0),
        ("unknown_age_class", f"SELECT COUNT(*) FROM observations_age5 o LEFT JOIN age_classes c"
                              f" ON c.age_class = o.age_class WHERE o.dataset_key = {DK} AND c.age_class IS NULL", 0),
        ("sum_ng", f"SELECT COUNT(*) FROM (SELECT key_code, reference_date, nationality, age_class,"
                   f" SUM(CASE WHEN sex IN ('male','female','unknown') THEN value END) AS parts,"
                   f" SUM(CASE WHEN sex = 'total' THEN value END) AS total"
                   f" FROM observations_age5 WHERE dataset_key = {DK} AND anomaly_id IS NULL"
                   f" GROUP BY 1, 2, 3, 4) WHERE parts != total", 0),
        # 系列間の検算：町丁目×基準日の総数・男が CKAN系列（minato_noage）と一致
        ("vs_noage_ng", f"SELECT COUNT(*) FROM (SELECT key_code, reference_date,"
                        f" SUM(CASE WHEN sex = 'total' THEN value END) AS t,"
                        f" SUM(CASE WHEN sex = 'male' THEN value END) AS m"
                        f" FROM observations_age5 WHERE dataset_key = {DK} GROUP BY 1, 2) a"
                        f" LEFT JOIN (SELECT key_code, reference_date,"
                        f" SUM(CASE WHEN sex = 'total' THEN value END) AS t,"
                        f" SUM(CASE WHEN sex = 'male' THEN value END) AS m"
                        f" FROM observations_noage WHERE muni_code = {M} AND measure = 'population'"
                        f" GROUP BY 1, 2) n ON n.key_code = a.key_code AND n.reference_date = a.reference_date"
                        f" WHERE n.t IS NULL OR n.t != a.t OR n.m != a.m", 0),
        ("demo_5y_untouched", f"SELECT COUNT(*) FROM observations_5y WHERE muni_code = {M}", 0),
    ]
    got = ", ".join(f"({s}) AS {n}" for n, s, _ in checks)
    shown = ", ".join(f"CASE WHEN {n} = {e} THEN 'OK ' ELSE 'NG expected {e}: ' END || {n} AS {n}"
                      for n, _, e in checks)
    (OUT / "99_verify.sql").write_text(f"WITH g AS (SELECT {got}) SELECT {shown} FROM g;\n", encoding="utf-8")

    VP = ['$ErrorActionPreference = "Stop"',
          '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
          f'$sql = (Get-Content "{OUT / "99_verify.sql"}" -Raw -Encoding UTF8).Trim()',
          f'npx wrangler d1 execute {DB} --remote --json --command $sql']
    (OUT / "verify.ps1").write_text("\n".join(VP) + "\n", encoding="utf-8-sig")

    R = ['$ErrorActionPreference = "Stop"']
    for f in sorted(files, key=lambda x: x["asof"]):
        sha = f["sha256"]
        ctype = "application/pdf" if f["format"] == "pdf" else "application/vnd.ms-excel.sheet.binary.macroEnabled.12"
        R.append(f'Write-Host "R2: {f["asof"]} {f["format"]}"')
        R.append(f'npx wrangler r2 object put "{BUCKET}/raw/{sha}" --file "{FETCH / "raw" / sha}"'
                 f' --content-type "{ctype}" --remote')
        R.append('if ($LASTEXITCODE -ne 0) { throw "R2 upload failed: ' + sha + '" }')
    (OUT / "r2_upload.ps1").write_text("\n".join(R) + "\n", encoding="utf-8-sig")

    X = ['$ErrorActionPreference = "Stop"', '[Console]::OutputEncoding = [Text.Encoding]::UTF8']
    for name in ["00_meta.sql"] + obs_files:
        X.append(f'Write-Host "D1: {name}"')
        X.append(f'npx wrangler d1 execute {DB} --remote --file "{OUT / name}" -y')
        X.append('if ($LASTEXITCODE -ne 0) { throw "D1 load failed: ' + name + '" }')
    X.append('Write-Host "D1: 検算"')
    X.append(f'& "{OUT / "verify.ps1"}"')
    (OUT / "run_load.ps1").write_text("\n".join(X) + "\n", encoding="utf-8-sig")

    print(f"生成しました: {OUT}")
    print(f"  観測 {len(obs)}行 / 基準日 {len(dates)}、原本 {len(files)}、別名 {len(alias_rows)}、例外 {len(anomalies)}")


if __name__ == "__main__":
    main()
