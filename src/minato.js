/* =====================================================================
 *  港区（試験表示・認証環境のみ）
 *
 *   目黒区の画面（一覧・詳細・集計）とは切り離した専用ページ。
 *   datasets.is_public は 0 のままなので、既存の画面には現れない。
 *   デモ環境（DEMO_MODE=1、認証なし）では存在しない扱いにする。
 *
 *   読むのは港区専用のビュー（migrations/0008_minato_views.sql）だけ。
 *   数字は公表値のまま出す（docs/policy/sex_residual.md の方針 A）。
 *     - 男女の内訳に含まれない人数は、区全体の月次でのみ表示（方針 2）
 *     - 5歳階級は男・女のみ（方針 3）
 *     - 「性別不明」というラベルは使わない（方針 1）
 *
 *   ルート
 *     /minato                 概要（系列・原本・不整合）
 *     /minato/monthly         月次（区全体・地区・町丁目）
 *     /minato/monthly.csv     月次のCSV
 *     /minato/age5            5歳階級（基準日 × 区全体・地区・町丁目 × 国籍）
 *     /minato/raw/{sha256}    CKAN系列の原本（CC BY 互換のもののみ）
 * ===================================================================== */

const MUNI = "131032";
const DS_NOAGE = "minato_noage";
const DS_AGE5 = "minato_5y";
const CKAN_DATASET = "jinko-chochomokubetsu";
const MAX_ALL_TOWNS_MONTHS = 24;

const KEY_RE = /^13103\d{6}$/;
const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-01$/;
const NAT = { all: "日本人＋外国人", japanese: "日本人", foreign: "外国人" };
const AGE_LABEL = (c) => (c === "unknown" ? "年齢不詳" : c === "100+" ? "100歳以上" : `${c.replace("-", "〜")}歳`);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString());

/* ------------------------------------------------------------ 入口 */
export async function handleMinato(url, env) {
  if (env.DEMO_MODE === "1") return null; // デモでは提供しない（ルーターが 404 を返す）
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (p === "/minato") return overview(env);
  if (p === "/minato/monthly") return monthly(env, url, false);
  if (p === "/minato/monthly.csv") return monthly(env, url, true);
  if (p === "/minato/age5") return age5(env, url);
  const raw = p.match(/^\/minato\/raw\/([0-9a-f]{64})$/);
  if (raw) return rawFile(env, raw[1]);
  return null;
}

