r"""
列構造ゆらぎの棚卸し

指定ディレクトリのCSVを基準日順に走査し、以下が「いつ変わったか」を年表にする。

    - 列名（表記ゆれ・追加・削除・並び替え）
    - 列数
    - 文字コード
    - 改行コード
    - データ行数

使い方:
    python column_survey.py "..\人口_test\目黒区\data_5y\src"
    python column_survey.py <dir> --out survey.md
    python column_survey.py <dir> --full        # 全ファイルを1行ずつ列挙

設計方針:
    値の意味づけはしない。観測された事実だけを並べる。
    読めないファイルは除外せず「破損」として年表に残す。
"""

from __future__ import annotations

import argparse
import csv
import io
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

ENCODINGS = ["utf-8-sig", "cp932", "utf-8", "euc-jp"]
DATE_RE = re.compile(r"(\d{8})(?=\.[^.]+$)")

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def log(msg: str = "") -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------- 読み取り

def detect_encoding(data: bytes) -> tuple[str, str]:
    """(復号したテキスト, 使った文字コード名) を返す。"""
    for enc in ENCODINGS:
        try:
            t = data.decode(enc)
        except UnicodeDecodeError:
            continue
        if "\ufffd" in t:
            continue
        return t, enc
    return data.decode("cp932", errors="replace"), "cp932(置換あり)"


def detect_newline(data: bytes) -> str:
    crlf = data.count(b"\r\n")
    lf = data.count(b"\n") - crlf
    cr = data.count(b"\r") - crlf
    if crlf and not lf and not cr:
        return "CRLF"
    if lf and not crlf and not cr:
        return "LF"
    if cr and not crlf and not lf:
        return "CR"
    return f"混在(CRLF={crlf},LF={lf},CR={cr})"


def ref_date(name: str) -> str:
    m = DATE_RE.search(name)
    if not m:
        return "????-??-??"
    try:
        return datetime.strptime(m.group(1), "%Y%m%d").date().isoformat()
    except ValueError:
        return "????-??-??"


def inspect(path: Path) -> dict:
    data = path.read_bytes()
    text, enc = detect_encoding(data)
    rec = {
        "file": path.name,
        "date": ref_date(path.name),
        "bytes": len(data),
        "encoding": enc,
        "newline": detect_newline(data),
        "header": [],
        "ncols": 0,
        "nrows": 0,
        "issues": [],
    }

    rows = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
    if not rows:
        rec["issues"].append("空ファイル")
        return rec

    rec["header"] = [c.strip() for c in rows[0]]
    rec["ncols"] = len(rec["header"])
    rec["nrows"] = len(rows) - 1

    # データ行の列数がヘッダと合わないもの
    widths = Counter(len(r) for r in rows[1:])
    bad = sum(n for w, n in widths.items() if w != rec["ncols"])
    if bad:
        rec["issues"].append(
            f"列数不一致 {bad}/{rec['nrows']}行 (観測列数 {dict(widths)})")

    # 1セルに複数の数値が空白区切りで入っているもの
    crammed = sum(1 for r in rows[1:] for c in r if re.search(r"\d\s+\d", c.strip()))
    if crammed:
        rec["issues"].append(f"空白区切りが残るセル {crammed}個")

    return rec


# ---------------------------------------------------------------- 差分

def header_diff(prev: list[str], cur: list[str]) -> list[str]:
    out = []
    sp, sc = set(prev), set(cur)
    removed, added = sp - sc, sc - sp

    # 位置だけ動いた列
    moved = [c for c in sp & sc
             if prev.index(c) != cur.index(c)]

    if len(prev) != len(cur):
        out.append(f"列数 {len(prev)} → {len(cur)}")
    for c in sorted(removed):
        out.append(f"  − {c}")
    for c in sorted(added):
        out.append(f"  ＋ {c}")
    if moved and not removed and not added:
        out.append(f"  位置変更 {len(moved)}列: {', '.join(sorted(moved)[:5])}"
                   + ("…" if len(moved) > 5 else ""))
    if not out:
        out.append("  （列名の変化なし）")
    return out


