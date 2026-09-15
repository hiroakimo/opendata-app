-- =====================================================================
--  0001_base_schema.sql —— D1 の土台（source_files / areas / area_aliases /
--  observations_5y / observations_1y）
--
--  opendata_sync/schema.sql を取り込んだもの（2026-08 に本番へ適用済み）。
--  新しい D1 を作るときは 0001 から番号順に適用する。
--  既存 DB 向けの opendata_sync/migration_01.sql（source_files.granularity_source の
--  追加）は、この CREATE 文に含まれているため不要。
-- =====================================================================

-- tokyo-population D1 スキーマ
-- 新規適用: wrangler d1 execute tokyo-population --remote --file=schema.sql
-- 既存DBがある場合は migration_01.sql を先に適用すること。

-- ============================================================
-- 台帳: 取り込んだ生ファイルの記録
-- ============================================================
CREATE TABLE IF NOT EXISTS source_files (
  sha256             TEXT PRIMARY KEY,
  r2_key             TEXT NOT NULL,
  dataset            TEXT,
  source_file        TEXT,
  muni_code          TEXT,
  granularity        TEXT,
  granularity_source TEXT,          -- filename / inferred:csv / inferred:xlsx
  reference_date     TEXT,
  content_bytes      INTEGER,
  status             TEXT NOT NULL, -- ingested / skipped
  skip_reason        TEXT,
  row_count          INTEGER,
  ingested_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_files_date
  ON source_files (reference_date, granularity);

-- ============================================================
-- 定義層: 町丁目とその別名
-- ============================================================
CREATE TABLE IF NOT EXISTS areas (
  key_code    TEXT PRIMARY KEY,
  muni_code   TEXT NOT NULL,
  area_code   TEXT,
  area_name   TEXT NOT NULL,
  first_seen  TEXT,
  last_seen   TEXT
);

-- 表記ゆらぎの対応表。
-- 1歳刻みには KEY_CODE が無く「駒場1丁目」、5歳刻みは「駒場一丁目」。
-- どのルールで解決したかを resolved_by に残す。key_code が NULL なら未解決。
CREATE TABLE IF NOT EXISTS area_aliases (
  muni_code    TEXT NOT NULL,
  alias_name   TEXT NOT NULL,
  key_code     TEXT,
  resolved_by  TEXT NOT NULL,   -- source / kansuji_normalize / manual …
  first_seen   TEXT,
  last_seen    TEXT,
  PRIMARY KEY (muni_code, alias_name)
);

CREATE INDEX IF NOT EXISTS idx_alias_key ON area_aliases (key_code);

-- ============================================================
-- 観測値
-- ============================================================
CREATE TABLE IF NOT EXISTS observations_5y (
  key_code        TEXT NOT NULL,
  muni_code       TEXT NOT NULL,
  reference_date  TEXT NOT NULL,
  measure         TEXT NOT NULL,   -- population / households
  age_class       TEXT NOT NULL,   -- 0-4 … 80-84 / 85+ / unknown / total
  sex             TEXT NOT NULL,   -- male / female / total
  value           INTEGER,
  source_sha256   TEXT NOT NULL,
  PRIMARY KEY (key_code, reference_date, measure, age_class, sex)
);

CREATE INDEX IF NOT EXISTS idx_5y_date   ON observations_5y (reference_date);
CREATE INDEX IF NOT EXISTS idx_5y_source ON observations_5y (source_sha256);

CREATE TABLE IF NOT EXISTS observations_1y (
  key_code        TEXT NOT NULL,
  muni_code       TEXT NOT NULL,
  reference_date  TEXT NOT NULL,
  age_class       TEXT NOT NULL,   -- '0'…'103' / '104+' など / unknown
  sex             TEXT NOT NULL,   -- male / female / total
  value           INTEGER,
  source_sha256   TEXT NOT NULL,
  PRIMARY KEY (key_code, reference_date, age_class, sex)
);

CREATE INDEX IF NOT EXISTS idx_1y_date   ON observations_1y (reference_date);
CREATE INDEX IF NOT EXISTS idx_1y_source ON observations_1y (source_sha256);
