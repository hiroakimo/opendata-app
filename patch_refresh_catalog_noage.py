"""scripts/refresh_catalog.sql パッチ
年齢区分なし系列（observations_noage / source_file_periods）を dataset_periods に反映する。
"""
import shutil, sys
from pathlib import Path

P = Path("scripts/refresh_catalog.sql")
src = P.read_text(encoding="utf-8")
MARK = "-- (1b) ファイル側：複数月を含むファイル"
if MARK in src:
    sys.exit("中止: 既に適用済み")

ANCHOR = "-- (2) 観測側 5y：実際にデータが引ける月か"
if src.count(ANCHOR) != 1:
    sys.exit("中止: 挿入位置（(2) 観測側 5y）が見つからない")

ADD_1B = """-- (1b) ファイル側：複数月を含むファイル（source_files.reference_date は NULL）
INSERT INTO dataset_periods (dataset_key, reference_date, file_count, obs_rows)
SELECT ds.dataset_key,
       p.reference_date,
       COUNT(*),
       0
FROM source_file_periods p
JOIN source_files sf ON sf.sha256 = p.sha256
JOIN dataset_sources ds
  ON ds.dataset = sf.dataset
 AND ds.granularity = sf.granularity
WHERE sf.status = 'ingested'
  AND sf.is_current = 1          -- 同じリソースの旧世代（月が重なる）は数えない
  AND sf.reference_date IS NULL
GROUP BY 1, 2
ON CONFLICT(dataset_key, reference_date)
DO UPDATE SET file_count = file_count + excluded.file_count;

"""
ADD_4 = """

-- (4) 観測側 年齢区分なし
INSERT INTO dataset_periods (dataset_key, reference_date, file_count, obs_rows)
SELECT d.dataset_key, o.reference_date, 0, COUNT(*)
FROM observations_noage o
JOIN datasets d
  ON d.muni_code = o.muni_code
 AND d.granularity = 'noage'
GROUP BY 1, 2
ON CONFLICT(dataset_key, reference_date)
DO UPDATE SET obs_rows = excluded.obs_rows;
"""
new = src.replace(ANCHOR, ADD_1B + ANCHOR).rstrip("\n") + ADD_4
shutil.copy2(P, P.with_suffix(".sql.bak"))
P.write_text(new, encoding="utf-8")
print("適用完了")
