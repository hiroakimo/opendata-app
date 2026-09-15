"""scripts/refresh_catalog.sql パッチ
区横断の5歳階級テーブル（observations_age5）を dataset_periods に反映する。
observations_age5 は dataset_key を持つので、datasets とは dataset_key で結ぶ。

実行場所: リポジトリ直下
    python patches/pipeline/patch_refresh_catalog_age5.py
"""
import shutil, sys
from pathlib import Path

P = Path("scripts/refresh_catalog.sql")
src = P.read_text(encoding="utf-8")
MARK = "-- (5) 観測側 5歳階級（区横断）"
if MARK in src:
    sys.exit("中止: 既に適用済み")
if "-- (4) 観測側 年齢区分なし" not in src:
    sys.exit("中止: 前提のパッチ（patch_refresh_catalog_noage）が未適用")

ADD = """

-- (5) 観測側 5歳階級（区横断）
INSERT INTO dataset_periods (dataset_key, reference_date, file_count, obs_rows)
SELECT o.dataset_key, o.reference_date, 0, COUNT(*)
FROM observations_age5 o
JOIN datasets d ON d.dataset_key = o.dataset_key
GROUP BY 1, 2
ON CONFLICT(dataset_key, reference_date)
DO UPDATE SET obs_rows = excluded.obs_rows;
"""
shutil.copy2(P, P.with_suffix(".sql.bak"))
P.write_text(src.rstrip("\n") + ADD, encoding="utf-8")
print("適用完了")
