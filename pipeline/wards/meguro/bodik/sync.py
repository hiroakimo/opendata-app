r"""
BODIK (CKAN) -> Cloudflare R2 同期

対象データセットのリソース一覧を CKAN から取得し、前回の状態（マニフェスト）と
突き合わせて 追加 / 変更 / 削除 を検知する。生ファイルはバイト単位で無改変のまま
R2 の raw/{sha256} に置く。内容が変わると別キーになるため、過去分は自動的に残る。

使い方 (PowerShell):
    python pipeline/wards/meguro/bodik/sync.py --list                # CKANのリソース一覧を出すだけ
    python pipeline/wards/meguro/bodik/sync.py --limit 5 --dry-run   # 少数で動作確認
    python pipeline/wards/meguro/bodik/sync.py                       # 実行
    python pipeline/wards/meguro/bodik/sync.py --report              # 変更履歴と欠落（ネットワーク不要）
    python pipeline/wards/meguro/bodik/sync.py --keep-local work\meguro\bodik\src # 生ファイルのローカル控えも残す

環境変数:
    R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY

前提:
    pip install requests boto3

判定の考え方:
    同一性は CKAN の resource_id で見る（ファイル名や年月ではない）。
      - マニフェストに無い resource_id     -> NEW
      - あるが sha256 が変わった           -> UPDATED（前回分は supersedes で連結）
      - あって sha256 が同じ               -> UNCHANGED
      - マニフェストにあるが CKAN に無い   -> MISSING（削除。エラー扱い）

    ダウンロードを減らすため、判定は3段階に分ける。
      1. CKAN の last_modified が前回と同じ -> 取得せずスキップ（--force で無効化）
      2. HTTP の ETag / Last-Modified で条件付きGET -> 304 なら本体を落とさない
      3. 実際に落ちてきたバイト列の sha256 で最終判定

配信元への負荷:
    リクエスト間隔は --sleep（既定 1.5 秒）で空ける。dry-run でも同じだけ空ける。
    403 / 429 / 5xx は指数バックオフで再試行し、それでも駄目なら FAILED とする。
    一度ブロックされると数分〜数十分は解除されないことがあるため、
    連続失敗が続いたら中断して時間を置くこと。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

CKAN_PACKAGE_SHOW = "https://data.bodik.jp/api/3/action/package_show"
BUCKET = "opendata-lake"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
TIMEOUT = 180
MAX_RETRY = 4
RETRYABLE = {403, 429, 500, 502, 503, 504}

# ファイル名に現れうる粒度トークン。増えたらここに足す。
KNOWN_GRAINS = {"1y", "5y", "3c"}

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def log(msg: str = "") -> None:
    print(msg, flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------- 設定

def load_datasets(path: Path) -> list[str]:
    if not path.exists():
        sys.exit(f"データセット設定ファイルがありません: {path}")
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.split("#", 1)[0].strip()
        if s:
            out.append(s)
    if not out:
        sys.exit(f"対象データセットが1件も書かれていません: {path}")
    return out


# ---------------------------------------------------------------- ファイル名解析

def parse_filename(name: str) -> dict:
    """ファイル名から素性を読む。読めなくても取り込みは止めない。"""
    base = {"muni_code": None, "domain": None, "granularity": None,
            "granularity_source": None, "reference_date": None,
            "extension": None, "parse_status": "unparsed"}

    stem, dot, ext = name.rpartition(".")
    if not dot:
        return base
    base["extension"] = ext.lower()

    parts = stem.split("_")
    if len(parts) < 3:
        return base

    muni_code, domain, ref_raw = parts[0], parts[1], parts[-1]
    middle = "_".join(parts[2:-1])

    if not (muni_code.isdigit() and len(muni_code) == 6):
        return base
    try:
        ref_date = datetime.strptime(ref_raw, "%Y%m%d").date().isoformat()
    except ValueError:
        return base

    if middle in KNOWN_GRAINS:
        grain, grain_src = middle, "filename"
    else:
        grain, grain_src = None, "unknown"

    base.update(muni_code=muni_code, domain=domain, granularity=grain,
                granularity_source=grain_src, reference_date=ref_date,
                parse_status="ok")
    return base


# ---------------------------------------------------------------- マニフェスト

def load_manifest(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def append_manifest(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def latest_by_resource(manifest: list[dict]) -> dict[str, dict]:
    """resource_id ごとに最後のレコードを返す（JSONLは追記順＝時系列）。"""
    out: dict[str, dict] = {}
    for r in manifest:
        rid = r.get("resource_id")
        if rid:
            out[rid] = r
    return out


# ---------------------------------------------------------------- CKAN

def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept": "*/*"})
    return s


def ckan_package_show(session: requests.Session, dataset: str) -> dict:
    last = None
    for i in range(1, MAX_RETRY + 1):
        try:
            r = session.get(CKAN_PACKAGE_SHOW, params={"id": dataset}, timeout=TIMEOUT)
            r.raise_for_status()
            d = r.json()
            if not d.get("success"):
                raise RuntimeError(f"CKAN success=false: {d.get('error')}")
            return d["result"]
        except Exception as e:  # noqa: BLE001
            last = e
            wait = 3 * 2 ** i
            log(f"    [リトライ {i}/{MAX_RETRY}] {e} -> {wait}秒待機")
            time.sleep(wait)
    raise RuntimeError(f"CKAN取得に失敗 ({dataset}): {last}")


def collect_resources(session: requests.Session, datasets: list[str]) -> list[dict]:
    entries: list[dict] = []
    for ds in datasets:
        log(f"■ データセット照会: {ds}")
        result = ckan_package_show(session, ds)
        resources = result.get("resources", [])
        log(f"    {result.get('title', '')}  (リソース {len(resources)} 件)")
        for res in resources:
            url = res.get("url")
            if not url:
                continue
            entries.append({
                "dataset": ds,
                "resource_id": res.get("id"),
                "resource_name": res.get("name") or "",
                "filename": url.rsplit("/", 1)[-1],
                "url": url,
                "format": str(res.get("format", "")).upper(),
                "size": res.get("size"),
                "source_last_modified": res.get("last_modified") or res.get("created"),
            })
        time.sleep(1.0)
    return entries


# ---------------------------------------------------------------- R2

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


ASCII_RE = re.compile(r"[^\x20-\x7e]")


def ascii_meta(v) -> str:
    """R2のユーザーメタデータはASCIIのみ。非ASCIIは落とす。"""
    return ASCII_RE.sub("", str(v or ""))[:512]


def object_exists(s3, key: str) -> bool:
    from botocore.exceptions import ClientError
    try:
        s3.head_object(Bucket=BUCKET, Key=key)
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


def upload(s3, key: str, data: bytes, entry: dict, meta: dict, digest: str) -> None:
    ctype = mimetypes.guess_type(entry["filename"])[0] or "application/octet-stream"
    s3.put_object(
        Bucket=BUCKET, Key=key, Body=data, ContentType=ctype,
        Metadata={
            "dataset": ascii_meta(entry["dataset"]),
            "resource-id": ascii_meta(entry["resource_id"]),
            "original-filename": ascii_meta(entry["filename"]),
            "muni-code": ascii_meta(meta.get("muni_code")),
            "granularity": ascii_meta(meta.get("granularity")),
            "reference-date": ascii_meta(meta.get("reference_date")),
            "sha256": digest,
        },
    )


# ---------------------------------------------------------------- 取得

def fetch(session: requests.Session, entry: dict, prev: dict | None,
          force: bool, sleep_sec: float) -> tuple[bytes | None, dict]:
    """条件付きGET + 指数バックオフ。304なら (None, info) を返す。"""
    headers = {}
    if prev and not force:
        if prev.get("http_etag"):
            headers["If-None-Match"] = prev["http_etag"]
        elif prev.get("http_last_modified"):
            headers["If-Modified-Since"] = prev["http_last_modified"]

    last_err = None
    for i in range(1, MAX_RETRY + 1):
        r = session.get(entry["url"], headers=headers, timeout=TIMEOUT)
        info = {"http_status": r.status_code,
                "http_etag": r.headers.get("ETag"),
                "http_last_modified": r.headers.get("Last-Modified")}

        if r.status_code == 304:
            return None, info
        if r.status_code == 200:
            return r.content, info

        last_err = f"{r.status_code} {r.reason}"
        if r.status_code not in RETRYABLE:
            break
        wait = max(sleep_sec, 5) * (2 ** i)   # 10, 20, 40, 80 秒
        log(f"    [{r.status_code}] 待機 {wait:.0f} 秒後に再試行 ({i}/{MAX_RETRY})")
        time.sleep(wait)

    raise RuntimeError(last_err or "取得失敗")


# ---------------------------------------------------------------- レポート

def do_report(manifest_path: Path) -> None:
    manifest = load_manifest(manifest_path)
    if not manifest:
        log(f"マニフェストが空です: {manifest_path}")
        return

    chains: dict[str, list[dict]] = {}
    for r in manifest:
        chains.setdefault(r.get("resource_id"), []).append(r)

    changed = {k: v for k, v in chains.items()
               if len([x for x in v if x.get("status") in ("new", "updated")]) > 1}
    missing = {k: v for k, v in chains.items() if v[-1].get("status") == "missing"}

    log(f"■ マニフェスト: {manifest_path}  ({len(manifest)} 行 / {len(chains)} リソース)")

    log(f"\n■ 変更履歴のあるリソース: {len(changed)} 件")
    for rid, recs in sorted(changed.items(),
                            key=lambda kv: kv[1][-1].get("source_file") or ""):
        log(f"  {recs[-1].get('source_file')}  ({rid})")
        for r in recs:
            if r.get("status") == "unchanged":
                continue
            sha = (r.get("sha256") or "-")[:12]
            log(f"      {r.get('checked_at')}  {str(r.get('status')):9} {sha}  "
                f"{r.get('content_bytes') or '-'} bytes")

    log(f"\n■ 取得できなくなったリソース: {len(missing)} 件")
    for rid, recs in sorted(missing.items(),
                            key=lambda kv: kv[1][-1].get("source_file") or ""):
        last_ok = next((r for r in reversed(recs) if r.get("sha256")), None)
        log(f"  [削除] {recs[-1].get('source_file')}  ({rid})")
        log(f"         検知: {recs[-1].get('checked_at')}  "
            f"最終取得: {last_ok.get('checked_at') if last_ok else '不明'}")


# ---------------------------------------------------------------- 本体

def main() -> int:
    ap = argparse.ArgumentParser(description="BODIK -> R2 同期")
    ap.add_argument("--datasets-file", default="pipeline/wards/meguro/bodik/datasets.txt")
    ap.add_argument("--manifest", default="work/meguro/bodik/manifest/bodik.jsonl")
    ap.add_argument("--list", action="store_true", dest="do_list")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true",
                    help="last_modified と条件付きGETを無視して全件取得する")
    ap.add_argument("--limit", type=int, default=0,
                    help="処理するリソース数の上限（0で無制限）。動作確認用")
    ap.add_argument("--sleep", type=float, default=1.5,
                    help="リクエスト間隔（秒）。配信元への負荷を抑える")
    ap.add_argument("--keep-local", default=None,
                    help="生ファイルのローカル控えを置くディレクトリ")
    args = ap.parse_args()

    manifest_path = Path(args.manifest)

    if args.report:
        do_report(manifest_path)
        return 0

    datasets = load_datasets(Path(args.datasets_file))
    session = make_session()
    entries = collect_resources(session, datasets)
    entries.sort(key=lambda x: (x["dataset"], x["filename"]))
    log(f"■ 全リソース {len(entries)} 件 / データセット {len(datasets)} 本\n")

    if args.do_list:
        for e in entries:
            size = f"{e['size']:,}B" if isinstance(e["size"], int) else "-"
            log(f"  {e['dataset'][:28]:28} {e['format']:<5} {size:>12}  {e['filename']}")
        return 0

    manifest = load_manifest(manifest_path)
    prev_by_rid = latest_by_resource(manifest)
    known_digests = {r["sha256"] for r in manifest if r.get("sha256")}

    s3 = None if args.dry_run else make_client()
    local_dir = Path(args.keep_local) if args.keep_local else None
    if local_dir and not args.dry_run:
        local_dir.mkdir(parents=True, exist_ok=True)

    counts = {"new": 0, "updated": 0, "unchanged": 0, "missing": 0, "failed": 0}
    seen_rids: set[str] = set()
    consecutive_failures = 0
    processed = 0

    for entry in entries:
        rid = entry["resource_id"]
        seen_rids.add(rid)
        prev = prev_by_rid.get(rid)

        # ---- 第1段: CKANの last_modified が同じならネットワークに出ない ----
        if (prev and not args.force
                and prev.get("sha256")
                and prev.get("source_last_modified")
                and prev["source_last_modified"] == entry["source_last_modified"]):
            log(f"UNCHANGED {entry['filename']}  [last_modified 同一・未取得]")
            counts["unchanged"] += 1
            continue

        if args.limit and processed >= args.limit:
            log(f"（--limit {args.limit} に達したため以降を打ち切り。"
                f"削除判定はスキップします）")
            return 0
        processed += 1

        meta = parse_filename(entry["filename"])

        try:
            data, http = fetch(session, entry, prev, args.force, args.sleep)
            consecutive_failures = 0
        except Exception as ex:  # noqa: BLE001
            log(f"FAILED    {entry['filename']}  ({ex})")
            counts["failed"] += 1
            consecutive_failures += 1
            if consecutive_failures >= 5:
                log("\n※ 連続5件失敗しました。配信元にブロックされている可能性が高いため中断します。")
                log("  時間を置いてから再実行してください。取得済みの分は記録されています。")
                return 2
            time.sleep(args.sleep)
            continue

        time.sleep(args.sleep)   # dry-run でも必ず空ける

        if data is None:                      # 304 Not Modified
            status = "unchanged"
            digest, size = prev.get("sha256"), prev.get("content_bytes")
        else:
            digest = hashlib.sha256(data).hexdigest()
            size = len(data)
            if prev is None:
                status = "new"
            elif prev.get("sha256") == digest:
                status = "unchanged"
            else:
                status = "updated"

        note = ""
        if meta["parse_status"] != "ok":
            note += "  [ファイル名を解析できず]"
        elif meta["granularity_source"] == "unknown":
            note += "  [粒度不明]"
        if status == "updated":
            note += f"  [前回 {(prev.get('sha256') or '')[:12]}...]"

        log(f"{status.upper():9} {entry['filename']}  "
            f"{size if size is not None else '-'} bytes  {(digest or '-')[:12]}...{note}")

        if status == "unchanged":
            counts["unchanged"] += 1
            continue
        if args.dry_run:
            counts[status] += 1
            continue

        key = f"raw/{digest}"
        if digest not in known_digests and not object_exists(s3, key):
            upload(s3, key, data, entry, meta, digest)
        if local_dir:
            (local_dir / entry["filename"]).write_bytes(data)

        record = {
            "dataset": entry["dataset"],
            "resource_id": rid,
            "resource_name": entry["resource_name"],
            "source_file": entry["filename"],
            "url": entry["url"],
            "format": entry["format"],
            **meta,
            "sha256": digest,
            "content_bytes": size,
            "r2_key": key,
            "source_last_modified": entry["source_last_modified"],
            "http_etag": http.get("http_etag"),
            "http_last_modified": http.get("http_last_modified"),
            "status": status,
            "checked_at": now_iso(),
            "supersedes": prev.get("sha256") if prev else None,
        }
        append_manifest(manifest_path, record)
        known_digests.add(digest)
        prev_by_rid[rid] = record
        counts[status] += 1

    # ---- 削除の検知: 前回あって今回 CKAN に無い resource_id ----
    for rid, prev in list(prev_by_rid.items()):
        if rid in seen_rids or prev.get("status") == "missing":
            continue
        log(f"MISSING   {prev.get('source_file')}  "
            f"[CKANのリソース一覧から消滅]  ({prev.get('dataset')})")
        counts["missing"] += 1
        if args.dry_run:
            continue
        append_manifest(manifest_path, {
            "dataset": prev.get("dataset"),
            "resource_id": rid,
            "resource_name": prev.get("resource_name"),
            "source_file": prev.get("source_file"),
            "url": prev.get("url"),
            "sha256": None, "content_bytes": None, "r2_key": None,
            "status": "missing",
            "checked_at": now_iso(),
            "supersedes": prev.get("sha256"),
            "note": "CKANのリソース一覧に存在しない",
        })

    log("\n" + "  ".join(f"{k}={v}" for k, v in counts.items()))
    if args.dry_run:
        log("(dry-run: R2にもマニフェストにも書いていません)")
    if counts["missing"] or counts["failed"]:
        log("※ MISSING / FAILED があります。--report で詳細を確認してください。")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