/* ------------------------------------------------------------ 表示部品 */
function layout(title, body, status = 200) {
  return new Response(`<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>
 :root{--fg:#1a1a1a;--mut:#666;--line:#ddd;--ok:#2f8f4e;--warn:#c47f00;--bad:#c0392b;--bg2:#fafafa;--m:#4a7fb5;--f:#c0607a}
 *{box-sizing:border-box}
 body{font-family:system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;
      color:var(--fg);margin:0;padding:2rem 1.25rem 5rem;max-width:62rem;margin-inline:auto;line-height:1.7}
 h1{font-size:1.4rem;margin:0 0 .25rem} h2{font-size:1.05rem;margin:2.2rem 0 .6rem}
 a{color:#0b5fa5} .mut{color:var(--mut);font-size:.85rem}
 table{border-collapse:collapse;width:100%;font-size:.88rem;margin-top:.5rem}
 th,td{border-bottom:1px solid var(--line);padding:.4rem .6rem;text-align:left;vertical-align:top}
 th{background:var(--bg2);font-weight:600;white-space:nowrap}
 td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
 code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85em;word-break:break-all}
 .pill{display:inline-block;padding:.05rem .45rem;border-radius:.7rem;font-size:.75rem;border:1px solid}
 .pill.ok{color:var(--ok);border-color:var(--ok)} .pill.warn{color:var(--warn);border-color:var(--warn)}
 .pill.bad{color:var(--bad);border-color:var(--bad)}
 .banner{background:#fff7e6;border:1px solid #f0c36d;border-radius:4px;padding:.5rem .8rem;font-size:.85rem;margin-bottom:1.2rem}
 .note{background:var(--bg2);border-left:3px solid var(--line);padding:.6rem .9rem;font-size:.85rem;margin:1rem 0}
 .form{display:flex;flex-wrap:wrap;gap:.75rem;align-items:end;background:var(--bg2);
       border:1px solid var(--line);border-radius:4px;padding:.9rem;margin:.5rem 0}
 .form label{display:flex;flex-direction:column;font-size:.8rem;color:var(--mut);gap:.2rem}
 .form select,.form input{padding:.35rem;font-size:.9rem;color:var(--fg)}
 .form button{padding:.42rem 1rem;font-size:.9rem;cursor:pointer}
 .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(18rem,1fr));gap:1rem}
 .card{border:1px solid var(--line);border-radius:6px;padding:1rem}
 .card h3{margin:0 0 .3rem;font-size:1rem}
 .bar{height:.8rem;border-radius:2px;display:block;flex:none}
 .bm{background:var(--m)} .bf{background:var(--f)}
 td.pl,td.pr{width:34%}
 .prow{display:flex;align-items:center;gap:.35rem;white-space:nowrap}
 .pl .prow{justify-content:flex-end}
 .prow .lbl{flex:none;font-size:.8rem;color:var(--mut);font-variant-numeric:tabular-nums}
 tbody td:first-child,tfoot th:first-child{white-space:nowrap}
 .tblwrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
 details{margin:.5rem 0} summary{cursor:pointer;font-size:.88rem;color:#0b5fa5}
 header nav{font-size:.85rem;margin-bottom:1rem}
 svg text{font-size:10px;fill:#666}
</style></head><body>
<header><nav><a href="/">データセット一覧</a> ・ <a href="/minato">港区トップ</a> ・
 <a href="/minato/monthly">月次</a> ・ <a href="/minato/age5">5歳階級</a> ・ <a href="/logout">ログアウト</a></nav></header>
<div class="banner">港区の試験表示です（認証環境のみ）。目黒区の画面とは統合していません。数字は区の公表値のままです。</div>
${body}</body></html>`, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

const notFound = (msg) => layout("見つかりません", `<h1>見つかりません</h1><p>${esc(msg)}</p>`, 404);
const badRequest = (msg) => layout("指定が不正です", `<h1>指定が不正です</h1><p>${esc(msg)}</p>`, 400);

/* ------------------------------------------------------------ 共通の取得 */
async function loadAreas(env) {
  const { results } = await env.DB.prepare(
    `SELECT a.key_code, a.area_name, g.group_label AS district, g.sort_order
       FROM areas a
       LEFT JOIN area_groups g ON g.key_code = a.key_code AND g.group_kind = 'district'
      WHERE a.muni_code = ?1
      ORDER BY g.sort_order, a.key_code`
  ).bind(MUNI).all();
  const districts = [];
  for (const r of results) if (r.district && !districts.includes(r.district)) districts.push(r.district);
  return { towns: results, districts };
}

async function sexNote(env, key) {
  try {
    const r = await env.DB.prepare(
      `SELECT note FROM v_dataset_sex_note WHERE dataset_key = ?1`).bind(key).first();
    return r?.note ?? null;
  } catch {
    return null; // 0007 未適用の環境
  }
}

async function datasetMeta(env, key) {
  return env.DB.prepare(
    `SELECT dataset_key, title, grain_label, source_site, source_url,
            license, license_url, attribution, notes
       FROM datasets WHERE dataset_key = ?1`
  ).bind(key).first();
}

/* scope: ward / d:<地区> / t:<key_code> を検証して解釈する */
function parseScope(raw, areas) {
  const s = raw || "ward";
  if (s === "ward") return { kind: "ward", label: "港区全体" };
  if (s === "all") return { kind: "all", label: "全町丁目" };
  if (s.startsWith("d:")) {
    const name = s.slice(2);
    return areas.districts.includes(name) ? { kind: "district", name, label: name } : null;
  }
  if (s.startsWith("t:")) {
    const key = s.slice(2);
    const t = KEY_RE.test(key) && areas.towns.find((x) => x.key_code === key);
    return t ? { kind: "town", key, label: `${t.area_name}（${t.district ?? ""}）` } : null;
  }
  return null;
}

function scopeOptions(areas, current, withAll) {
  const opt = (v, l) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(l)}</option>`;
  const byD = areas.districts.map((d) =>
    `<optgroup label="${esc(d)}の町丁目">${areas.towns
      .filter((t) => t.district === d)
      .map((t) => opt(`t:${t.key_code}`, t.area_name)).join("")}</optgroup>`).join("");
  return opt("ward", "港区全体")
    + (withAll ? opt("all", `全町丁目（CSVのみ・${MAX_ALL_TOWNS_MONTHS}か月まで）`) : "")
    + `<optgroup label="地区">${areas.districts.map((d) => opt(`d:${d}`, d)).join("")}</optgroup>`
    + byD;
}

function attributionBlock(meta, extra = "") {
  if (!meta) return "";
  return `<p class="mut">出典：${meta.attribution ? esc(meta.attribution) : esc(meta.source_site)}
   ／ ライセンス：${meta.license
      ? (meta.license_url ? `<a href="${esc(meta.license_url)}" rel="noreferrer">${esc(meta.license)}</a>` : esc(meta.license))
      : '<span class="pill bad">未確認</span>'}${extra}</p>`;
}

/* =====================================================================
 *  概要
 * ===================================================================== */
async function overview(env) {
  const [mNoage, mAge5] = await Promise.all([datasetMeta(env, DS_NOAGE), datasetMeta(env, DS_AGE5)]);
  if (!mNoage && !mAge5) return notFound("港区のデータセットが登録されていません。");

  const { results: periods } = await env.DB.prepare(
    `SELECT dataset_key, MIN(reference_date) AS first, MAX(reference_date) AS last,
            COUNT(*) AS n, SUM(obs_rows) AS obs
       FROM dataset_periods WHERE dataset_key IN (?1, ?2) GROUP BY dataset_key`
  ).bind(DS_NOAGE, DS_AGE5).all();
  const P = Object.fromEntries(periods.map((r) => [r.dataset_key, r]));

  const { results: files } = await env.DB.prepare(
    `SELECT sf.sha256, sf.dataset, sf.source_file, sf.reference_date, sf.content_bytes,
            sf.row_count, COALESCE(sf.distributable, 1) AS distributable, sf.hold_reason,
            COALESCE(sf.is_current, 1) AS is_current,
            (SELECT MIN(p.reference_date) FROM source_file_periods p WHERE p.sha256 = sf.sha256) AS p_first,
            (SELECT MAX(p.reference_date) FROM source_file_periods p WHERE p.sha256 = sf.sha256) AS p_last
       FROM source_files sf
      WHERE sf.muni_code = ?1 AND sf.status = 'ingested'
      ORDER BY sf.dataset, COALESCE(sf.reference_date, p_first)`
  ).bind(MUNI).all();

  const { results: anomalies } = await env.DB.prepare(
    `SELECT d.anomaly_id, d.dataset_key, d.reference_date, d.kind, d.treatment, d.reported,
            a.area_name
       FROM data_anomalies d LEFT JOIN areas a ON a.key_code = d.key_code
      WHERE d.dataset_key IN (?1, ?2)
      ORDER BY d.dataset_key, d.reference_date`
  ).bind(DS_NOAGE, DS_AGE5).all();

  const [noteNoage, noteAge5] = await Promise.all([sexNote(env, DS_NOAGE), sexNote(env, DS_AGE5)]);

  const card = (m, p, note, link, linkLabel) => m ? `<div class="card">
    <h3>${esc(m.title)}</h3>
    <p class="mut">${esc(m.grain_label)} ・ ${m.source_url
      ? `<a href="${esc(m.source_url)}" rel="noreferrer">${esc(m.source_site)}</a>` : esc(m.source_site)}</p>
    <p>${p ? `${esc(p.first)} 〜 ${esc(p.last)}<br><span class="mut">${p.n} 時点 ／ ${num(p.obs)} 行</span>`
           : '<span class="mut">収録なし</span>'}</p>
    <p class="mut">ライセンス：${m.license ? esc(m.license) : '<span class="pill bad">未確認</span>'}</p>
    ${note ? `<p class="mut">※ ${esc(note)}</p>` : ""}
    <p><a href="${link}">${linkLabel} →</a></p>
  </div>` : "";

  const describe = (a) => {
    let r = {};
    try { r = JSON.parse(a.reported || "{}"); } catch { /* 記録の形式違い */ }
    switch (a.kind) {
      case "sum_mismatch":
        return `${esc(a.area_name)}：人口の合計が男女の値と整合しない（原本の値のまま保持し、フラグを付けています）`;
      case "name_variant":
        return `町丁目名の表記ゆれ「${esc(r.town ?? "")}」→「${esc(a.area_name)}」として取り込み`;
      case "blank_cell":
        return `${esc(a.area_name)}：${esc(NAT[r.nationality] ?? "")} ${esc(AGE_LABEL(r.age_class ?? ""))} のセルが空欄（補わずに保持）`;
      case "subtotal_mismatch":
        return "小計行の検算が一致しない箇所（小計行は取り込んでいないため、値への影響はありません）";
      default:
        return esc(a.kind);
    }
  };
  const anomalyRows = anomalies.map((a) => `<tr>
      <td>${a.dataset_key === DS_NOAGE ? "月次" : "5歳階級"}</td>
      <td>${esc(a.reference_date.slice(0, 7))}</td>
      <td>${describe(a)}</td></tr>`).join("");

  const fileRow = (f) => {
    const period = f.reference_date
      ? f.reference_date.slice(0, 7)
      : f.p_first ? `${f.p_first.slice(0, 7)}〜${f.p_last.slice(0, 7)}` : "—";
    const dl = f.dataset === CKAN_DATASET && f.distributable && f.is_current
      ? `<a href="/minato/raw/${esc(f.sha256)}">ダウンロード</a>`
      : f.distributable ? '<span class="mut">—</span>'
      : `<span class="pill bad">配布停止</span>`;
    return `<tr><td>${esc(period)}</td><td>${esc(f.source_file ?? "—")}</td>
      <td class="num">${f.content_bytes ? (f.content_bytes / 1024).toFixed(0) + " KB" : "—"}</td>
      <td class="num">${num(f.row_count)}</td>
      <td><code class="mut">${esc(f.sha256.slice(0, 12))}</code>${f.is_current ? "" : ' <span class="pill warn">旧版</span>'}</td>
      <td>${dl}</td></tr>`;
  };
  const group = (ds, title) => {
    const fs = files.filter((f) => f.dataset === ds);
    if (!fs.length) return "";
    const hold = fs.find((f) => !f.distributable)?.hold_reason;
    return `<details><summary>${esc(title)}（${fs.length} 件）</summary>
      ${hold ? `<div class="note">${esc(hold)}</div>` : ""}
      <table><thead><tr><th>期間</th><th>ファイル名</th><th class="num">サイズ</th><th class="num">行数</th>
      <th>SHA256</th><th></th></tr></thead><tbody>${fs.map(fileRow).join("")}</tbody></table></details>`;
  };

  return layout("港区", `
<h1>港区</h1>
<p class="mut">住民基本台帳に基づく町丁目別の人口（2系列）</p>

<div class="cards">
${card(mNoage, P[DS_NOAGE], noteNoage, "/minato/monthly", "月次を見る")}
${card(mAge5, P[DS_AGE5], noteAge5, "/minato/age5", "5歳階級を見る")}
</div>

<div class="note">2つの系列は、町丁目×基準日の男・女・総数が一致することを取り込み時に確認しています
（5歳階級表の各時点について、月次系列の同じ月と照合）。</div>

<h2>原本</h2>
${group(CKAN_DATASET, "月次（港区オープンデータカタログ）")}
${group("minato_web:chocho_nenrei_5y", "5歳階級（港区ホームページ）")}

<h2>原本の不整合（補正せずに記録しているもの）</h2>
${anomalyRows
    ? `<table><thead><tr><th>系列</th><th>年月</th><th>内容</th></tr></thead><tbody>${anomalyRows}</tbody></table>`
    : '<p class="mut">ありません。</p>'}
`);
}

/* =====================================================================
 *  月次
 * ===================================================================== */
async function monthly(env, url, asCsv) {
  const areas = await loadAreas(env);
  const scope = parseScope(url.searchParams.get("scope"), areas);
  if (!scope) return badRequest("範囲（scope）の指定が不正です。");
  if (scope.kind === "all" && !asCsv) return badRequest("全町丁目はCSVでのみ出力できます。");

  const range = await env.DB.prepare(
    `SELECT MIN(reference_date) AS first, MAX(reference_date) AS last
       FROM dataset_periods WHERE dataset_key = ?1`).bind(DS_NOAGE).first();
  if (!range?.last) return notFound("月次系列が取り込まれていません。");
  const lastYm = range.last.slice(0, 7);
  const firstYm = range.first.slice(0, 7);

  let to = url.searchParams.get("to") || lastYm;
  let from = url.searchParams.get("from") || shiftYm(to, -(MAX_ALL_TOWNS_MONTHS - 1));
  if (!YM_RE.test(from) || !YM_RE.test(to)) return badRequest("期間は YYYY-MM で指定してください。");
  if (from > to) return badRequest("開始が終了より後になっています。");
  if (from < firstYm) from = firstYm;
  if (scope.kind === "all" && monthsBetween(from, to) > MAX_ALL_TOWNS_MONTHS) {
    return badRequest(`全町丁目のCSVは1回あたり ${MAX_ALL_TOWNS_MONTHS} か月までです。`);
  }
  const f = `${from}-01`, t = `${to}-01`;

  let sql, binds;
  if (scope.kind === "ward") {
    sql = `SELECT reference_date, households, male, female, total, not_in_sex_breakdown, anomalies
             FROM v_minato_ward_monthly WHERE reference_date BETWEEN ?1 AND ?2 ORDER BY reference_date`;
    binds = [f, t];
  } else if (scope.kind === "district") {
    sql = `SELECT reference_date, households, male, female, total, anomalies
             FROM v_minato_district_monthly WHERE district = ?1 AND reference_date BETWEEN ?2 AND ?3
            ORDER BY reference_date`;
    binds = [scope.name, f, t];
  } else if (scope.kind === "town") {
    sql = `SELECT reference_date, households, male, female, total, anomaly_id
             FROM v_minato_town_monthly WHERE key_code = ?1 AND reference_date BETWEEN ?2 AND ?3
            ORDER BY reference_date`;
    binds = [scope.key, f, t];
  } else {
    sql = `SELECT key_code, area_name, district, reference_date, households, male, female, total, anomaly_id
             FROM v_minato_town_monthly WHERE reference_date BETWEEN ?1 AND ?2
            ORDER BY reference_date, sort_order`;
    binds = [f, t];
  }
  const { results: rows } = await env.DB.prepare(sql).bind(...binds).all();
  const meta = await datasetMeta(env, DS_NOAGE);

  if (asCsv) {
    const cols = scope.kind === "all"
      ? ["key_code", "area_name", "district", "reference_date", "households", "male", "female", "total", "anomaly_id"]
      : ["reference_date", "households", "male", "female", "total"];
    const head = scope.kind === "all" ? cols : ["scope", ...cols];
    const lines = rows.map((r) => (scope.kind === "all" ? [] : [scope.label])
      .concat(cols.map((c) => r[c])).map(csvCell).join(","));
    const name = `minato_monthly_${scope.kind === "town" ? scope.key : scope.kind === "district" ? "district" : scope.kind}_${from}_${to}.csv`;
    return new Response("\uFEFF" + head.join(",") + "\n" + lines.join("\n") + "\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        "X-Robots-Tag": "noindex, nofollow",
        "Cache-Control": "no-store",
        "X-Source-License": encodeURIComponent(meta?.license ?? "unspecified"),
        "X-Source-Attribution": encodeURIComponent(meta?.attribution ?? "unspecified"),
      },
    });
  }

  const note = await sexNote(env, DS_NOAGE);
  const scopeParam = url.searchParams.get("scope") || "ward";
  const flagged = rows.some((r) => r.anomaly_id || r.anomalies > 0);
  const body = rows.map((r, i) => {
    const prev = rows[i - 1]?.total;
    const diff = prev === undefined || prev === null || r.total === null ? "" : r.total - prev;
    const flag = r.anomaly_id || r.anomalies > 0 ? ' <span class="pill warn">原本に不整合</span>' : "";
    return `<tr><td>${esc(r.reference_date.slice(0, 7))}${flag}</td>
      <td class="num">${num(r.households)}</td><td class="num">${num(r.male)}</td>
      <td class="num">${num(r.female)}</td><td class="num">${num(r.total)}</td>
      <td class="num">${diff === "" ? "" : (diff > 0 ? "+" : "") + diff.toLocaleString()}</td>
      ${scope.kind === "ward" ? `<td class="num">${num(r.not_in_sex_breakdown)}</td>` : ""}</tr>`;
  }).join("");

  return layout(`港区 月次 ${scope.label}`, `
<h1>月次の人口・世帯数</h1>
<p class="mut">${esc(scope.label)} ／ ${esc(from)} 〜 ${esc(to)}</p>

<form class="form" method="GET" action="/minato/monthly">
  <label>範囲 <select name="scope">${scopeOptions(areas, scopeParam, false)}</select></label>
  <label>開始 <input type="month" name="from" value="${esc(from)}" min="${esc(firstYm)}" max="${esc(lastYm)}"></label>
  <label>終了 <input type="month" name="to" value="${esc(to)}" min="${esc(firstYm)}" max="${esc(lastYm)}"></label>
  <button type="submit">表示</button>
</form>

${lineChart(rows)}

<table><thead><tr><th>年月</th><th class="num">世帯数</th><th class="num">男</th><th class="num">女</th>
<th class="num">総数</th><th class="num">総数の前月差</th>
${scope.kind === "ward" ? '<th class="num">男女の内訳に<br>含まれない人数</th>' : ""}</tr></thead>
<tbody>${body || '<tr><td colspan="7">該当する月がありません</td></tr>'}</tbody></table>

${note ? `<div class="note">${esc(note)}${scope.kind === "ward"
    ? "区全体の月次に限り、その人数を右端の列に示しています。" : ""}</div>` : ""}
${flagged ? '<div class="note">「原本に不整合」の月は、区の公表値に整合しない箇所があります。値は補正せずそのまま表示しています（詳細は<a href="/minato">港区トップ</a>）。</div>' : ""}

<h2>CSV</h2>
<form class="form" method="GET" action="/minato/monthly.csv">
  <label>範囲 <select name="scope">${scopeOptions(areas, scopeParam, true)}</select></label>
  <label>開始 <input type="month" name="from" value="${esc(from)}" min="${esc(firstYm)}" max="${esc(lastYm)}"></label>
  <label>終了 <input type="month" name="to" value="${esc(to)}" min="${esc(firstYm)}" max="${esc(lastYm)}"></label>
  <button type="submit">CSVをダウンロード</button>
</form>
<p class="mut">列は横持ち（世帯数・男・女・総数）です。総数は区の公表値で、男＋女と一致しない場合があります。</p>
${attributionBlock(meta)}
`);
}

function lineChart(rows) {
  const pts = rows.filter((r) => r.total !== null && r.total !== undefined);
  if (pts.length < 2) return "";
  const W = 900, H = 180, L = 60, R = 10, T = 10, B = 24;
  const vals = pts.map((r) => r.total);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo -= 1; hi += 1; }
  const x = (i) => L + (i * (W - L - R)) / (pts.length - 1);
  const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
  const d = pts.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(r.total).toFixed(1)}`).join("");
  const step = Math.max(1, Math.ceil(pts.length / 8));
  const ticks = pts.map((r, i) => (i % step === 0 || i === pts.length - 1)
    ? `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(r.reference_date.slice(0, 7))}</text>` : "").join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="総数の推移">
  <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#ccc"/>
  <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#ccc"/>
  <text x="${L - 6}" y="${T + 8}" text-anchor="end">${hi.toLocaleString()}</text>
  <text x="${L - 6}" y="${H - B}" text-anchor="end">${lo.toLocaleString()}</text>
  <path d="${d}" fill="none" stroke="#0b5fa5" stroke-width="2"/>${ticks}</svg>
  <p class="mut">総数（公表値）の推移</p>`;
}

/* =====================================================================
 *  5歳階級
 * ===================================================================== */
async function age5(env, url) {
  const areas = await loadAreas(env);
  const scopeParam = url.searchParams.get("scope") || "ward";
  const scope = parseScope(scopeParam, areas);
  if (!scope || scope.kind === "all") return badRequest("範囲（scope）の指定が不正です。");

  const nat = url.searchParams.get("nat") || "all";
  if (!NAT[nat]) return badRequest("国籍（nat）の指定が不正です。");

  const { results: dates } = await env.DB.prepare(
    `SELECT reference_date FROM dataset_periods WHERE dataset_key = ?1 AND obs_rows > 0
      ORDER BY reference_date`).bind(DS_AGE5).all();
  if (!dates.length) return notFound("5歳階級の系列が取り込まれていません。");
  const dateList = dates.map((r) => r.reference_date);
  const date = url.searchParams.get("date") || dateList[dateList.length - 1];
  if (!DATE_RE.test(date) || !dateList.includes(date)) return badRequest("基準日の指定が不正です。");

  const natAt = scope.kind === "ward" ? 2 : 3;
  const natWhere = nat === "all" ? "" : ` AND nationality = ?${natAt}`;
  let sql, binds;
  const agg = `SELECT age_class, MIN(sort_order) AS sort_order, SUM(male) AS male, SUM(female) AS female,
                      SUM(blank_cells) AS blank_cells`;
  if (scope.kind === "ward") {
    sql = `${agg} FROM v_minato_age5_ward WHERE reference_date = ?1${natWhere}
           GROUP BY age_class ORDER BY sort_order`;
    binds = [date];
  } else if (scope.kind === "district") {
    sql = `${agg} FROM v_minato_age5_district WHERE reference_date = ?1 AND district = ?2${natWhere}
           GROUP BY age_class ORDER BY sort_order`;
    binds = [date, scope.name];
  } else {
    sql = `${agg} FROM v_minato_age5 WHERE reference_date = ?1 AND key_code = ?2${natWhere}
           GROUP BY age_class ORDER BY sort_order`;
    binds = [date, scope.key];
  }
  if (nat !== "all") binds.push(nat);
  const { results: rows } = await env.DB.prepare(sql).bind(...binds).all();

  const meta = await datasetMeta(env, DS_AGE5);
  const note = await sexNote(env, DS_AGE5);
  const maxV = Math.max(1, ...rows.flatMap((r) => [r.male ?? 0, r.female ?? 0]));
  const sumM = rows.reduce((s, r) => s + (r.male ?? 0), 0);
  const sumF = rows.reduce((s, r) => s + (r.female ?? 0), 0);
  const blanks = rows.reduce((s, r) => s + (r.blank_cells ?? 0), 0);
  // ラベル分の幅は、表示する数値の最大桁数から決める（桁が増えても棒がはみ出さない）
  const maxChars = Math.max(1, ...rows.flatMap((r) => [num(r.male).length, num(r.female).length]));
  const reserve = (maxChars * 0.5 + 0.8).toFixed(2);
  const w = (v) => (v ? `max(1px, calc((100% - ${reserve}em) * ${((v ?? 0) / maxV).toFixed(4)}))` : "0");

  const body = rows.map((r) => `<tr>
    <td>${esc(AGE_LABEL(r.age_class))}${r.blank_cells ? ' <span class="pill warn">空欄あり</span>' : ""}</td>
    <td class="pl"><div class="prow"><span class="lbl">${num(r.male)}</span><span class="bar bm" style="width:${w(r.male)}"></span></div></td>
    <td class="pr"><div class="prow"><span class="bar bf" style="width:${w(r.female)}"></span><span class="lbl">${num(r.female)}</span></div></td>
    <td class="num">${r.male === null || r.female === null ? "—" : num(r.male + r.female)}</td>
  </tr>`).join("");

  const opt = (v, l, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`;

  return layout(`港区 5歳階級 ${scope.label}`, `
<h1>年齢5歳階級別の人口</h1>
<p class="mut">${esc(scope.label)} ／ ${esc(date)} 現在 ／ ${esc(NAT[nat])}</p>

<form class="form" method="GET" action="/minato/age5">
  <label>基準日 <select name="date">${dateList.map((d) => opt(d, d, date)).join("")}</select></label>
  <label>範囲 <select name="scope">${scopeOptions(areas, scopeParam, false)}</select></label>
  <label>国籍 <select name="nat">${Object.entries(NAT).map(([k, l]) => opt(k, l, nat)).join("")}</select></label>
  <button type="submit">表示</button>
</form>

<div class="tblwrap"><table><thead><tr><th>年齢</th><th class="num">男</th><th>女</th><th class="num">男女計</th></tr></thead>
<tbody>${body || '<tr><td colspan="4">該当するデータがありません</td></tr>'}</tbody>
<tfoot><tr><th>計</th><th class="num">${num(sumM)}</th><th>${num(sumF)}</th><th class="num">${num(sumM + sumF)}</th></tr></tfoot>
</table></div>

<div class="note">この表は男・女の値のみを表示しています。「男女計」は男＋女で、区が公表する総数とは一致しない場合があります。
町丁目の総数（公表値）は<a href="/minato/monthly?scope=${esc(encodeURIComponent(scopeParam))}&from=${esc(date.slice(0, 7))}&to=${esc(date.slice(0, 7))}">月次のページ</a>で確認できます。
${note ? esc(note) : ""}</div>
${blanks ? `<div class="note">原本で空欄のセルが ${blanks} 件あります。値を補わずに集計しているため、該当する行と合計は空欄の分だけ小さくなります。</div>` : ""}

<p class="mut">ダウンロードは提供していません。区ホームページの掲載資料のため、利用条件の確認が取れてから提供します。</p>
${attributionBlock(meta, " ／ 認証環境での内部確認用")}
`);
}

