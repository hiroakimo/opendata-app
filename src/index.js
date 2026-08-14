/* =====================================================================
 *  opendata-app / Worker
 *
 *   入口で共有パスワード認証（要件1）→ データセット一覧（要件2）
 *
 *   認証は fetch() の先頭だけで完結させ、アプリ本体（router）には
 *   一切持ち込まない。後で Cloudflare Access に差し替えるとき、
 *   前半のブロックを削るだけで済むようにするため。
 * ===================================================================== */

import { handleAnalysis } from "./analysis.js";   // 20260814 追加

const COOKIE = "__Host-session";
const TTL = 60 * 60 * 12; // 12時間

/* ---------------------------------------------------------------- 署名 */
const te = new TextEncoder();

const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64uDec = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const hmacKey = (secret) =>
  crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"]);

const sign = async (secret, data) =>
  b64u(await crypto.subtle.sign("HMAC", await hmacKey(secret), te.encode(data)));

const verifySig = async (secret, data, sig) => {
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), b64uDec(sig), te.encode(data));
  } catch {
    return false;
  }
};

/* ---------------------------------------------------------------- 認証 */
async function isAuthed(request, env) {
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)__Host-session=([^;]+)/);
  if (!m) return false;
  const [ver, exp, sig] = m[1].split(".");
  if (ver !== "v1" || !sig) return false;
  if (!(Number(exp) > Date.now() / 1000)) return false;
  return verifySig(env.COOKIE_SECRET, `v1.${exp}`, sig);
}

// 生の文字列比較を避け、双方をHMACに通してから比べる
async function checkPassword(env, submitted) {
  const a = await sign(env.COOKIE_SECRET, `pw:${submitted}`);
  const b = await sign(env.COOKIE_SECRET, `pw:${env.APP_PASSWORD}`);
  return a === b;
}

async function issueCookie(env) {
  const exp = Math.floor(Date.now() / 1000) + TTL;
  const sig = await sign(env.COOKIE_SECRET, `v1.${exp}`);
  return `${COOKIE}=v1.${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL}`;
}

/* ------------------------------------------------------------ 応答補助 */
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const html = (body, status = 200, extra = {}) =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      ...extra,
    },
  });

const json = (obj, status = 200) =>
  Response.json(obj, { status, headers: { "X-Robots-Tag": "noindex, nofollow" } });

/* ------------------------------------------------------------- 月の操作 */
const ymOf = (d) => String(d).slice(0, 7); // '2010-04-01' -> '2010-04'

