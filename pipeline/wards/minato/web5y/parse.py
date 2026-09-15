#!/usr/bin/env python3
"""
港区「町丁別年齢5歳階級別人口表」パーサー（PDF / xlsb）

入力 : work/minato/web5y/fetch/manifest.json と raw/{sha256}（fetch.py）
       ../towns.json（key_code 付与済み）
       work/minato/ckan/parsed/observations.csv（港区CKAN系列。照合に使う）
出力 : work/minato/web5y/parsed/（検証をすべて通過した場合のみ）
       observations.csv / files.csv / summary.md

原本の構造（PDF・xlsb 共通）
  1ページ = 1町丁目（117ページ）。左に日本人、右に外国人。
  年齢22区分（0-4 … 95-99, 100+, 年齢不詳）＋ 小計3行（0-14 / 15-64 / 65+）。
  各行は 総数・男・女。総数 − 男 − 女 = 性別不明。

検証
  L0 ファイル : 117ページ / 表題 / 「現在」の日付がリンク文字列の日付と一致（全ページ同一）
  L1 行       : 年齢ラベルの並びが完全一致（左右とも）/ 非負整数 / 総数 ≧ 男+女
  L2 小計     : 小計3行 = 該当区分の合計（総数・男・女とも）
  L3 町丁目   : 集合がマスタ117件と完全一致（全角数字は NFKC で正規化して照合）
  L4 照合     : 町丁目ごとの男・女・総数（日本人+外国人、全年齢）が
                CKAN系列の同じ基準日の値と一致
  補助        : xlsb の印刷範囲外にある作業列（K〜Q列）が表示値と一致すること

例外（../exceptions.json の "web5y"）
  cell_exceptions     : 空欄などのセル。原本値のまま（空欄は NULL）保持し、異常フラグを付け、
                        性別不明の導出から除外する。空欄の本来の値は
                        「CKAN系列から引いた値」と「同ページの小計から引いた値」が一致する場合のみ
                        推定値として記録する（保存する値は補わない）
  subtotal_exceptions : 小計行の不一致。小計行は保存しないので検証のみ
  いずれも登録値と原本が完全一致しなければエラー。適用されなかった登録は警告。

保存するもの
  nationality = japanese / foreign、age_class 22区分、sex = male / female / total（原本値）
  / unknown（total − male − female、is_derived=1）
  小計行と国籍計（all）は導出できるので保存しない（検証のみ）。

使い方（リポジトリ直下で）:
  python pipeline/wards/minato/web5y/parse.py
"""
import csv
import io
import json
import re
import shutil
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
MASTER = HERE.parent / "towns.json"
EXCEPTIONS = HERE.parent / "exceptions.json"
SRC = Path("work/minato/web5y/fetch")
CKAN_OBS = Path("work/minato/ckan/parsed/observations.csv")
OUT = Path("work/minato/web5y/parsed")

DATASET_KEY = "minato_5y"
MUNI = "131032"
TITLE = "町丁別年齢５歳階級別人口総括表"
N_TOWNS = 117

AGE_LABELS = ["０～４歳", "５～９歳"] + [f"{a}～{a + 4}歳" for a in range(10, 100, 5)] \
    + ["100歳以上", "年齢不詳"]
AGE_CLASS = ["0-4", "5-9"] + [f"{a}-{a + 4}" for a in range(10, 100, 5)] + ["100+", "unknown"]
HEADER = ["年齢", "総数", "男", "女"] * 2
SUB_LABELS = ["０～14歳", "15～64歳", "65歳以上"]
SUB_RANGES = [(0, 3), (3, 13), (13, 21)]          # AGE_LABELS の添字範囲
SUB_CLASS = ["0-14", "15-64", "65+"]
HELPER_AGES = ["0～4歳", "5～9歳"] + [f"{a}～{a + 4}歳" for a in range(10, 100, 5)] + ["100～150歳"]

WAREKI = re.compile(r"(令和|平成)(元|\d+)年(\d+)月(\d+)日")
ERA = {"令和": 2018, "平成": 1988}


