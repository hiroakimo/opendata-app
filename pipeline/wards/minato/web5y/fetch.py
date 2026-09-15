#!/usr/bin/env python3
"""
港区「町丁別年齢5歳階級別人口表」の取得（区ホームページ）

- 一覧ページを取得して保存し、PDF / Excel(.xlsb) へのリンクを順に取得する。
- 取得ファイルは work/minato/web5y/fetch/raw/{sha256} に保存（2回目以降は再利用）。
- 読み取りのみ。D1 / R2 には書き込まない。

使い方:
  python pipeline/wards/minato/web5y/fetch.py
出力:
  work/minato/web5y/fetch/page_{stamp}.html
  work/minato/web5y/fetch/manifest.json
"""
import hashlib
import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PAGE_URL = ("https://www.city.minato.tokyo.jp/toukeichousa/kuse/toke/jinko/"
            "chocho/nenrei/20220401.html")
UA = "machinome-fetch/0.1 (+https://github.com/hiroakimo/opendata-app)"
OUT = Path("work/minato/web5y/fetch")
RAW = OUT / "raw"
WAIT_SEC = 2.0

LINK = re.compile(r'<a[^>]+href="([^"]+\.(?:pdf|xlsb|xlsx|xls))"[^>]*>(.*?)</a>', re.I | re.S)
WAREKI = re.compile(r"(令和|平成)(元|\d+)年(\d+)月(\d+)日")
ERA = {"令和": 2018, "平成": 1988}


def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(), dict(r.headers)


def wareki_to_iso(text):
    m = WAREKI.search(unicodedata.normalize("NFKC", text))
    if not m:
        return None
    y = ERA[m.group(1)] + (1 if m.group(2) == "元" else int(m.group(2)))
    return f"{y:04d}-{int(m.group(3)):02d}-{int(m.group(4)):02d}"


def extract_links(html, base):
    out = []
    for href, label in LINK.findall(html):
        label = re.sub(r"<[^>]+>", "", label).strip()
        url = urllib.parse.urljoin(base, href)
        out.append({"url": url, "label": label, "asof": wareki_to_iso(label),
                    "format": url.rsplit(".", 1)[-1].lower()})
    return out


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    body, _ = http_get(PAGE_URL)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    (OUT / f"page_{stamp}.html").write_bytes(body)
    html = body.decode("utf-8", errors="replace")
    links = extract_links(html, PAGE_URL)
    if not links:
        sys.exit("中止: ファイルへのリンクが見つからない（ページ構成が変わった可能性）")
    bad = [l for l in links if not l["asof"]]
    if bad:
        sys.exit(f"中止: リンク文字列から基準日を読めない: {bad}")
    dup = {l["asof"] for l in links if sum(x["asof"] == l["asof"] for x in links) > 1}
    if dup:
        sys.exit(f"中止: 同じ基準日のリンクが複数ある: {sorted(dup)}")

    files = []
    for l in sorted(links, key=lambda x: x["asof"]):
        time.sleep(WAIT_SEC)
        data, headers = http_get(l["url"])
        sha = hashlib.sha256(data).hexdigest()
        if not (RAW / sha).exists():
            (RAW / sha).write_bytes(data)
        files.append(dict(l, sha256=sha, bytes=len(data),
                          http_last_modified=headers.get("Last-Modified"),
                          http_content_type=headers.get("Content-Type")))
        print(f"  取得 {l['asof']} {l['format']:5} {len(data):>8} bytes  {sha[:12]}")

    (OUT / "manifest.json").write_text(json.dumps(
        {"page_url": PAGE_URL, "page_file": f"page_{stamp}.html",
         "fetched_at": stamp, "files": files}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n完了: {len(files)}件 → {OUT / 'manifest.json'}")


if __name__ == "__main__":
    main()
