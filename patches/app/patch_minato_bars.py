"""src/minato.js パッチ：5歳階級の棒グラフで数値ラベルが改行される問題を直す

原因: 棒が長いと「数値ラベル＋棒」の幅がセルを超え、ラベルが次の行に押し出される。
対処: 1行をフレックスレイアウトにし、ラベルは固定幅・改行なし、棒は残りの幅（トラック）
      に対する割合で描く。値や計算は変えない。

実行場所: リポジトリ直下
    python patches/app/patch_minato_bars.py
"""
import shutil, sys
from pathlib import Path

P = Path("src/minato.js")
raw = P.read_bytes()
bom = raw.startswith(b"\xef\xbb\xbf")
text = raw.decode("utf-8-sig")
nl = "\r\n" if "\r\n" in text else "\n"
text = text.replace("\r\n", "\n")

if ".prow{" in text:
    sys.exit("中止: 既に適用済み")

EDITS = [
    (''' .bar{height:.8rem;border-radius:2px;display:inline-block;vertical-align:middle}
 .bm{background:var(--m)} .bf{background:var(--f)}
 td.pl{text-align:right;width:28%} td.pr{width:28%}''',
     ''' .bar{height:.8rem;border-radius:2px;display:block;flex:none}
 .bm{background:var(--m)} .bf{background:var(--f)}
 td.pl,td.pr{width:34%}
 .prow{display:flex;align-items:center;gap:.35rem;white-space:nowrap}
 .pl .prow{justify-content:flex-end}
 .prow .lbl{flex:none;font-size:.8rem;color:var(--mut);font-variant-numeric:tabular-nums}
 tbody td:first-child,tfoot th:first-child{white-space:nowrap}
 .tblwrap{overflow-x:auto;-webkit-overflow-scrolling:touch}'''),
    # 表が画面幅を超える場合は、ページ全体ではなく表だけを横スクロールさせる
    ('''<table><thead><tr><th>年齢</th><th class="num">男</th><th>女</th><th class="num">男女計</th></tr></thead>''',
     '''<div class="tblwrap"><table><thead><tr><th>年齢</th><th class="num">男</th><th>女</th><th class="num">男女計</th></tr></thead>'''),
    ('''</tfoot>
</table>''',
     '''</tfoot>
</table></div>'''),
    ('''    <td class="pl"><span class="mut">${num(r.male)}</span> <span class="bar bm" style="width:${w(r.male)}"></span></td>
    <td class="pr"><span class="bar bf" style="width:${w(r.female)}"></span> <span class="mut">${num(r.female)}</span></td>''',
     '''    <td class="pl"><div class="prow"><span class="lbl">${num(r.male)}</span><span class="bar bm" style="width:${w(r.male)}"></span></div></td>
    <td class="pr"><div class="prow"><span class="bar bf" style="width:${w(r.female)}"></span><span class="lbl">${num(r.female)}</span></div></td>'''),
    # 棒の長さは「行の幅 − ラベル分（最大 7 桁＋区切り）」に対する割合。0 は描かない
    ('''  const w = (v) => `${((100 * (v ?? 0)) / maxV).toFixed(1)}%`;''',
     '''  // ラベル分の幅は、表示する数値の最大桁数から決める（桁が増えても棒がはみ出さない）
  const maxChars = Math.max(1, ...rows.flatMap((r) => [num(r.male).length, num(r.female).length]));
  const reserve = (maxChars * 0.5 + 0.8).toFixed(2);
  const w = (v) => (v ? `max(1px, calc((100% - ${reserve}em) * ${((v ?? 0) / maxV).toFixed(4)}))` : "0");'''),
]
for old, _ in EDITS:
    n = text.count(old)
    if n != 1:
        sys.exit(f"中止: 置換元が {n} 回出現（1回であるべき）:\n{old[:80]}")
for old, new in EDITS:
    text = text.replace(old, new)

shutil.copy2(P, P.with_suffix(".js.bak"))
P.write_bytes((b"\xef\xbb\xbf" if bom else b"") + text.replace("\n", nl).encode("utf-8"))
print("適用完了: src/minato.js の棒グラフのレイアウトを修正")