def wareki_to_iso(text):
    m = WAREKI.search(unicodedata.normalize("NFKC", text or ""))
    if not m:
        return None
    y = ERA[m.group(1)] + (1 if m.group(2) == "元" else int(m.group(2)))
    return f"{y:04d}-{int(m.group(3)):02d}-{int(m.group(4)):02d}"


def to_int(v):
    if isinstance(v, (int, float)):
        return int(v) if float(v).is_integer() and v >= 0 else None
    s = str(v).replace(",", "").strip()
    return int(s) if re.fullmatch(r"\d+", s) else None


# ---------------------------------------------------------------- 読み取り
# 各リーダーは「ページ」の列を返す:
#   dict(page, town, title, created, asof, rows=[(label_l, t, m, f, label_r, t, m, f) ×25],
#        helper=[(town, label, jm, jf, x, fm, ff) ×21] or None)
ROW_LABELS = r"(０～４歳|５～９歳|\d{2,3}～\d{2}歳|100歳以上|年齢不詳|０～14歳|15～64歳|65歳以上)"
NUM = r"([\d,]+)"
PDF_ROW = re.compile(rf"^{ROW_LABELS} {NUM} {NUM} {NUM} {ROW_LABELS} {NUM} {NUM} {NUM}$")


def read_pdf(data):
    import pdfplumber
    pages = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for i, p in enumerate(pdf.pages, start=1):
            lines = [re.sub(r"\s+", " ", l).strip() for l in (p.extract_text() or "").splitlines()]
            lines = [l for l in lines if l]
            name = [l for l in lines if "（日本人）" in l]
            rows = [m.groups() for m in map(PDF_ROW.match, lines) if m]
            head = [l for l in lines if l.startswith("年齢 ")]
            pages.append(dict(
                page=i,
                header=head[0].split(" ") if len(head) == 1 else None,
                town=name[0].split("（日本人）")[0].strip() if len(name) == 1 else None,
                title=lines[0] if lines else None,
                created=next((l for l in lines if l.endswith("作成")), None),
                asof=next((l for l in lines if l.endswith("現在")), None),
                rows=rows, helper=None))
    return pages


def read_xlsb(data):
    from pyxlsb import open_workbook
    import tempfile, os
    with tempfile.NamedTemporaryFile(suffix=".xlsb", delete=False) as tf:
        tf.write(data)
        path = tf.name
    try:
        with open_workbook(path) as wb:
            if len(wb.sheets) != 1:
                raise ValueError(f"シート数が1でない: {wb.sheets}")
            with wb.get_sheet(wb.sheets[0]) as sh:
                grid = [[c.v for c in r] for r in sh.rows()]
    finally:
        os.unlink(path)
    grid = [r + [None] * (17 - len(r)) for r in grid]
    starts = [i for i, r in enumerate(grid) if r[0] == TITLE]
    pages = []
    for n, s in enumerate(starts, start=1):
        b = grid[s:s + 32]
        if len(b) < 31:
            pages.append(dict(page=n, town=None, title=TITLE, created=None, asof=None,
                              rows=[], header=None, helper=None))
            continue
        rows = [tuple(r[c] for c in (0, 1, 2, 3, 5, 6, 7, 8)) for r in b[6:31]]
        helper = [tuple(r[10:17]) for r in b[6:27]]
        first = lambda r: next((v for v in r if v is not None), None)
        # 「（外国人）」の列位置はページによって G列/H列 と揺れるため、行内の有無で判定する
        name_ok = "（日本人）" in b[4] and "（外国人）" in b[4]
        pages.append(dict(
            page=n, town=b[4][0] if name_ok else None,
            title=b[0][0], created=first(b[2]), asof=first(b[3]), rows=rows,
            header=[b[5][c] for c in (0, 1, 2, 3, 5, 6, 7, 8)],
            helper=helper if all(h[0] is not None for h in helper) else None))
    return pages


