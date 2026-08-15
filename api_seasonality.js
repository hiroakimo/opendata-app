/* =====================================================================
 *  季節変動（要件4：定型可視化の4本目）
 *
 *  analysis.js の apiRanking の直後あたりに貼る。
 *  返却形は既存エンドポイントに合わせて {rows, sql, params, notes, annotations}。
 *  meta(out, d) がそのまま SQL と注記を描画してくれる。
 *
 *  前提: sql/seasonality.sql と sql/seasonality_age.sql を適用済み。
 *    v_nl_seasonality           町丁 × 暦月
 *    v_nl_seasonality_strength  町丁ごとの振幅
 *    v_nl_seasonality_age       町丁 × 暦月 × 年齢階級
 *
 *  mode パラメータで3つの見せ方を切り替える。
 *    strength  振幅ランキング（どの町丁が季節変動を持つか）
 *    profile   1町丁の12ヶ月プロファイル
 *    age       1町丁 × 1暦月の年齢階級別内訳
 * ===================================================================== */

const isMonth = (s) => /^(0[1-9]|1[0-2])$/.test(s || "");

async function apiSeasonality(env, url) {
  const ds = await dataset(env, url.searchParams.get("dataset") || "");
  if (!ds) return bad("データセットが見つかりません");

  const mode = url.searchParams.get("mode") || "strength";
  const keyCode = url.searchParams.get("key_code") || "";
  const month = url.searchParams.get("month") || "09";

  if (mode !== "strength" && !isKey(keyCode)) return bad("町丁を指定してください");
  if (mode === "age" && !isMonth(month)) return bad("月の指定が不正です");

  /* 共通の注記。季節指数の性質はモードによらず同じなので、
     利用者が数字だけを持ち出さないよう毎回付ける。 */
  const notes = [
    "季節指数は 2×12 移動平均でトレンドを除去した比率の暦月平均。1.0（0%）がトレンド並み",
    "2012-08 の系列断絶以降のみを対象にした。それ以前は総人口の定義が異なる",
    "移動平均の窓（前後6ヶ月）が欠測を含む月は集計から除外。n_years が暦月ごとに 10〜12 とばらつくのはこのため",
    "n_above は n_years のうち指数が 1 を上回った年数。10年中5年程度なら偶然と区別がつかない",
    "住民基本台帳の異動が反映された値であり、実際の居住実態とは異なる場合がある",
  ];

  let sql;
  let params;

  if (mode === "strength") {
    sql =
      `SELECT area_name, amplitude_pct, peak_month, peak_pct,\n` +
      `       trough_month, trough_pct, key_code\n` +
      `  FROM v_nl_seasonality_strength\n` +
      ` WHERE key_code LIKE ?1 || '%'\n` +
      ` ORDER BY amplitude_pct DESC\n` +
      ` LIMIT 20`;
    params = [ds.muni_code];
  } else if (mode === "profile") {
    sql =
      `SELECT month, seasonal_index, pct_vs_trend, n_above, n_years\n` +
      `  FROM v_nl_seasonality\n` +
      ` WHERE key_code = ?1\n` +
      ` ORDER BY month`;
    params = [keyCode];
  } else {
    sql =
      `SELECT age_class, age_order, pct_vs_trend, n_above, n_years\n` +
      `  FROM v_nl_seasonality_age\n` +
      ` WHERE key_code = ?1 AND month = ?2\n` +
      ` ORDER BY age_order`;
    params = [keyCode, month];
  }

  const rs = await getDb(env).prepare(sql).bind(...params).all();
  const rows = rs.results || [];

  if (!rows.length) {
    notes.push(
      "該当する行がない。人数が少なく比率が不安定になる階級（トレンド20人未満）は" +
        "算出対象から外しているため、小規模な町丁では結果が空になることがある"
    );
  }

  /* 断絶・欠測は 2012-08 以降の全期間が対象なので、
     ランキングのように期間で絞らず、対象データセットの分を全部渡す。
     どの月が窓から抜けているかを利用者が確認できるようにする。 */
  const gaps = await getDb(env)
    .prepare(
      `SELECT reference_date, kind, reason
         FROM dataset_gaps
        WHERE dataset_key = ?1
          AND reference_date >= '2012-08-01'
        ORDER BY reference_date`
    )
    .bind(ds.dataset_key)
    .all();

  /* 既知の不整合。階級別合計と公表総人口の差は、
     年齢別モードの数値に直接効くので必ず出す。 */
  const issues = await getDb(env)
    .prepare(
      `SELECT title, detail, severity
         FROM known_issues
        WHERE dataset_key = ?1 AND resolved_at IS NULL
        ORDER BY issue_id`
    )
    .bind(ds.dataset_key)
    .all();

  for (const g of gaps.results || []) {
    if (g.kind !== "series_break") {
      notes.push(
        g.reference_date + " は欠測。この月の前後6ヶ月は移動平均の窓が埋まらず集計から外れる"
      );
    }
  }

  if (mode === "age") {
    notes.push(
      "年齢階級別の値は、階級別の明細から算出している。区公表の総人口とは" +
        "最大4人の差があることが確認されている（下の既知の問題を参照）"
    );
  }

  return json({
    mode,
    rows,
    sql,
    params,
    notes,
    annotations: gaps.results || [],
    issues: issues.results || [],
  });
}
