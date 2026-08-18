-- sql/seasonality_households.sql
--
-- 世帯数の季節変動指数を前計算する。
--
-- sql/seasonality.sql（人口版）の複製。手法・窓・採用条件は一切変えない。
-- 変えたのは入力だけ。
--
--   人口版: v_nl_population の population（年齢×男女を SUM したもの）
--   世帯版: v_households_5y の value（既に1町丁1ヶ月1行。SUM 不要）
--
-- なぜ複製するのか:
--   人口版のテーブル・ビューには一切触れない。公開版（/analyze）が
--   参照しているため、共通化して壊すと本番に影響する。
--   23区展開のときに measure 列を持つ形へ統合するのが本筋だが、
--   それは構造変更なので今はやらない。→ known_issues 候補
--
-- 年齢階級別（v_nl_seasonality_age 相当）は作らない。
--   世帯数は年齢の内訳を持たない。空のビューを置くより、
--   存在しないことを明示するほうがよい。
--
-- 対象期間: 2012-08-01 以降
--   世帯数にも同じ系列断絶がある。2012-07 → 08 で +3,736世帯、
--   前後の月次変動が数十〜百数十世帯なので、通常変動の20倍以上。
--   人口側（+6,858人）と割ると 1.84人/世帯 で、区全体の世帯人員に近い。
--   同一の制度変更が両系列に同時に効いていることを確認済み。

-- =====================================================================
-- 1. 町丁 × 月 の世帯数を実体化する
--    88町丁 × 169ヶ月 = 約14,900行。
-- =====================================================================
DROP TABLE IF EXISTS agg_hh_month;

CREATE TABLE agg_hh_month (
  key_code       TEXT    NOT NULL,
  area_name      TEXT,
  reference_date TEXT    NOT NULL,
  month_index    INTEGER NOT NULL,  -- 年*12+月。欠測月を跨いでも距離が正しく出る
  month          TEXT    NOT NULL,  -- '01'..'12'
  households     INTEGER NOT NULL,
  PRIMARY KEY (key_code, reference_date)
);

INSERT INTO agg_hh_month
SELECT key_code,
       area_name,
       reference_date,
       CAST(substr(reference_date, 1, 4) AS INTEGER) * 12
         + CAST(substr(reference_date, 6, 2) AS INTEGER),
       substr(reference_date, 6, 2),
       value
  FROM v_households_5y
 WHERE reference_date >= '2012-08-01';

CREATE INDEX idx_agg_hh_month_idx ON agg_hh_month (key_code, month_index);


-- =====================================================================
-- 2. 季節指数の素データ
--
--   トレンドは 2×12 移動平均。RANGE で month_index の距離を数えるので、
--   欠測月（2017-07 / 2024-12）は窓から外れるだけでずれを生まない。
--   win_n = 13 で窓が完全に埋まっている月だけ採用する。
--
--   ここは人口版と完全に同一。指標が変わっても手法は変わらない。
-- =====================================================================
DROP TABLE IF EXISTS agg_seasonality_hh_raw;

CREATE TABLE agg_seasonality_hh_raw (
  key_code   TEXT NOT NULL,
  area_name  TEXT,
  month      TEXT NOT NULL,
  raw_index  REAL NOT NULL,   -- 正規化前の平均比率
  n_years    INTEGER NOT NULL,-- 採用できた年数
  n_above    INTEGER NOT NULL,-- そのうち比率が1を超えた年数（再現性の指標）
  PRIMARY KEY (key_code, month)
);

INSERT INTO agg_seasonality_hh_raw
WITH t AS (
  SELECT key_code,
         area_name,
         month,
         households,
         ( AVG(households) OVER w_back + AVG(households) OVER w_fwd ) / 2.0 AS trend,
         COUNT(*) OVER w_full AS win_n
    FROM agg_hh_month
  WINDOW
    w_back AS (PARTITION BY key_code ORDER BY month_index RANGE BETWEEN 6 PRECEDING AND 5 FOLLOWING),
    w_fwd  AS (PARTITION BY key_code ORDER BY month_index RANGE BETWEEN 5 PRECEDING AND 6 FOLLOWING),
    w_full AS (PARTITION BY key_code ORDER BY month_index RANGE BETWEEN 6 PRECEDING AND 6 FOLLOWING)
),
r AS (
  SELECT key_code, area_name, month,
         households * 1.0 / trend AS ratio
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
-- 3. ビュー
-- =====================================================================
DROP VIEW IF EXISTS v_nl_seasonality_hh;
DROP VIEW IF EXISTS v_nl_seasonality_hh_strength;

-- 町丁 × 暦月 の季節指数
--   pct_vs_trend: その月の世帯数がトレンド比で何%高い（低い）か
CREATE VIEW v_nl_seasonality_hh AS
SELECT s.key_code,
       s.area_name,
       s.month,
       ROUND(s.raw_index / n.mean_index, 5)                  AS seasonal_index,
       ROUND((s.raw_index / n.mean_index - 1.0) * 100, 2)    AS pct_vs_trend,
       s.n_years,
       s.n_above
  FROM agg_seasonality_hh_raw s
  JOIN (SELECT key_code, AVG(raw_index) AS mean_index
          FROM agg_seasonality_hh_raw
         GROUP BY key_code) n
    ON n.key_code = s.key_code;

-- 町丁ごとの季節変動の強さ
CREATE VIEW v_nl_seasonality_hh_strength AS
WITH pk AS (
  SELECT key_code, area_name,
         month           AS peak_month,
         MAX(pct_vs_trend) AS peak_pct
    FROM v_nl_seasonality_hh
   GROUP BY key_code
),
tr AS (
  SELECT key_code,
         month           AS trough_month,
         MIN(pct_vs_trend) AS trough_pct
    FROM v_nl_seasonality_hh
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
--   -- 88町丁 × 12ヶ月 = 1056行になるはず（人口版と同数）
--   SELECT COUNT(*) FROM agg_seasonality_hh_raw;
--
--   -- 正規化が効いていれば平均が 1.0
--   SELECT key_code, ROUND(AVG(seasonal_index), 6) FROM v_nl_seasonality_hh
--    GROUP BY key_code ORDER BY 2 LIMIT 5;
--
--   -- 採用年数。13前後なら健全
--   SELECT MIN(n_years), MAX(n_years), AVG(n_years) FROM agg_seasonality_hh_raw;
--
--   -- 人口版との突合。駒場4丁目の振幅が世帯数でも突出するか。
--   -- 人口では 8.86%（次点 2.42%）だった。
--   SELECT p.area_name,
--          p.amplitude_pct AS pop_amp,
--          h.amplitude_pct AS hh_amp,
--          p.trough_month  AS pop_trough,
--          h.trough_month  AS hh_trough
--     FROM v_nl_seasonality_strength p
--     JOIN v_nl_seasonality_hh_strength h ON h.key_code = p.key_code
--    ORDER BY p.amplitude_pct DESC
--    LIMIT 10;
-- =====================================================================
