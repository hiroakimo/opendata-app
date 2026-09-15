"""build_minato_load.py パッチ v2
99_verify.sql を D1 で実行できる形に直す。
  - UNION ALL を使わず、1行のSELECT（列ごとに OK/NG と取得値）にする
    （D1 は compound SELECT の項数に上限がある）
  - --file では SELECT の結果が表示されないため、--command で流す
  - 検算だけを単独で流せる verify.ps1 を生成する
"""
import py_compile, shutil, sys
from pathlib import Path

P = Path("build_minato_load.py")
src = P.read_text(encoding="utf-8")
if "verify.ps1" in src:
    sys.exit("中止: 既に適用済み")

start = src.find("    # ---- 99_verify.sql（期待値つき）")
end = src.find("    # ---- r2_upload.ps1")
if start < 0 or end < 0 or end < start:
    sys.exit("中止: 置換範囲が見つからない")

NEW_VERIFY = '''    # ---- 99_verify.sql（1行のSELECT。列ごとに OK/NG と取得値）
    M = q(MUNI)
    checks = [
        ("rows", f"SELECT COUNT(*) FROM observations_noage WHERE muni_code = {M}", len(obs)),
        ("months", f"SELECT COUNT(DISTINCT reference_date) FROM observations_noage WHERE muni_code = {M}", len(dates)),
        ("areas", f"SELECT COUNT(*) FROM areas WHERE muni_code = {M}", N_TOWNS),
        ("files", f"SELECT COUNT(*) FROM source_files WHERE dataset = {q(CKAN_DATASET)} AND is_current = 1", len(files)),
        ("periods", f"SELECT COUNT(DISTINCT p.reference_date) FROM source_file_periods p JOIN source_files s ON s.sha256 = p.sha256 WHERE s.dataset = {q(CKAN_DATASET)} AND s.is_current = 1", len(dates)),
        ("anomalies", f"SELECT COUNT(*) FROM data_anomalies WHERE dataset_key = {q(DATASET_KEY)}", len(anomalies)),
        ("orphan_keys", f"SELECT COUNT(*) FROM (SELECT DISTINCT key_code FROM observations_noage WHERE muni_code = {M}) o LEFT JOIN areas a ON a.key_code = o.key_code WHERE a.key_code IS NULL", 0),
        ("sum_ng", f"SELECT COUNT(*) FROM (SELECT key_code, reference_date,"
                   f" SUM(CASE WHEN sex IN ('male','female','unknown') THEN value END) AS parts,"
                   f" SUM(CASE WHEN sex = 'total' THEN value END) AS total"
                   f" FROM observations_noage WHERE muni_code = {M} AND measure = 'population' AND anomaly_id IS NULL"
                   f" GROUP BY key_code, reference_date) WHERE parts != total", 0),
        ("demo_5y_untouched", f"SELECT COUNT(*) FROM observations_5y WHERE muni_code = {M}", 0),
    ]
    got = ", ".join(f"({s}) AS {n}" for n, s, _ in checks)
    cols = ", ".join(f"CASE WHEN {n} = {e} THEN 'OK ' ELSE 'NG expected {e}: ' END || {n} AS {n}"
                     for n, _, e in checks)
    verify_sql = f"WITH g AS (SELECT {got}) SELECT {cols} FROM g;"
    (OUT / "99_verify.sql").write_text(verify_sql + "\\n", encoding="utf-8")

    VP = ['$ErrorActionPreference = "Stop"',
          '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
          f'$sql = (Get-Content "{OUT / "99_verify.sql"}" -Raw -Encoding UTF8).Trim()',
          f'npx wrangler d1 execute {DB} --remote --json --command $sql']
    (OUT / "verify.ps1").write_text("\\n".join(VP) + "\\n", encoding="utf-8-sig")

'''
src = src[:start] + NEW_VERIFY + src[end:]

OLD_RUN = '''    X.append('Write-Host "D1: 99_verify.sql"')
    X.append(f'npx wrangler d1 execute {DB} --remote --file "{OUT / "99_verify.sql"}" -y')'''
NEW_RUN = '''    X.append('Write-Host "D1: 検算"')
    X.append(f'& "{OUT / "verify.ps1"}"')'''
if src.count(OLD_RUN) != 1:
    sys.exit("中止: run_load.ps1 の検算行が見つからない")
src = src.replace(OLD_RUN, NEW_RUN)

bak = P.with_suffix(".py.bak")
shutil.copy2(P, bak)
P.write_text(src, encoding="utf-8")
try:
    py_compile.compile(str(P), doraise=True)
except py_compile.PyCompileError as e:
    shutil.copy2(bak, P)
    sys.exit(f"構文エラーのため元に戻しました: {e}")
print(f"適用完了（バックアップ: {bak}）")
