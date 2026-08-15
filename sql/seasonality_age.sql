-- sql/seasonality_age.sql
--
-- 年齢階級別の季節変動指数。seasonality.sql の適用後に流すこと。
--
-- 目的:
--   「7〜9月の減少は留学生によるものか」のような仮説に対し、
--   年齢構成という傍証を出せるようにする。
--   留学生が要因なら 20-24 歳に偏り、高齢層には現れないはず。
--
-- 重要な限界（要件6の注記で必ず出すこと）:
--   これは年齢別の動きであって、国籍別ではない。
--   foreign_population は 2026-04〜08 の5ヶ月しか収録がなく、
--   季節変動を計算できない。したがって留学生仮説は本データでは
--   検証できず、年齢構成との整合性を示せるにとどまる。

-- =====================================================================
-- 1. 町丁 × 月 × 年齢階級 の実体化
--    88町丁 × 169ヶ月 × 19階級 = 約28万行
--    'unknown' は除外する（値が0〜1で比率が発散するため）
-- =====================================================================
DROP TABLE IF EXISTS agg_pop_month_age;

CREATE TABLE agg_pop_month_age (
  key_code       TEXT    NOT NULL,
  area_name      TEXT,
  reference_date TEXT    NOT NULL,
  month_index    INTEGER NOT NULL,
  month          TEXT    NOT NULL,
  age_class      TEXT    NOT NULL,
  age_order      INTEGER NOT NULL,
  population     INTEGER NOT NULL,
  PRIMARY KEY (key_code, reference_date, age_class)
);

INSERT INTO agg_pop_month_age
SELECT key_code,
       area_name,
       reference_date,
       CAST(substr(reference_date, 1, 4) AS INTEGER) * 12
         + CAST(substr(reference_date, 6, 2) AS INTEGER),
       substr(reference_date, 6, 2),
       age_class,
       age_order,
       population
  FROM v_nl_population_by_age
 WHERE reference_date >= '2012-08-01'
   AND age_class <> 'unknown';

CREATE INDEX idx_agg_pma ON agg_pop_month_age (key_code, age_class, month_index);


-- =====================================================================
-- 2. 季節指数
--    手法は seasonality.sql と同一（2×12 移動平均比率法）。
--    PARTITION に age_class を加えるだけ。
--
--    trend >= 20 の条件を足している。人数が一桁の階級では
--    1人の増減が比率を大きく振らせ、季節性と区別がつかないため。
-- =====================================================================
DROP TABLE IF EXISTS agg_seasonality_age_raw;

CREATE TABLE agg_seasonality_age_raw (
  key_code   TEXT NOT NULL,
  area_name  TEXT,
  age_class  TEXT NOT NULL,
  age_order  INTEGER NOT NULL,
  month      TEXT NOT NULL,
  raw_index  REAL NOT NULL,
  n_years    INTEGER NOT NULL,
  n_above    INTEGER NOT NULL,
  PRIMARY KEY (key_code, age_class, month)
);

INSERT INTO agg_seasonality_age_raw
WITH t AS (
  SELECT key_code, area_name, age_class, age_order, month, population,
         ( AVG(population) OVER w_back + AVG(population) OVER w_fwd ) / 2.0 AS trend,
         COUNT(*) OVER w_full AS win_n
    FROM agg_pop_month_age
  WINDOW
    w_back AS (PARTITION BY key_code, age_class ORDER BY month_index
               RANGE BETWEEN 6 PRECEDING AND 5 FOLLOWING),
    w_fwd  AS (PARTITION BY key_code, age_class ORDER BY month_index
               RANGE BETWEEN 5 PRECEDING AND 6 FOLLOWING),
    w_full AS (PARTITION BY key_code, age_class ORDER BY month_index
               RANGE BETWEEN 6 PRECEDING AND 6 FOLLOWING)
),
r AS (
  SELECT key_code, area_name, age_class, age_order, month,
         population * 1.0 / trend AS ratio
    FROM t
   WHERE win_n = 13
     AND trend >= 20
)
SELECT key_code, area_name, age_class, age_order, month,
       AVG(ratio),
       COUNT(*),
       SUM(CASE WHEN ratio > 1.0 THEN 1 ELSE 0 END)
  FROM r
 GROUP BY key_code, age_class, month;


-- =====================================================================
-- 3. LLM に見せるビュー
-- =====================================================================
DROP VIEW IF EXISTS v_nl_seasonality_age;

CREATE VIEW v_nl_seasonality_age AS
SELECT s.key_code,
       s.area_name,
       s.age_class,
       s.age_order,
       s.month,
       ROUND(s.raw_index / n.mean_index, 5)               AS seasonal_index,
       ROUND((s.raw_index / n.mean_index - 1.0) * 100, 2) AS pct_vs_trend,
       s.n_years,
       s.n_above
  FROM agg_seasonality_age_raw s
  JOIN (SELECT key_code, age_class, AVG(raw_index) AS mean_index
          FROM agg_seasonality_age_raw
         GROUP BY key_code, age_class) n
    ON n.key_code = s.key_code AND n.age_class = s.age_class;


-- =====================================================================
-- 使用例
--
-- (1) 区全体で、9月に最も落ち込む年齢階級はどれか
--     留学生仮説が正しければ 20-24 が突出するはず
--
--   SELECT age_class, ROUND(AVG(pct_vs_trend),2) AS avg_pct, COUNT(*) AS n_areas
--     FROM v_nl_seasonality_age WHERE month='09'
--    GROUP BY age_class ORDER BY age_order;
--
-- (2) 20-24歳が 6月→9月で最も減る町丁
--
--   SELECT a.area_name,
--          ROUND(b.seasonal_index/a.seasonal_index*100-100, 2) AS chg_pct
--     FROM v_nl_seasonality_age a
--     JOIN v_nl_seasonality_age b
--       ON b.key_code=a.key_code AND b.age_class=a.age_class
--    WHERE a.age_class='20-24' AND a.month='06' AND b.month='09'
--    ORDER BY chg_pct ASC LIMIT 10;
--
-- (3) 反証テスト: 同じ町丁の 65-69 歳に同様の落ち込みがあるか
--     あれば留学生では説明できない（調査時期など別要因の可能性）
--
--   SELECT area_name, age_class, pct_vs_trend
--     FROM v_nl_seasonality_age
--    WHERE month='09' AND age_class IN ('20-24','65-69')
--      AND area_name LIKE '駒場%'
--    ORDER BY area_name, age_order;
-- =====================================================================
