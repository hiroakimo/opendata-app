#!/usr/bin/env python3
"""
港区オープンデータカタログ（独自CKAN）
「港区の町丁目別人口・世帯数（住民基本台帳に基づく）」全年ファイルの内容確認。

- 読み取り専用。D1 / R2 には書き込まない。
- package_show の応答をそのまま保存する（raw_json）。
- 取得したファイルは work/minato/ckan/survey/raw/{sha256} に保存し、2回目以降は再利用する。
- --offline で前回取得分だけを使って再集計する（通信なし）。

使い方:
  python pipeline/wards/minato/ckan/survey.py            # 取得＋集計
  python pipeline/wards/minato/ckan/survey.py --offline  # 保存済みファイルで再集計
出力:
  work/minato/ckan/survey/report.md       # 人が読む調査結果
  work/minato/ckan/survey/resources.csv   # リソース単位の一覧
"""
import argparse
import csv
import hashlib
import io
import json
import re
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

PACKAGE_URL = ("https://opendata.city.minato.tokyo.jp/api/3/action/"
               "package_show?id=jinko-chochomokubetsu")
UA = "machinome-survey/0.1 (+https://github.com/hiroakimo/opendata-app)"
OUT = Path("work/minato/ckan/survey")
RAW = OUT / "raw"
MANIFEST = OUT / "manifest.json"
WAIT_SEC = 2.0  # 公開サーバーへの負荷を避けるため、1件ずつ間隔をあけて取得

ROLES = [("date", "年月日"), ("area", "地区"), ("town", "町丁"),
         ("hh", "世帯"), ("male", "男"), ("female", "女"), ("total", ("合計", "総数"))]
NUM_ROLES = ["hh", "male", "female", "total"]


# ---------------------------------------------------------------- 取得
def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(), dict(r.headers)


def fetch_all():
    RAW.mkdir(parents=True, exist_ok=True)
    body, _ = http_get(PACKAGE_URL)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    (OUT / f"package_{stamp}.json").write_bytes(body)
    pkg = json.loads(body)["result"]

    manifest = {"fetched_at": stamp, "package_file": f"package_{stamp}.json",
                "resources": {}}
    for res in pkg["resources"]:
        time.sleep(WAIT_SEC)
        data, headers = http_get(res["url"])
        sha = hashlib.sha256(data).hexdigest()
        path = RAW / sha
        if not path.exists():
            path.write_bytes(data)
        manifest["resources"][res["id"]] = {
            "sha256": sha, "bytes": len(data),
            "http_last_modified": headers.get("Last-Modified"),
            "http_content_type": headers.get("Content-Type"),
        }
        print(f"  取得 {res['name']}  {len(data):>8} bytes  {sha[:12]}")
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2),
                        encoding="utf-8")
    return pkg, manifest


def load_offline():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    pkg = json.loads((OUT / manifest["package_file"]).read_bytes())["result"]
    return pkg, manifest


# ---------------------------------------------------------------- 解析
def decode(b):
    bom = b.startswith(b"\xef\xbb\xbf")
    for enc, label in (("utf-8-sig", "utf-8"), ("cp932", "cp932")):
        try:
            return b.decode(enc), label, bom
        except UnicodeDecodeError:
            pass
    return b.decode("utf-8", errors="replace"), "不明", bom


def find_cols(header):
    cols, problems = {}, []
    for role, key in ROLES:
        keys = key if isinstance(key, tuple) else (key,)
        hits = [i for i, h in enumerate(header) if any(k in h for k in keys)]
        if len(hits) == 1:
            cols[role] = hits[0]
        else:
            problems.append(f"{role}({key}): 該当{len(hits)}列")
    return cols, problems


def to_int(s):
    s = s.strip()
    return int(s) if re.fullmatch(r"-?\d+", s) else None


