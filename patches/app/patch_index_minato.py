"""src/index.js パッチ：港区専用ページ（src/minato.js）への入口を追加する

実行場所: リポジトリ直下
    python patches/app/patch_index_minato.py

変更内容（目黒区の画面の動作は変えない）
  1. import { handleMinato } from "./minato.js" を追加
  2. router に /minato 以下のルートを追加（デモ環境では minato.js 側で 404 扱い）
  3. データセット一覧に、認証環境でのみ港区ページへのリンクを表示

安全策
  - 挿入位置の文字列がそれぞれ1回だけ出現する場合のみ適用
  - src/minato.js が無ければ中止
  - 改行コード（LF/CRLF）と BOM は元のファイルに合わせる
  - 変更前のファイルを .bak に保存
"""
import shutil, sys
from pathlib import Path

P = Path("src/index.js")
if not Path("src/minato.js").exists():
    sys.exit("中止: src/minato.js がありません。先に配置してください")

raw = P.read_bytes()
bom = raw.startswith(b"\xef\xbb\xbf")
text = raw.decode("utf-8-sig")
nl = "\r\n" if "\r\n" in text else "\n"
text = text.replace("\r\n", "\n")

if 'from "./minato.js"' in text:
    sys.exit("中止: 既に適用済み")

EDITS = [
    ('import { handleLab } from "./lab.js";',
     'import { handleLab } from "./lab.js";',
     '\nimport { handleMinato } from "./minato.js";     // 20260915 追加（港区・認証環境のみ）',
     "after_line"),
    ('  if (url.pathname === "/download/csv") return downloadCsv(env, url);',
     None,
     '\n\n  // 港区（試験表示）。目黒区の画面とは切り離した専用ページ。デモでは null が返り 404 になる\n'
     '  if (url.pathname === "/minato" || url.pathname.startsWith("/minato/")) {\n'
     '    const mn = await handleMinato(url, env);\n'
     '    if (mn) return mn;\n'
     '  }',
     "after_line"),
    ('<p class="mut">東京都オープンデータ統合基盤（試験公開）</p>',
     None,
     '\n${env.DEMO_MODE !== "1" ? \'<p class="mut">港区（試験表示・認証環境のみ）：<a href="/minato">港区のページへ</a></p>\' : ""}',
     "after_text"),
]

for anchor, _, _, _ in EDITS:
    n = text.count(anchor)
    if n != 1:
        sys.exit(f"中止: 挿入位置が {n} 回出現（1回であるべき）: {anchor}")

for anchor, _, add, mode in EDITS:
    i = text.index(anchor) + len(anchor)
    if mode == "after_line":
        j = text.index("\n", i)          # 行末（コメントを含む）の後ろに入れる
        text = text[:j] + add + text[j:]
    else:
        text = text[:i] + add + text[i:]

shutil.copy2(P, P.with_suffix(".js.bak"))
out = text.replace("\n", nl)
P.write_bytes((b"\xef\xbb\xbf" if bom else b"") + out.encode("utf-8"))
print("適用完了: src/index.js に港区ページへの入口を追加")
