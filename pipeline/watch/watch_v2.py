"""
上流の巡回チェック（CKAN 系・汎用）

やること:
  1. 対象パッケージのリソース情報を API から取得する
  2. 全フィールドをテーブル形式（1 リソース 1 行）で蓄積する
  3. 前回の観測と last_modified を比べ、更新対象を判定する

判定は last_modified のみで行う。
size やレコード数は記録するが、判定には使わない。
後日、蓄積したデータで別の基準を検証できるようにするため。

読み取り専用。ファイル本体はダウンロードしない。
R2 にも D1 にも書き込まない。

出力（いずれも 1 行 1 レコードの JSONL。D1 へはそのまま行として移せる）:
  work/watch/data/observations.jsonl   全リソースの観測記録（追記）
  work/watch/data/findings.jsonl       更新対象と判定したもの（追記）
  work/watch/data/runs.jsonl           巡回の実行記録（追記）

使い方:
    python pipeline/watch/watch_v2.py                     # 有効な全スコープ
    python pipeline/watch/watch_v2.py --scope tokyo:koto  # 1 スコープだけ
    python pipeline/watch/watch_v2.py --dry-run           # 記録せず判定だけ表示
    python pipeline/watch/watch_v2.py --list              # 直近の実行履歴
    python pipeline/watch/watch_v2.py --pending           # 未処理の更新対象
"""

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path("work/watch/data")
OBS_FILE = DATA_DIR / "observations.jsonl"
FIND_FILE = DATA_DIR / "findings.jsonl"
RUNS_FILE = DATA_DIR / "runs.jsonl"

UA = {"User-Agent": "machinome-watch/1.0 (+opendata update monitoring)"}

# D1 へ移す際に列にするフィールド。
# ここに無いものは raw_json に残るので、後から列を増やせる。
CORE_FIELDS = [
    "id", "name", "url", "format", "mimetype",
    "last_modified", "metadata_modified", "created",
    "size", "hash", "state", "position",
    "datastore_active", "url_type",
]


# =====================================================================
# スコープ定義
#
# 配布元ごとに違うのは
#   - パッケージの見つけ方
#   - ファイル名から基準日を読む規則
# の 2 点。他は CKAN 共通で扱える。
# =====================================================================
SCOPES = {
    "bodik:meguro": {
        "source_site": "BODIK",
        "muni_code": "131105",
        "muni_name": "目黒区",
        "api_base": "https://data.bodik.jp/api/3/action/",
        "packages": [
            "131105_population_by_town_section_age_gender_and_number_of_households_by_town_section",
            "131105_population_by_town_section_age_gender_and_number_of_households_by_town_section2",
            "131105_population_by_town_section_age_gender_and_number_of_households_by_town_section3",
            "131105_population_by_town_section_age_gender_and_number_of_households_by_town_section4",
            "131105_saishinjinko",
        ],
        "discovery_fq": None,
        # 131105_population_20170701.csv → 2017-07-01
        "date_patterns": [r"_(\d{4})(\d{2})(\d{2})\.[a-z0-9]+$"],
        "enabled": True,
        "note": "ファイル本体が BODIK 上にある。取り込み対応済み",
    },
    "tokyo:koto": {
        "source_site": "tokyo_catalog",
        "muni_code": "131083",
        "muni_name": "江東区",
        "api_base": "https://catalog.data.metro.tokyo.lg.jp/api/3/action/",
        "packages": [
            "t131083d3100000017",
            "t131083d3100000022",
        ],
        "discovery_fq": "organization:t131083",
        # 131083_204_population_detail_chouchoubetu_202606.csv → 2026-06-01
        "date_patterns": [r"_(\d{4})(\d{2})\.[a-z0-9]+$"],
        "enabled": True,
        "note": "ファイルは www.opendata.metro.tokyo.lg.jp。size は空。検知のみ",
    },
    "minato_catalog:minato": {
        "source_site": "minato_catalog",
        "muni_code": "131032",
        "muni_name": "港区",
        "api_base": "https://opendata.city.minato.tokyo.jp/api/3/action/",
        "packages": [
            "jinko-chochomokubetsu",
        ],
        # 組織は「港区」1つだけなので、名前で人口系に絞る
        "discovery_fq": "organization:minatoku AND name:jinko*",
        # chomokubetsu_2026.csv / chomokubetu_2017.csv → 年しか入っていない。
        # 月は中身（トレーラー行の Ver）で決まるため、ここでは読まない
        "date_patterns": [],
        "enabled": True,
        "note": "港区独自CKAN。年1ファイルで当年分は毎月追記（MODIFIED）、"
                "毎年1月に新しい年のリソースが増える（NEW）。D1取り込み対応済み（minato_noage）",
    },
}


