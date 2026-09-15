-- =====================================================================
--  0008_minato_views.sql —— 港区専用のビュー（試験表示・認証環境のみ）
--
--  目黒区の画面・ビュー（v_nl_* / v_population_5y など）とは切り離す。
--  区横断での統合（目黒区とのマージ）は、状況を確認してから別途行う。
--
--  数字は公表値のまま出す（docs/policy/sex_residual.md の方針 A）。
--    - 町丁目・地区・区全体の月次: 世帯数・男・女・総数（公表値）
--    - 男女の内訳に含まれない人数は区全体の月次でのみ出す（方針 2）
--    - 5歳階級は男・女のみ。総数を並べない（方針 3）
--  冪等。
-- =====================================================================

-- 町丁目のまとまり（地区など）。区ごとに区分が違うので種類を持たせる。
CREATE TABLE IF NOT EXISTS area_groups (
  key_code    TEXT    NOT NULL,
  group_kind  TEXT    NOT NULL,   -- 'district' など
  group_name  TEXT    NOT NULL,   -- 原本の表記（例: 芝地区総合支所管内）
  group_label TEXT    NOT NULL,   -- 画面の表記（例: 芝地区）
  sort_order  INTEGER NOT NULL,   -- 町丁目の並び順（原本の並び）
  PRIMARY KEY (key_code, group_kind)
);
CREATE INDEX IF NOT EXISTS idx_area_groups_name ON area_groups (group_kind, group_name);

-- 0007 で総数を加えた汎用ビューは、CSV の「そのまま合計してよい」約束に合わせて
-- 男・女だけに戻す（総数は v_published_totals_noage）。区横断の統合時に使う。
DROP VIEW IF EXISTS v_population_noage;
CREATE VIEW v_population_noage AS
SELECT o.muni_code, o.key_code, a.area_name, o.reference_date,
       o.sex, o.value, o.anomaly_id, o.source_sha256
  FROM observations_noage o
  LEFT JOIN areas a ON a.key_code = o.key_code
 WHERE o.measure = 'population'
   AND o.sex IN ('male', 'female');


-- ---------------------------------------------------------------------
--  月次（年齢区分なし系列 minato_noage）
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_minato_town_monthly;
CREATE VIEW v_minato_town_monthly AS
SELECT o.key_code,
       a.area_name,
       g.group_label AS district,
       g.sort_order,
       o.reference_date,
       SUM(CASE WHEN o.measure = 'households' THEN o.value END)                    AS households,
       SUM(CASE WHEN o.measure = 'population' AND o.sex = 'male'   THEN o.value END) AS male,
       SUM(CASE WHEN o.measure = 'population' AND o.sex = 'female' THEN o.value END) AS female,
       SUM(CASE WHEN o.measure = 'population' AND o.sex = 'total'  THEN o.value END) AS total,
       MAX(o.anomaly_id) AS anomaly_id
  FROM observations_noage o
  LEFT JOIN areas a       ON a.key_code = o.key_code
  LEFT JOIN area_groups g ON g.key_code = o.key_code AND g.group_kind = 'district'
 WHERE o.muni_code = '131032'
   AND o.sex <> 'unknown'
 GROUP BY o.key_code, o.reference_date;

DROP VIEW IF EXISTS v_minato_district_monthly;
CREATE VIEW v_minato_district_monthly AS
SELECT g.group_label AS district,
       MIN(g.sort_order) AS sort_order,
       o.reference_date,
       SUM(CASE WHEN o.measure = 'households' THEN o.value END)                    AS households,
       SUM(CASE WHEN o.measure = 'population' AND o.sex = 'male'   THEN o.value END) AS male,
       SUM(CASE WHEN o.measure = 'population' AND o.sex = 'female' THEN o.value END) AS female,
       SUM(CASE WHEN o.measure = 'population' AND o.sex = 'total'  THEN o.value END) AS total,
       COUNT(DISTINCT o.anomaly_id) AS anomalies
  FROM observations_noage o
  JOIN area_groups g ON g.key_code = o.key_code AND g.group_kind = 'district'
 WHERE o.muni_code = '131032'
   AND o.sex <> 'unknown'
 GROUP BY g.group_label, o.reference_date;

