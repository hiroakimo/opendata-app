-- =====================================================================
--  0005_noage_observations.sql —— 年齢区分を持たない系列（港区CKAN など）
--
--  設計方針
--    1. 既存の observations_5y / observations_1y / v_nl_* / agg_* は変更しない。
--       デモ（DEMO_MODE）は同じ D1 を読むため、既存経路に行を混ぜない。
--    2. granularity は「年齢の粒度」を表す。'1y' / '5y' に 'noage' を加える。
--    3. 導出値（sex='unknown' = total - male - female）は is_derived=1 で区別する。
--    4. 原本の明らかな誤記は補正しない。anomaly_id を付け data_anomalies に記録する。
--    5. 1ファイルに複数月を含む配信形式に対応するため、
--       ファイル×月の対応を source_file_periods に持つ。
--       この形式のファイルは source_files.reference_date を NULL にする。
--  冪等。何度流しても安全。
-- =====================================================================

CREATE TABLE IF NOT EXISTS observations_noage (
  key_code        TEXT    NOT NULL,
  muni_code       TEXT    NOT NULL,
  reference_date  TEXT    NOT NULL,
  measure         TEXT    NOT NULL,            -- population / households
  sex             TEXT    NOT NULL,            -- male / female / unknown / total（households は total のみ）
  value           INTEGER,
  is_derived      INTEGER NOT NULL DEFAULT 0,  -- 1 = 原本になく導出した値
  anomaly_id      TEXT,                        -- data_anomalies.anomaly_id
  source_sha256   TEXT    NOT NULL,
  PRIMARY KEY (key_code, reference_date, measure, sex)
);
CREATE INDEX IF NOT EXISTS idx_ona_date      ON observations_noage (reference_date);
CREATE INDEX IF NOT EXISTS idx_ona_muni_date ON observations_noage (muni_code, reference_date);
CREATE INDEX IF NOT EXISTS idx_ona_source    ON observations_noage (source_sha256);


CREATE TABLE IF NOT EXISTS source_file_periods (
  sha256          TEXT    NOT NULL,
  reference_date  TEXT    NOT NULL,
  row_count       INTEGER NOT NULL,            -- 原本の行数（その月分）
  PRIMARY KEY (sha256, reference_date)
);
CREATE INDEX IF NOT EXISTS idx_sfp_date ON source_file_periods (reference_date);


-- 原本の不整合の記録。補正はしない。
--   kind      : sum_mismatch / name_variant …
--   treatment : keep_reported_flag / map_to_canonical …
CREATE TABLE IF NOT EXISTS data_anomalies (
  anomaly_id      TEXT NOT NULL,
  dataset_key     TEXT NOT NULL,
  key_code        TEXT NOT NULL,
  reference_date  TEXT NOT NULL,
  kind            TEXT NOT NULL,
  treatment       TEXT NOT NULL,
  reported        TEXT,                        -- 原本の値（JSON）
  note            TEXT,
  source_sha256   TEXT NOT NULL,
  PRIMARY KEY (anomaly_id, key_code, reference_date)
);


-- ---------------------------------------------------------------------
--  ビュー
--  町丁目単位の性別不明（unknown）は出さない。
--    該当は数人規模で、月次に並べると個人単位の記録の出入りが追えるため。
--    そのため男+女は、不明がある町丁目・月で公表合計と一致しない。
--    合計は v_published_totals_noage を使うこと。
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_population_noage;
CREATE VIEW v_population_noage AS
SELECT o.muni_code, o.key_code, a.area_name, o.reference_date,
       o.sex, o.value, o.anomaly_id, o.source_sha256
  FROM observations_noage o
  LEFT JOIN areas a ON a.key_code = o.key_code
 WHERE o.measure = 'population'
   AND o.sex IN ('male', 'female');

DROP VIEW IF EXISTS v_published_totals_noage;
CREATE VIEW v_published_totals_noage AS
SELECT o.muni_code, o.key_code, a.area_name, o.reference_date,
       o.measure, o.value, o.anomaly_id, o.source_sha256
  FROM observations_noage o
  LEFT JOIN areas a ON a.key_code = o.key_code
 WHERE o.sex = 'total';

DROP VIEW IF EXISTS v_households_noage;
CREATE VIEW v_households_noage AS
SELECT o.muni_code, o.key_code, a.area_name, o.reference_date,
       o.value, o.anomaly_id, o.source_sha256
  FROM observations_noage o
  LEFT JOIN areas a ON a.key_code = o.key_code
 WHERE o.measure = 'households';

-- 性別不明は区単位に合算して出す（異常フラグ付きの行は導出していない）
DROP VIEW IF EXISTS v_unknown_sex_by_muni_noage;
CREATE VIEW v_unknown_sex_by_muni_noage AS
SELECT o.muni_code, o.reference_date, SUM(o.value) AS unknown_sex
  FROM observations_noage o
 WHERE o.measure = 'population'
   AND o.sex     = 'unknown'
 GROUP BY o.muni_code, o.reference_date;
