-- =====================================================================
--  0006_age5_unified.sql —— 5歳階級を区横断で1本にまとめる観測テーブル
--
--  設計方針
--    1. 区ごとに異なる粒度（年齢の上端・国籍の有無・時点）をそのまま保持し、
--       集計時に「選択範囲の最大公約数」へ揃える。揃え方の材料は
--       age_classes（区分の下限・上限）と dataset_traits（系列の性質）に持つ。
--    2. 年齢区分は名前で比較しない。age_lo / age_hi で比較・並べ替えする。
--    3. 国籍は原本にある分だけ入れる。partition の系列では 'all' を保存しない
--       （日本人+外国人で導出できるため）。
--    4. 既存の observations_5y / v_nl_* / agg_* には触れない（デモ保護）。
--       目黒区の移行は Final Stage 後に行う。
--  冪等。ALTER を使わないので何度流しても安全。
-- =====================================================================

CREATE TABLE IF NOT EXISTS age_classes (
  age_class   TEXT    PRIMARY KEY,
  age_lo      INTEGER,                    -- 下限（不詳・合計は NULL）
  age_hi      INTEGER,                    -- 上限（上が開いていれば NULL）
  is_unknown  INTEGER NOT NULL DEFAULT 0,
  is_total    INTEGER NOT NULL DEFAULT 0, -- 原本の合計行（導出可能な冗長行）
  sort_order  INTEGER NOT NULL
);

INSERT OR REPLACE INTO age_classes (age_class, age_lo, age_hi, is_unknown, is_total, sort_order) VALUES
  ('0-4',     0,    4,    0, 0,   0), ('5-9',     5,    9,    0, 0,   5),
  ('10-14',  10,   14,    0, 0,  10), ('15-19',  15,   19,    0, 0,  15),
  ('20-24',  20,   24,    0, 0,  20), ('25-29',  25,   29,    0, 0,  25),
  ('30-34',  30,   34,    0, 0,  30), ('35-39',  35,   39,    0, 0,  35),
  ('40-44',  40,   44,    0, 0,  40), ('45-49',  45,   49,    0, 0,  45),
  ('50-54',  50,   54,    0, 0,  50), ('55-59',  55,   59,    0, 0,  55),
  ('60-64',  60,   64,    0, 0,  60), ('65-69',  65,   69,    0, 0,  65),
  ('70-74',  70,   74,    0, 0,  70), ('75-79',  75,   79,    0, 0,  75),
  ('80-84',  80,   84,    0, 0,  80), ('85-89',  85,   89,    0, 0,  85),
  ('90-94',  90,   94,    0, 0,  90), ('95-99',  95,   99,    0, 0,  95),
  ('85+',    85, NULL,    0, 0,  85), ('100+',  100, NULL,    0, 0, 100),
  ('unknown', NULL, NULL, 1, 0, 998), ('total', NULL, NULL,   0, 1, 999);


-- 系列の性質。集計時の粒度合わせに使う。
CREATE TABLE IF NOT EXISTS dataset_traits (
  dataset_key            TEXT PRIMARY KEY,
  age_top_lo             INTEGER,  -- 上が開いた年齢区分の下限（85 / 100）。年齢なしは NULL
  nationality_semantics  TEXT NOT NULL,  -- none / partition（日本人+外国人=総数）/ subset（外国人は内数）
  time_pattern           TEXT,     -- monthly / semiannual_0101_0401 など（説明用）
  notes                  TEXT
);


CREATE TABLE IF NOT EXISTS observations_age5 (
  dataset_key     TEXT    NOT NULL,
  key_code        TEXT    NOT NULL,
  muni_code       TEXT    NOT NULL,
  reference_date  TEXT    NOT NULL,
  measure         TEXT    NOT NULL,             -- population / households
  nationality     TEXT    NOT NULL,             -- all / japanese / foreign
  age_class       TEXT    NOT NULL REFERENCES age_classes(age_class),
  sex             TEXT    NOT NULL,             -- male / female / unknown / total
  value           INTEGER,
  is_derived      INTEGER NOT NULL DEFAULT 0,   -- 1 = 原本になく導出した値
  anomaly_id      TEXT,
  source_sha256   TEXT    NOT NULL,
  PRIMARY KEY (dataset_key, key_code, reference_date, measure, nationality, age_class, sex)
);
CREATE INDEX IF NOT EXISTS idx_oa5_date      ON observations_age5 (reference_date);
CREATE INDEX IF NOT EXISTS idx_oa5_muni_date ON observations_age5 (muni_code, reference_date);
CREATE INDEX IF NOT EXISTS idx_oa5_key_date  ON observations_age5 (key_code, reference_date);
CREATE INDEX IF NOT EXISTS idx_oa5_source    ON observations_age5 (source_sha256);


-- ---------------------------------------------------------------------
--  集計の土台となるビュー
--    葉ノードだけを通す（age_class の合計行・sex の total/unknown を除く）。
--    粒度合わせ（年齢上限・国籍・時点）は、選択範囲に応じて呼び出し側で
--    age_lo と age_top_lo を使って行う。
--    町丁目単位の性別不明は出さない（数人規模で個人の出入りが追えるため）。
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_age5_leaf;
CREATE VIEW v_age5_leaf AS
SELECT o.dataset_key, o.muni_code, o.key_code, a.area_name, o.reference_date,
       o.nationality, o.age_class, c.age_lo, c.age_hi, c.is_unknown, c.sort_order,
       t.age_top_lo, t.nationality_semantics,
       o.sex, o.value, o.anomaly_id, o.source_sha256
  FROM observations_age5 o
  JOIN age_classes c     ON c.age_class = o.age_class
  JOIN dataset_traits t  ON t.dataset_key = o.dataset_key
  LEFT JOIN areas a      ON a.key_code = o.key_code
 WHERE o.measure = 'population'
   AND c.is_total = 0
   AND o.sex IN ('male', 'female');

-- 性別不明は区単位に合算して出す
DROP VIEW IF EXISTS v_age5_unknown_sex_by_muni;
CREATE VIEW v_age5_unknown_sex_by_muni AS
SELECT dataset_key, muni_code, reference_date, SUM(value) AS unknown_sex
  FROM observations_age5
 WHERE measure = 'population' AND sex = 'unknown'
 GROUP BY dataset_key, muni_code, reference_date;
