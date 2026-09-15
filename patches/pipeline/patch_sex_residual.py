"""性別の内訳に含まれない人数の扱い（docs/policy/sex_residual.md）に合わせた更新

実行場所: リポジトリ直下
    python patches/pipeline/patch_sex_residual.py

変更内容
  1. scripts/refresh_catalog.sql に (6) を追加（dataset_sex_residual の自動判定）
  2. pipeline/registry.json の minato/web5y の状態を「取込済み・非公開」に更新
"""
import json, shutil, sys
from pathlib import Path

CAT = Path("scripts/refresh_catalog.sql")
REG = Path("pipeline/registry.json")
MARK = "-- (6) 性別の内訳に含まれない人数の有無"

src = CAT.read_text(encoding="utf-8")
reg = json.loads(REG.read_text(encoding="utf-8"))
web5y = reg["wards"]["minato"]["series"]["web5y"]
if MARK in src and web5y["status"] == "取込済み・非公開":
    sys.exit("中止: 既に適用済み")
if "-- (5) 観測側 5歳階級（区横断）" not in src:
    sys.exit("中止: 前提のパッチ（patch_refresh_catalog_age5）が未適用")

ADD = """

-- (6) 性別の内訳に含まれない人数の有無（注記の自動判定。町丁目・人数は持たない）
--     方針: docs/policy/sex_residual.md
--     D1 は compound SELECT の項数に上限があるため、UNION を使わず UPDATE を分ける。
DELETE FROM dataset_sex_residual;

INSERT INTO dataset_sex_residual (dataset_key, reference_date, has_residual)
SELECT dataset_key, reference_date, 0 FROM dataset_periods;

UPDATE dataset_sex_residual SET has_residual = 1
 WHERE dataset_key || '|' || reference_date IN (
   SELECT d.dataset_key || '|' || o.reference_date
     FROM observations_noage o
     JOIN datasets d ON d.muni_code = o.muni_code AND d.granularity = 'noage'
    WHERE o.measure = 'population' AND o.sex = 'unknown' AND o.value > 0);

UPDATE dataset_sex_residual SET has_residual = 1
 WHERE dataset_key || '|' || reference_date IN (
   SELECT dataset_key || '|' || reference_date
     FROM observations_age5
    WHERE measure = 'population' AND sex = 'unknown' AND value > 0);

UPDATE dataset_sex_residual SET has_residual = 1
 WHERE dataset_key || '|' || reference_date IN (
   SELECT d.dataset_key || '|' || x.reference_date
     FROM (SELECT muni_code, key_code, reference_date, age_class,
                  SUM(CASE WHEN sex = 'total' THEN value END) AS t,
                  SUM(CASE WHEN sex IN ('male', 'female') THEN value END) AS mf
             FROM observations_5y WHERE measure = 'population'
            GROUP BY 1, 2, 3, 4) x
     JOIN datasets d ON d.muni_code = x.muni_code AND d.granularity = '5y'
    WHERE x.t != x.mf);

UPDATE dataset_sex_residual SET has_residual = 1
 WHERE dataset_key || '|' || reference_date IN (
   SELECT d.dataset_key || '|' || x.reference_date
     FROM (SELECT muni_code, key_code, reference_date, age_class,
                  SUM(CASE WHEN sex = 'total' THEN value END) AS t,
                  SUM(CASE WHEN sex IN ('male', 'female') THEN value END) AS mf
             FROM observations_1y
            GROUP BY 1, 2, 3, 4) x
     JOIN datasets d ON d.muni_code = x.muni_code AND d.granularity = '1y'
    WHERE x.t != x.mf);
"""
if MARK not in src:
    shutil.copy2(CAT, CAT.with_suffix(".sql.bak"))
    CAT.write_text(src.rstrip("\n") + ADD, encoding="utf-8")
web5y["status"] = "取込済み・非公開"
REG.write_text(json.dumps(reg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("適用完了: refresh_catalog.sql に (6) を追加、registry.json の web5y を更新")
