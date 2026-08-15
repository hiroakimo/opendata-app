-- sql/seasonality.sql
--
-- 町丁ごとの季節変動指数を前計算する。
--
-- 手法: 移動平均比率法（ratio-to-moving-average）
--   1. 各町丁の12ヶ月中心化移動平均を取り、トレンド成分とする
--   2. 実測値 ÷ トレンド = 比率（トレンドを除いた季節成分）
--   3. 暦月ごとに比率を平均し、季節指数とする
--   4. 12ヶ月の平均が 1.0 になるよう正規化
--
-- なぜLLMに書かせないか:
--   トレンド除去を省くと、単なる人口増加を季節変動と誤認する。
--   手順を固定し、LLM には WHERE / ORDER BY だけ書かせる。
--
-- 対象期間: 2012-08-01 以降
--   2012-08 に住民基本台帳法改正による系列断絶があり、それ以前と
--   総人口の定義が異なる。移動平均の窓が断絶を跨ぐと比率が汚染されるため、
--   断絶以降に限定する（dataset_gaps に記録済みの事実を分析設計に反映）。

-- =====================================================================
-- 1. 町丁 × 月 の人口を実体化する
--    v_nl_population は72万行の集計ビューなので、期間指定なしで
--    窓関数をかけると毎回全走査になる。88町丁 × 169ヶ月 = 約14,900行。
-- =====================================================================
DROP TABLE IF EXISTS agg_pop_month;

CREATE TABLE agg_pop_month (
  key_code       TEXT    NOT NULL,
  area_name      TEXT,
  reference_date TEXT    NOT NULL,
  month_index    INTEGER NOT NULL,  -- 年*12+月。欠測月を跨いでも距離が正しく出る
  month          TEXT    NOT NULL,  -- '01'..'12'
  population     INTEGER NOT NULL,
  PRIMARY KEY (key_code, reference_date)
);

INSERT INTO agg_pop_month
SELECT key_code,
       area_name,
       reference_date,
       CAST(substr(reference_date, 1, 4) AS INTEGER) * 12
         + CAST(substr(reference_date, 6, 2) AS INTEGER),
       substr(reference_date, 6, 2),
       population
  FROM v_nl_population
 WHERE reference_date >= '2012-08-01';

CREATE INDEX idx_agg_pop_month_idx ON agg_pop_month (key_code, month_index);


-- =====================================================================
-- 2. 季節指数の素データ
--
--   トレンドは 2×12 移動平均（12ヶ月移動平均を2つ平均したもの）。
--   単純13ヶ月平均だと窓の両端が同じ暦月になり、その月だけ二重に
--   数えてしまうため、この形にしている。
--
--   RANGE を使うのは欠測月（2017-07 / 2024-12）への対処。
--   ROWS だと行数で数えるので、欠測を跨ぐと12行=13ヶ月になってずれる。
--   RANGE なら month_index の距離で数えるので、欠測分は単に窓から外れる。
--
--   win_n = 13 の条件で、窓が完全に埋まっている月だけを採用する。
--   これにより期間の先頭6ヶ月・末尾6ヶ月と、欠測の前後は自動的に除外される。
-- =====================================================================
DROP TABLE IF EXISTS agg_seasonality_raw;

CREATE TABLE agg_seasonality_raw (
  key_code   TEXT NOT NULL,
  area_name  TEXT,
  month      TEXT NOT NULL,
  raw_index  REAL NOT NULL,   -- 正規化前の平均比率
  n_years    INTEGER NOT NULL,-- 採用できた年数
  n_above    INTEGER NOT NULL,-- そのうち比率が1を超えた年数（再現性の指標）
  PRIMARY KEY (key_code, month)
);

INSERT INTO agg_seasonality_raw
WITH t AS (
  SELECT key_code,
         area_name,
         month,
         population,
         ( AVG(population) OVER w_back + AVG(population) OVER w_fwd ) / 2.0 AS trend,
         COUNT(*) OVER w_full AS win_n
    FROM agg_pop_month
  WINDOW
    w_back AS (PARTITION BY key_code ORDER BY month_index RANGE BETWEEN 6 PRECEDING AND 5 FOLLOWING),
    w_fwd  AS (PARTITION BY key_code ORDER BY month_index RANGE BETWEEN 5 PRECEDING AND 6 FOLLOWING),
    w_full AS (PARTITION BY key_code ORDER BY month_index RANGE BETWEEN 6 PRECEDING AND 6 FOLLOWING)
),
r AS (
  SELECT key_code, area_name, month,
         population * 1.0 / trend AS ratio
    FROM t
   WHERE win_n = 13
     AND trend > 0
)
SELECT key_code,
       area_name,
       month,
       AVG(ratio),
       COUNT(*),
       SUM(CASE WHEN ratio > 1.0 THEN 1 ELSE 0 END)
  FROM r
 GROUP BY key_code, month;


-- =====================================================================
-- 3. LLM に見せるビュー
-- =====================================================================
DROP VIEW IF EXISTS v_nl_seasonality;
DROP VIEW IF EXISTS v_nl_seasonality_strength;

-- 町丁 × 暦月 の季節指数
--   pct_vs_trend: その月の人口がトレンド比で何%高い（低い）か
--   n_above / n_years: 何年中何年で同じ向きに振れたか。再現性の目安
CREATE VIEW v_nl_seasonality AS
SELECT s.key_code,
       s.area_name,
       s.month,
       ROUND(s.raw_index / n.mean_index, 5)                  AS seasonal_index,
       ROUND((s.raw_index / n.mean_index - 1.0) * 100, 2)    AS pct_vs_trend,
       s.n_years,
       s.n_above
  FROM agg_seasonality_raw s
  JOIN (SELECT key_code, AVG(raw_index) AS mean_index
          FROM agg_seasonality_raw
         GROUP BY key_code) n
    ON n.key_code = s.key_code;

-- 町丁ごとの季節変動の強さ
--   amplitude_pct: 年間で最も高い月と最も低い月の差（%ポイント）
--   peak_month / trough_month: それぞれの暦月
CREATE VIEW v_nl_seasonality_strength AS
WITH pk AS (
  SELECT key_code, area_name,
         month           AS peak_month,
         MAX(pct_vs_trend) AS peak_pct
    FROM v_nl_seasonality
   GROUP BY key_code
),
tr AS (
  SELECT key_code,
         month           AS trough_month,
         MIN(pct_vs_trend) AS trough_pct
    FROM v_nl_seasonality
   GROUP BY key_code
)
SELECT pk.key_code,
       pk.area_name,
       ROUND(pk.peak_pct - tr.trough_pct, 2) AS amplitude_pct,
       pk.peak_month,
       pk.peak_pct,
       tr.trough_month,
       tr.trough_pct
  FROM pk JOIN tr ON tr.key_code = pk.key_code;


-- =====================================================================
-- 検証用
--
--   -- 各町丁12ヶ月ぶん、計1056行になるはず
--   SELECT COUNT(*) FROM agg_seasonality_raw;
--
--   -- 正規化が効いていれば平均が 1.0 になる
--   SELECT key_code, ROUND(AVG(seasonal_index), 6) FROM v_nl_seasonality
--    GROUP BY key_code ORDER BY 2 LIMIT 5;
--
--   -- 採用年数。13前後なら健全
--   SELECT MIN(n_years), MAX(n_years), AVG(n_years) FROM agg_seasonality_raw;
-- =====================================================================
