"""parse_minato_ckan.py パッチ v2
summary.md の「性別不明が1以上の町丁目」が、リソースの並び順（新しい年が先）の
まま出力されていたため、期間の表示が逆転していた。日付順に並べ替え、
連続していない場合は区間ごとに表示する。
"""
import py_compile, shutil, sys
from pathlib import Path

P = Path("parse_minato_ckan.py")
src = P.read_text(encoding="utf-8")

OLD = '''    for t, xs in sorted(unknown_pos.items(), key=lambda kv: kv[1][0][0]):
        L.append(f"- {t}: {len(xs)}か月 {xs[0][0]}〜{xs[-1][0]} 最大{max(v for _, v in xs)}")'''
NEW = '''    all_months = sorted(monthly)
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
        L.append(f"- {t}: {len(xs)}か月 {desc}")'''

if NEW in src:
    sys.exit("中止: 既に適用済み")
n = src.count(OLD)
if n != 1:
    sys.exit(f"中止: 置換元が{n}回出現（1回であるべき）")

bak = P.with_suffix(".py.bak")
shutil.copy2(P, bak)
P.write_text(src.replace(OLD, NEW), encoding="utf-8")
try:
    py_compile.compile(str(P), doraise=True)
except py_compile.PyCompileError as e:
    shutil.copy2(bak, P)
    sys.exit(f"構文エラーのため元に戻しました: {e}")
print(f"適用完了（バックアップ: {bak}）")