function monthRange(fromYm, toYm) {
  const out = [];
  if (!fromYm || !toYm) return out;
  let [y, m] = fromYm.split("-").map(Number);
  const [ey, em] = toYm.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/* =====================================================================
 *  エントリポイント
 * ===================================================================== */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const safeNext = (v) => (v && v.startsWith("/") && !v.startsWith("//") ? v : "/");

    /* --- ログイン ------------------------------------------------- */
    if (url.pathname === "/login") {
      if (request.method === "GET") {
        return html(loginPage(safeNext(url.searchParams.get("next")), false));
      }
      if (request.method === "POST") {
        const form = await request.formData();
        const next = safeNext(form.get("next"));
        if (await checkPassword(env, form.get("password") || "")) {
          return new Response(null, {
            status: 303,
            headers: { Location: next, "Set-Cookie": await issueCookie(env) },
          });
        }
        await new Promise((r) => setTimeout(r, 800)); // 総当たりの速度を落とす
        return html(loginPage(next, true), 401);
      }
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/logout") {
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/login",
          "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        },
      });
    }

    /* --- 認証の壁 ------------------------------------------------- */
    if (!(await isAuthed(request, env))) {
      if (url.pathname.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
      return new Response(null, {
        status: 302,
        headers: { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` },
      });
    }

    /* --- ここから先はアプリ本体 ----------------------------------- */
    try {
      return await router(request, url, env, ctx);
    } catch (e) {
      return html(page("エラー", `<h1>エラー</h1><pre>${esc(e.message)}</pre>`), 500);
    }
  },
};

/* =====================================================================
 *  ルーティング
 * ===================================================================== */
async function router(request, url, env) {
  if (url.pathname === "/") return catalogPage(env);
  if (url.pathname === "/api/catalog") return json({ datasets: await loadCatalog(env) });

  const m = url.pathname.match(/^\/dataset\/([A-Za-z0-9_-]+)$/);
  if (m) return datasetPage(env, m[1]);

  const dl = url.pathname.match(/^\/download\/raw\/([0-9a-f]{64})$/);
  if (dl) return downloadRaw(env, dl[1]);

  if (url.pathname === "/download/csv") return downloadCsv(env, url);

  const an = await handleAnalysis(env, url);  // 20260814追加
  if (an) return an;                          // 20260814追加

  return html(page("404", "<h1>404</h1><p><a href='/'>一覧へ</a></p>"), 404);
}

/* =====================================================================
 *  データ取得
 * ===================================================================== */
async function loadCatalog(env) {
  const { results: datasets } = await env.DB.prepare(
    `SELECT dataset_key, muni_code, muni_name, domain, title, granularity, grain_label,
            source_site, source_url, license, attribution, notes
       FROM datasets WHERE is_public = 1
      ORDER BY muni_code, granularity`
  ).all();

  const { results: periods } = await env.DB.prepare(
    `SELECT dataset_key, reference_date, file_count, obs_rows FROM dataset_periods`
  ).all();

  const { results: gaps } = await env.DB.prepare(
    `SELECT dataset_key, reference_date, kind, reason FROM dataset_gaps`
  ).all();

  // 最終取込時刻は source_files 側から。dataset_sources を経由して集約する
  const { results: health } = await env.DB.prepare(
    `SELECT ds.dataset_key,
            MAX(sf.ingested_at) AS last_ingested_at,
            COUNT(*)            AS files_total,
            SUM(CASE WHEN sf.status = 'skipped' THEN 1 ELSE 0 END) AS files_skipped
       FROM source_files sf
       JOIN dataset_sources ds
         ON ds.dataset = sf.dataset AND ds.granularity = sf.granularity
      GROUP BY 1`
  ).all();

  // 同期の試行。source_files には「成功」しか残らないため別建て
  const { results: runs } = await env.DB.prepare(
    `SELECT dataset_key,
            MAX(started_at)                                        AS last_run_at,
            MAX(CASE WHEN status IN ('ok','no_change') THEN started_at END) AS last_ok_at
       FROM sync_runs GROUP BY 1`
  ).all();

  // 原本ファイル。dataset_sources に対応付いたものだけが対象になるので、
  // meguro_local_seed のような未対応付けのものはここに現れない。
  // ただしそれは副作用であり、配布可否の判定は distributable が担う。
  const { results: files } = await env.DB.prepare(
    `SELECT ds.dataset_key, sf.sha256, sf.r2_key, sf.reference_date, sf.source_file,
            sf.content_bytes, sf.status, sf.row_count,
            COALESCE(sf.distributable, 1) AS distributable, sf.hold_reason
       FROM source_files sf
       JOIN dataset_sources ds
         ON ds.dataset = sf.dataset AND ds.granularity = sf.granularity
      ORDER BY sf.reference_date, sf.ingested_at`
  ).all();

  const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.dataset_key, r]));
  const H = byKey(health), R = byKey(runs);

  return datasets.map((d) => {
    const ps = periods.filter((p) => p.dataset_key === d.dataset_key);
    const gs = gaps.filter((g) => g.dataset_key === d.dataset_key);
    const gapBy = Object.fromEntries(gs.map((g) => [ymOf(g.reference_date), g]));

    const pBy = {};
    for (const p of ps) pBy[ymOf(p.reference_date)] = p;

    const present = ps.filter((p) => p.obs_rows > 0).map((p) => ymOf(p.reference_date)).sort();
    const from = present[0] ?? null;
    const to = present[present.length - 1] ?? null;

    // 欠測は「期間内に存在するはずの月のうち観測行が無いもの」
    const months = monthRange(from, to).map((ym) => {
      const p = pBy[ym];
      const state = p?.obs_rows > 0 ? "ok" : p?.file_count > 0 ? "not_loaded" : "missing";
      return { ym, state, obs_rows: p?.obs_rows ?? 0, files: p?.file_count ?? 0, gap: gapBy[ym] ?? null };
    });

    // 期間の外側にあるファイルも拾う（2026-08 の 1y がここに出る）
    const outside = ps
      .filter((p) => p.obs_rows === 0 && p.file_count > 0 && !monthRange(from, to).includes(ymOf(p.reference_date)))
      .map((p) => ({ ym: ymOf(p.reference_date), state: "not_loaded", obs_rows: 0,
                     files: p.file_count, gap: gapBy[ymOf(p.reference_date)] ?? null }));

    const all = [...months, ...outside].sort((a, b) => a.ym.localeCompare(b.ym));

    // 月に原本を添える。同一月に複数版がありうる（差し替え）ので配列で持つ
    const fs = files.filter((f) => f.dataset_key === d.dataset_key);
    for (const m of all) m.files = fs.filter((f) => ymOf(f.reference_date) === m.ym);

    return {
      ...d,
      period_from: from,
      period_to: to,
      months_expected: all.length,
      months_present: present.length,
      obs_rows: ps.reduce((s, p) => s + p.obs_rows, 0),
      anomalies: all.filter((x) => x.state !== "ok"),
      months: all,
      last_ingested_at: H[d.dataset_key]?.last_ingested_at ?? null,
      files_total: H[d.dataset_key]?.files_total ?? 0,
      files_skipped: H[d.dataset_key]?.files_skipped ?? 0,
      last_run_at: R[d.dataset_key]?.last_run_at ?? null,
      last_ok_at: R[d.dataset_key]?.last_ok_at ?? null,
    };
  });
}

/* =====================================================================
 *  原本ダウンロード（要件3）
 *
 *   R2の公開URLは認証を通らないため、必ずWorkerを経由させる。
 *   配布可否は distributable で明示的に判定する。
 *   「一覧に出ないから配られない」に依存すると、経路が増えた瞬間に破れる。
 * ===================================================================== */
const MIME = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
};

async function downloadRaw(env, sha256) {
  // dataset_sources に対応付いた公開データセットのものだけを配る
  const row = await env.DB.prepare(
    `SELECT sf.sha256, sf.r2_key, sf.source_file, sf.reference_date, sf.content_bytes,
            COALESCE(sf.distributable, 1) AS distributable, sf.hold_reason,
            d.dataset_key, d.title, d.license, d.attribution
       FROM source_files sf
       JOIN dataset_sources ds
         ON ds.dataset = sf.dataset AND ds.granularity = sf.granularity
       JOIN datasets d
         ON d.dataset_key = ds.dataset_key AND d.is_public = 1
      WHERE sf.sha256 = ?1
      LIMIT 1`
  ).bind(sha256).first();

  if (!row) {
    return html(page("404", `<h1>見つかりません</h1>
      <p>指定されたファイルは公開対象ではありません。</p>
      <p><a href="/">一覧へ</a></p>`), 404);
  }

  // 存在を隠すのではなく、理由を示して断る。
  // 解除したときに何が変わったのかを説明できる状態にしておく。
  if (!row.distributable) {
    return html(page("配布停止中", `
      <h1>配布停止中</h1>
      <p>${esc(row.title)} / ${esc(ymOf(row.reference_date))} の原本は、現在ダウンロードできません。</p>
      <div class="note">${esc(row.hold_reason ?? "理由が記録されていません。")}</div>
      <p class="mut"><code>${esc(row.sha256)}</code></p>
      <p><a href="/dataset/${esc(row.dataset_key)}">データセットへ戻る</a></p>`), 403);
  }

  const obj = await env.LAKE.get(row.r2_key);
  if (!obj) {
    return html(page("エラー", `<h1>原本が見つかりません</h1>
      <p>D1には記録がありますが、R2に実体がありません。同期の不整合です。</p>
      <p class="mut"><code>${esc(row.r2_key)}</code></p>`), 502);
  }

  const name = row.source_file || `${sha256.slice(0, 12)}.bin`;
  const ext = name.split(".").pop().toLowerCase();

  const headers = new Headers();
  headers.set("Content-Type", MIME[ext] ?? "application/octet-stream");
  headers.set("Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  // 監査のため、配ったものの素性をヘッダに残す
  headers.set("X-Source-SHA256", row.sha256);
  headers.set("X-Source-License", row.license ?? "unspecified");
  if (obj.size) headers.set("Content-Length", String(obj.size));

  return new Response(obj.body, { headers });
}

/* =====================================================================
 *  正規化データ（long形式）のCSVダウンロード（要件3）
 *
 *   出力元は必ずビュー。observations_* を直接読まない。
 *   ビューが total 行を落としているので、受け取った側が素直に
 *   SUM(value) しても二重計上にならない。
 *
 *   期間の上限を設けているのは課金対策ではなく、完全なファイルしか
 *   出さないため。途中で切れたCSVは開けてしまうので気づかれにくい。
 * ===================================================================== */
const MAX_MONTHS = 24;
const CHUNK = 5000;

// ビュー名はユーザー入力から作らない。ここでの完全一致のみを許す。
function exportSpec(granularity, measure) {
  const ageCols = ["muni_code", "key_code", "area_name", "reference_date",
                   "age_class", "sex", "value", "source_sha256"];
  const table = {
    "5y:population":         { view: "v_population_5y",         cols: ageCols,
                               label: "人口（5歳階級×性別）" },
    "5y:households":         { view: "v_households_5y",
                               cols: ["muni_code", "key_code", "area_name", "reference_date", "value", "source_sha256"],
                               label: "世帯数" },
    "5y:foreign_population": { view: "v_foreign_population_5y",
                               cols: ["muni_code", "key_code", "area_name", "reference_date", "sex", "value", "source_sha256"],
                               label: "外国人人口" },
    "5y:published_totals":   { view: "v_published_totals_5y",
                               cols: ["muni_code", "key_code", "area_name", "reference_date", "measure", "value"],
                               label: "区の公表値（検算用・総数行）" },
    "1y:population":         { view: "v_population_1y",         cols: ageCols,
                               label: "人口（1歳階級×性別）" },
  };
  return table[`${granularity}:${measure}`] ?? null;
}

const monthsBetween = (from, to) => {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
};

const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function errPage(title, body, status) {
  return html(page(title, `<h1>${esc(title)}</h1>${body}<p><a href="/">一覧へ</a></p>`), status);
}

async function downloadCsv(env, url) {
  const key = url.searchParams.get("dataset") ?? "";
  const measure = url.searchParams.get("measure") ?? "population";
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";

  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) {
    return errPage("期間の指定が不正です", "<p>YYYY-MM の形式で指定してください。</p>", 400);
  }
  if (from > to) {
    return errPage("期間の指定が不正です", "<p>開始が終了より後になっています。</p>", 400);
  }

  const d = await env.DB.prepare(
    `SELECT dataset_key, title, granularity, muni_name, license, attribution
       FROM datasets WHERE dataset_key = ?1 AND is_public = 1`
  ).bind(key).first();
  if (!d) return errPage("データセットが見つかりません", "", 404);

  const spec = exportSpec(d.granularity, measure);
  if (!spec) return errPage("指定された内容は出力できません",
    `<p><code>${esc(measure)}</code> は ${esc(d.granularity)} 粒度では提供していません。</p>`, 400);

  const n = monthsBetween(from, to);
  if (n > MAX_MONTHS) {
    // 断るだけだと利用者が試行錯誤するので、収まる期間を示す
    const [fy, fm] = from.split("-").map(Number);
    const endM = fm + MAX_MONTHS - 1;
    const suggest = `${fy + Math.floor((endM - 1) / 12)}-${String(((endM - 1) % 12) + 1).padStart(2, "0")}`;
    return errPage("期間が長すぎます", `
      <p>指定は ${n} ヶ月です。1回あたり ${MAX_MONTHS} ヶ月までに制限しています。</p>
      <p>途中で打ち切られたCSVは一見開けてしまい、行の不足に気づきにくいためです。</p>
      <div class="note">例：<code>${esc(from)}</code> 〜 <code>${esc(suggest)}</code> に分けてください。</div>`, 400);
  }

  const order = ["reference_date", "key_code", "measure", "age_class", "sex"]
    .filter((c) => spec.cols.includes(c)).join(", ");
  const sql = `SELECT ${spec.cols.join(", ")} FROM ${spec.view}
                WHERE muni_code = ?1 AND reference_date >= ?2 AND reference_date <= ?3
                ORDER BY ${order} LIMIT ?4 OFFSET ?5`;

  const muni = (await env.DB.prepare(
    `SELECT muni_code FROM datasets WHERE dataset_key = ?1`).bind(key).first())?.muni_code;

  const enc = new TextEncoder();
  let offset = 0, done = false;

  const stream = new ReadableStream({
    start(controller) {
      // BOM。Excelでそのまま開いたときに文字化けしないため
      controller.enqueue(enc.encode("\uFEFF" + spec.cols.join(",") + "\n"));
    },
    async pull(controller) {
      if (done) return;
      const { results } = await env.DB.prepare(sql)
        .bind(muni, `${from}-01`, `${to}-01`, CHUNK, offset).all();
      if (!results.length) { done = true; controller.close(); return; }
      let buf = "";
      for (const r of results) buf += spec.cols.map((c) => csvCell(r[c])).join(",") + "\n";
      controller.enqueue(enc.encode(buf));
      offset += results.length;
      if (results.length < CHUNK) { done = true; controller.close(); }
    },
  });

  const name = `${key}_${measure}_${from}_${to}.csv`;
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Robots-Tag": "noindex, nofollow",
      "X-Source-View": spec.view,
      "X-Source-License": d.license ?? "unspecified",
      "X-Source-Attribution": d.attribution ?? "unspecified",
    },
  });
}

/* =====================================================================
 *  画面
 * ===================================================================== */
function page(title, body) {
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>
 :root{--fg:#1a1a1a;--mut:#666;--line:#ddd;--ok:#2f8f4e;--warn:#c47f00;--bad:#c0392b;--bg2:#fafafa}
 *{box-sizing:border-box}
 body{font-family:system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;
      color:var(--fg);margin:0;padding:2rem 1.25rem 5rem;max-width:62rem;margin-inline:auto;line-height:1.7}
 h1{font-size:1.4rem;margin:0 0 .25rem} h2{font-size:1.05rem;margin:2.5rem 0 .6rem}
 a{color:#0b5fa5} .mut{color:var(--mut);font-size:.85rem}
 table{border-collapse:collapse;width:100%;font-size:.88rem;margin-top:.5rem}
 th,td{border-bottom:1px solid var(--line);padding:.5rem .6rem;text-align:left;vertical-align:top}
 th{background:var(--bg2);font-weight:600;white-space:nowrap}
 td.num{text-align:right;font-variant-numeric:tabular-nums}
 code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85em;word-break:break-all}
 .pill{display:inline-block;padding:.05rem .45rem;border-radius:.7rem;font-size:.75rem;border:1px solid}
 .pill.ok{color:var(--ok);border-color:var(--ok)}
 .pill.warn{color:var(--warn);border-color:var(--warn)}
 .pill.bad{color:var(--bad);border-color:var(--bad)}
 .grid{display:flex;flex-wrap:wrap;gap:2px;margin:.35rem 0 1rem}
 .cell{width:1.5rem;height:1.5rem;border-radius:2px;font-size:.6rem;display:flex;
       align-items:center;justify-content:center;color:#fff}
 .cell.ok{background:#bcd9c5;color:#2a4a33}
 .cell.not_loaded{background:var(--warn)}
 .cell.missing{background:var(--bad)}
 .yr{display:flex;align-items:center;gap:.5rem;margin-bottom:2px}
 .yr b{width:3rem;font-size:.78rem;color:var(--mut);font-weight:600}
 a.celllink{text-decoration:none;display:block}
 a.celllink:hover .cell{outline:2px solid #0b5fa5;outline-offset:1px}
 .dlform{display:flex;flex-wrap:wrap;gap:.75rem;align-items:end;background:var(--bg2);
         border:1px solid var(--line);border-radius:4px;padding:.9rem;margin:.5rem 0}
 .dlform label{display:flex;flex-direction:column;font-size:.8rem;color:var(--mut);gap:.2rem}
 .dlform select,.dlform input{padding:.35rem;font-size:.9rem;color:var(--fg)}
 .dlform button{padding:.42rem 1rem;font-size:.9rem;cursor:pointer}
 details{margin:.5rem 0}
 summary{cursor:pointer;font-size:.88rem;color:#0b5fa5}
 header nav{font-size:.85rem;margin-bottom:1.5rem}
 .note{background:var(--bg2);border-left:3px solid var(--line);padding:.6rem .9rem;font-size:.85rem;margin:1rem 0}
</style></head><body>
<header><nav><a href="/">データセット一覧</a> ・ <a href="/logout">ログアウト</a></nav></header>
${body}</body></html>`;
}

function loginPage(next, error) {
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>認証</title>
<style>body{font-family:system-ui,sans-serif;max-width:22rem;margin:6rem auto;padding:0 1rem;line-height:1.7}
input,button{width:100%;padding:.6rem;font-size:1rem;box-sizing:border-box}
button{margin-top:.75rem;cursor:pointer}.err{color:#c0392b;font-size:.9rem}
.note{color:#666;font-size:.85rem;margin-top:2rem}</style></head><body>
<h1>認証</h1>
${error ? '<p class="err">パスワードが違います。</p>' : ""}
<form method="POST" action="/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <input type="password" name="password" placeholder="パスワード" autofocus required autocomplete="current-password">
  <button type="submit">入る</button>
</form>
<p class="note">開発テスト中のため関係者限定で公開しています。</p>
</body></html>`;
}

async function catalogPage(env) {
  const cat = await loadCatalog(env);

  const rows = cat.map((d) => {
    const bad = d.anomalies.length;
    const health = bad === 0
      ? '<span class="pill ok">正常</span>'
      : `<span class="pill warn">要確認 ${bad}</span>`;
    const lic = d.license
      ? esc(d.license)
      : '<span class="pill bad">未確認</span>';
    return `<tr>
      <td><a href="/dataset/${esc(d.dataset_key)}">${esc(d.title)}</a><br>
          <span class="mut">${esc(d.muni_name)} · ${esc(d.grain_label)} · ${esc(d.source_site)}</span></td>
      <td>${esc(d.period_from ?? "—")} 〜 ${esc(d.period_to ?? "—")}<br>
          <span class="mut">${d.months_present} / ${d.months_expected} ヶ月</span></td>
      <td class="num">${d.obs_rows.toLocaleString()}</td>
      <td>${health}</td>
      <td>${lic}</td>
      <td class="mut">${esc(d.last_ok_at ?? d.last_ingested_at ?? "—")}</td>
    </tr>`;
  }).join("");

  const noLicense = cat.filter((d) => !d.license).length;
  const noAttr = cat.filter((d) => d.license && !d.attribution).length;
  const noRuns = cat.filter((d) => !d.last_run_at).length;

  // known_issues はまだ無い環境もありうるので失敗を握りつぶす
  let issues = [];
  try {
    const r = await env.DB.prepare(
      `SELECT severity, title FROM known_issues WHERE resolved_at IS NULL
        ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`
    ).all();
    issues = r.results ?? [];
  } catch { /* テーブル未作成 */ }

  const warnings = [];
  if (noAttr) warnings.push(
    `<strong>出典表示（attribution）が未設定のデータセットが ${noAttr} 件あります。</strong>
     CC BY は帰属表示が義務です。原本を配布する前に
     <code>datasets.attribution</code> を埋めてください。`);
  if (noLicense) warnings.push(
    `<strong>ライセンス未確認が ${noLicense} 件あります。</strong>
     収集時点で記録しないと、後から遡って調べる作業が発生します。
     <code>datasets.license</code> / <code>attribution</code> を埋めてください。`);
  if (noRuns) warnings.push(
    `<strong>同期の試行ログがありません。</strong>
     いまの「最終更新」は取込に成功したファイルの時刻なので、
     上流が落ちて何も取れなかった日は痕跡が残りません。
     GitHub Actions から <code>sync_runs</code> に1行書くようにしてください。`);

  return html(page("データセット一覧", `
<h1>データセット一覧</h1>
<p class="mut">東京都オープンデータ統合基盤（試験公開）</p>

<table>
  <thead><tr><th>データセット</th><th>期間</th><th>行数</th><th>状態</th><th>ライセンス</th><th>最終同期</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6">データセットがありません</td></tr>'}</tbody>
</table>

${warnings.map((w) => `<div class="note">${w}</div>`).join("")}

${issues.length ? `<h2>既知の課題（${issues.length}）</h2>
<table><thead><tr><th>重要度</th><th>内容</th></tr></thead><tbody>
${issues.map((i) => `<tr>
  <td><span class="pill ${i.severity === "high" ? "bad" : "warn"}">${esc(i.severity)}</span></td>
  <td>${esc(i.title)}</td></tr>`).join("")}
</tbody></table>
<p class="mut">解決済みの課題は <code>known_issues.resolved_at</code> を埋めると消えます。</p>` : ""}
`));
}

async function datasetPage(env, key) {
  const cat = await loadCatalog(env);
  const d = cat.find((x) => x.dataset_key === key);
  if (!d) return html(page("404", "<h1>404</h1><p><a href='/'>一覧へ</a></p>"), 404);

  // 年ごとに12マスの帯を作る
  const byYear = {};
  for (const m of d.months) (byYear[m.ym.slice(0, 4)] ||= []).push(m);
  const grid = Object.keys(byYear).sort().map((y) => {
    const cells = Array.from({ length: 12 }, (_, i) => {
      const ym = `${y}-${String(i + 1).padStart(2, "0")}`;
      const m = byYear[y].find((x) => x.ym === ym);
      if (!m) return `<div class="cell" style="background:#f0f0f0"></div>`;
      const t = m.state === "ok" ? `${m.obs_rows.toLocaleString()}行`
              : m.state === "not_loaded" ? "ファイルはあるがDB未反映"
              : "欠測";
      const tip = `${ym} — ${t}${m.gap ? " / " + esc(m.gap.reason) : ""}`;
      const dlable = (m.files ?? []).find((f) => f.distributable);
      const inner = `<div class="cell ${m.state}" title="${tip}">${i + 1}</div>`;
      return dlable
        ? `<a href="/download/raw/${esc(dlable.sha256)}" class="celllink">${inner}</a>`
        : inner;
    }).join("");
    return `<div class="yr"><b>${y}</b>${cells}</div>`;
  }).join("");

  // 原本の一覧。同一月に複数版が並ぶ場合があるため、月ではなくファイル単位で出す
  const allFiles = d.months.flatMap((m) => (m.files ?? []).map((f) => ({ ...f, ym: m.ym })));
  const fileRows = allFiles.map((f) => `<tr>
      <td>${esc(f.ym)}</td>
      <td>${esc(f.source_file ?? "—")}</td>
      <td class="num">${f.content_bytes ? (f.content_bytes / 1024).toFixed(0) + " KB" : "—"}</td>
      <td class="num">${f.row_count?.toLocaleString() ?? "—"}</td>
      <td><code class="mut">${esc(f.sha256.slice(0, 12))}</code></td>
      <td>${f.distributable
            ? `<a href="/download/raw/${esc(f.sha256)}">ダウンロード</a>`
            : `<span class="pill bad">配布停止</span><br><span class="mut">${esc(f.hold_reason ?? "")}</span>`}</td>
    </tr>`).join("");

  const anomalies = d.anomalies.length === 0
    ? '<p class="mut">ありません。</p>'
    : `<table><thead><tr><th>年月</th><th>区分</th><th>種別</th><th>理由</th></tr></thead><tbody>` +
      d.anomalies.map((a) => `<tr>
        <td>${a.ym}</td>
        <td>${a.state === "not_loaded"
              ? '<span class="pill warn">ファイル有・DB未反映</span>'
              : '<span class="pill bad">欠測</span>'}</td>
        <td>${esc(a.gap?.kind ?? "未分類")}</td>
        <td>${esc(a.gap?.reason ?? "理由が記録されていません")}</td>
      </tr>`).join("") + "</tbody></table>";

  // 出力できる内容は exportSpec の許可リストから引く
  const measures = d.granularity === "5y"
    ? ["population", "households", "foreign_population", "published_totals"]
    : ["population"];
  const measureOpts = measures
    .map((m) => `<option value="${m}">${esc(exportSpec(d.granularity, m).label)}</option>`)
    .join("");

  // 既定は末尾12ヶ月。上限内に収まる範囲を初期表示しておく
  const defTo = d.period_to ?? "";
  const defFrom = (() => {
    if (!defTo) return "";
    let [y, m] = defTo.split("-").map(Number);
    m -= 11; while (m < 1) { m += 12; y--; }
    const cand = `${y}-${String(m).padStart(2, "0")}`;
    return d.period_from && cand < d.period_from ? d.period_from : cand;
  })();

  return html(page(d.title, `
<h1>${esc(d.title)}</h1>
<p class="mut">${esc(d.muni_name)}（${esc(d.muni_code)}）· ${esc(d.grain_label)} ·
   出典 ${d.source_url ? `<a href="${esc(d.source_url)}" rel="noreferrer">${esc(d.source_site)}</a>` : esc(d.source_site)}</p>

<h2>収録状況</h2>
<p class="mut">${esc(d.period_from ?? "—")} 〜 ${esc(d.period_to ?? "—")} ／
   ${d.months_present} ヶ月 ／ ${d.obs_rows.toLocaleString()} 行</p>
${grid}
<p class="mut">緑 = 収録済 ／ 橙 = ファイルは取得済だがDBに未反映 ／ 赤 = 欠測</p>

<h2>データのダウンロード</h2>
<p class="mut">long形式のCSVです。集計してよい行だけを通すビューから出力しているため、
   そのまま <code>SUM</code> しても二重計上になりません。1回あたり ${MAX_MONTHS} ヶ月まで。</p>
<form method="GET" action="/download/csv" class="dlform">
  <input type="hidden" name="dataset" value="${esc(d.dataset_key)}">
  <label>内容
    <select name="measure">${measureOpts}</select>
  </label>
  <label>開始 <input type="month" name="from" value="${esc(defFrom)}" required></label>
  <label>終了 <input type="month" name="to"   value="${esc(defTo)}" required></label>
  <button type="submit">CSVをダウンロード</button>
</form>
<p class="mut">ライセンス：${d.license ? esc(d.license) : "未確認"}
  ${d.attribution ? "" : ' <span class="pill bad">出典表示が未設定</span>'}</p>

<h2>原本のダウンロード</h2>
<p class="mut">区が公開したファイルそのものです。加工していません。
   グリッドのマスからも直接落とせます。</p>
<details>
  <summary>ファイル一覧（${allFiles.length} 件）</summary>
  <table>
    <thead><tr><th>年月</th><th>ファイル名</th><th>サイズ</th><th>行数</th><th>SHA256</th><th></th></tr></thead>
    <tbody>${fileRows || '<tr><td colspan="6">ファイルがありません</td></tr>'}</tbody>
  </table>
</details>

<h2>欠測・不整合</h2>
${anomalies}

<h2>同期の状態</h2>
<table><tbody>
<tr><th>最終同期試行</th><td>${esc(d.last_run_at ?? "記録なし")}</td></tr>
<tr><th>最終同期成功</th><td>${esc(d.last_ok_at ?? "記録なし")}</td></tr>
<tr><th>最終取込時刻</th><td>${esc(d.last_ingested_at ?? "—")}</td></tr>
<tr><th>取得ファイル数</th><td>${d.files_total}（うちスキップ ${d.files_skipped}）</td></tr>
</tbody></table>

<h2>ライセンス</h2>
<p>${d.license ? esc(d.license) : '<span class="pill bad">未確認</span> — 再配布とダウンロード提供の前に確認が必要です。'}</p>
${d.attribution ? `<p class="mut">出典表示：${esc(d.attribution)}</p>` : ""}
${d.notes ? `<div class="note">${esc(d.notes)}</div>` : ""}
`));
}