/* =====================================================================
 *  原本（CKAN系列のみ）
 * ===================================================================== */
async function rawFile(env, sha256) {
  const row = await env.DB.prepare(
    `SELECT sf.sha256, sf.r2_key, sf.source_file, COALESCE(sf.distributable, 1) AS distributable,
            sf.hold_reason, d.license, d.attribution
       FROM source_files sf
       JOIN datasets d ON d.dataset_key = ?2
      WHERE sf.sha256 = ?1 AND sf.dataset = ?3`
  ).bind(sha256, DS_NOAGE, CKAN_DATASET).first();
  if (!row) return notFound("指定されたファイルは提供対象ではありません。");
  if (!row.distributable || !row.license) {
    return layout("配布停止中", `<h1>配布停止中</h1>
      <div class="note">${esc(row.hold_reason ?? "ライセンスが確認できていません。")}</div>`, 403);
  }
  const obj = await env.LAKE.get(row.r2_key);
  if (!obj) {
    return layout("エラー", `<h1>原本が見つかりません</h1>
      <p>D1には記録がありますが、R2に実体がありません。</p>`, 502);
  }
  const name = row.source_file || `${sha256.slice(0, 12)}.csv`;
  const headers = new Headers({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    "X-Robots-Tag": "noindex, nofollow",
    "Cache-Control": "no-store",
    "X-Source-SHA256": row.sha256,
    "X-Source-License": encodeURIComponent(row.license),
  });
  if (obj.size) headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
}

/* ------------------------------------------------------------ 補助 */
function shiftYm(ym, delta) {
  let [y, m] = ym.split("-").map(Number);
  m += delta;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

function monthsBetween(from, to) {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
