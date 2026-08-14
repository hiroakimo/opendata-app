-- =====================================================================
--  0003_views.sql  —— 集計用ビュー
--
--  observations_* は原本の内容をそのまま保持する層なので変更しない。
--  区が公表している total 行も、公表値との検算材料として残す。
--
--  代わりに、集計してよい行だけを通すビューを被せる。
--  要件3の集計用CSV、要件4でAIに見せるスキーマは、すべてこちら側を使う。
--
--  【検証済み】2026-04-01 の全88町丁で
--    SUM(age_class<>'total' AND sex IN ('male','female')) = population/total/total
--  が一致することを確認済み。よって total 行は導出可能な冗長行である。
-- =====================================================================


-- ---------------------------------------------------------------------
--  人口（年齢階級 × 性別）
--
--    sex <> 'total' … 年齢別には male/female しか存在しないため実質無害だが、
--                     将来 total が入ったときに黙って二重計上しないための保険
--    age_class <> 'total' … これが二重集計の主犯
--    'unknown' は残す … 年齢不詳は葉ノード。除くと総数が合わなくなる
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_population_5y;
CREATE VIEW v_population_5y AS
SELECT o.muni_code,
       o.key_code,
       a.area_name,
       o.reference_date,
       o.age_class,
       o.sex,
       o.value,
       o.source_sha256
  FROM observations_5y o
  LEFT JOIN areas a ON a.key_code = o.key_code
 WHERE o.measure    = 'population'
   AND o.age_class <> 'total'
   AND o.sex       <> 'total';


DROP VIEW IF EXISTS v_population_1y;
CREATE VIEW v_population_1y AS
SELECT o.muni_code,
       o.key_code,
       a.area_name,
       o.reference_date,
       o.age_class,
       o.sex,
       o.value,
       o.source_sha256
  FROM observations_1y o
  LEFT JOIN areas a ON a.key_code = o.key_code
 WHERE o.age_class <> 'total'
   AND o.sex       <> 'total';


-- ---------------------------------------------------------------------
--  世帯数
--    人口とは単位が違う。同じビューに混ぜると SUM(value) が意味を失うため分離。
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_households_5y;
CREATE VIEW v_households_5y AS
SELECT o.muni_code, o.key_code, a.area_name, o.reference_date, o.value, o.source_sha256
  FROM observations_5y o
  LEFT JOIN areas a ON a.key_code = o.key_code
 WHERE o.measure = 'households';


-- ---------------------------------------------------------------------
--  外国人人口
--    年齢区分を持たない。2026-04 以降のみ存在する。
--    ★ 総人口の内数か外数かは未確認（known_issues 参照）。
--       内数と推定しているが、確定するまで比率の解釈に使わないこと。
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_foreign_population_5y;
CREATE VIEW v_foreign_population_5y AS
SELECT o.muni_code, o.key_code, a.area_name, o.reference_date, o.sex, o.value, o.source_sha256
  FROM observations_5y o
  LEFT JOIN areas a ON a.key_code = o.key_code
 WHERE o.measure = 'foreign_population'
   AND o.sex    <> 'total';


-- ---------------------------------------------------------------------
--  公表値（検算用）
--    ビューから除外した total 行を、あえて別ビューとして残す。
--    「集計結果が区の公表値と一致するか」を確かめられることは、
--    このデータの信頼性を示す材料になる。捨てない。
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_published_totals_5y;
CREATE VIEW v_published_totals_5y AS
SELECT o.muni_code, o.key_code, a.area_name, o.reference_date, o.measure, o.value
  FROM observations_5y o
  LEFT JOIN areas a ON a.key_code = o.key_code
 WHERE o.age_class = 'total'
   AND o.sex       = 'total';