# ---------------------------------------------------------------- 基本
def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def parse_ref_date(filename: str, patterns: list):
    """ファイル名から基準日を読む。ここだけが配布元ごとに異なる。"""
    for pat in patterns:
        m = re.search(pat, filename)
        if not m:
            continue
        g = m.groups()
        if len(g) == 3:
            return f"{g[0]}-{g[1]}-{g[2]}"
        if len(g) == 2:
            return f"{g[0]}-{g[1]}-01"
    return None


def read_jsonl(path: Path):
    if not path.exists():
        return []
    out = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def append_jsonl(path: Path, rows: list) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def latest_observations(scope_id: str = None) -> dict:
    """resource_id -> 直近の観測。snapshot_id が最も新しいものを採る。"""
    latest = {}
    for r in read_jsonl(OBS_FILE):
        if scope_id and r.get("scope_id") != scope_id:
            continue
        rid = r.get("resource_id")
        if not rid:
            continue
        prev = latest.get(rid)
        if prev is None or r.get("snapshot_id", "") >= prev.get("snapshot_id", ""):
            latest[rid] = r
    return latest


# ---------------------------------------------------------------- 巡回
def discover(cfg: dict) -> tuple:
    """登録済みパッケージと、検索で見つかった未登録パッケージ。"""
    known = list(cfg["packages"])
    extra = []
    fq = cfg.get("discovery_fq")
    if not fq:
        return known, extra
    try:
        url = (cfg["api_base"] + "package_search?fq="
               + urllib.parse.quote(fq) + "&rows=200")
        res = fetch_json(url)["result"]
        for p in res.get("results", []):
            if p["name"] not in known:
                extra.append({"package_id": p["name"], "title": p.get("title")})
    except Exception as e:
        print(f"   [警告] パッケージ検索に失敗: {e}", file=sys.stderr)
    return known, extra


def check_scope(scope_id: str, cfg: dict, snapshot_id: str) -> dict:
    prev_obs = latest_observations(scope_id)
    is_first = not prev_obs

    print(f"── {scope_id}  ({cfg['muni_name']} / {cfg['source_site']})")
    print(f"   前回の記録: {'なし（初回）' if is_first else f'{len(prev_obs)} 件'}")

    packages, extra = discover(cfg)
    observations = []
    findings = []
    seen = set()
    errors = []

    for pid in packages:
        try:
            pkg = fetch_json(cfg["api_base"] + "package_show?id=" + pid)["result"]
        except Exception as e:
            errors.append(f"{pid}: {e}")
            print(f"   [ERROR] {pid}: {e}", file=sys.stderr)
            continue

        for r in pkg.get("resources") or []:
            rid = r.get("id")
            if not rid:
                continue
            seen.add(rid)

            url = r.get("url") or ""
            fn = url.rsplit("/", 1)[-1]

            row = {
                "snapshot_id": snapshot_id,
                "scope_id": scope_id,
                "source_site": cfg["source_site"],
                "muni_code": cfg["muni_code"],
                "package_id": pid,
                "package_metadata_modified": pkg.get("metadata_modified"),
                "resource_id": rid,
                "source_file": fn,
                "reference_date": parse_ref_date(fn, cfg["date_patterns"]),
            }
            for k in CORE_FIELDS:
                row[k] = r.get(k)
            # 応答をそのまま残す。後から判定基準を変えられるように。
            row["raw_json"] = json.dumps(r, ensure_ascii=False)

            observations.append(row)

            # ---- 判定は last_modified のみ ----
            prev = prev_obs.get(rid)
            lm = r.get("last_modified")
            if prev is None:
                verdict = "NEW"
            elif lm != prev.get("last_modified"):
                verdict = "MODIFIED"
            else:
                verdict = None

            if verdict:
                findings.append({
                    "snapshot_id": snapshot_id,
                    "scope_id": scope_id,
                    "source_site": cfg["source_site"],
                    "package_id": pid,
                    "resource_id": rid,
                    "source_file": fn,
                    "url": url,
                    "reference_date": row["reference_date"],
                    "verdict": verdict,
                    "last_modified": lm,
                    "prev_last_modified": prev.get("last_modified") if prev else None,
                    "size": r.get("size"),
                    "prev_size": prev.get("size") if prev else None,
                    "detected_at": snapshot_id,
                    "state": "pending",
                })

    # 上流から消えたもの
    for rid, prev in prev_obs.items():
        if rid not in seen:
            findings.append({
                "snapshot_id": snapshot_id,
                "scope_id": scope_id,
                "source_site": cfg["source_site"],
                "package_id": prev.get("package_id"),
                "resource_id": rid,
                "source_file": prev.get("source_file"),
                "url": prev.get("url"),
                "reference_date": prev.get("reference_date"),
                "verdict": "GONE",
                "last_modified": None,
                "prev_last_modified": prev.get("last_modified"),
                "size": None,
                "prev_size": prev.get("size"),
                "detected_at": snapshot_id,
                "state": "pending",
            })

    print(f"   パッケージ {len(packages)} 件 / リソース {len(observations)} 件")
    if extra:
        print(f"   [!] 未登録のパッケージを {len(extra)} 件検出:")
        for e in extra:
            print(f"       {e['package_id']}  {e.get('title') or ''}")

    return {
        "scope_id": scope_id, "observations": observations,
        "findings": findings, "extra": extra, "errors": errors,
        "packages": len(packages), "is_first": is_first,
    }


