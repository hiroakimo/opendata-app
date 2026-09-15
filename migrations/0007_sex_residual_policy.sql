-- =====================================================================
--  0007_sex_residual_policy.sql —— 性別の内訳に含まれない人数の扱い
--  方針: docs/policy/sex_residual.md
--
--  要点
--    A. 町丁目単位の男・女・総数は公表値のまま出す（総数 − 男 − 女 は計算できる）
--    1. 「性別不明」という区分・ラベルは出さない
--    2. 内訳に含まれない人数を出すのは区全体の合計だけ（国籍・年齢と組み合わせない）
--    3. 町丁目 × 国籍 × 年齢 のセルでは男・女だけを出し、総数を並べない
--    4. 注記は系列単位で出す（どの町丁目・何人かは示さない）
--    5. 注記の要否は dataset_sex_residual で自動判定（refresh_catalog.sql の (6) で更新）
--
--  既存の observations_5y / v_nl_* / agg_* には触れない（デモ保護）。冪等。
-- =====================================================================

-- 系列 × 基準日 ごとに「男女の合計が総数と一致しない箇所があるか」だけを持つ。
-- 町丁目・人数は持たない。
CREATE TABLE IF NOT EXISTS dataset_sex_residual (
  dataset_key     TEXT    NOT NULL,
  reference_date  TEXT    NOT NULL,
  has_residual    INTEGER NOT NULL,   -- 1 = 一致しない箇所がある
  PRIMARY KEY (dataset_key, reference_date)
);

-- 画面・AI 層が読む注記。系列に一度でも該当があれば注記を付ける。
DROP VIEW IF EXISTS v_dataset_sex_note;
CREATE VIEW v_dataset_sex_note AS
SELECT dataset_key,
       MAX(has_residual) AS has_residual_any,
       CASE WHEN MAX(has_residual) = 1
            THEN '男女の内訳に含まれない人数があるため、男女の合計は総数と一致しない場合があります。'
       END AS note
  FROM dataset_sex_residual
 GROUP BY dataset_key;


-- ---------------------------------------------------------------------
--  年齢区分なし系列（町丁目 × 男女 × 総数）
--  方針 A: 男・女・総数（公表値）を出す。unknown（導出値）は出さない。
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_population_noage;
CREATE VIEW v_population_noage AS
SELECT o.muni_code, o.key_code, a.area_name, o.reference_date,
       o.sex, o.value, o.anomaly_id, o.source_sha256
  FROM observations_noage o
  LEFT JOIN areas a ON a.key_code = o.key_code
 WHERE o.measure = 'population'
   AND o.sex IN ('male', 'female', 'total');


-- ---------------------------------------------------------------------
--  5歳階級（区横断）
--  方針 3: 町丁目 × 国籍 × 年齢 のセルは男・女だけ（v_age5_leaf、0006 のまま）。
--  町丁目の総数は年齢なし系列の公表値を使う。
--  方針 2: 内訳に含まれない人数は区全体の合計のみ（v_age5_unknown_sex_by_muni、0006 のまま）。
--  ここでは区全体の合計を「国籍・年齢で分けない」ことを明示した名前のビューに置き換える。
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_age5_unknown_sex_by_muni;
DROP VIEW IF EXISTS v_sex_residual_by_muni;
CREATE VIEW v_sex_residual_by_muni AS
SELECT d.dataset_key, o.muni_code, o.reference_date, SUM(o.value) AS residual
  FROM observations_noage o
  JOIN datasets d ON d.muni_code = o.muni_code AND d.granularity = 'noage'
 WHERE o.measure = 'population' AND o.sex = 'unknown'
 GROUP BY d.dataset_key, o.muni_code, o.reference_date;

DROP VIEW IF EXISTS v_unknown_sex_by_muni_noage;