def signature(rec: dict) -> tuple:
    """この4つが同じなら「同じ構造」とみなす。"""
    return (tuple(rec["header"]), rec["encoding"], rec["newline"])


# ---------------------------------------------------------------- 出力

def build_report(recs: list[dict], full: bool) -> list[str]:
    out: list[str] = []
    a = out.append

    a(f"# 列構造ゆらぎ 棚卸し")
    a("")
    a(f"対象ファイル数: {len(recs)}")
    a(f"期間: {recs[0]['date']} 〜 {recs[-1]['date']}")
    a("")

    a("## 分布")
    a("")
    for label, key in (("文字コード", "encoding"), ("改行コード", "newline"),
                       ("列数", "ncols")):
        c = Counter(r[key] for r in recs)
        a(f"- {label}: " + " / ".join(f"{k}={v}件" for k, v in c.most_common()))
    a("")

    # ---- 構造の変化点 ----
    a("## 構造の変化点")
    a("")
    prev = None
    segments: list[tuple[dict, dict]] = []   # (開始レコード, 終了レコード)
    for r in recs:
        if prev is None or signature(r) != signature(prev):
            segments.append((r, r))
        else:
            segments[-1] = (segments[-1][0], r)
        prev = r

    a(f"構造は {len(segments)} 区間に分かれます。")
    a("")
    for i, (start, end) in enumerate(segments):
        span = start["date"] if start is end else f"{start['date']} 〜 {end['date']}"
        n = recs.index(end) - recs.index(start) + 1
        a(f"### 区間{i + 1}: {span}  （{n}件）")
        a(f"- 列数 {start['ncols']} / {start['encoding']} / {start['newline']}")
        if i > 0:
            a("- 前区間からの変化:")
            for line in header_diff(segments[i - 1][1]["header"], start["header"]):
                a(f"  {line}")
        a("")

    # ---- 問題のあるファイル ----
    bad = [r for r in recs if r["issues"]]
    a(f"## 問題が検出されたファイル: {len(bad)} 件")
    a("")
    for r in bad:
        a(f"- **{r['file']}** ({r['date']}, {r['bytes']:,}B)")
        for msg in r["issues"]:
            a(f"  - {msg}")
    a("")

    # ---- 行数の推移（急変のみ）----
    a("## データ行数の急変")
    a("")
    jumps = []
    for p, c in zip(recs, recs[1:]):
        if p["nrows"] and abs(c["nrows"] - p["nrows"]) / p["nrows"] > 0.02:
            jumps.append((p, c))
    if jumps:
        for p, c in jumps:
            a(f"- {c['date']}: {p['nrows']} → {c['nrows']} 行  ({c['file']})")
    else:
        a("（2%を超える変動なし）")
    a("")

    if full:
        a("## 全ファイル一覧")
        a("")
        a("| 基準日 | 列数 | 行数 | バイト | 文字コード | 改行 | 備考 |")
        a("|---|---|---|---|---|---|---|")
        for r in recs:
            a(f"| {r['date']} | {r['ncols']} | {r['nrows']} | {r['bytes']:,} | "
              f"{r['encoding']} | {r['newline']} | {'; '.join(r['issues'])} |")
        a("")

    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("directory")
    ap.add_argument("--out", default=None, help="Markdownで書き出すパス")
    ap.add_argument("--full", action="store_true", help="全ファイル一覧も出力")
    ap.add_argument("--pattern", default="*.csv")
    args = ap.parse_args()

    src = Path(args.directory)
    if not src.is_dir():
        sys.exit(f"ディレクトリが見つかりません: {src}")

    files = sorted(src.glob(args.pattern), key=lambda p: ref_date(p.name))
    if not files:
        sys.exit(f"対象ファイルがありません: {src}\\{args.pattern}")

    recs = [inspect(p) for p in files]
    lines = build_report(recs, args.full)

    text = "\n".join(lines)
    log(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        log(f"\n書き出しました: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
