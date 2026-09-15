#!/usr/bin/env python3
"""
港区CKAN「町丁目別人口・世帯数（住民基本台帳に基づく）」パーサー

入力 : minato_survey.py が保存した package / manifest / raw/{sha256}
設定 : minato_towns.json      … 町丁目マスタ（--init-master で一度だけ生成し、確認してコミット）
       minato_exceptions.json … 既知の不整合（表記ゆれ・行単位の例外）
出力 : work/minato_parsed/ 以下（検証をすべて通過した場合のみ書き込む）
       observations.csv  … 縦持ち。世帯数・男・女・合計（原本値）・不明（導出）
       anomalies.csv     … 適用した例外・表記ゆれの記録
       files.csv         … リソースごとの取込結果
       monthly_totals.csv… 月ごとの区合計（区ページの公表値との照合用）
       summary.md

検証
  L0 ファイル : ヘッダー完全一致 / UTF-8 / 末尾トレーラー1行（年・Verが中身と一致）
  L1 行       : 日付8桁・1日・ファイルの年と一致 / 非負整数 / (年月日,町丁目)重複なし
                男+女≦合計（超える場合は例外登録が必須、値も完全一致）
  L2 月       : 町丁目の集合がマスタと完全一致 / 月の連続 / 最終月=Ver
  L3 地区     : 町丁目→地区の対応がマスタと一致
  L4 全体     : 月が複数ファイルに出ない / 2002-09 から最新Verまで欠けなし
  ※ 区合計の行は原本にないため、区総数の検算は monthly_totals.csv で別系列と照合する

使い方
  python parse_minato_ckan.py --init-master   # マスタ生成（初回のみ）
  python parse_minato_ckan.py                 # 検証＋出力
"""
import argparse
import csv
import io
import json
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path

MUNI_CODE = "131032"
HERE = Path(__file__).resolve().parent
SURVEY = Path("work/minato_survey")
OUT = Path("work/minato_parsed")

EXPECTED_HEADER = ["年月日［西暦］", "地区", "町丁目", "世帯数",
                   "人口男［人］", "人口女［人］", "人口合計［人］"]
TRAILER_TITLE = re.compile(r"^町丁目別人口・世帯数 (\d{4})年$")
TRAILER_VER = re.compile(r"^Ver(\d{6})$")
NAME_YEAR = re.compile(r"(\d{4})年$")
CHOME = re.compile(r"^(.+?)([一二三四五六七八九十]+)丁目$")
FIRST_MONTH = {"2002": "200209"}  # 系列の公開開始月（調査で確認済み）
KN = dict(zip("一二三四五六七八九", range(1, 10)))


def kanji_int(s):
    if "十" in s:
        a, _, b = s.partition("十")
        if (a and a not in KN) or (b and b not in KN):
            return None
        return (KN[a] if a else 1) * 10 + (KN[b] if b else 0)
    return KN.get(s) if len(s) == 1 else None


def split_town(town, no_chome):
    m = CHOME.match(town)
    if m:
        n = kanji_int(m.group(2))
        if n is not None:
            return m.group(1), n
    if town in no_chome:
        return town, None
    return None


