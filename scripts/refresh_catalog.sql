-- =====================================================================
--  refresh_catalog.sql —— dataset_periods を作り直す
--
--  取込処理の最後に毎回実行する。冪等。
--    npx wrangler d1 execute tokyo-population --remote --file=scripts/refresh_catalog.sql
-- =====================================================================

DELETE FROM dataset_periods;

-- (1) ファイル側：取り込みに成功した記録があるか
INSERT INTO dataset_periods (dataset_key, reference_date, file_count, obs_rows)
SELECT ds.dataset_key,
       sf.reference_date,
       COUNT(*),
       0
FROM source_files sf
JOIN dataset_sources ds
  ON ds.dataset = sf.dataset
 AND ds.granularity = sf.granularity
WHERE sf.status = 'ingested'
  AND sf.reference_date IS NOT NULL
GROUP BY 1, 2;

-- (2) 観測側 5y：実際にデータが引ける月か
INSERT INTO dataset_periods (dataset_key, reference_date, file_count, obs_rows)
SELECT d.dataset_key, o.reference_date, 0, COUNT(*)
FROM observations_5y o
JOIN datasets d
  ON d.muni_code = o.muni_code
 AND d.granularity = '5y'
GROUP BY 1, 2
ON CONFLICT(dataset_key, reference_date)
DO UPDATE SET obs_rows = excluded.obs_rows;

-- (3) 観測側 1y
INSERT INTO dataset_periods (dataset_key, reference_date, file_count, obs_rows)
SELECT d.dataset_key, o.reference_date, 0, COUNT(*)
FROM observations_1y o
JOIN datasets d
  ON d.muni_code = o.muni_code
 AND d.granularity = '1y'
GROUP BY 1, 2
ON CONFLICT(dataset_key, reference_date)
DO UPDATE SET obs_rows = excluded.obs_rows;