-- 区全体。男女の内訳に含まれない人数はここでだけ出す（方針 2）
DROP VIEW IF EXISTS v_minato_ward_monthly;
CREATE VIEW v_minato_ward_monthly AS
SELECT o.reference_date,
       SUM(CASE WHEN o.measure = 'households' THEN o.value END)                     AS households,
       SUM(CASE WHEN o.measure = 'population' AND o.sex = 'male'    THEN o.value END) AS male,
       SUM(CASE WHEN o.measure = 'population' AND o.sex = 'female'  THEN o.value END) AS female,
       SUM(CASE WHEN o.measure = 'population' AND o.sex = 'total'   THEN o.value END) AS total,
       SUM(CASE WHEN o.measure = 'population' AND o.sex = 'unknown' THEN o.value END) AS not_in_sex_breakdown,
       COUNT(DISTINCT o.anomaly_id) AS anomalies
  FROM observations_noage o
 WHERE o.muni_code = '131032'
 GROUP BY o.reference_date;


-- ---------------------------------------------------------------------
--  5歳階級（minato_5y）。男・女のみ（方針 3）
--  空欄セル（例外登録済み）は value が NULL。blank_cells で数を返す。
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_minato_age5;
CREATE VIEW v_minato_age5 AS
SELECT o.key_code,
       a.area_name,
       o.reference_date,
       o.nationality,
       o.age_class,
       c.sort_order,
       SUM(CASE WHEN o.sex = 'male'   THEN o.value END) AS male,
       SUM(CASE WHEN o.sex = 'female' THEN o.value END) AS female,
       SUM(CASE WHEN o.value IS NULL THEN 1 ELSE 0 END) AS blank_cells
  FROM observations_age5 o
  JOIN age_classes c ON c.age_class = o.age_class
  LEFT JOIN areas a  ON a.key_code = o.key_code
 WHERE o.dataset_key = 'minato_5y'
   AND o.sex IN ('male', 'female')
 GROUP BY o.key_code, o.reference_date, o.nationality, o.age_class;

DROP VIEW IF EXISTS v_minato_age5_district;
CREATE VIEW v_minato_age5_district AS
SELECT g.group_label AS district,
       o.reference_date,
       o.nationality,
       o.age_class,
       c.sort_order,
       SUM(CASE WHEN o.sex = 'male'   THEN o.value END) AS male,
       SUM(CASE WHEN o.sex = 'female' THEN o.value END) AS female,
       SUM(CASE WHEN o.value IS NULL THEN 1 ELSE 0 END) AS blank_cells
  FROM observations_age5 o
  JOIN age_classes c ON c.age_class = o.age_class
  JOIN area_groups g ON g.key_code = o.key_code AND g.group_kind = 'district'
 WHERE o.dataset_key = 'minato_5y'
   AND o.sex IN ('male', 'female')
 GROUP BY g.group_label, o.reference_date, o.nationality, o.age_class;

DROP VIEW IF EXISTS v_minato_age5_ward;
CREATE VIEW v_minato_age5_ward AS
SELECT o.reference_date,
       o.nationality,
       o.age_class,
       c.sort_order,
       SUM(CASE WHEN o.sex = 'male'   THEN o.value END) AS male,
       SUM(CASE WHEN o.sex = 'female' THEN o.value END) AS female,
       SUM(CASE WHEN o.value IS NULL THEN 1 ELSE 0 END) AS blank_cells
  FROM observations_age5 o
  JOIN age_classes c ON c.age_class = o.age_class
 WHERE o.dataset_key = 'minato_5y'
   AND o.sex IN ('male', 'female')
 GROUP BY o.reference_date, o.nationality, o.age_class;