def month_seq(first, last):
    y, m = int(first[:4]), int(first[4:6])
    out = []
    while f"{y:04d}{m:02d}" <= last:
        out.append(f"{y:04d}{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def iso(d):
    return f"{d[:4]}-{d[4:6]}-{d[6:]}"


def to_nonneg_int(s):
    s = s.strip()
    return int(s) if re.fullmatch(r"\d+", s) else None


# ---------------------------------------------------------------- 入力
def load_inputs():
    manifest = json.loads((SURVEY / "manifest.json").read_text(encoding="utf-8"))
    pkg = json.loads((SURVEY / manifest["package_file"]).read_bytes())["result"]
    items = []
    for res in pkg["resources"]:
        m = manifest["resources"][res["id"]]
        items.append((res, m["sha256"], (SURVEY / "raw" / m["sha256"]).read_bytes()))
    return pkg, items


def load_exceptions(path):
    cfg = json.loads(path.read_text(encoding="utf-8"))
    aliases = {a["alias"]: a for a in cfg.get("aliases", [])}
    rows = {(x["reference_date"], x["town"]): x for x in cfg.get("row_exceptions", [])}
    return aliases, rows


# ---------------------------------------------------------------- 1ファイル
def read_file(res, data, aliases, E, W):
    """L0 と行の形式だけを見る。値の整合は後段。"""
    name = res["name"]
    if data.startswith(b"\xef\xbb\xbf"):
        W(f"[{name}] BOMあり（除去して読む）")
        data = data[3:]
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        E(f"[{name}] UTF-8として読めない: {e}")
        return None

    rows = list(csv.reader(io.StringIO(text)))
    while rows and not any(c.strip() for c in rows[-1]):
        rows.pop()
    if len(rows) < 3:
        E(f"[{name}] 行数不足")
        return None
    if [c.strip() for c in rows[0]] != EXPECTED_HEADER:
        E(f"[{name}] ヘッダー不一致: {rows[0]}")
        return None

    trailer = [c.strip() for c in rows[-1]]
    while trailer and trailer[-1] == "":
        trailer.pop()
    mt = TRAILER_TITLE.match(trailer[0]) if len(trailer) == 2 else None
    mv = TRAILER_VER.match(trailer[1]) if len(trailer) == 2 else None
    if not (mt and mv):
        E(f"[{name}] 末尾がトレーラー行ではない: {rows[-1]}")
        return None
    year, ver = mt.group(1), mv.group(1)
    ny = NAME_YEAR.search(name)
    if not ny or ny.group(1) != year:
        E(f"[{name}] リソース名の年とトレーラーの年({year})が不一致")
    if ver[:4] != year:
        E(f"[{name}] Ver{ver} がトレーラーの年({year})と不一致")

    body = rows[1:-1]
    while body and not any(c.strip() for c in body[-1]):
        body.pop()  # トレーラー直前の空行のみ許容

    recs = []
    for ln, row in enumerate(body, start=2):
        if len(row) != 7:
            E(f"[{name}] L{ln} 列数{len(row)}: {row}")
            continue
        d, dist, town = (c.strip() for c in row[:3])
        if not re.fullmatch(r"\d{8}", d) or d[6:] != "01" or d[:4] != year:
            E(f"[{name}] L{ln} 日付が不正（8桁・1日・{year}年であること）: {d}")
            continue
        nums = [to_nonneg_int(c) for c in row[3:]]
        if None in nums:
            E(f"[{name}] L{ln} 非負整数でないセル: {row[3:]}")
            continue
        alias = None
        if town in aliases:
            a = aliases[town]
            if iso(d) not in a["dates"]:
                E(f"[{name}] L{ln} 表記ゆれ「{town}」が登録範囲外の月({iso(d)})に出現")
                continue
            alias, town = a, a["canonical"]
        hh, m, f, t = nums
        recs.append(dict(ln=ln, date=d, district=dist, town=town, raw_town=row[2].strip(),
                         alias=alias, hh=hh, male=m, female=f, total=t))
    return dict(year=year, ver=ver, recs=recs, trailer="/".join(trailer))


# ---------------------------------------------------------------- マスタ生成
def init_master(items, aliases, path):
    errors, warns = [], []
    district, sets = defaultdict(set), {}
    for res, sha, data in items:
        f = read_file(res, data, aliases, errors.append, warns.append)
        if not f:
            continue
        for r in f["recs"]:
            district[r["town"]].add(r["district"])
            sets.setdefault(r["date"], set()).add(r["town"])
    uniq = {frozenset(s) for s in sets.values()}
    if len(uniq) != 1:
        errors.append(f"月によって町丁目の集合が異なる（{len(uniq)}種類）。マスタを自動生成できない")
    multi = {t: s for t, s in district.items() if len(s) != 1}
    if multi:
        errors.append(f"複数の地区に出る町丁目: {multi}")
    if errors:
        sys.exit("マスタ生成を中止:\n" + "\n".join(errors))

    latest = max(sets)
    order = [r["town"] for res, sha, data in items
             for r in (read_file(res, data, aliases, lambda *_: None, lambda *_: None) or {"recs": []})["recs"]
             if r["date"] == latest]
    no_chome = [t for t in order if not CHOME.match(t)]
    towns = []
    for t in order:
        sp = split_town(t, set(no_chome))
        towns.append({"town": t, "district": next(iter(district[t])),
                      "town_name": sp[0], "chome": sp[1]})
    path.write_text(json.dumps({"muni_code": MUNI_CODE, "built_from": latest,
                                "no_chome": no_chome, "towns": towns},
                               ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"マスタを書き出しました: {path}（{len(towns)}町丁目、丁目なし {no_chome}）")
    print("内容を確認してからコミットしてください。")


# ---------------------------------------------------------------- 本処理
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--init-master", action="store_true")
    ap.add_argument("--master", type=Path, default=HERE / "minato_towns.json")
    ap.add_argument("--exceptions", type=Path, default=HERE / "minato_exceptions.json")
    args = ap.parse_args()

    pkg, items = load_inputs()
    aliases, row_exc = load_exceptions(args.exceptions)

    if args.init_master:
        if args.master.exists():
            sys.exit(f"中止: {args.master} は既にあります（作り直す場合は手で削除）")
        return init_master(items, aliases, args.master)
    if not args.master.exists():
        sys.exit(f"中止: {args.master} がありません。先に --init-master を実行してください")

    master = json.loads(args.master.read_text(encoding="utf-8"))
    mtown = {x["town"]: x for x in master["towns"]}
    mset = set(mtown)

    errors, warns = [], []
    E, W = errors.append, warns.append
    parsed = []
    for res, sha, data in items:
        f = read_file(res, data, aliases, E, W)
        if f:
            parsed.append((res, sha, f))
    latest_year = max(f["year"] for _, _, f in parsed) if parsed else None

    obs, anomalies, files, used_exc, used_alias = [], [], [], set(), set()
    month_owner = {}
    monthly = defaultdict(lambda: [0, 0, 0, 0, 0])  # hh, male, female, total, unknown
    unknown_pos = defaultdict(list)

    for res, sha, f in parsed:
        name, rid = res["name"], res["id"]
        by_date, seen = defaultdict(set), set()
        for r in f["recs"]:
            key = (r["date"], r["town"])
            if key in seen:
                E(f"[{name}] L{r['ln']} (年月日,町丁目)重複: {key}")
            seen.add(key)
            by_date[r["date"]].add(r["town"])
            mt = mtown.get(r["town"])
            if not mt:
                E(f"[{name}] L{r['ln']} マスタにない町丁目: {r['raw_town']}")
                continue
            if mt["district"] != r["district"]:
                E(f"[{name}] L{r['ln']} 地区がマスタと不一致: {r['town']} {r['district']}")

        # L2 月
        first = FIRST_MONTH.get(f["year"], f["year"] + "01")
        last = f["ver"] if f["year"] == latest_year else f["year"] + "12"
        if f["year"] != latest_year and f["ver"] != last:
            E(f"[{name}] 過年ファイルなのに Ver{f['ver']} が12月でない")
        expected = month_seq(first, last)
        got = sorted(d[:6] for d in by_date)
        if got != expected:
            E(f"[{name}] 月の並びが想定と不一致 想定{expected[0]}〜{expected[-1]} 実際{got[:1]}〜{got[-1:]}（{len(got)}か月）")
        for d, s in by_date.items():
            if s != mset:
                E(f"[{name}] {iso(d)} 町丁目の集合がマスタと不一致 不足{sorted(mset - s)} 余分{sorted(s - mset)}")
            if d in month_owner:
                E(f"[{name}] {iso(d)} は {month_owner[d]} にも出現")
            month_owner[d] = name

        n_obs = 0
        for r in f["recs"]:
            mt = mtown.get(r["town"])
            if not mt:
                continue
            d_iso = iso(r["date"])
            unknown = r["total"] - r["male"] - r["female"]
            exc = row_exc.get((d_iso, r["town"]))
            anomaly_id = None
            if exc:
                rep = exc["reported"]
                if unknown >= 0:
                    W(f"[{name}] 例外 {exc['id']} は不要になった可能性（男+女≦合計）。例外を使わずに取り込む")
                elif all(r[k] == rep[k] for k in ("male", "female", "total")):
                    anomaly_id = exc["id"]
                    used_exc.add(exc["id"])
                    anomalies.append(dict(anomaly_id=exc["id"], kind=exc["kind"],
                                          treatment=exc["treatment"], reference_date=d_iso,
                                          town=r["town"], reported=json.dumps(rep, ensure_ascii=False),
                                          note=exc["note"], source_sha256=sha, resource_id=rid))
                else:
                    E(f"[{name}] L{r['ln']} 例外 {exc['id']} の登録値と原本が不一致: "
                      f"原本 男{r['male']} 女{r['female']} 計{r['total']}")
                    continue
            elif unknown < 0:
                E(f"[{name}] L{r['ln']} 男+女>合計（未登録）: {r['town']} {d_iso} "
                  f"{r['male']}+{r['female']}>{r['total']}")
                continue

            if r["alias"]:
                a = r["alias"]
                used_alias.add(a["id"])
                anomalies.append(dict(anomaly_id=a["id"], kind="name_variant",
                                      treatment="map_to_canonical", reference_date=d_iso,
                                      town=r["town"], reported=json.dumps({"town": r["raw_town"]}, ensure_ascii=False),
                                      note=a["note"], source_sha256=sha, resource_id=rid))

            base = dict(muni_code=MUNI_CODE, reference_date=d_iso, district=mt["district"],
                        town_key=mt["town"], town_name=mt["town_name"], chome=mt["chome"],
                        anomaly_id=anomaly_id, source_sha256=sha, resource_id=rid)
            out = [("households", "total", r["hh"], 0),
                   ("population", "male", r["male"], 0),
                   ("population", "female", r["female"], 0),
                   ("population", "total", r["total"], 0)]
            if anomaly_id is None:
                out.append(("population", "unknown", unknown, 1))
                if unknown > 0:
                    unknown_pos[mt["town"]].append((d_iso, unknown))
            for measure, sex, value, derived in out:
                obs.append(dict(base, measure=measure, sex=sex, value=value, is_derived=derived))
            n_obs += len(out)
            mm = monthly[d_iso]
            mm[0] += r["hh"]; mm[1] += r["male"]; mm[2] += r["female"]; mm[3] += r["total"]
            if anomaly_id is None:
                mm[4] += unknown

        months = sorted(by_date)
        files.append(dict(resource_id=rid, name=name, sha256=sha,
                          last_modified=res.get("last_modified"), created=res.get("created"),
                          trailer=f["trailer"], first=iso(months[0]) if months else "",
                          last=iso(months[-1]) if months else "", months=len(months),
                          source_rows=len(f["recs"]), obs_rows=n_obs))

    # L4 全体
    if month_owner:
        allm = sorted(d[:6] for d in month_owner)
        full = month_seq("200209", allm[-1])
        if allm != full:
            E(f"系列全体で欠けている月: {sorted(set(full) - set(allm))}")
    for eid in {x["id"] for x in row_exc.values()} - used_exc:
        W(f"例外 {eid} は今回一度も適用されなかった")
    for aid in {a["id"] for a in aliases.values()} - used_alias:
        W(f"表記ゆれ {aid} は今回一度も出現しなかった")

    if errors:
        rep = Path("work/minato_parse_errors.md")
        rep.parent.mkdir(parents=True, exist_ok=True)
        rep.write_text("# 検証エラー（出力は書き込んでいません）\n\n" +
                       "\n".join(f"- {e}" for e in errors) + "\n\n## 警告\n\n" +
                       "\n".join(f"- {w}" for w in warns) + "\n", encoding="utf-8")
        print(f"検証エラー {len(errors)}件。出力は書き込みません → {rep}")
        for e in errors[:20]:
            print("  " + e)
        return 1

    # 書き込み（一時ディレクトリに作ってから差し替え）
    tmp = OUT.with_name(OUT.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)

    def write_csv(fname, rows, fields):
        with open(tmp / fname, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=fields)
            w.writeheader()
            w.writerows(rows)

    obs.sort(key=lambda x: (x["reference_date"], x["town_key"], x["measure"], x["sex"]))
    write_csv("observations.csv", obs,
              ["muni_code", "reference_date", "district", "town_key", "town_name", "chome",
               "measure", "sex", "value", "is_derived", "anomaly_id", "source_sha256", "resource_id"])
    write_csv("anomalies.csv", anomalies,
              ["anomaly_id", "kind", "treatment", "reference_date", "town", "reported",
               "note", "source_sha256", "resource_id"])
    files.sort(key=lambda x: x["first"])
    write_csv("files.csv", files, list(files[0].keys()))
    write_csv("monthly_totals.csv",
              [dict(reference_date=d, households=v[0], male=v[1], female=v[2],
                    total=v[3], unknown_derived=v[4]) for d, v in sorted(monthly.items())],
              ["reference_date", "households", "male", "female", "total", "unknown_derived"])

    L = ["# 港区CKAN 取込結果\n",
         f"- package: `{pkg['name']}` / リソース {len(files)}件",
         f"- 期間: {files[0]['first']} 〜 {files[-1]['last']}（{len(month_owner)}か月）",
         f"- 町丁目: {len(mset)}（マスタ built_from {master['built_from']}）",
         f"- 出力行: {len(obs)}",
         f"- 適用した例外・表記ゆれ: {len(anomalies)}件\n",
         "## 性別不明（導出）が1以上の町丁目\n"]
    all_months = sorted(monthly)
    for t in unknown_pos:
        unknown_pos[t].sort()
    for t, xs in sorted(unknown_pos.items(), key=lambda kv: (kv[1][0][0], kv[0])):
        spans, cur = [], [xs[0]]
        for prev, x in zip(xs, xs[1:]):
            if all_months.index(x[0]) == all_months.index(prev[0]) + 1:
                cur.append(x)
            else:
                spans.append(cur)
                cur = [x]
        spans.append(cur)
        desc = " / ".join(
            f"{s[0][0][:7]}〜{s[-1][0][:7]}（値 {','.join(str(v) for _, v in s)}）"
            for s in spans)
        L.append(f"- {t}: {len(xs)}か月 {desc}")
    L.append("\n## 警告\n")
    L += [f"- {w}" for w in warns] or ["- なし"]
    (tmp / "summary.md").write_text("\n".join(L) + "\n", encoding="utf-8")

    shutil.rmtree(OUT, ignore_errors=True)
    tmp.rename(OUT)
    print(f"完了: {OUT}（{len(obs)}行、例外・表記ゆれ {len(anomalies)}件、警告 {len(warns)}件）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
