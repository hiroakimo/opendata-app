"""
patch_web5y_v2.py —— 港区 区ページ5歳階級表パーサーを例外対応版（v2）に更新する

実行場所: リポジトリ直下
    python patches/pipeline/patch_web5y_v2.py

変更内容
  1. pipeline/wards/minato/web5y/parse.py を v2 に置き換える
     - 空欄セル（cell_exceptions）と小計の不一致（subtotal_exceptions）を、
       exceptions.json に登録した箇所だけ通す（登録値と原本が完全一致すること）
     - 空欄は NULL のまま保持し、異常フラグを付け、性別不明の導出から除外
     - 空欄の推定値は「CKAN系列から引いた値」と「小計から引いた値」が一致した場合のみ記録
     - anomalies.csv を出力
  2. pipeline/wards/minato/exceptions.json に "web5y" を追加（既存の内容は変えない）
     - 2025-04-01 赤坂1丁目 外国人50〜54歳 女が空欄
     - 2026-01-01 赤坂7丁目 外国人 小計15〜64歳の総数が1少ない

安全策
  - parse.py が配布した v1 と完全一致する場合のみ置き換える（v2 なら適用済みとして止まる）
  - 変更前のファイルは .bak に保存し、構文エラーなら元に戻す
"""
import base64, hashlib, json, py_compile, shutil, sys, zlib
from pathlib import Path

PARSE = Path("pipeline/wards/minato/web5y/parse.py")
EXC = Path("pipeline/wards/minato/exceptions.json")
V1_SHA = "6e9b5241ac6f799b0203c29396338e198ef5764257857493f8d869a17d1ee1fb"
V2_SHA = "2fe101a03cd95781ed5045ebe8666640fc5362b1b4351dbfcd758b0e77b1b700"
V2 = zlib.decompress(base64.b64decode(
    "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"
    "/MiSlvg/S3qJnQ=="
))
WEB5Y = json.loads("{\"cell_exceptions\": [{\"id\": \"minato-5y-2025-04-akasaka1-foreign-50-54\", \"reference_date\": \"2025-04-01\", \"area_name\": \"赤坂1丁目\", \"nationality\": \"foreign\", \"age_class\": \"50-54\", \"kind\": \"blank_cell\", \"reported\": {\"total\": 9, \"male\": 7, \"female\": null}, \"treatment\": \"keep_reported_flag\", \"note\": \"外国人50〜54歳の女のセルが空欄。値は補わずNULLのまま保持し、性別不明の導出から除外する。本来の値はCKAN系列と小計の双方から引いた値が一致した場合のみ推定値として記録する。\"}], \"subtotal_exceptions\": [{\"id\": \"minato-5y-2026-01-akasaka7-foreign-sub15-64\", \"reference_date\": \"2026-01-01\", \"area_name\": \"赤坂7丁目\", \"nationality\": \"foreign\", \"subtotal\": \"15-64\", \"kind\": \"subtotal_mismatch\", \"reported\": {\"total\": 204, \"male\": 105, \"female\": 99}, \"computed\": {\"total\": 205, \"male\": 105, \"female\": 99}, \"treatment\": \"validation_only\", \"note\": \"小計（15〜64歳）の総数が男+女（204）で計算されており、各年齢の総数の合計（205、性別不明1人を含む）と一致しない。小計行は保存しないため検証のみ。\"}]}")

if hashlib.sha256(V2).hexdigest() != V2_SHA:
    sys.exit("中止: パッチ本体が壊れている")
if not PARSE.exists() or not EXC.exists():
    sys.exit("中止: リポジトリ直下で実行してください（対象ファイルが見つからない）")

cur = hashlib.sha256(PARSE.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
exc = json.loads(EXC.read_text(encoding="utf-8"))
if cur == V2_SHA and exc.get("web5y") == WEB5Y:
    sys.exit("中止: 既に適用済み")
if cur not in (V1_SHA, V2_SHA):
    sys.exit("中止: parse.py が想定の版と異なる（手で変更された可能性）")
if "web5y" in exc and exc["web5y"] != WEB5Y:
    sys.exit("中止: exceptions.json に別内容の web5y が既にある")

shutil.copy2(PARSE, PARSE.with_suffix(".py.bak"))
shutil.copy2(EXC, EXC.with_suffix(".json.bak"))
PARSE.write_bytes(V2)
try:
    py_compile.compile(str(PARSE), doraise=True)
except py_compile.PyCompileError as e:
    shutil.copy2(PARSE.with_suffix(".py.bak"), PARSE)
    sys.exit(f"構文エラーのため元に戻しました: {e}")
exc["web5y"] = WEB5Y
EXC.write_text(json.dumps(exc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("適用完了: parse.py を v2 に更新、exceptions.json に web5y（例外2件）を追加")
