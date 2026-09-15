#!/usr/bin/env python3
"""
港区CKAN系列を D1 / R2 に載せるための SQL と実行スクリプトを生成する。
このスクリプト自体は D1 / R2 に接続しない。生成物を確認してから run_load.ps1 で流す。

前提
  - migrations/0005_noage_observations.sql 適用済み
  - parse_minato_ckan.py が成功し work/minato_parsed/ がある
  - minato_towns.json に key_code が振られている（--assign-keys で一度だけ）

使い方
  python build_minato_load.py --assign-keys   # 初回のみ。key_code を固定してコミット
  python build_minato_load.py                 # work/minato_load/ を生成

生成物（work/minato_load/）
  r2_upload.ps1   原本を R2 raw/{sha256} に置く
  00_meta.sql     datasets / dataset_sources / areas / area_aliases /
                  source_files / source_file_periods / data_anomalies
  obs_YYYY.sql    年ごとに DELETE → INSERT（冪等）
  99_verify.sql   取込後の検算（読み取りのみ）
  run_load.ps1    上記を順に流す。途中で失敗したら止まる
"""
import argparse
import csv
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MASTER = HERE / "minato_towns.json"
SURVEY = Path("work/minato_survey")
PARSED = Path("work/minato_parsed")
OUT = Path("work/minato_load")

DB = "tokyo-population"
BUCKET = "opendata-lake"
MUNI = "131032"
KEY_PREFIX = "13103"
DATASET_KEY = "minato_noage"
CKAN_DATASET = "jinko-chochomokubetsu"
GRAN = "noage"
N_TOWNS = 117
ROWS_PER_TOWN_MONTH = 5
BATCH = 200
MAX_STMT_BYTES = 90_000  # D1 の1文上限（100KB）に余裕を持たせる


def q(v):
    if v is None or v == "":
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def area_name(t):
    return t["town_name"] + (f"{t['chome']}丁目" if t["chome"] is not None else "")