# ---------------------------------------------------------------- 表示
def show_findings(findings: list) -> None:
    if not findings:
        print("更新対象はありません。")
        return
    by = defaultdict(list)
    for f in findings:
        by[(f["scope_id"], f["package_id"])].append(f)
    for (sid, pid), items in by.items():
        print(f"\n  {sid} / {pid}   ({len(items)} 件)")
        for f in sorted(items, key=lambda x: x["source_file"] or ""):
            line = f"    {f['verdict']:9} {f['source_file']}"
            if f.get("reference_date"):
                line += f"  [{f['reference_date']}]"
            print(line)
            print(f"        last_modified {f['last_modified']}", end="")
            if f.get("prev_last_modified"):
                print(f"   ← 前回 {f['prev_last_modified']}")
            else:
                print()
            if f.get("size") is not None or f.get("prev_size") is not None:
                s, ps = f.get("size"), f.get("prev_size")
                if s != ps and ps is not None:
                    print(f"        size {ps} → {s}")


def cmd_list() -> int:
    runs = read_jsonl(RUNS_FILE)
    if not runs:
        print("実行履歴はありません。")
        return 0
    print(f"{'snapshot_id':<26} {'scopes':<8} {'resources':>10} {'findings':>9}  status")
    print("-" * 70)
    for r in runs[-30:]:
        print(f"{r['snapshot_id']:<26} {r.get('scopes',''):<8} "
              f"{r.get('resources',0):>10} {r.get('findings',0):>9}  {r.get('status','')}")
    return 0


def cmd_pending() -> int:
    rows = read_jsonl(FIND_FILE)
    pend = [r for r in rows if r.get("state") == "pending"]
    if not pend:
        print("未処理の更新対象はありません。")
        return 0
    print(f"未処理 {len(pend)} 件\n")
    show_findings(pend)
    return 0


# ---------------------------------------------------------------- 本体
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scope", default=None)
    ap.add_argument("--dry-run", action="store_true", help="記録せず判定だけ")
    ap.add_argument("--list", action="store_true", help="実行履歴")
    ap.add_argument("--pending", action="store_true", help="未処理の更新対象")
    args = ap.parse_args()

    if args.list:
        return cmd_list()
    if args.pending:
        return cmd_pending()

    if args.scope and args.scope not in SCOPES:
        print(f"未知のスコープ: {args.scope}", file=sys.stderr)
        return 1

    targets = ({args.scope: SCOPES[args.scope]} if args.scope
               else {k: v for k, v in SCOPES.items() if v.get("enabled")})

    if not args.scope:
        for k, v in SCOPES.items():
            if not v.get("enabled"):
                print(f"── {k} はスキップ（無効）")

    snapshot_id = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"snapshot_id: {snapshot_id}\n")

    all_obs, all_find, all_err = [], [], []
    for scope_id, cfg in targets.items():
        r = check_scope(scope_id, cfg, snapshot_id)
        all_obs.extend(r["observations"])
        all_find.extend(r["findings"])
        all_err.extend(r["errors"])
        print()

    print("=" * 62)
    counts = Counter(f["verdict"] for f in all_find)
    print(f"  観測 {len(all_obs)} 件")
    if all_find:
        for k in ("NEW", "MODIFIED", "GONE"):
            if counts.get(k):
                print(f"  {k:10} {counts[k]:4}")
    else:
        print("  更新対象なし")
    print("=" * 62)

    if all_find:
        print("\n■ 更新対象")
        show_findings(all_find)

    if not args.dry_run:
        append_jsonl(OBS_FILE, all_obs)
        if all_find:
            append_jsonl(FIND_FILE, all_find)
        append_jsonl(RUNS_FILE, [{
            "snapshot_id": snapshot_id,
            "scopes": ",".join(targets.keys()),
            "packages": sum(len(SCOPES[s]["packages"]) for s in targets),
            "resources": len(all_obs),
            "findings": len(all_find),
            "status": "error" if all_err else "ok",
            "errors": all_err or None,
            "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }])
        print(f"\n記録しました: {OBS_FILE} ({len(all_obs)} 行) "
              f"/ {FIND_FILE} ({len(all_find)} 行)")
    else:
        print("\n(dry-run: 記録していません)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