# ---------------------------------------------------------------- 検証
def load_exceptions():
    cfg = json.loads(EXCEPTIONS.read_text(encoding="utf-8")).get("web5y", {}) \
        if EXCEPTIONS.exists() else {}
    cells = {(x["reference_date"], x["area_name"], x["nationality"], x["age_class"]): x
             for x in cfg.get("cell_exceptions", [])}
    subs = {(x["reference_date"], x["area_name"], x["nationality"], x["subtotal"]): x
            for x in cfg.get("subtotal_exceptions", [])}
    return cells, subs


def check_file(f, pages, towns_by_name, exc, E, W):
    """1ファイル分を検証し、町丁目ごとの値を返す。
    値は [total, male, female]。空欄（例外登録済み）は None。"""
    cell_exc, sub_exc, used = exc
    tag = f"[{f['asof']} {f['format']}]"
    if len(pages) != N_TOWNS:
        E(f"{tag} ページ数 {len(pages)}（想定 {N_TOWNS}）")
    out = {}
    failed = 0
    for p in pages:
        pt = f"{tag} p{p['page']}"
        if p["title"] != TITLE:
            E(f"{pt} 表題が不一致: {p['title']}")
        if wareki_to_iso(p["asof"]) != f["asof"]:
            E(f"{pt} 基準日 {p['asof']} がリンクの日付 {f['asof']} と不一致")
        if p["header"] != HEADER:
            E(f"{pt} 見出し行が不一致: {p['header']}")
            failed += 1
            continue
        if not p["town"]:
            E(f"{pt} 町丁目名の行が見つからない")
            failed += 1
            continue
        norm = unicodedata.normalize("NFKC", p["town"]).replace(" ", "")
        t = towns_by_name.get(norm)
        if not t:
            E(f"{pt} マスタにない町丁目: {p['town']}")
            failed += 1
            continue
        if t["key_code"] in out:
            E(f"{pt} 町丁目が重複: {p['town']}")
            continue
        rows = p["rows"]
        if len(rows) != 25:
            E(f"{pt} {p['town']} データ行が {len(rows)} 行（想定 25）")
            failed += 1
            continue
        labels_l = [r[0] for r in rows]
        labels_r = [r[4] for r in rows]
        if labels_l != AGE_LABELS + SUB_LABELS or labels_r != labels_l:
            E(f"{pt} {p['town']} 年齢ラベルの並びが不一致")
            failed += 1
            continue
        vals, anomalies, ok = {}, {}, True
        for side, off in (("japanese", 1), ("foreign", 5)):
            cells = []
            for k, r in enumerate(rows):
                raw = r[off:off + 3]
                v = [to_int(x) for x in raw]
                blank = [x is None or str(x).strip() == "" for x in raw]
                key = (f["asof"], norm, side, AGE_CLASS[k] if k < 22 else None)
                ex = cell_exc.get(key)
                if ex and None not in v:
                    # 上流で空欄が埋まった可能性。例外を使わずに通常どおり扱う
                    W(f"{pt} {p['town']} {side} {r[0]} 例外 {ex['id']} は不要になった可能性（空欄がない）")
                    ex = None
                if ex:
                    rep = ex["reported"]
                    got = {"total": v[0] if not blank[0] else None,
                           "male": v[1] if not blank[1] else None,
                           "female": v[2] if not blank[2] else None}
                    bad_nonblank = any(x is None and not b for x, b in zip(v, blank))
                    if got != rep or bad_nonblank:
                        E(f"{pt} {p['town']} {side} {r[0]} 例外 {ex['id']} の登録値と原本が不一致: {raw}")
                        ok = False
                    else:
                        anomalies[(side, k)] = ex
                        used.add(ex["id"])
                elif None in v:
                    E(f"{pt} {p['town']} {side} {r[0]} 非負整数でない: {raw}")
                    ok = False
                cells.append(v)
            if not ok:
                break
            for k, (tt, mm, ff) in enumerate(cells[:22]):
                if None not in (tt, mm, ff) and tt < mm + ff:
                    E(f"{pt} {p['town']} {side} {AGE_LABELS[k]} 総数{tt} < 男{mm}+女{ff}")
                    ok = False
            for j, (lo, hi) in enumerate(SUB_RANGES):
                st = cells[22 + j]
                part = cells[lo:hi]
                calc = [sum(c[x] for c in part if c[x] is not None) for x in range(3)]
                has_blank = [any(c[x] is None for c in part) for x in range(3)]
                # 空欄を含む列は「小計 − 他の合計」を空欄の推定値として控える
                for x in range(3):
                    if has_blank[x]:
                        (bk,) = [kk for kk in range(lo, hi) if cells[kk][x] is None]
                        anomalies[(side, bk)] = dict(anomalies[(side, bk)],
                                                     _implied_by_subtotal={x: st[x] - calc[x]})
                cmp_st = [st[x] for x in range(3) if not has_blank[x]]
                cmp_calc = [calc[x] for x in range(3) if not has_blank[x]]
                if cmp_st == cmp_calc:
                    continue
                sx = sub_exc.get((f["asof"], norm, side, SUB_CLASS[j]))
                if sx and list(st) == [sx["reported"][k] for k in ("total", "male", "female")] \
                        and calc == [sx["computed"][k] for k in ("total", "male", "female")]:
                    used.add(sx["id"])
                    anomalies[("sub", side, j)] = sx
                    continue
                E(f"{pt} {p['town']} {side} 小計{SUB_LABELS[j]} {st} ≠ 合計{calc}")
                ok = False
            vals[side] = cells[:22]
        if not ok:
            failed += 1
            continue
        if f["format"] == "xlsb":
            h = p["helper"]
            if h is None:
                W(f"{pt} {p['town']} 作業列がない")
            else:
                for k, row in enumerate(h):
                    exp = (vals["japanese"][k][1], vals["japanese"][k][2],
                           vals["foreign"][k][1], vals["foreign"][k][2])
                    got = tuple(to_int(x) for x in (row[2], row[3], row[5], row[6]))
                    blank_ok = all(g == e or (e is None and g in (None, 0)) for g, e in zip(got, exp))
                    if (unicodedata.normalize("NFKC", str(row[0])).replace(" ", "") != norm
                            or row[1] != HELPER_AGES[k] or not blank_ok):
                        E(f"{pt} {p['town']} 作業列が表示値と不一致（{AGE_LABELS[k]}）: {row}")
                        break
                    if to_int(row[4]) != 0:
                        W(f"{pt} {p['town']} 作業列の用途不明の列が0でない（{AGE_LABELS[k]}）: {row[4]}")
        out[t["key_code"]] = (t, vals, anomalies)
    if len(out) + failed == N_TOWNS and failed == 0:
        missing = set(x["key_code"] for x in towns_by_name.values()) - set(out)
        if missing:
            E(f"{tag} 欠けている町丁目: {sorted(missing)}")
    return out