def analyze(data):
    text, enc, bom = decode(data)
    r = {"encoding": enc, "bom": bom,
         "newline": "CRLF" if "\r\n" in text else "LF",
         "preamble": [], "header": None, "col_problems": [],
         "n_data": 0, "blank_rows": 0, "odd_rows": [],
         "dates": Counter(), "towns_by_date": defaultdict(set),
         "areas_by_town": defaultdict(set), "dup_keys": [],
         "non_int": [], "sum_ng": [], "zero_rows": [], "negative": []}

    rows = list(csv.reader(io.StringIO(text)))
    hi = next((i for i, row in enumerate(rows)
               if any("町丁" in c for c in row)), None)
    if hi is None:
        r["col_problems"].append("ヘッダー行（町丁を含む行）が見つからない")
        return r
    r["preamble"] = rows[:hi]
    header = [c.strip() for c in rows[hi]]
    r["header"] = header
    cols, r["col_problems"] = find_cols(header)
    if "date" not in cols or "town" not in cols:
        return r

    seen = set()
    for ln, row in enumerate(rows[hi + 1:], start=hi + 2):
        if not any(c.strip() for c in row):
            r["blank_rows"] += 1
            continue
        d = row[cols["date"]].strip() if len(row) > cols["date"] else ""
        if len(row) != len(header) or not re.fullmatch(r"\d{8}", d):
            r["odd_rows"].append((ln, row))
            continue
        town = row[cols["town"]].strip()
        r["n_data"] += 1
        r["dates"][d] += 1
        r["towns_by_date"][d].add(town)
        if "area" in cols:
            r["areas_by_town"][town].add(row[cols["area"]].strip())
        if (d, town) in seen:
            r["dup_keys"].append((ln, d, town))
        seen.add((d, town))

        v = {}
        for role in NUM_ROLES:
            if role in cols:
                x = to_int(row[cols[role]])
                if x is None:
                    r["non_int"].append((ln, role, row[cols[role]]))
                else:
                    v[role] = x
                    if x < 0:
                        r["negative"].append((ln, role, x))
        if all(k in v for k in ("male", "female", "total")):
            if v["male"] + v["female"] != v["total"]:
                r["sum_ng"].append((ln, d, town, v["male"], v["female"], v["total"]))
            if v["total"] == 0:
                r["zero_rows"].append((d, town))
    return r


