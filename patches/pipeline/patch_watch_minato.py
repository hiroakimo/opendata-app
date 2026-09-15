"""watch_v2.py パッチ：港区オープンデータカタログ（独自CKAN）を監視対象に追加する。

- パッケージ: jinko-chochomokubetsu（町丁目別人口・世帯数、年1ファイル・当年分は毎月追記）
- ファイル名は年のみ（chomokubetsu_2026.csv）。月の基準日は読めないので date_patterns は空。
  年ファイルの追加（毎年1月）は、未知の resource_id として NEW で検知される。
- 港区CKANの組織は「港区」1つのため、組織だけで絞ると全データセットが出る。
  人口系は name が jinko- で始まる前提で name:jinko* に絞る。
"""
import py_compile, shutil, sys
from pathlib import Path

P = Path("watch_v2.py")
src = P.read_text(encoding="utf-8")
if '"minato_catalog:minato"' in src:
    sys.exit("中止: 既に適用済み")

ANCHOR = '''        "note": "ファイルは www.opendata.metro.tokyo.lg.jp。size は空。検知のみ",
    },
}'''
ADD = '''        "note": "ファイルは www.opendata.metro.tokyo.lg.jp。size は空。検知のみ",
    },
    "minato_catalog:minato": {
        "source_site": "minato_catalog",
        "muni_code": "131032",
        "muni_name": "港区",
        "api_base": "https://opendata.city.minato.tokyo.jp/api/3/action/",
        "packages": [
            "jinko-chochomokubetsu",
        ],
        # 組織は「港区」1つだけなので、名前で人口系に絞る
        "discovery_fq": "organization:minatoku AND name:jinko*",
        # chomokubetsu_2026.csv / chomokubetu_2017.csv → 年しか入っていない。
        # 月は中身（トレーラー行の Ver）で決まるため、ここでは読まない
        "date_patterns": [],
        "enabled": True,
        "note": "港区独自CKAN。年1ファイルで当年分は毎月追記（MODIFIED）、"
                "毎年1月に新しい年のリソースが増える（NEW）。D1取り込み対応済み（minato_noage）",
    },
}'''
n = src.count(ANCHOR)
if n != 1:
    sys.exit(f"中止: 挿入位置が{n}回出現（1回であるべき）")

bak = P.with_suffix(".py.bak")
shutil.copy2(P, bak)
P.write_text(src.replace(ANCHOR, ADD), encoding="utf-8")
try:
    py_compile.compile(str(P), doraise=True)
except py_compile.PyCompileError as e:
    shutil.copy2(bak, P)
    sys.exit(f"構文エラーのため元に戻しました: {e}")

# 適用後チェック：スコープとして読めるか
import importlib.util
spec = importlib.util.spec_from_file_location("w", P)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
cfg = w.SCOPES["minato_catalog:minato"]
assert w.parse_ref_date("chomokubetsu_2026.csv", cfg["date_patterns"]) is None
assert list(w.SCOPES)[:2] == ["bodik:meguro", "tokyo:koto"]
print(f"適用完了（バックアップ: {bak}）スコープ: {list(w.SCOPES)}")
