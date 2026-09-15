"""
BODIK 上流の現在状態を取得し、手元の記録と照合して差分を一覧化する。

読み取り専用。R2 にも D1 にも書き込まない。
CSV 本体のダウンロードは、差分が疑われるリソースに限定する。

使い方:
    python check_upstream.py
    python check_upstream.py --manifest ..\opendata_sync\manifest\bodik.jsonl
    python check_upstream.py --no-download      # SHA256 照合を省略（API 情報のみで判定）
    python check_upstream.py --out report.json  # 判定結果を JSON で保存

判定区分:
    NEW        上流にあるが manifest に無い          → 取り込み候補
    MODIFIED   last_modified が変わり、中身も変わった → 取り込み候補
    TOUCHED    last_modified は変わったが中身は同一   → 対象外（メタ編集など）
    UNCHANGED  変化なし
    GONE       manifest にあるが上流に無い           → 取り下げの可能性
"""

import argparse
import hashlib
import json
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

API = "https://data.bodik.jp/api/3/action/package_show?id="

PACKAGES = [
    "131105_population_by_town_section_age_gender_and_number_of_households_by_town_section",
    "131105_population_by_town_section_age_gender_and_number_of_households_by_town_section2",
    "131105_population_by_town_section_age_gender_and_number_of_households_by_town_section3",
    "131105_population_by_town_section_age_gender_and_number_of_households_by_town_section4",
    "131105_saishinjinko",
]

