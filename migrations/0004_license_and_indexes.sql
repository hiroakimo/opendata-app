-- =====================================================================
--  0004_license_and_indexes.sql
--
--   (1) ライセンスと出典表示（要件3の法的な穴を塞ぐ）
--   (2) 定型可視化のためのインデックス（要件4の前提）
--
--   根拠：
--     目黒区オープンデータ利用規約は、個別に定めるものを除き
--     CC BY 4.0 と互換であると区が明示している。
--     https://www.city.meguro.tokyo.jp/gyousei/kusei/jouhoukoukai/torikumi.html
--
--   CC BY はクレジット表示が義務。既にCSVを配れる状態なので、
--   これが空のまま他の作業を積むのは筋が悪い。
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. ライセンスと出典
--    attribution は「利用者がそのまま貼れる文字列」にする。
--    CC BY で求められるのは、作成者・タイトル・出所・ライセンス・改変の有無。
-- ---------------------------------------------------------------------
UPDATE datasets
   SET license     = 'CC BY 4.0',
       attribution = '出典：目黒区「住民基本台帳による町丁別・年齢別・男女別人口（5歳階級）」'
                     || '（BODIKオープンデータカタログサイト経由、CC BY 4.0）を加工して作成',
       notes       = COALESCE(notes || ' / ', '')
                     || '目黒区オープンデータ利用規約はCC BY 4.0と互換である旨を区が明示している。'
 WHERE dataset_key = 'meguro_5y';

UPDATE datasets
   SET license     = 'CC BY 4.0',
       attribution = '出典：目黒区「住民基本台帳による町丁別・年齢別・男女別人口（1歳階級）」'
                     || '（BODIKオープンデータカタログサイト経由、CC BY 4.0）を加工して作成',
       notes       = COALESCE(notes || ' / ', '')
                     || '目黒区オープンデータ利用規約はCC BY 4.0と互換である旨を区が明示している。'
 WHERE dataset_key = 'meguro_1y';


-- ---------------------------------------------------------------------
-- 2. foreign_population の内数／外数を確定させる
--    区の公表値（総人口 = 日本人人口 + 外国人人口）が一致することを
--    確認済み。推定ではなく確定として記録する。
-- ---------------------------------------------------------------------
UPDATE known_issues
   SET severity = 'resolved',
       detail   = detail
                  || ' [2026-08-14 解決] 目黒区公表値で 日本人271,350 + 外国人12,563 = 総人口283,913 '
                  || 'が男女別も含めて一致することを確認。foreign_population は population の内数で確定。'
                  || '出典：目黒区「目黒区の今月の人口」'
 WHERE title LIKE '%foreign_population%内数%';


-- ---------------------------------------------------------------------
-- 3. 集計用インデックス
--    定型可視化は「全期間 × 全町丁の SUM」を引く。
--    reference_date に索引が無いと 195ヶ月分の全走査になる。
--    IF NOT EXISTS なので何度流しても安全。
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_obs5_date
    ON observations_5y (reference_date);

CREATE INDEX IF NOT EXISTS idx_obs5_key_date
    ON observations_5y (key_code, reference_date);

CREATE INDEX IF NOT EXISTS idx_obs5_measure_date
    ON observations_5y (measure, reference_date);

CREATE INDEX IF NOT EXISTS idx_obs1_date
    ON observations_1y (reference_date);

CREATE INDEX IF NOT EXISTS idx_obs1_key_date
    ON observations_1y (key_code, reference_date);