# ---------------------------------------------------------------- key_code 付与
def assign_keys():
    m = json.loads(MASTER.read_text(encoding="utf-8"))
    have = [t for t in m["towns"] if t.get("key_code")]
    if have:
        sys.exit(f"中止: 既に key_code がある町丁目が {len(have)} 件あります（振り直しはしない）")
    seq = {}
    for t in m["towns"]:
        seq.setdefault(t["town_name"], len(seq) + 1)
    for t in m["towns"]:
        t["town_seq"] = seq[t["town_name"]]
        t["key_code"] = f"{KEY_PREFIX}{seq[t['town_name']]:03d}{(t['chome'] or 0):03d}"
        t["area_name"] = area_name(t)
    keys = [t["key_code"] for t in m["towns"]]
    names = [t["area_name"] for t in m["towns"]]
    if len(set(keys)) != len(keys) or len(set(names)) != len(names):
        sys.exit("中止: key_code または area_name が重複する")
    m["key_rule"] = (f"{KEY_PREFIX} + 町の連番3桁（マスタ初出順）+ 丁目3桁（丁目なしは000）。"
                     "一度振った番号は変えない。新しい町丁目は末尾に追加する。")
    MASTER.write_text(json.dumps(m, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"key_code を付与しました: {len(keys)}件 / 町 {len(seq)}件")
    print(f"  例: {m['towns'][0]['town']} → {keys[0]} {names[0]}")
    print("内容を確認してからコミットしてください。")


# ---------------------------------------------------------------- 生成
def read_csv(p):
    with open(p, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def insert_batches(table, cols, rows):
    out = []
    for i in range(0, len(rows), BATCH):
        vals = ",\n".join("(" + ",".join(q(v) for v in r) + ")" for r in rows[i:i + BATCH])
        stmt = f"INSERT INTO {table} ({', '.join(cols)}) VALUES\n{vals};"
        if len(stmt.encode("utf-8")) > MAX_STMT_BYTES:
            sys.exit(f"中止: 1文が {MAX_STMT_BYTES} バイトを超える（BATCH を下げる）")
        out.append(stmt)
    return out


def build():
    m = json.loads(MASTER.read_text(encoding="utf-8"))
    towns = m["towns"]
    if not all(t.get("key_code") for t in towns):
        sys.exit("中止: key_code 未付与。先に --assign-keys を実行してください")
    if len(towns) != N_TOWNS:
        sys.exit(f"中止: マスタが {len(towns)} 件（想定 {N_TOWNS}）")
    by_town = {t["town"]: t for t in towns}

    manifest = json.loads((SURVEY / "manifest.json").read_text(encoding="utf-8"))
    pkg = json.loads((SURVEY / manifest["package_file"]).read_bytes())["result"]
    res_by_id = {r["id"]: r for r in pkg["resources"]}

    obs = read_csv(PARSED / "observations.csv")
    anomalies = read_csv(PARSED / "anomalies.csv")
    files = read_csv(PARSED / "files.csv")

    # ---- 事前チェック
    errs = []
    shas = {f["sha256"] for f in files}
    if {o["source_sha256"] for o in obs} != shas:
        errs.append("observations.csv と files.csv の sha256 集合が一致しない")
    for f in files:
        if f["resource_id"] not in res_by_id:
            errs.append(f"package にないリソース: {f['resource_id']}")
        if manifest["resources"].get(f["resource_id"], {}).get("sha256") != f["sha256"]:
            errs.append(f"manifest と sha256 が不一致: {f['name']}")
        if not (SURVEY / "raw" / f["sha256"]).exists():
            errs.append(f"原本ファイルがない: {f['sha256']}")
    for o in obs:
        if o["town_key"] not in by_town:
            errs.append(f"マスタにない町丁目: {o['town_key']}")
            break
    per_month = defaultdict(int)
    for o in obs:
        per_month[o["reference_date"]] += 1
    n_anom_rows = sum(1 for a in anomalies if a["kind"] == "sum_mismatch")
    expected_total = len(per_month) * N_TOWNS * ROWS_PER_TOWN_MONTH - n_anom_rows
    if len(obs) != expected_total:
        errs.append(f"行数 {len(obs)} が想定 {expected_total} と不一致")
    if errs:
        sys.exit("中止:\n  " + "\n  ".join(errs))

    OUT.mkdir(parents=True, exist_ok=True)
    for p in OUT.glob("*"):
        p.unlink()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    dates = sorted(per_month)

    # ---- 00_meta.sql
    S = ["-- 生成: build_minato_load.py " + now, "-- 港区CKAN（jinko-chochomokubetsu）メタデータ", ""]
    S.append(
        "INSERT OR REPLACE INTO datasets (dataset_key, muni_code, muni_name, domain, title, granularity,"
        " grain_label, source_site, source_url, license, attribution, is_public, notes, license_url) VALUES ("
        + ", ".join(q(v) for v in [
            DATASET_KEY, MUNI, "港区", "population", "町丁目別 男女別人口・世帯数", GRAN,
            "年齢区分なし", "港区オープンデータカタログ",
            f"https://opendata.city.minato.tokyo.jp/dataset/{CKAN_DATASET}",
            None, None, 0,
            f"{dates[0][:7]}以降の月次。年ごとに1ファイルで、当年分は毎月追記される。"
            "カタログ上の表示はCC BY（版の表記なし）。確認するまで license は NULL。"
            "Final Stage 終了まで is_public=0。",
            None]) + ");")
    S.append(f"INSERT OR REPLACE INTO dataset_sources (dataset_key, dataset, granularity, role) "
             f"VALUES ({q(DATASET_KEY)}, {q(CKAN_DATASET)}, {q(GRAN)}, 'archive');")
    S.append("")

    first_last = {}
    for o in obs:
        k = o["town_key"]
        d = o["reference_date"]
        a, b = first_last.get(k, (d, d))
        first_last[k] = (min(a, d), max(b, d))
    area_rows = [(t["key_code"], MUNI, None, t["area_name"], *first_last[t["town"]]) for t in towns]
    S += insert_batches("areas", ["key_code", "muni_code", "area_code", "area_name",
                                  "first_seen", "last_seen"], area_rows)
    S[-1] = S[-1].replace("INSERT INTO areas", "INSERT OR REPLACE INTO areas")

    alias_rows = [(MUNI, t["town"], t["key_code"], "kansuji_normalize", *first_last[t["town"]])
                  for t in towns if t["town"] != t["area_name"]]
    for a in anomalies:
        if a["kind"] == "name_variant":
            raw = json.loads(a["reported"])["town"]
            alias_rows.append((MUNI, raw, by_town[a["town"]]["key_code"], "manual",
                               a["reference_date"], a["reference_date"]))
    stmts = insert_batches("area_aliases", ["muni_code", "alias_name", "key_code", "resolved_by",
                                            "first_seen", "last_seen"], alias_rows)
    S += [s.replace("INSERT INTO", "INSERT OR REPLACE INTO") for s in stmts]
    S.append("")

    # source_files：同じ resource_id の旧世代は is_current=0 にし、新世代の supersedes に記録
    periods = defaultdict(lambda: defaultdict(int))
    obs_rows_by_sha = defaultdict(int)
    for o in obs:
        obs_rows_by_sha[o["source_sha256"]] += 1
        if o["measure"] == "households":
            periods[o["source_sha256"]][o["reference_date"]] += 1
    for f in files:
        res = res_by_id[f["resource_id"]]
        sha = f["sha256"]
        vals = dict(
            sha256=sha, r2_key=f"raw/{sha}", dataset=CKAN_DATASET,
            source_file=res["url"].rsplit("/", 1)[-1], muni_code=MUNI, granularity=GRAN,
            reference_date=None, content_bytes=manifest["resources"][f["resource_id"]]["bytes"],
            status="ingested", skip_reason=None, row_count=obs_rows_by_sha[sha], ingested_at=now,
            granularity_source="parser", distributable=1, hold_reason=None,
            resource_id=f["resource_id"], source_last_modified=res.get("last_modified"),
            is_current=1, filename_date=None, date_source="trailer")
        cols = list(vals)
        upd = ", ".join(f"{c} = excluded.{c}" for c in cols if c not in ("sha256", "ingested_at"))
        S.append(
            f"INSERT INTO source_files ({', '.join(cols)}, supersedes) VALUES ("
            + ", ".join(q(vals[c]) for c in cols)
            + f", (SELECT sha256 FROM source_files WHERE resource_id = {q(f['resource_id'])}"
              f" AND sha256 <> {q(sha)} AND is_current = 1 ORDER BY source_last_modified DESC LIMIT 1))"
            + f"\n  ON CONFLICT(sha256) DO UPDATE SET {upd};")
        S.append(f"UPDATE source_files SET is_current = 0 WHERE resource_id = {q(f['resource_id'])}"
                 f" AND sha256 <> {q(sha)};")
    S.append("")

    sha_list = ", ".join(q(s) for s in sorted(shas))
    S.append(f"DELETE FROM source_file_periods WHERE sha256 IN ({sha_list});")
    S += insert_batches("source_file_periods", ["sha256", "reference_date", "row_count"],
                        [(sha, d, n) for sha, dd in periods.items() for d, n in sorted(dd.items())])
    S.append("")

    S.append(f"DELETE FROM data_anomalies WHERE dataset_key = {q(DATASET_KEY)};")
    if anomalies:
        S += insert_batches("data_anomalies",
                            ["anomaly_id", "dataset_key", "key_code", "reference_date", "kind",
                             "treatment", "reported", "note", "source_sha256"],
                            [(a["anomaly_id"], DATASET_KEY, by_town[a["town"]]["key_code"],
                              a["reference_date"], a["kind"], a["treatment"], a["reported"],
                              a["note"], a["source_sha256"]) for a in anomalies])
    (OUT / "00_meta.sql").write_text("\n".join(S) + "\n", encoding="utf-8")

    # ---- obs_YYYY.sql
    by_year = defaultdict(list)
    for o in obs:
        by_year[o["reference_date"][:4]].append((
            by_town[o["town_key"]]["key_code"], MUNI, o["reference_date"], o["measure"], o["sex"],
            int(o["value"]), int(o["is_derived"]), o["anomaly_id"] or None, o["source_sha256"]))
    obs_files = []
    for y in sorted(by_year):
        body = [f"-- {y}年 {len(by_year[y])}行",
                f"DELETE FROM observations_noage WHERE muni_code = {q(MUNI)}"
                f" AND reference_date BETWEEN '{y}-01-01' AND '{y}-12-31';"]
        body += insert_batches("observations_noage",
                               ["key_code", "muni_code", "reference_date", "measure", "sex",
                                "value", "is_derived", "anomaly_id", "source_sha256"], by_year[y])
        name = f"obs_{y}.sql"
        (OUT / name).write_text("\n".join(body) + "\n", encoding="utf-8")
        obs_files.append(name)

    # ---- 99_verify.sql（1行のSELECT。列ごとに OK/NG と取得値）
    M = q(MUNI)
    checks = [
        ("rows", f"SELECT COUNT(*) FROM observations_noage WHERE muni_code = {M}", len(obs)),
        ("months", f"SELECT COUNT(DISTINCT reference_date) FROM observations_noage WHERE muni_code = {M}", len(dates)),
        ("areas", f"SELECT COUNT(*) FROM areas WHERE muni_code = {M}", N_TOWNS),
        ("files", f"SELECT COUNT(*) FROM source_files WHERE dataset = {q(CKAN_DATASET)} AND is_current = 1", len(files)),
        ("periods", f"SELECT COUNT(DISTINCT p.reference_date) FROM source_file_periods p JOIN source_files s ON s.sha256 = p.sha256 WHERE s.dataset = {q(CKAN_DATASET)} AND s.is_current = 1", len(dates)),
        ("anomalies", f"SELECT COUNT(*) FROM data_anomalies WHERE dataset_key = {q(DATASET_KEY)}", len(anomalies)),
        ("orphan_keys", f"SELECT COUNT(*) FROM (SELECT DISTINCT key_code FROM observations_noage WHERE muni_code = {M}) o LEFT JOIN areas a ON a.key_code = o.key_code WHERE a.key_code IS NULL", 0),
        ("sum_ng", f"SELECT COUNT(*) FROM (SELECT key_code, reference_date,"
                   f" SUM(CASE WHEN sex IN ('male','female','unknown') THEN value END) AS parts,"
                   f" SUM(CASE WHEN sex = 'total' THEN value END) AS total"
                   f" FROM observations_noage WHERE muni_code = {M} AND measure = 'population' AND anomaly_id IS NULL"
                   f" GROUP BY key_code, reference_date) WHERE parts != total", 0),
        ("demo_5y_untouched", f"SELECT COUNT(*) FROM observations_5y WHERE muni_code = {M}", 0),
    ]
    got = ", ".join(f"({s}) AS {n}" for n, s, _ in checks)
    cols = ", ".join(f"CASE WHEN {n} = {e} THEN 'OK ' ELSE 'NG expected {e}: ' END || {n} AS {n}"
                     for n, _, e in checks)
    verify_sql = f"WITH g AS (SELECT {got}) SELECT {cols} FROM g;"
    (OUT / "99_verify.sql").write_text(verify_sql + "\n", encoding="utf-8")

    VP = ['$ErrorActionPreference = "Stop"',
          '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
          f'$sql = (Get-Content "{OUT / "99_verify.sql"}" -Raw -Encoding UTF8).Trim()',
          f'npx wrangler d1 execute {DB} --remote --json --command $sql']
    (OUT / "verify.ps1").write_text("\n".join(VP) + "\n", encoding="utf-8-sig")

    # ---- r2_upload.ps1
    R = ['$ErrorActionPreference = "Stop"']
    for f in sorted(files, key=lambda x: x["first"]):
        sha = f["sha256"]
        R.append(f'Write-Host "R2: {f["name"]}"')
        R.append(f'npx wrangler r2 object put "{BUCKET}/raw/{sha}" --file "{SURVEY / "raw" / sha}"'
                 f' --content-type "text/csv; charset=utf-8" --remote')
        R.append('if ($LASTEXITCODE -ne 0) { throw "R2 upload failed: ' + sha + '" }')
    (OUT / "r2_upload.ps1").write_text("\n".join(R) + "\n", encoding="utf-8-sig")

    # ---- run_load.ps1
    X = ['$ErrorActionPreference = "Stop"',
         '[Console]::OutputEncoding = [Text.Encoding]::UTF8']
    for name in ["00_meta.sql"] + obs_files:
        X.append(f'Write-Host "D1: {name}"')
        X.append(f'npx wrangler d1 execute {DB} --remote --file "{OUT / name}" -y')
        X.append('if ($LASTEXITCODE -ne 0) { throw "D1 load failed: ' + name + '" }')
    X.append('Write-Host "D1: 検算"')
    X.append(f'& "{OUT / "verify.ps1"}"')
    (OUT / "run_load.ps1").write_text("\n".join(X) + "\n", encoding="utf-8-sig")

    print(f"生成しました: {OUT}")
    print(f"  観測 {len(obs)}行 / {len(obs_files)}ファイル、町丁目 {len(area_rows)}、"
          f"別名 {len(alias_rows)}、原本 {len(files)}、例外 {len(anomalies)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--assign-keys", action="store_true")
    args = ap.parse_args()
    assign_keys() if args.assign_keys else build()


if __name__ == "__main__":
    main()