def load_ckan(dates):
    ck = defaultdict(dict)
    with open(CKAN_OBS, encoding="utf-8", newline="") as fh:
        for r in csv.DictReader(fh):
            if r["reference_date"] in dates and r["measure"] == "population" \
                    and r["sex"] in ("male", "female", "total"):
                ck[(r["reference_date"], r["town_key"])][r["sex"]] = int(r["value"])
    return ck


# ---------------------------------------------------------------- 本体
def main():
    master = json.loads(MASTER.read_text(encoding="utf-8"))
    if not all(t.get("key_code") for t in master["towns"]):
        sys.exit("中止: towns.json に key_code がない")
    towns_by_name = {t["area_name"]: t for t in master["towns"]}
    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    files = manifest["files"]
    errors, warns = [], []
    E, W = errors.append, warns.append
    cell_exc, sub_exc = load_exceptions()
    used = set()

    parsed = []
    for f in files:
        data = (SRC / "raw" / f["sha256"]).read_bytes()
        try:
            pages = read_pdf(data) if f["format"] == "pdf" else \
                read_xlsb(data) if f["format"] == "xlsb" else None
        except Exception as e:
            E(f"[{f['asof']} {f['format']}] 読み取りに失敗: {e}")
            continue
        if pages is None:
            E(f"[{f['asof']}] 未対応の形式: {f['format']}")
            continue
        parsed.append((f, check_file(f, pages, towns_by_name, (cell_exc, sub_exc, used), E, W)))
        print(f"  読み取り {f['asof']} {f['format']:5} {len(pages)}ページ")

    # L4 CKAN系列との照合
    dates = {f["asof"] for f, _ in parsed}
    ck = load_ckan(dates)
    unknown_cells = []
    anomaly_rows = []
    for f, towns in parsed:
        for key, (t, vals, anomalies) in towns.items():
            c = ck.get((f["asof"], t["town"]))
            cells = [v for s_ in vals.values() for v in s_]
            sums = [sum(v[x] for v in cells if v[x] is not None) for x in range(3)]
            blank = [any(v[x] is None for v in cells) for x in range(3)]
            if not c:
                E(f"[{f['asof']}] CKAN系列に {t['town']} の同日の値がない")
                continue
            ckv = [c.get("total"), c.get("male"), c.get("female")]
            for x, name in enumerate(("総数", "男", "女")):
                if blank[x]:
                    continue
                if ckv[x] != sums[x]:
                    E(f"[{f['asof']}] {t['area_name']} CKAN系列と不一致（{name}）: "
                      f"本表 {sums[x]} / CKAN {ckv[x]}")
            # 空欄の推定値：CKAN から引いた値と小計から引いた値が一致すること
            for akey, ex in anomalies.items():
                if akey[0] == "sub":
                    anomaly_rows.append(dict(anomaly_id=ex["id"], kind=ex["kind"],
                                             treatment=ex["treatment"], reference_date=f["asof"],
                                             key_code=key, nationality=akey[1],
                                             age_class=SUB_CLASS[akey[2]] + "（小計）",
                                             reported=json.dumps(ex["reported"], ensure_ascii=False),
                                             implied="", note=ex["note"], source_sha256=f["sha256"]))
                    continue
                side, k = akey
                implied = {}
                for x, name in enumerate(("total", "male", "female")):
                    if vals[side][k][x] is not None:
                        continue
                    by_ck = ckv[x] - sums[x]
                    by_sub = ex.get("_implied_by_subtotal", {}).get(x)
                    if by_ck != by_sub or by_ck < 0:
                        E(f"[{f['asof']}] {t['area_name']} {side} {AGE_LABELS[k]} 空欄の推定値が一致しない: "
                          f"CKANから {by_ck} / 小計から {by_sub}")
                    implied[name] = by_ck
                anomaly_rows.append(dict(anomaly_id=ex["id"], kind=ex["kind"],
                                         treatment=ex["treatment"], reference_date=f["asof"],
                                         key_code=key, nationality=side, age_class=AGE_CLASS[k],
                                         reported=json.dumps(ex["reported"], ensure_ascii=False),
                                         implied=json.dumps(implied, ensure_ascii=False),
                                         note=ex["note"], source_sha256=f["sha256"]))
            for side, cells_ in vals.items():
                for k, (a_, b_, d_) in enumerate(cells_):
                    if (side, k) in anomalies:
                        continue
                    if a_ - b_ - d_:
                        unknown_cells.append((f["asof"], t["area_name"], side, AGE_CLASS[k], a_ - b_ - d_))
    for xid in ({x["id"] for x in cell_exc.values()} | {x["id"] for x in sub_exc.values()}) - used:
        W(f"例外 {xid} は今回一度も適用されなかった")

    if errors:
        rep = Path("work/minato/web5y/parse_errors.md")
        rep.parent.mkdir(parents=True, exist_ok=True)
        rep.write_text("# 検証エラー（出力は書き込んでいません）\n\n"
                       + "\n".join(f"- {e}" for e in errors) + "\n\n## 警告\n\n"
                       + "\n".join(f"- {w}" for w in warns) + "\n", encoding="utf-8")
        print(f"検証エラー {len(errors)}件。出力は書き込みません → {rep}")
        for e in errors[:20]:
            print("  " + e)
        return 1

    obs, file_rows, per_date = [], [], {}
    for f, towns in sorted(parsed, key=lambda x: x[0]["asof"]):
        n = 0
        tot = Counter()
        for key, (t, vals, anomalies) in sorted(towns.items()):
            for side, cells in vals.items():
                for k, (a, b, d) in enumerate(cells):
                    ex = anomalies.get((side, k))
                    base = dict(dataset_key=DATASET_KEY, key_code=key, muni_code=MUNI,
                                reference_date=f["asof"], measure="population",
                                nationality=side, age_class=AGE_CLASS[k],
                                anomaly_id=ex["id"] if ex else "", source_sha256=f["sha256"])
                    out_rows = [("male", b, 0), ("female", d, 0), ("total", a, 0)]
                    if ex is None:
                        out_rows.append(("unknown", a - b - d, 1))
                    for sex, v, der in out_rows:
                        obs.append(dict(base, sex=sex, value="" if v is None else v, is_derived=der))
                        n += 1
                    tot[side] += a or 0
                    if AGE_CLASS[k] == "unknown":
                        tot["age_unknown"] += a or 0
        per_date[f["asof"]] = tot
        file_rows.append(dict(asof=f["asof"], format=f["format"], url=f["url"],
                              label=f["label"], sha256=f["sha256"], bytes=f["bytes"],
                              http_last_modified=f.get("http_last_modified"),
                              towns=len(towns), obs_rows=n))

    tmp = OUT.with_name(OUT.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    fields = ["dataset_key", "key_code", "muni_code", "reference_date", "measure",
              "nationality", "age_class", "sex", "value", "is_derived", "anomaly_id", "source_sha256"]
    with open(tmp / "observations.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(obs)
    with open(tmp / "anomalies.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["anomaly_id", "kind", "treatment", "reference_date",
                                           "key_code", "nationality", "age_class", "reported",
                                           "implied", "note", "source_sha256"])
        w.writeheader()
        w.writerows(anomaly_rows)
    with open(tmp / "files.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(file_rows[0]))
        w.writeheader()
        w.writerows(file_rows)

    L = ["# 港区 町丁別年齢5歳階級別人口表 取込結果\n",
         f"- ファイル: {len(file_rows)}件 / 出力行: {len(obs)}",
         "- CKAN系列（町丁目×男女×総数）と全町丁目・全時点で一致\n",
         "## 時点別\n", "| 基準日 | 形式 | 日本人 | 外国人 | 総数 | 年齢不詳 |", "|---|---|---|---|---|---|"]
    for r in file_rows:
        t = per_date[r["asof"]]
        L.append(f"| {r['asof']} | {r['format']} | {t['japanese']:,} | {t['foreign']:,} | "
                 f"{t['japanese'] + t['foreign']:,} | {t['age_unknown']} |")
    L.append(f"\n## 適用した例外: {len(anomaly_rows)}件\n")
    for r in anomaly_rows:
        L.append(f"- {r['reference_date']} {r['anomaly_id']}（{r['age_class']} {r['nationality']}）"
                 f" 原本 {r['reported']}" + (f" / 推定 {r['implied']}" if r["implied"] else ""))
    L.append(f"\n## 性別不明（導出）が1以上のセル: {len(unknown_cells)}件\n")
    L.append("町丁目×国籍×年齢の単位で特定されるため、画面・集計ビューでは区単位に合算して扱う。\n")
    by = Counter((d, s) for d, _, s, _, _ in unknown_cells)
    for (d, s), n in sorted(by.items()):
        L.append(f"- {d} {s}: {n}セル")
    L.append("\n## 警告\n")
    L += [f"- {w}" for w in warns] or ["- なし"]
    (tmp / "summary.md").write_text("\n".join(L) + "\n", encoding="utf-8")

    shutil.rmtree(OUT, ignore_errors=True)
    tmp.rename(OUT)
    print(f"完了: {OUT}（{len(obs)}行、警告 {len(warns)}件）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
