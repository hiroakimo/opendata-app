-- sql/nl_views.sql
-- NL→SQL で LLM に見せる専用ビュー。
-- 方針:
--   1. LLM には実テーブルも既存の v_population_* も見せない。このファイルのビューだけ。
--   2. よくある質問が WHERE と ORDER BY だけで書ける形まで集計を済ませておく。
--   3. 公表合計行（age_class='total' / sex='total'）はビュー内で除外済み。
--   4. 系列断絶・欠測の判定はここでは行わない。別の決定論クエリで付与する。

DROP VIEW IF EXISTS v_nl_population;
DROP VIEW IF EXISTS v_nl_population_by_sex;
DROP VIEW IF EXISTS v_nl_population_by_age;
DROP VIEW IF EXISTS v_nl_foreign_population;
DROP VIEW IF EXISTS v_nl_households;
DROP VIEW IF EXISTS v_nl_areas;
DROP VIEW IF EXISTS v_nl_gaps;

-- 1. 町丁 × 年月 の総人口（性・年齢を合算済み）
CREATE VIEW v_nl_population AS
SELECT o.muni_code, o.key_code, a.area_name, o.reference_date,
       SUM(o.value) AS population
  FROM observations_5y o
  LEFT JOIN areas a ON a.key_code = o.key_code
 WHERE o.measure    = 'population'
   AND o.age_class <> 'total'
   AND o.sex       <> 'total'
 GROUP BY o.muni_code, o.key_code, o.reference_date;

-- 2. 町丁 × 年月 × 性別
CREATE VIEW v_nl_population_by_sex AS
SELECT o.muni_code, o.key_code, a.area_name, o.reference_date, o.sex,
       SUM(o.value) AS population
  FROM observations_5y o
  LEFT JOIN areas a ON a.key_code = o.key_code
 WHERE o.measure    = 'population'
   AND o.age_class <> 'total'
   AND o.sex       <> 'total'
 GROUP BY o.muni_code, o.key_code, o.reference_date, o.sex;

-- 3. 町丁 × 年月 × 5歳階級（性別を合算済み）
--    age_order は表示順用。文字列順だと '10-14' < '5-9' になるため必須。
CREATE VIEW v_nl_population_by_age AS
SELECT o.muni_code, o.key_code, a.area_name, o.reference_date, o.age_class,
       CASE
         WHEN o.age_class = 'unknown' THEN 999
         WHEN o.age_class = '85+'     THEN 85
         ELSE CAST(substr(o.age_class, 1, instr(o.age_class, '-') - 1) AS INTEGER)
       END AS age_order,
       SUM(o.value) AS population
  FROM observations_5y o
  LEFT JOIN areas a ON a.key_code = o.key_code
 WHERE o.measure    = 'population'
   AND o.age_class <> 'total'
   AND o.sex       <> 'total'
 GROUP BY o.muni_code, o.key_code, o.reference_date, o.age_class;

-- 4. 外国人人口（総人口の内数。収録は 2026-04-01 以降の5ヶ月のみ）
CREATE VIEW v_nl_foreign_population AS
SELECT o.muni_code, o.key_code, a.area_name, o.reference_date,
       SUM(o.value) AS foreign_population
  FROM observations_5y o
  LEFT JOIN areas a ON a.key_code = o.key_code
 WHERE o.measure  = 'foreign_population'
   AND o.sex     <> 'total'
 GROUP BY o.muni_code, o.key_code, o.reference_date;

-- 5. 世帯数
CREATE VIEW v_nl_households AS
SELECT o.muni_code, o.key_code, a.area_name, o.reference_date,
       SUM(o.value) AS households
  FROM observations_5y o
  LEFT JOIN areas a ON a.key_code = o.key_code
 WHERE o.measure = 'households'
 GROUP BY o.muni_code, o.key_code, o.reference_date;

-- 6. 町丁マスタ（表記ゆれ解決用。別名があると行が増える点に注意）
CREATE VIEW v_nl_areas AS
SELECT a.key_code, a.muni_code, a.area_name, a.first_seen, a.last_seen,
       al.alias_name
  FROM areas a
  LEFT JOIN area_aliases al ON al.key_code = a.key_code;

-- 7. 欠測・系列断絶
CREATE VIEW v_nl_gaps AS
SELECT g.dataset_key, d.muni_name, d.grain_label, g.reference_date,
       g.kind, g.reason
  FROM dataset_gaps g
  LEFT JOIN datasets d ON d.dataset_key = g.dataset_key;
