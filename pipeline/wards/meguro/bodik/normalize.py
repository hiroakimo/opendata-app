r"""
R2 の生ファイル -> 正規化 -> D1 投入用SQL

使い方:
    python pipeline/wards/meguro/bodik/normalize.py --manifest work\meguro\bodik\manifest\bodik.jsonl --dry-run
    python pipeline/wards/meguro/bodik/normalize.py --manifest work\meguro\bodik\manifest\bodik.jsonl work\meguro\bodik\manifest\meguro_local_seed.jsonl

環境変数:
    R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY

前提:
    pip install boto3 openpyxl

3つの軸を独立に扱う:
    形式     … CSV か XLSX か。先頭バイト(PK)で判別する。拡張子は見ない。
    レイアウト … ワイド（年齢が列）かロング（年齢が行）か。ヘッダで判別する。
    粒度     … 5歳刻みか1歳刻みか。どちらのテーブルに入れるかを決める。

    5歳刻みには「CSV×ワイド」と「XLSX×ワイド」があり、
    1歳刻みは「XLSX×ロング」。この3軸は互いに独立している。

処理の順序:
    ワイド形式は KEY_CODE を持つので先に処理し、町丁目レジストリを作る。
    ロング形式は KEY_CODE を持たないため、そのレジストリで名寄せする。

その他の方針:
  - 破損の判定は構造検査で行い、ファイル名の決め打ち除外はしない。
  - 除外したファイルも source_files に status='skipped' と理由付きで記録する。
  - 想定と異なるヘッダは推測せず、実際のヘッダを添えてスキップする。
  - SQL は冪等。基準日ごとに DELETE してから INSERT する。
  - 99_sweep.sql はマニフェストに無い基準日を削除する。
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

BUCKET = "opendata-lake"
ROWS_PER_INSERT = 400

# 発行元の表記ゆれに耐えるよう「男性/男」「女性/女」の双方を受ける。
# 2026-04 以降の5歳刻みXLSXでは「不詳者の女性」が「不詳者の女」になっている。
RE_RANGE = re.compile(r"^(\d+)-(\d+)歳の(男性|女性|男|女)$")
RE_OVER = re.compile(r"^(\d+)歳以上の(男性|女性|男|女)$")
RE_UNKNOWN = re.compile(r"^不詳者の(男性|女性|男|女)$")
# 2026-04 以降に追加された外国人の列。年齢別の内訳はない。
FOREIGN_COLS = {
    "男性_外国人": "male",
    "女性_外国人": "female",
    "計_外国人": "total",
}
RE_AGE_RANGE = re.compile(r"^(\d+)\s*[-–~〜～]\s*(\d+)\s*(?:歳)?$")
RE_AGE_PLUS = re.compile(r"^(\d+)\s*(?:歳)?以上$")
SEX_MAP = {"男性": "male", "女性": "female", "男": "male", "女": "female"}

KANSUJI = {"一": "1", "二": "2", "三": "3", "四": "4", "五": "5",
           "六": "6", "七": "7", "八": "8", "九": "9"}
RE_KAN_CHOME = re.compile(r"([一二三四五六七八九])丁目")

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def log(msg: str = "") -> None:
    print(msg, flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def q(v) -> str:
    if v is None or v == "":
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def to_int(cell):
    if isinstance(cell, bool):
        return None
    if isinstance(cell, int):
        return cell
    if isinstance(cell, float):
        return int(cell) if float(cell).is_integer() else None
    s = str(cell or "").replace("\u3000", " ").strip().replace(",", "")
    if s in ("", "-", "－", "…"):
        return None
    try:
        return int(s)
    except ValueError:
        return None


def to_date(v) -> str:
    if isinstance(v, (datetime, date)):
        return v.strftime("%Y-%m-%d")
    return str(v or "").strip()


def normalize_area_name(s: str) -> str:
    """漢数字の丁目を算用数字に寄せ、空白を除く。突合用のキーを作る。"""
    s = str(s or "").replace("\u3000", "").replace(" ", "").strip()
    return RE_KAN_CHOME.sub(lambda m: KANSUJI[m.group(1)] + "丁目", s)


def normalize_age_class(v) -> str:
    """年齢の表記を age_class に寄せる。各歳・階級・以上・不詳のいずれにも対応。"""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return str(int(v))
    s = str(v or "").replace("\u3000", " ").strip()
    if s in ("不詳", "不詳者", "年齢不詳"):
        return "unknown"
    if s in ("総数", "合計"):
        return "total"
    if m := RE_AGE_RANGE.match(s):
        return f"{int(m.group(1))}-{int(m.group(2))}"
    if m := RE_AGE_PLUS.match(s):
        return f"{int(m.group(1))}+"
    if s.isdigit():
        return str(int(s))
    return s or "unknown"


# ---------------------------------------------------------------- 粒度

def classify_granularity(rec: dict) -> tuple[str | None, str]:
    """(粒度, 判定根拠) を返す。粒度はどちらのテーブルに入れるかだけを決める。"""
    g = rec.get("granularity")
    if g in ("5y", "1y"):
        return g, "filename"
    ext = (rec.get("extension") or
           Path(rec.get("source_file", "")).suffix.lstrip(".")).lower()
    if ext == "csv":
        return "5y", "inferred:csv"
    if ext in ("xlsx", "xlsm"):
        return "1y", "inferred:xlsx"
    return None, "undetermined"


# ---------------------------------------------------------------- 読み取り

def is_xlsx(data: bytes) -> bool:
    """XLSX は ZIP コンテナなので先頭が PK。拡張子ではなく実体で判別する。"""
    return data[:2] == b"PK"


def decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "cp932", "utf-8", "euc-jp"):
        try:
            t = data.decode(enc)
        except UnicodeDecodeError:
            continue
        if "\ufffd" not in t:
            return t
    return data.decode("cp932", errors="replace")


def rows_from_csv(data: bytes) -> list[list]:
    text = decode(data)
    return [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]


def rows_from_xlsx(data: bytes) -> list[list]:
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    ws = wb.worksheets[0]
    rows = [list(r) for r in ws.iter_rows(values_only=True)
            if any(c is not None and str(c).strip() for c in r)]
    wb.close()
    return rows


def read_rows(data: bytes) -> tuple[list[list], str]:
    if is_xlsx(data):
        return rows_from_xlsx(data), "xlsx"
    return rows_from_csv(data), "csv"


def detect_layout(header: list) -> str:
    """ヘッダから wide / long を判別する。判別できなければ unknown。"""
    names = {str(c or "").strip() for c in header}
    if "総人口" in names and any(RE_RANGE.match(n) for n in names):
        return "wide"
    if "年齢" in names or "年齢階級" in names or "年齢区分" in names:
        return "long"
    return "unknown"


# ---------------------------------------------------------------- ワイド形式

def parse_wide(rows: list[list]) -> dict:
    """年齢が列に並ぶ形式。KEY_CODE を持つので町丁目レジストリの元になる。

    列は (measure, age_class, sex) に対応づける。対応表に無い列は捨てるが、
    捨てたことを unmapped に記録して呼び出し側に返す（黙って落とさない）。
    """
    if not rows:
        return {"issues": ["空ファイル"], "obs": [], "areas": [], "unmapped": []}

    header = rows[0]
    ncols = len(header)
    bad = [i for i, r in enumerate(rows[1:], start=2) if len(r) != ncols]
    if bad:
        return {"issues": [f"列数不一致 {len(bad)}行 (先頭は{bad[0]}行目)"],
                "obs": [], "areas": [], "unmapped": []}

    # 素性として使うが観測値にはしない列
    META_COLS = {"都道府県コード又は市区町村コード", "地域コード", "都道府県名",
                 "市区町村名", "調査年月日", "地域名", "KEY_CODE", "備考"}

    measures: dict[int, tuple[str, str, str]] = {}   # 列 -> (measure, age, sex)
    fixed: dict[str, int] = {}
    unmapped: list[str] = []

    for i, raw in enumerate(header):
        name = str(raw or "").strip()
        if name == "総人口":
            measures[i] = ("population", "total", "total")
        elif name == "男性":
            measures[i] = ("population", "total", "male")
        elif name == "女性":
            measures[i] = ("population", "total", "female")
        elif name == "世帯数":
            measures[i] = ("households", "total", "total")
        elif name in FOREIGN_COLS:
            measures[i] = ("foreign_population", "total", FOREIGN_COLS[name])
        elif m := RE_RANGE.match(name):
            measures[i] = ("population", f"{m.group(1)}-{m.group(2)}",
                           SEX_MAP[m.group(3)])
        elif m := RE_OVER.match(name):
            measures[i] = ("population", f"{m.group(1)}+", SEX_MAP[m.group(2)])
        elif m := RE_UNKNOWN.match(name):
            measures[i] = ("population", "unknown", SEX_MAP[m.group(1)])
        elif name in META_COLS:
            fixed[name] = i
        elif name:
            unmapped.append(name)

    need = ("地域名", "KEY_CODE", "調査年月日", "都道府県コード又は市区町村コード")
    missing = [k for k in need if k not in fixed]
    if missing:
        return {"issues": [f"必須列なし: {', '.join(missing)}"],
                "obs": [], "areas": [], "unmapped": unmapped}

    obs, areas = [], []
    for r in rows[1:]:
        key_code = str(r[fixed["KEY_CODE"]] or "").strip()
        if not key_code:
            continue
        muni = str(r[fixed["都道府県コード又は市区町村コード"]] or "").strip()
        d = to_date(r[fixed["調査年月日"]])
        name = str(r[fixed["地域名"]] or "").strip()
        acode = (str(r[fixed["地域コード"]] or "").strip()
                 if "地域コード" in fixed else None)

        areas.append((key_code, muni, acode, name, d))
        for i, (measure, age, sex) in measures.items():
            obs.append((key_code, muni, d, measure, age, sex, to_int(r[i])))

    issues = []
    if unmapped:
        issues.append(f"対応表に無い列 {len(unmapped)}個: {', '.join(unmapped[:6])}")
    return {"issues": [], "obs": obs, "areas": areas,
            "unmapped": unmapped, "warnings": issues}


# ---------------------------------------------------------------- ロング形式

def parse_long(rows: list[list], name_to_key: dict[str, str], muni: str) -> dict:
    """年齢が行に並ぶ形式。KEY_CODE が無いのでレジストリで名寄せする。"""
    if len(rows) < 2:
        return {"issues": ["データ行なし"], "obs": [], "aliases": {}, "unresolved": []}

    header = [str(c or "").strip() for c in rows[0]]

    def find(*names):
        for n in names:
            if n in header:
                return header.index(n)
        return None

    i_date = find("調査年月日", "基準日", "年月日")
    i_area = find("町丁目", "地域名", "町丁名")
    i_age = find("年齢", "年齢階級", "年齢区分")
    i_tot = find("総数", "合計", "総人口")
    i_m = find("男性", "男")
    i_f = find("女性", "女")

    if None in (i_date, i_area, i_age, i_m, i_f):
        return {"issues": [f"想定と異なるヘッダ: {header[:10]}"],
                "obs": [], "aliases": {}, "unresolved": []}

    cols = {"male": i_m, "female": i_f}
    if i_tot is not None:
        cols["total"] = i_tot

    obs, aliases, unresolved = [], {}, set()
    for r in rows[1:]:
        raw_name = str(r[i_area] or "").strip()
        if not raw_name:
            continue
        d = to_date(r[i_date])
        key_code = name_to_key.get(normalize_area_name(raw_name))
        aliases[raw_name] = (key_code,
                             "kansuji_normalize" if key_code else "unresolved", d)
        if not key_code:
            unresolved.add(raw_name)
            continue

        age_class = normalize_age_class(r[i_age])
        for sex, i in cols.items():
            obs.append((key_code, muni, d, age_class, sex, to_int(r[i])))

    issues = []
    if unresolved:
        issues.append(f"町丁目名を解決できず {len(unresolved)}件: "
                      + ", ".join(sorted(unresolved)[:5]))
    return {"issues": issues, "obs": obs, "aliases": aliases,
            "unresolved": sorted(unresolved)}


# ---------------------------------------------------------------- R2 / SQL

def make_client():
    import boto3
    missing = [k for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")
               if not os.environ.get(k)]
    if missing:
        sys.exit(f"環境変数が未設定です: {', '.join(missing)}")
    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def insert_batches(table: str, cols: list[str], rows: list[tuple]) -> list[str]:
    out = []
    head = f"INSERT OR REPLACE INTO {table} ({', '.join(cols)}) VALUES"
    for i in range(0, len(rows), ROWS_PER_INSERT):
        chunk = rows[i:i + ROWS_PER_INSERT]
        vals = ",\n".join("(" + ", ".join(q(v) for v in row) + ")" for row in chunk)
        out.append(f"{head}\n{vals};")
    return out



# ---------------------------------------------------------------- 基準日の決定

SF_COLS = [
    "sha256", "r2_key", "dataset", "source_file", "muni_code", "granularity",
    "granularity_source", "reference_date", "content_bytes", "status",
    "skip_reason", "row_count", "ingested_at",
    "resource_id", "source_last_modified", "supersedes", "is_current",
    "filename_date", "date_source",
]


def resolve_date(rec: dict, obs_dates: list[str]) -> tuple[str, str, str | None]:
    """(採用する基準日, 判定根拠, 食い違いの説明) を返す。

    シート内の「調査年月日」を正とする。ファイル名は配信元の都合で
    実態と食い違うことがあり、実際 2026-08 分として配信されたファイルの
    中身が 2026-06 分だった事例がある。

    ここを揃えていないと DELETE と INSERT が別の月を指し、
    無関係な月のデータを黙って上書きする。
    """
    fname = rec.get("reference_date") or ""
    if not obs_dates:
        return fname, "filename", None
    if len(obs_dates) > 1:
        return obs_dates[0], "sheet", (
            f"1ファイルに複数の基準日が含まれる（{', '.join(obs_dates)}）"
        )
    eff = obs_dates[0]
    if fname and eff != fname:
        return eff, "sheet", (
            f"ファイル名の基準日 {fname} と、シート内の調査年月日 {eff} が"
            f"一致しない。シート内の日付を採用した"
        )
    return eff, "sheet", None


def pick_current(rows: list[dict]) -> list[str]:
    """同一 (粒度, 基準日) に複数の実体があるとき、どれを正とするか決める。

    配信元の更新日が新しいものを採用する。採用しなかった世代は
    is_current=0 にして残す。行は消さない。
    """
    notes: list[str] = []
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        if r["status"] != "ingested":
            r["is_current"] = 0
            continue
        groups.setdefault((r["granularity"], r["reference_date"]), []).append(r)

    for (gran, date), g in sorted(groups.items()):
        if len(g) == 1:
            g[0]["is_current"] = 1
            continue
        g.sort(key=lambda r: (r.get("source_last_modified") or "",
                              r.get("ingested_at") or ""), reverse=True)
        g[0]["is_current"] = 1
        for r in g[1:]:
            r["is_current"] = 0
        notes.append(
            f"{gran} {date}: {len(g)} 件が競合。"
            f"更新日が最も新しい {g[0]['source_file']}"
            f"（{g[0].get('source_last_modified')}）を採用し、"
            + "、".join(f"{r['source_file']}（{r.get('source_last_modified')}）"
                        for r in g[1:])
            + " は採用しない"
        )
    return notes

# ---------------------------------------------------------------- 本体

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", nargs="+", required=True)
    ap.add_argument("--out", default="work/meguro/bodik/sql")
    ap.add_argument("--muni", default="131105", help="ロング形式に付与する団体コード")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--dataset-key-prefix", default="meguro",
                    help="known_issues に書く dataset_key の接頭辞")
    ap.add_argument("--allow-sweep", action="store_true",
                    help="配信元から消えた基準日の削除文を有効にする。"
                         "既定ではコメントアウトして生成する")
    args = ap.parse_args()

    latest: dict[str, dict] = {}
    gone: set[str] = set()          # CKAN から消えたリソース
    for mp in args.manifest:
        p = Path(mp)
        if not p.exists():
            sys.exit(f"マニフェストがありません: {p}")
        for line in p.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            key = r.get("resource_id") or r.get("source_file")
            if r.get("status") == "missing":
                gone.add(key)
                continue
            if not r.get("sha256"):
                continue
            gone.discard(key)       # 消えた後に復活した場合
            latest[key] = r         # JSONL は追記順＝時系列なので後勝ちでよい

    for key in gone:
        if latest.pop(key, None) is not None:
            log(f"※ 配信元から消滅したため対象外: {key}")

    dedup: dict[str, dict] = {r["sha256"]: r for r in latest.values()}
    targets = sorted(dedup.values(), key=lambda r: (r.get("reference_date") or "",
                                                    r.get("source_file") or ""))
    log(f"対象 {len(targets)} 件（マニフェスト {len(args.manifest)} 本）\n")

    s3 = make_client()
    src_rows, area_latest, alias_latest = [], {}, {}
    date_issues: list[tuple] = []
    kept5, kept1, skipped, n_obs = [], [], [], 0
    sql: dict[str, list[str]] = defaultdict(list)

    def ledger(rec, gran, status, reason, nrows, eff_date=None, dsrc=None):
        return {
            "sha256": rec["sha256"], "r2_key": rec["r2_key"],
            "dataset": rec.get("dataset"), "source_file": rec.get("source_file"),
            "muni_code": rec.get("muni_code"), "granularity": gran,
            "granularity_source": rec.get("_gsource"),
            "reference_date": eff_date if eff_date is not None
                              else rec.get("reference_date"),
            "content_bytes": rec.get("content_bytes"), "status": status,
            "skip_reason": reason, "row_count": nrows, "ingested_at": now_iso(),
            "resource_id": rec.get("resource_id"),
            "source_last_modified": rec.get("source_last_modified"),
            "supersedes": rec.get("supersedes"),
            "is_current": 1,                     # pick_current で振り直す
            "filename_date": rec.get("reference_date"),
            "date_source": dsrc or "filename",
        }

    def emit(rec, gran, obs):
        """DELETE と INSERT の基準日を、どちらも観測行が持つ日付から取る。

        以前はファイル名由来の日付で DELETE し、シート由来の日付で INSERT
        していた。両者が食い違うと、消すべき月を消さず、無関係な月を
        上書きする。2026-08 の事故はこれで起きた。
        """
        table = "observations_5y" if gran == "5y" else "observations_1y"
        prefix = "10_5y" if gran == "5y" else "11_1y"
        cols = (["key_code", "muni_code", "reference_date", "measure",
                 "age_class", "sex", "value", "source_sha256"] if gran == "5y"
                else ["key_code", "muni_code", "reference_date",
                      "age_class", "sex", "value", "source_sha256"])

        by_date: dict[str, list] = {}
        for o in obs:
            by_date.setdefault(o[2] or "", []).append(o)

        for d, rows_d in sorted(by_date.items()):
            st = sql[f"{prefix}_{d[:4] or 'unknown'}"]
            st.append(f"DELETE FROM {table} WHERE reference_date = {q(d)};")
            st.extend(insert_batches(table, cols,
                                     [o + (rec["sha256"],) for o in rows_d]))

    # ---- 第1段: 全件を読み、レイアウトで振り分ける ----
    log("■ 読み取りとレイアウト判別")
    wide_jobs, long_jobs = [], []
    for rec in targets:
        gran, gsrc = classify_granularity(rec)
        rec["_gsource"] = gsrc
        rec["_granularity"] = gran

        data = s3.get_object(Bucket=BUCKET, Key=rec["r2_key"])["Body"].read()
        try:
            rows, fmt = read_rows(data)
        except Exception as ex:  # noqa: BLE001
            reason = f"読み取り失敗: {ex}"
            log(f"  SKIP  {rec['source_file']}  {reason}")
            skipped.append(rec["source_file"])
            src_rows.append(ledger(rec, gran, "skipped", reason, 0))
            continue

        layout = detect_layout(rows[0]) if rows else "unknown"
        rec["_format"], rec["_layout"] = fmt, layout

        if layout == "wide":
            wide_jobs.append((rec, rows))
        elif layout == "long":
            long_jobs.append((rec, rows))
        else:
            hdr = [str(c or "").strip() for c in (rows[0] if rows else [])][:10]
            reason = f"レイアウト判別不能: {hdr}"
            log(f"  SKIP  {rec['source_file']}  {reason}")
            skipped.append(rec["source_file"])
            src_rows.append(ledger(rec, gran, "skipped", reason, 0))

    log(f"  ワイド {len(wide_jobs)} 件 / ロング {len(long_jobs)} 件\n")

    # ---- 第2段: ワイド形式（KEY_CODEあり）----
    log("■ ワイド形式")
    for rec, rows in wide_jobs:
        res = parse_wide(rows)
        gran = rec["_granularity"] or "5y"
        d = rec.get("reference_date") or ""

        if res["issues"]:
            reason = "; ".join(res["issues"])
            log(f"  SKIP  {rec['source_file']}  {reason}")
            skipped.append(rec["source_file"])
            src_rows.append(ledger(rec, gran, "skipped", reason, 0))
            continue

        obs_dates = sorted({o[2] for o in res["obs"] if o[2]})
        eff, dsrc, mismatch = resolve_date(rec, obs_dates)
        if mismatch:
            log(f"  ！     {rec['source_file']}  {mismatch}")
            date_issues.append((rec, gran, mismatch))

        warn = "; ".join(([mismatch] if mismatch else [])
                         + (res.get("warnings") or [])) or None
        if warn and not mismatch:
            log(f"  ※     {rec['source_file']}  {warn}")
        (kept5 if gran == "5y" else kept1).append(eff)
        n_obs += len(res["obs"])
        src_rows.append(ledger(rec, gran, "ingested", warn, len(res["obs"]),
                               eff, dsrc))

        for key_code, muni, acode, name, dd in res["areas"]:
            cur = area_latest.get(key_code)
            area_latest[key_code] = (key_code, muni, acode, name,
                                     min(cur[4], dd) if cur else dd, dd)
            a = alias_latest.get((muni, name))
            alias_latest[(muni, name)] = (muni, name, key_code, "source",
                                          min(a[4], dd) if a else dd, dd)

        if not args.dry_run:
            emit(rec, gran, res["obs"])
        log(f"  OK    {rec['source_file']}  {len(res['obs']):,} 行  "
            f"[{gran}/{rec['_format']}]")

    name_to_key = {normalize_area_name(v[3]): k for k, v in area_latest.items()}
    log(f"\n町丁目レジストリ: {len(name_to_key)} 件\n")

    # ---- 第3段: ロング形式（KEY_CODEなし・名寄せ）----
    log("■ ロング形式")
    for rec, rows in long_jobs:
        res = parse_long(rows, name_to_key, args.muni)
        gran = rec["_granularity"] or "1y"
        d = rec.get("reference_date") or ""

        for raw, (key_code, how, dd) in res["aliases"].items():
            a = alias_latest.get((args.muni, raw))
            if a and a[2] and not key_code:
                continue
            alias_latest[(args.muni, raw)] = (args.muni, raw, key_code, how,
                                              min(a[4], dd) if a else dd, dd)

        if not res["obs"]:
            reason = "; ".join(res["issues"]) or "観測値なし"
            log(f"  SKIP  {rec['source_file']}  {reason}")
            skipped.append(rec["source_file"])
            src_rows.append(ledger(rec, gran, "skipped", reason, 0))
            continue

        obs = res["obs"]
        if gran == "5y":
            obs = [(o[0], o[1], o[2], "population", o[3], o[4], o[5]) for o in obs]

        obs_dates = sorted({o[2] for o in obs if o[2]})
        eff, dsrc, mismatch = resolve_date(rec, obs_dates)
        if mismatch:
            log(f"  ！     {rec['source_file']}  {mismatch}")
            date_issues.append((rec, gran, mismatch))

        (kept5 if gran == "5y" else kept1).append(eff)

        n_obs += len(obs)
        note = "; ".join(([mismatch] if mismatch else []) + res["issues"]) or None
        src_rows.append(ledger(rec, gran, "ingested", note, len(obs), eff, dsrc))
        if not args.dry_run:
            emit(rec, gran, obs)
        log(f"  OK    {rec['source_file']}  {len(obs):,} 行  "
            f"[{gran}/{rec['_format']}]" + (f"  ※{note}" if note else ""))

    # ---- 同一基準日の競合を解決する ----
    #      後勝ちに任せず、配信元の更新日が新しいものを正とする。
    #      採用しなかった世代は is_current=0 で残す。
    conflict_notes = pick_current(src_rows)
    for n in conflict_notes:
        log(f"\n※ {n}")

    unres = [a for a in alias_latest.values() if a[2] is None]
    log(f"\n取り込み {len(kept5) + len(kept1)} 件 / 除外 {len(skipped)} 件 / "
        f"観測値 {n_obs:,} 行 / 未解決の別名 {len(unres)} 件")
    if skipped:
        log("除外: " + ", ".join(str(x) for x in skipped))
    if unres:
        log("未解決: " + ", ".join(a[1] for a in unres))

    if args.dry_run:
        log("\n(dry-run: SQLは生成していません)")
        return 0

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for name, stmts in sorted(sql.items()):
        p = out / f"{name}.sql"
        p.write_text("\n".join(stmts) + "\n", encoding="utf-8")
        written.append(p)

    meta = insert_batches(
        "source_files", SF_COLS,
        [tuple(r[c] for c in SF_COLS) for r in src_rows])
    meta += insert_batches(
        "areas",
        ["key_code", "muni_code", "area_code", "area_name", "first_seen", "last_seen"],
        list(area_latest.values()))
    meta += insert_batches(
        "area_aliases",
        ["muni_code", "alias_name", "key_code", "resolved_by", "first_seen", "last_seen"],
        list(alias_latest.values()))
    p = out / "20_meta.sql"
    p.write_text("\n".join(meta) + "\n", encoding="utf-8")
    written.append(p)

    # ---- 食い違いと競合を known_issues に残す ----
    #      画面に出して利用者が判断できるようにする。黙って直さない。
    issues_sql = ["-- 取り込み時に検出した食い違い"]
    for rec, gran, msg in date_issues:
        issues_sql.append(
            "INSERT INTO known_issues "
            "(dataset_key, severity, title, detail, raised_at) VALUES ("
            + q(f"{args.dataset_key_prefix}_{gran}") + ", " + q("warn") + ", "
            + q("配信元のファイル名と内容の基準日が一致しない") + ", "
            + q(f"{rec.get('source_file')}: {msg}"
                f"（sha256 {str(rec.get('sha256'))[:12]}…）") + ", "
            + q(now_iso()[:10]) + ");")
    for n in conflict_notes:
        gran = "5y" if n.startswith("5y") else "1y"
        issues_sql.append(
            "INSERT INTO known_issues "
            "(dataset_key, severity, title, detail, raised_at) VALUES ("
            + q(f"{args.dataset_key_prefix}_{gran}") + ", " + q("info") + ", "
            + q("同一基準日に複数の配信ファイルが存在する") + ", "
            + q(n) + ", " + q(now_iso()[:10]) + ");")
    p = out / "21_issues.sql"
    p.write_text("\n".join(issues_sql) + "\n", encoding="utf-8")
    written.append(p)

    # ---- 配信元から消えた基準日の掃除 ----
    #      NOT IN は取りこぼすと大量削除になる。既定では実行しない形で出し、
    #      中身を目で見てから --allow-sweep で有効にする。
    on = args.allow_sweep
    sweep = ["-- マニフェストに無い基準日を削除する（配信元での削除を反映）"]
    if not on:
        sweep.append("-- 既定では無効。内容を確認のうえ --allow-sweep で生成し直すこと。")
    mark = "" if on else "-- "
    if kept5:
        sweep.append(mark + "DELETE FROM observations_5y WHERE reference_date NOT IN ("
                     + ", ".join(q(d) for d in sorted(set(kept5))) + ");")
    if kept1:
        sweep.append(mark + "DELETE FROM observations_1y WHERE reference_date NOT IN ("
                     + ", ".join(q(d) for d in sorted(set(kept1))) + ");")
    p = out / "99_sweep.sql"
    p.write_text("\n".join(sweep) + "\n", encoding="utf-8")
    written.append(p)

    log(f"\n生成: {len(written)} ファイル")
    log("\n適用順:")
    for p in written:
        log(f"  wrangler d1 execute tokyo-population --remote --file={p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
