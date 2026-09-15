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

-- (1b) ファイル側：複数月を含むファイル（source_files.reference_date は NULL）
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

-- (5) 観測側 5歳階級（区横断）
INSERT INTO dataset_periods (dataset_key, reference_date, file_count, obs_rows)
SELECT o.dataset_key, o.reference_date, 0, COUNT(*)
FROM observations_age5 o
JOIN datasets d ON d.dataset_key = o.dataset_key
GROUP BY 1, 2
ON CONFLICT(dataset_key, reference_date)
DO UPDATE SET obs_rows = excluded.obs_rows;

-- (6) 性別の内訳に含まれない人数の有無（注記の自動判定。町丁目・人数は持たない）
--     方針: docs/policy/sex_residual.md
--     D1 は compound SELECT の項数に上限があるため、UNION を使わず UPDATE を分ける。
DELETE FROM dataset_sex_residual;

INSERT INTO dataset_sex_residual (dataset_key, reference_date, has_residual)
SELECT dataset_key, reference_date, 0 FROM dataset_periods;

UPDATE dataset_sex_residual SET has_residual = 1
 WHERE dataset_key || '|' || reference_date IN (
   SELECT d.dataset_key || '|' || o.reference_date
     FROM observations_noage o
     JOIN datasets d ON d.muni_code = o.muni_code AND d.granularity = 'noage'
    WHERE o.measure = 'population' AND o.sex = 'unknown' AND o.value > 0);

UPDATE dataset_sex_residual SET has_residual = 1
 WHERE dataset_key || '|' || reference_date IN (
   SELECT dataset_key || '|' || reference_date
     FROM observations_age5
    WHERE measure = 'population' AND sex = 'unknown' AND value > 0);

UPDATE dataset_sex_residual SET has_residual = 1
 WHERE dataset_key || '|' || reference_date IN (
   SELECT d.dataset_key || '|' || x.reference_date
     FROM (SELECT muni_code, key_code, reference_date, age_class,
                  SUM(CASE WHEN sex = 'total' THEN value END) AS t,
                  SUM(CASE WHEN sex IN ('male', 'female') THEN value END) AS mf
             FROM observations_5y WHERE measure = 'population'
            GROUP BY 1, 2, 3, 4) x
     JOIN datasets d ON d.muni_code = x.muni_code AND d.granularity = '5y'
    WHERE x.t != x.mf);

UPDATE dataset_sex_residual SET has_residual = 1
 WHERE dataset_key || '|' || reference_date IN (
   SELECT d.dataset_key || '|' || x.reference_date
     FROM (SELECT muni_code, key_code, reference_date, age_class,
                  SUM(CASE WHEN sex = 'total' THEN value END) AS t,
                  SUM(CASE WHEN sex IN ('male', 'female') THEN value END) AS mf
             FROM observations_1y
            GROUP BY 1, 2, 3, 4) x
     JOIN datasets d ON d.muni_code = x.muni_code AND d.granularity = '1y'
    WHERE x.t != x.mf);
