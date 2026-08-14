-- =====================================================================
--  0002_catalog.sql  —— 公開面（要件2）のためのメタデータ層
--
--  設計方針
--    1. 既存の source_files / observations_* は一切変更しない
--    2. 「公開単位（dataset_key）」と「物理ソース（source_files.dataset）」
--       を分離する。BODIK側の4分割はこちらの都合ではないため
--    3. 導出できるものはテーブルにしない。
--       導出できないのは「ライセンス」「欠測の理由」「同期の試行」の3つ
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 公開単位
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS datasets (
  dataset_key  TEXT PRIMARY KEY,          -- 'meguro_5y' / 'meguro_1y'
  muni_code    TEXT NOT NULL,             -- '131105'
  muni_name    TEXT NOT NULL,             -- '目黒区'
  domain       TEXT NOT NULL DEFAULT 'population',
  title        TEXT NOT NULL,
  granularity  TEXT NOT NULL,             -- '1y' / '5y'  (observations_* の選択に使う)
  grain_label  TEXT NOT NULL,             -- '5歳階級'
  source_site  TEXT NOT NULL,             -- 'BODIK'
  source_url   TEXT,
  license      TEXT,                      -- NULL = 未確認。画面に警告を出す
  attribution  TEXT,                      -- 出典表示の文言
  is_public    INTEGER NOT NULL DEFAULT 1,
  notes        TEXT
);


-- ---------------------------------------------------------------------
-- 2. 公開単位 ←→ 物理ソースの対応
--    source_files.dataset は BODIK 側のデータセット名がそのまま入っている。
--    131105_saishinjinko は 1y / 5y の両方に現れるため granularity も鍵に含む。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dataset_sources (
  dataset_key TEXT NOT NULL,
  dataset     TEXT NOT NULL,
  granularity TEXT NOT NULL,
  role        TEXT,                       -- 'archive' / 'latest'
  PRIMARY KEY (dataset_key, dataset, granularity)
);


-- ---------------------------------------------------------------------
-- 3. 欠測の理由
--    欠測そのものは月列の差分で自動検出できる。人手でしか書けないのは理由。
--    kind を分けているのは、上流に無いのか自分の取込が失敗したのかで
--    意味がまったく違うため。前者は「区が公開していない」という発見であり、
--    後者は「直せるかもしれない不具合」。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dataset_gaps (
  dataset_key    TEXT NOT NULL,
  reference_date TEXT NOT NULL,
  kind           TEXT NOT NULL,           -- 'upstream_missing' / 'ingest_failed' / 'pending_fix'
  reason         TEXT,
  noted_at       TEXT,
  PRIMARY KEY (dataset_key, reference_date)
);


-- ---------------------------------------------------------------------
-- 4. 同期の試行ログ
--    source_files には「取れた」記録しか残らない。
--    上流が落ちて何も取れなかった日は行が増えないので痕跡が消え、
--    画面上は前日と同じに見える = 壊れたまま静かに古いデータを返す状態。
--    試行そのものを記録して初めて「最終試行 / 最終成功」を分けて出せる。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_runs (
  run_id      TEXT PRIMARY KEY,
  dataset_key TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,              -- ok / no_change / error
  new_files   INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_ds ON sync_runs(dataset_key, started_at DESC);


-- ---------------------------------------------------------------------
-- 5. 月別サマリ（要再構築テーブル）
--    観測テーブルは 86万行あり、画面表示のたびに GROUP BY を走らせると重い。
--    取込後に scripts/refresh_catalog.sql で作り直す。
--
--    file_count と obs_rows を別に持つのが要点。
--    「ファイルは取り込んだ記録があるのに観測行が0」という状態が
--    実際に発生している（2026-08 の 1y）。1つの数字にまとめると消える。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dataset_periods (
  dataset_key    TEXT NOT NULL,
  reference_date TEXT NOT NULL,
  file_count     INTEGER NOT NULL DEFAULT 0,
  obs_rows       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dataset_key, reference_date)
);


-- ---------------------------------------------------------------------
-- 6. 索引
--    いずれも主キー先頭列に当たらないアクセスパスを補うもの。
--    観測テーブルの時系列クエリ（要件4でAIが生成する主要な形）に効く。
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_sf_dataset ON source_files(dataset, granularity, reference_date);
CREATE INDEX IF NOT EXISTS idx_o5y_date   ON observations_5y(reference_date);
CREATE INDEX IF NOT EXISTS idx_o5y_area   ON observations_5y(key_code, reference_date);
CREATE INDEX IF NOT EXISTS idx_o1y_date   ON observations_1y(reference_date);
CREATE INDEX IF NOT EXISTS idx_o1y_area   ON observations_1y(key_code, reference_date);


-- =====================================================================
--  初期データ
-- =====================================================================

INSERT OR REPLACE INTO datasets
  (dataset_key, muni_code, muni_name, title, granularity, grain_label,
   source_site, source_url, license, attribution, is_public, notes)
VALUES
  ('meguro_5y', '131105', '目黒区',
   '町丁目別 年齢別人口・世帯数（5歳階級）', '5y', '5歳階級',
   'BODIK', 'https://data.bodik.jp/organization/131105',
   NULL,                                  -- ★要確認。確認するまでNULLのまま
   NULL,
   1,
   '2010-04以降。アーカイブ4本と【最新】を1つの系列として提供している'),

  ('meguro_1y', '131105', '目黒区',
   '町丁目別 年齢別人口（1歳階級）', '1y', '1歳階級',
   'BODIK', 'https://data.bodik.jp/dataset/131105_saishinjinko',
   NULL,                                  -- ★要確認
   NULL,
   1,
   '【最新】データセットのみ。長期の遡及不可');


INSERT OR REPLACE INTO dataset_sources (dataset_key, dataset, granularity, role) VALUES
  ('meguro_5y', '131105_population_by_town_section_age_gender_and_number_of_households_by_town_section',  '5y', 'archive'),
  ('meguro_5y', '131105_population_by_town_section_age_gender_and_number_of_households_by_town_section2', '5y', 'archive'),
  ('meguro_5y', '131105_population_by_town_section_age_gender_and_number_of_households_by_town_section3', '5y', 'archive'),
  ('meguro_5y', '131105_population_by_town_section_age_gender_and_number_of_households_by_town_section4', '5y', 'archive'),
  ('meguro_5y', '131105_saishinjinko',                                                                    '5y', 'latest'),
  ('meguro_1y', '131105_saishinjinko',                                                                    '1y', 'latest');
-- meguro_local_seed は開発用シードのため意図的に対応付けない（= 一覧に出ない）


INSERT OR REPLACE INTO dataset_gaps (dataset_key, reference_date, kind, reason, noted_at) VALUES
  ('meguro_5y', '2017-07-01', 'upstream_missing',
   'BODIKに該当月のリソースが存在しない。区が公開していない可能性が高い。',
   '2026-08-14'),
  ('meguro_5y', '2024-12-01', 'ingest_failed',
   'リソースは存在するが取込時にスキップ。source_files.skip_reason を参照。',
   '2026-08-14'),
  ('meguro_1y', '2026-08-01', 'pending_fix',
   '生データに問題があり修正待ち。ファイルは取得済みだが観測行に未反映。',
   '2026-08-14');