UA = {"User-Agent": "machinome-upstream-check/1.0 (+opendata monitoring)"}


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def fetch_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def load_manifest(path: Path) -> dict:
    """resource_id -> 最新レコード。同一 id が複数行あれば checked_at が新しい方を採る。"""
    latest = {}
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            rid = r.get("resource_id")
            if not rid:
                continue
            prev = latest.get(rid)
            if prev is None or (r.get("checked_at") or "") >= (prev.get("checked_at") or ""):
                latest[rid] = r
    return latest


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest",
                    default=r"..\opendata_sync\manifest\bodik.jsonl")
    ap.add_argument("--no-download", action="store_true",
                    help="CSV を取得せず、API の申告値だけで判定する")
    ap.add_argument("--out", default=None, help="判定結果を JSON で保存する")
    ap.add_argument("--sleep", type=float, default=0.5,
                    help="ダウンロード間隔の秒数（上流への配慮）")
    args = ap.parse_args()

    mpath = Path(args.manifest)
    if not mpath.exists():
        print(f"manifest が見つかりません: {mpath}", file=sys.stderr)
        return 1

    known = load_manifest(mpath)
    print(f"manifest: {mpath}  ({len(known)} リソース)")
    print()

    seen_ids = set()
    findings = []

    for pkg in PACKAGES:
        try:
            data = fetch_json(API + pkg)
        except Exception as e:
            print(f"[ERROR] {pkg}: {e}", file=sys.stderr)
            continue

        resources = data["result"]["resources"]
        print(f"── {pkg}")
        print(f"   上流 {len(resources)} 件 / 手元 "
              f"{sum(1 for r in known.values() if r.get('dataset') == pkg)} 件")

        for res in resources:
            rid = res["id"]
            seen_ids.add(rid)
            prev = known.get(rid)

            up_lm = res.get("last_modified") or res.get("metadata_modified")
            lm_src = "last_modified" if res.get("last_modified") else "metadata_modified"

            rec = {
                "dataset": pkg,
                "resource_id": rid,
                "source_file": res["url"].rsplit("/", 1)[-1],
                "url": res["url"],
                "format": res.get("format"),
                "upstream_last_modified": up_lm,
                "modified_source": lm_src,
                "prev_last_modified": prev.get("source_last_modified") if prev else None,
                "prev_sha256": prev.get("sha256") if prev else None,
                "prev_reference_date": prev.get("reference_date") if prev else None,
                "sha256": None,
                "content_bytes": None,
                "verdict": None,
            }

            if prev is None:
                rec["verdict"] = "NEW"
            elif up_lm == prev.get("source_last_modified"):
                rec["verdict"] = "UNCHANGED"
            else:
                rec["verdict"] = "CHANGED?"     # 中身を見て確定させる

            findings.append(rec)

        print()

    # 上流から消えたもの
    for rid, prev in known.items():
        if rid not in seen_ids:
            findings.append({
                "dataset": prev.get("dataset"),
                "resource_id": rid,
                "source_file": prev.get("source_file"),
                "url": prev.get("url"),
                "format": None,
                "upstream_last_modified": None,
                "modified_source": None,
                "prev_last_modified": prev.get("source_last_modified"),
                "prev_sha256": prev.get("sha256"),
                "prev_reference_date": prev.get("reference_date"),
                "sha256": None,
                "content_bytes": None,
                "verdict": "GONE",
            })

    # ── 中身の確認が要るものだけダウンロードする
    targets = [f for f in findings if f["verdict"] in ("NEW", "CHANGED?")]
    if targets and not args.no_download:
        print(f"── 中身の確認 ({len(targets)} 件)")
        for i, f in enumerate(targets, 1):
            try:
                b = fetch_bytes(f["url"])
            except Exception as e:
                f["verdict"] = "FETCH_ERROR"
                f["error"] = str(e)
                print(f"   [{i}/{len(targets)}] ERROR {f['source_file']}: {e}")
                continue
            f["sha256"] = hashlib.sha256(b).hexdigest()
            f["content_bytes"] = len(b)
            if f["verdict"] == "CHANGED?":
                f["verdict"] = "TOUCHED" if f["sha256"] == f["prev_sha256"] else "MODIFIED"
            print(f"   [{i}/{len(targets)}] {f['verdict']:9} {f['source_file']}  "
                  f"{f['content_bytes']:,} bytes  {f['sha256'][:12]}…")
            time.sleep(args.sleep)
        print()
    elif targets:
        for f in targets:
            if f["verdict"] == "CHANGED?":
                f["verdict"] = "MODIFIED?"      # 未確認のまま

    # ── まとめ
    print("=" * 62)
    counts = Counter(f["verdict"] for f in findings)
    for k in ("NEW", "MODIFIED", "TOUCHED", "UNCHANGED", "GONE",
              "MODIFIED?", "FETCH_ERROR"):
        if counts.get(k):
            print(f"  {k:12} {counts[k]:4}")
    print("=" * 62)
    print()

    actionable = [f for f in findings
                  if f["verdict"] in ("NEW", "MODIFIED", "MODIFIED?", "GONE", "FETCH_ERROR")]
    if not actionable:
        print("取り込み候補はありません。上流に変化なし。")
    else:
        print("■ 要判定")
        by_ds = defaultdict(list)
        for f in actionable:
            by_ds[f["dataset"]].append(f)
        for ds, items in by_ds.items():
            print(f"\n  {ds}")
            for f in sorted(items, key=lambda x: x["source_file"] or ""):
                print(f"    {f['verdict']:11} {f['source_file']}")
                print(f"      resource_id : {f['resource_id']}")
                print(f"      上流更新    : {f['upstream_last_modified']}"
                      f"  ({f['modified_source']})")
                if f["prev_last_modified"]:
                    print(f"      手元の記録  : {f['prev_last_modified']}")
                if f["sha256"]:
                    print(f"      sha256      : {f['sha256']}"
                          f"  ({f['content_bytes']:,} bytes)")
                if f.get("prev_sha256") and f["verdict"] in ("MODIFIED", "TOUCHED"):
                    print(f"      前回        : {f['prev_sha256']}")
                if f.get("error"):
                    print(f"      error       : {f['error']}")

    if args.out:
        Path(args.out).write_text(
            json.dumps(findings, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n判定結果を書き出しました: {args.out}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