def month_seq(first, last):
    y, m = int(first[:4]), int(first[4:6])
    out = []
    while f"{y:04d}{m:02d}" <= last[:6]:
        out.append(f"{y:04d}{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


# ---------------------------------------------------------------- 報告
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    pkg, manifest = load_offline() if args.offline else fetch_all()

    L = []
    L.append("# 港区 町丁目別人口・世帯数 調査結果\n")
    L.append(f"- package: `{pkg['name']}` / id `{pkg['id']}`")
    L.append(f"- metadata_modified: {pkg.get('metadata_modified')}")
    L.append(f"- 取得: {manifest['fetched_at']} / リソース数: {len(pkg['resources'])}")
    names = Counter(r["name"] for r in pkg["resources"])
    dups = {n: c for n, c in names.items() if c > 1}
    L.append(f"- 同名リソース: {dups if dups else 'なし'}\n")

    header_groups = defaultdict(list)
    month_files = defaultdict(list)
    towns_by_date = {}
    rows_csv = []

    L.append("## ファイル別\n")
    for res in pkg["resources"]:
        m = manifest["resources"][res["id"]]
        data = (RAW / m["sha256"]).read_bytes()
        a = analyze(data)
        name = res["name"]
        fname = res["url"].rsplit("/", 1)[-1]
        dates = sorted(a["dates"])
        name_year = (re.search(r"(\d{4})年", name) or [None, None])[1]
        years_in = sorted({d[:4] for d in dates})
        per_date = sorted(set(a["dates"].values()))

        header_groups[tuple(a["header"] or ["(なし)"])].append(fname)
        for d in dates:
            month_files[d[:6]].append(fname)
            towns_by_date[d] = a["towns_by_date"][d]

        multi_area = {t: s for t, s in a["areas_by_town"].items() if len(s) > 1}
        L.append(f"### {name}  (`{fname}`)")
        L.append(f"- last_modified: {res.get('last_modified')} / created: {res.get('created')}"
                 f" / HTTP Last-Modified: {m['http_last_modified']}")
        L.append(f"- CKAN size/hash: {res.get('size')} / {res.get('hash') or '-'}"
                 f"  実バイト: {m['bytes']}  sha256: {m['sha256'][:16]}")
        L.append(f"- 文字コード: {a['encoding']}  BOM: {a['bom']}  改行: {a['newline']}")
        if a["preamble"]:
            L.append(f"- ヘッダー前の行: {a['preamble']}")
        if a["col_problems"]:
            L.append(f"- **列特定の問題**: {a['col_problems']}")
        L.append(f"- データ行: {a['n_data']}  月数: {len(dates)}"
                 f"  範囲: {dates[0] if dates else '-'}〜{dates[-1] if dates else '-'}"
                 f"  1か月あたり行数: {per_date}")
        if name_year and years_in != [name_year]:
            L.append(f"- **リソース名の年({name_year})と中身の年{years_in}が不一致**")
        if a["odd_rows"]:
            L.append(f"- 形式外の行（トレーラー候補）: {a['odd_rows'][:5]}")
        for key, label in (("blank_rows", "空行"),):
            if a[key]:
                L.append(f"- {label}: {a[key]}")
        for key, label in (("dup_keys", "(年月日,町丁目)重複"), ("non_int", "非整数セル"),
                           ("sum_ng", "男+女≠合計"), ("negative", "負の値"),
                           ("zero_rows", "人口0の行")):
            if a[key]:
                L.append(f"- {label}: {len(a[key])}件 例 {a[key][:5]}")
        if multi_area:
            L.append(f"- **複数の地区に出る町丁目**: {multi_area}")
        L.append("")

        rows_csv.append({
            "name": name, "file": fname, "resource_id": res["id"],
            "last_modified": res.get("last_modified"), "created": res.get("created"),
            "http_last_modified": m["http_last_modified"], "bytes": m["bytes"],
            "sha256": m["sha256"], "encoding": a["encoding"], "bom": a["bom"],
            "newline": a["newline"], "header": "|".join(a["header"] or []),
            "n_data": a["n_data"], "n_months": len(dates),
            "first": dates[0] if dates else "", "last": dates[-1] if dates else "",
            "rows_per_month": "/".join(map(str, per_date)),
            "odd_rows": len(a["odd_rows"]), "sum_ng": len(a["sum_ng"]),
            "non_int": len(a["non_int"]), "dup_keys": len(a["dup_keys"]),
            "zero_rows": len(a["zero_rows"]),
        })

    L.append("## ヘッダーの種類\n")
    for h, files in header_groups.items():
        L.append(f"- `{','.join(h)}`\n  - {len(files)}件: {', '.join(sorted(files))}")
    L.append("")

    L.append("## 月の欠け・重複\n")
    if month_files:
        months = sorted(month_files)
        missing = [x for x in month_seq(months[0], months[-1]) if x not in month_files]
        multi = {k: v for k, v in month_files.items() if len(v) > 1}
        L.append(f"- 範囲: {months[0]}〜{months[-1]}（{len(months)}か月）")
        L.append(f"- 欠けている月: {missing if missing else 'なし'}")
        L.append(f"- 複数ファイルに出る月: {multi if multi else 'なし'}")
        days = Counter(d[6:] for d in towns_by_date)
        L.append(f"- 日付の日部分: {dict(days)}")
    L.append("")

    L.append("## 町丁目の出入り（前月との差）\n")
    prev_d, prev = None, None
    for d in sorted(towns_by_date):
        cur = towns_by_date[d]
        if prev is not None and cur != prev:
            L.append(f"- {prev_d} → {d}: 追加 {sorted(cur - prev)} / 消滅 {sorted(prev - cur)}")
        prev_d, prev = d, cur
    if towns_by_date:
        all_towns = set().union(*towns_by_date.values())
        L.append(f"\n- 通期で出現した町丁目: {len(all_towns)}")
        no_chome = sorted(t for t in all_towns if not re.search(r"丁目$", t))
        L.append(f"- 「丁目」で終わらない町丁目: {no_chome}")
        arabic = sorted(t for t in all_towns if re.search(r"[0-9０-９]", t))
        L.append(f"- 数字（算用・全角）を含む町丁目: {arabic if arabic else 'なし'}")

    (OUT / "report.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    with open(OUT / "resources.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows_csv[0].keys()))
        w.writeheader()
        w.writerows(rows_csv)
    print(f"\n完了: {OUT / 'report.md'} / {OUT / 'resources.csv'}")


if __name__ == "__main__":
    sys.exit(main())
