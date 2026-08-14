/* =====================================================================
 *  analysis.js —— 定型クエリによる集計・可視化（要件4の前半／AI不使用）
 *
 *  設計の要点
 *
 *   1. 出力元は必ずビュー。observations_* を直接読まない。
 *      ビューが total 行を落としているので、素直に SUM しても
 *      二重計上にならない。
 *
 *   2. **実行したSQLと適用したルールを、必ず画面に返す。**
 *      定型クエリの段階からこれを守っておくと、NL→SQL を足したとき
 *      表示のしくみを作り直さずに済む。検算できることが信頼の担保。
 *
 *   3. 欠測と系列断絶をグラフ上に描く。隠さない。
 *      2017-07（上流に存在せず）と 2012-08（定義変更）は、
 *      線を繋いだ瞬間に誤読を生む。線を切るか、印を置くかの判断を
 *      利用者に渡すのではなく、こちらで明示する。
 *
 *   4. ビュー名・列名はユーザー入力から組み立てない。許可リストのみ。
 *
 *  index.js への組み込みは2行。
 *      import { handleAnalysis } from "./analysis.js";
 *      ...
 *      const r = await handleAnalysis(env, url);
 *      if (r) return r;
 * ===================================================================== */

/* ---------------------------------------------------------------------
 *  D1バインディング
 *    wrangler.toml の binding 名が判らないので候補から拾う。
 *    確定したらこの関数は消して env.DB を直接使ってよい。
 * ------------------------------------------------------------------- */
function getDb(env) {
  const db = env.DB || env.D1 || env.DATABASE || env.TOKYO_POPULATION;
  if (!db) throw new Error("D1バインディングが見つかりません（wrangler.toml の binding 名を確認）");
  return db;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const bad = (msg) => json({ error: msg }, 400);

/* 日付の形だけ検証する。SQLには必ずバインドで渡す。 */
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const isKey = (s) => /^\d{6,13}$/.test(s || "");

/* ---------------------------------------------------------------------
 *  データセット情報とビューの解決
 *    ここが唯一の「文字列からビュー名への変換点」。許可リスト方式。
 * ------------------------------------------------------------------- */
const VIEW_BY_GRAIN = { "5y": "v_population_5y", "1y": "v_population_1y" };

async function dataset(env, key) {
  const row = await getDb(env)
    .prepare(
      `SELECT dataset_key, title, granularity, grain_label, muni_code,
              muni_name, license, attribution
         FROM datasets
        WHERE dataset_key = ?1 AND is_public = 1`
    )
    .bind(key)
    .first();
  if (!row) return null;
  const view = VIEW_BY_GRAIN[row.granularity];
  if (!view) return null;
  return { ...row, view };
}

/* =====================================================================
 *  API
 * ===================================================================== */

/* --- 画面の初期化に要るもの一式 ------------------------------------- */
async function apiMeta(env, url) {
  const ds = await dataset(env, url.searchParams.get("dataset") || "");
  if (!ds) return bad("データセットが見つかりません");
  const db = getDb(env);

  const months = await db
    .prepare(
      `SELECT reference_date
         FROM dataset_periods
        WHERE dataset_key = ?1 AND obs_rows > 0
        ORDER BY reference_date`
    )
    .bind(ds.dataset_key)
    .all();

  const list = (months.results || []).map((r) => r.reference_date);
  const latest = list[list.length - 1];

  /* 町丁一覧は「最新月に実在する町丁」から作る。
     areas テーブルを引かないのは、1歳階級と5歳階級で町名表記が
     揺れている（駒場1丁目 / 駒場一丁目）ため。ビュー側に合わせる。 */
  let areas = { results: [] };
  if (latest) {
    areas = await db
      .prepare(
        `SELECT key_code, area_name
           FROM ${ds.view}
          WHERE reference_date = ?1
          GROUP BY key_code, area_name
          ORDER BY key_code`
      )
      .bind(latest)
      .all();
  }

  const gaps = await db
    .prepare(
      `SELECT reference_date, kind, reason
         FROM dataset_gaps
        WHERE dataset_key = ?1
        ORDER BY reference_date`
    )
    .bind(ds.dataset_key)
    .all();

  return json({
    dataset: {
      key: ds.dataset_key,
      title: ds.title,
      grain_label: ds.grain_label,
      muni_name: ds.muni_name,
      license: ds.license,
      attribution: ds.attribution,
    },
    months: list,
    areas: areas.results || [],
    gaps: gaps.results || [],
  });
}

/* --- ① 人口推移 ------------------------------------------------------ */
async function apiTrend(env, url) {
  const ds = await dataset(env, url.searchParams.get("dataset") || "");
  if (!ds) return bad("データセットが見つかりません");

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!isDate(from) || !isDate(to)) return bad("期間の指定が不正です");

  const keys = (url.searchParams.get("key_code") || "")
    .split(",").map((s) => s.trim()).filter(isKey).slice(0, 20);

  const notes = [
    ds.view + " を参照（age_class='total' と sex='total' を除外済みのため、SUMしても二重計上にならない）",
    "measure='population' のみ。世帯数・外国人人口は含まない",
    "男女を合算した値",
  ];

  let sql =
    `SELECT reference_date, SUM(value) AS value, COUNT(DISTINCT key_code) AS areas\n` +
    `  FROM ${ds.view}\n` +
    ` WHERE reference_date BETWEEN ?1 AND ?2`;
  const params = [from, to];

  if (keys.length) {
    const ph = keys.map((_, i) => "?" + (i + 3)).join(", ");
    sql += `\n   AND key_code IN (${ph})`;
    params.push(...keys);
    notes.push(`町丁 ${keys.length} 件に限定`);
  } else {
    notes.push("区全体（全町丁の合計）");
  }
  sql += `\n GROUP BY reference_date\n ORDER BY reference_date`;

  const rs = await getDb(env).prepare(sql).bind(...params).all();

  /* 期間内に落ちる欠測・系列断絶 */
  const gaps = await getDb(env)
    .prepare(
      `SELECT reference_date, kind, reason
         FROM dataset_gaps
        WHERE dataset_key = ?1 AND reference_date BETWEEN ?2 AND ?3
        ORDER BY reference_date`
    )
    .bind(ds.dataset_key, from, to)
    .all();

  return json({ rows: rs.results || [], sql, params, notes, annotations: gaps.results || [] });
}

/* --- ② 年齢構成 ------------------------------------------------------ */
async function apiPyramid(env, url) {
  const ds = await dataset(env, url.searchParams.get("dataset") || "");
  if (!ds) return bad("データセットが見つかりません");

  const date = url.searchParams.get("date");
  if (!isDate(date)) return bad("基準日の指定が不正です");

  const key = url.searchParams.get("key_code") || "";
  const notes = [
    ds.view + " を参照",
    "年齢別は男女別にしか保存されていない（性別合計は葉ノードではないため持たない）",
  ];

  let sql =
    `SELECT age_class, sex, SUM(value) AS value\n` +
    `  FROM ${ds.view}\n` +
    ` WHERE reference_date = ?1`;
  const params = [date];

  if (isKey(key)) {
    sql += `\n   AND key_code = ?2`;
    params.push(key);
    notes.push("町丁を1件に限定");
  } else {
    notes.push("区全体（全町丁の合計）");
  }
  sql += `\n GROUP BY age_class, sex`;

  const rs = await getDb(env).prepare(sql).bind(...params).all();
  return json({ rows: rs.results || [], sql, params, notes, grain_label: ds.grain_label });
}

/* --- ③ 増減率ランキング ---------------------------------------------- */
async function apiRanking(env, url) {
  const ds = await dataset(env, url.searchParams.get("dataset") || "");
  if (!ds) return bad("データセットが見つかりません");

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!isDate(from) || !isDate(to)) return bad("期間の指定が不正です");
  if (from >= to) return bad("開始日は終了日より前にしてください");

  const sql =
    `SELECT key_code,\n` +
    `       MAX(area_name) AS area_name,\n` +
    `       SUM(CASE WHEN reference_date = ?1 THEN value ELSE 0 END) AS v_from,\n` +
    `       SUM(CASE WHEN reference_date = ?2 THEN value ELSE 0 END) AS v_to\n` +
    `  FROM ${ds.view}\n` +
    ` WHERE reference_date IN (?1, ?2)\n` +
    ` GROUP BY key_code\n` +
    `HAVING v_from > 0 AND v_to > 0\n` +
    ` ORDER BY key_code`;

  const rs = await getDb(env).prepare(sql).bind(from, to).all();

  const rows = (rs.results || []).map((r) => ({
    ...r,
    diff: r.v_to - r.v_from,
    rate: r.v_from ? ((r.v_to - r.v_from) / r.v_from) * 100 : null,
  }));
  rows.sort((a, b) => b.rate - a.rate);

  const notes = [
    ds.view + " を参照",
    "2時点の比較。間の月は見ていない",
    "どちらかの時点で0の町丁は除外（町名変更・区画整理で別行になった可能性があるため）",
    "町名の同一性は key_code で判定。表記が変わっても追える",
  ];

  /* 2時点の「間」に定義変更や欠測が挟まっていないか。
     推移グラフは線が跳ねるので目で気づけるが、ランキングは表として
     整った形で出てしまうため、こちらの方が誤読が起きやすい。

     from ちょうどの日付は含めない。断絶月を起点に取る比較は
     両端とも新定義なので、そもそも問題が無い。 */
  const gaps = await getDb(env)
    .prepare(
      `SELECT reference_date, kind, reason
         FROM dataset_gaps
        WHERE dataset_key = ?1
          AND reference_date > ?2
          AND reference_date <= ?3
        ORDER BY reference_date`
    )
    .bind(ds.dataset_key, from, to)
    .all();

  const breaks = (gaps.results || []).filter((g) => g.kind === "series_break");
  if (breaks.length) {
    notes.push(
      "この期間には定義変更（" +
        breaks.map((b) => b.reference_date).join("、") +
        "）が挟まっている。増減率は定義変更分を含む"
    );
  }

  return json({
    rows,
    sql,
    params: [from, to],
    notes,
    annotations: gaps.results || [],
    safe_from: breaks.length ? breaks[breaks.length - 1].reference_date : null,
  });
}

/* =====================================================================
 *  画面
 *    描画はクライアント側で決定論的に行う。AIは一切通らない。
 * ===================================================================== */
function analyzePage(datasetKey) {
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>集計・可視化</title>
<style>
:root{--fg:#1a1a1a;--mut:#6b6b6b;--line:#e0ddd6;--bg:#faf9f7;--acc:#2b5a8a;--warn:#b4552d}
*{box-sizing:border-box}
body{margin:0;padding:24px;font-family:system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;
     color:var(--fg);background:var(--bg);line-height:1.7}
.wrap{max-width:960px;margin:0 auto}
h1{font-size:1.3rem;margin:0 0 4px}
.sub{color:var(--mut);font-size:.85rem;margin-bottom:20px}
.tabs{display:flex;gap:4px;border-bottom:2px solid var(--line);margin-bottom:18px;flex-wrap:wrap}
.tab{padding:8px 16px;border:0;background:none;cursor:pointer;font:inherit;font-size:.9rem;
     color:var(--mut);border-bottom:2px solid transparent;margin-bottom:-2px}
.tab[aria-selected=true]{color:var(--acc);border-bottom-color:var(--acc);font-weight:600}
.panel{display:none}.panel.on{display:block}
.ctl{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:16px}
label{display:block;font-size:.75rem;color:var(--mut);margin-bottom:3px}
select,button.go{font:inherit;font-size:.85rem;padding:6px 8px;border:1px solid var(--line);
                 border-radius:4px;background:#fff}
select[multiple]{min-width:200px;height:110px}
select:disabled{background:#f2f0ec;color:#a9a29a}
.radios{display:flex;gap:12px;padding-bottom:5px}
label.rd{display:flex;align-items:center;gap:4px;font-size:.85rem;color:var(--fg);margin:0;cursor:pointer}
label.rd input{margin:0}
button.mini{font:inherit;font-size:.72rem;padding:3px 8px;margin-top:4px;border:1px solid var(--line);
            border-radius:4px;background:#fff;color:var(--mut);cursor:pointer;display:block}
button.mini:disabled{opacity:.4;cursor:default}
button.go{background:var(--acc);color:#fff;border-color:var(--acc);cursor:pointer;padding:7px 18px}
.card{background:#fff;border:1px solid var(--line);border-radius:6px;padding:16px;margin-bottom:14px}
svg{display:block;width:100%;height:auto}
table{border-collapse:collapse;width:100%;font-size:.85rem}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right}
th:nth-child(-n+2),td:nth-child(-n+2){text-align:left}
th{color:var(--mut);font-weight:600;font-size:.75rem}
.up{color:var(--acc)}.dn{color:var(--warn)}
details{font-size:.8rem;color:var(--mut);margin-top:10px}
summary{cursor:pointer}
pre{background:#f4f2ee;padding:10px;border-radius:4px;overflow-x:auto;font-size:.75rem;line-height:1.5}
ul.notes{margin:8px 0 0;padding-left:1.2em}
.flag{background:#fdf4ee;border-left:3px solid var(--warn);padding:8px 12px;font-size:.8rem;margin-bottom:12px}
.attr{font-size:.75rem;color:var(--mut);border-top:1px solid var(--line);padding-top:12px;margin-top:24px}
.busy{color:var(--mut);font-size:.85rem}
</style></head><body><div class="wrap">

<h1 id="ttl">読み込み中…</h1>
<div class="sub"><a href="/dataset/${esc(datasetKey)}">データセット詳細へ戻る</a></div>

<div class="tabs" role="tablist">
  <button class="tab" role="tab" data-p="trend" aria-selected="true">人口推移</button>
  <button class="tab" role="tab" data-p="pyramid" aria-selected="false">年齢構成</button>
  <button class="tab" role="tab" data-p="rank" aria-selected="false">増減率ランキング</button>
</div>

<section class="panel on" id="p-trend">
  <div class="ctl">
    <div><label>開始</label><select id="t-from"></select></div>
    <div><label>終了</label><select id="t-to"></select></div>
    <div class="scope">
      <label>対象</label>
      <div class="radios">
        <label class="rd"><input type="radio" name="t-scope" value="all" checked> 区全体</label>
        <label class="rd"><input type="radio" name="t-scope" value="pick"> 町丁を選ぶ</label>
      </div>
    </div>
    <div><label>町丁（Ctrlクリックで複数）</label>
      <select id="t-area" multiple disabled></select>
      <button type="button" class="mini" id="t-clear">選択を解除</button>
    </div>
    <button class="go" id="t-go">描画</button>
  </div>
  <div id="t-out"></div>
</section>

<section class="panel" id="p-pyramid">
  <div class="ctl">
    <div><label>基準日</label><select id="y-date"></select></div>
    <div><label>町丁</label><select id="y-area"></select></div>
    <button class="go" id="y-go">描画</button>
  </div>
  <div id="y-out"></div>
</section>

<section class="panel" id="p-rank">
  <div class="ctl">
    <div><label>比較開始</label><select id="r-from"></select></div>
    <div><label>比較終了</label><select id="r-to"></select></div>
    <button class="go" id="r-go">集計</button>
  </div>
  <div id="r-out"></div>
</section>

<div class="attr" id="attr"></div>
</div>
<script>
var DS = ${JSON.stringify(datasetKey)};
var META = null;

function $(id){ return document.getElementById(id); }
function fmt(n){ return (n===null||n===undefined) ? "-" : Number(n).toLocaleString("ja-JP"); }
function el(tag, attrs, text){
  var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (var k in attrs) e.setAttribute(k, attrs[k]);
  if (text !== undefined) e.textContent = text;
  return e;
}
function svgRoot(w, h){
  var s = el("svg", {viewBox: "0 0 " + w + " " + h, preserveAspectRatio: "xMidYMid meet"});
  return s;
}
function api(path){
  return fetch(path, {credentials: "same-origin"}).then(function(r){
    if (!r.ok) return r.json().then(function(j){ throw new Error(j.error || ("HTTP " + r.status)); });
    return r.json();
  });
}
function fill(sel, arr, valKey, labKey, selected){
  sel.innerHTML = "";
  arr.forEach(function(o){
    var op = document.createElement("option");
    op.value = valKey ? o[valKey] : o;
    op.textContent = labKey ? o[labKey] : o;
    if (op.value === selected) op.selected = true;
    sel.appendChild(op);
  });
}
function meta(box, d){
  var w = document.createElement("details");
  var s = document.createElement("summary");
  s.textContent = "実行したSQLと適用したルール";
  w.appendChild(s);
  var ul = document.createElement("ul");
  ul.className = "notes";
  (d.notes || []).forEach(function(n){
    var li = document.createElement("li"); li.textContent = n; ul.appendChild(li);
  });
  w.appendChild(ul);
  var pre = document.createElement("pre");
  pre.textContent = d.sql + "\\n\\n-- パラメータ: " + JSON.stringify(d.params);
  w.appendChild(pre);
  box.appendChild(w);
}
function card(html){
  var c = document.createElement("div"); c.className = "card";
  if (html) c.innerHTML = html;
  return c;
}

/* ---------- ① 推移 ---------- */
function drawTrend(d, box){
  var rows = d.rows;
  if (!rows.length){ box.appendChild(card("<p>該当する月がありません。</p>")); return; }

  var W = 900, H = 360, ml = 70, mr = 20, mt = 20, mb = 46;
  var pw = W - ml - mr, ph = H - mt - mb;
  var vals = rows.map(function(r){ return r.value; });
  var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  var pad = (hi - lo) * 0.1 || 100;
  lo = lo - pad; hi = hi + pad;

  var x = function(i){ return ml + (rows.length < 2 ? pw/2 : pw * i / (rows.length - 1)); };
  var y = function(v){ return mt + ph - ph * (v - lo) / (hi - lo); };

  var s = svgRoot(W, H);

  for (var g = 0; g <= 4; g++){
    var vy = mt + ph * g / 4, vv = hi - (hi - lo) * g / 4;
    s.appendChild(el("line", {x1: ml, y1: vy, x2: W - mr, y2: vy, stroke: "#eae7e0"}));
    s.appendChild(el("text", {x: ml - 8, y: vy + 4, "text-anchor": "end",
                              "font-size": 11, fill: "#6b6b6b"}, Math.round(vv).toLocaleString("ja-JP")));
  }

  /* 欠測・系列断絶。線を引く前に描いて背面に置く */
  var idxOf = {};
  rows.forEach(function(r, i){ idxOf[r.reference_date] = i; });
  (d.annotations || []).forEach(function(a){
    var i = idxOf[a.reference_date];
    var px;
    if (i !== undefined) { px = x(i); }
    else {
      var after = -1;
      for (var k = 0; k < rows.length; k++){ if (rows[k].reference_date > a.reference_date){ after = k; break; } }
      if (after <= 0) return;
      px = (x(after - 1) + x(after)) / 2;
    }
    var col = a.kind === "series_break" ? "#b4552d" : "#a9a29a";
    s.appendChild(el("line", {x1: px, y1: mt, x2: px, y2: mt + ph,
                              stroke: col, "stroke-width": 1.5, "stroke-dasharray": "4 3"}));
    s.appendChild(el("text", {x: px + 4, y: mt + 12, "font-size": 10, fill: col},
                     a.kind === "series_break" ? "定義変更" : "欠測"));
  });

  var dpath = rows.map(function(r, i){ return (i ? "L" : "M") + x(i) + " " + y(r.value); }).join(" ");
  s.appendChild(el("path", {d: dpath, fill: "none", stroke: "#2b5a8a", "stroke-width": 1.8}));

  var step = Math.max(1, Math.ceil(rows.length / 8));
  rows.forEach(function(r, i){
    if (i % step === 0 || i === rows.length - 1){
      s.appendChild(el("text", {x: x(i), y: H - 16, "text-anchor": "middle",
                                "font-size": 11, fill: "#6b6b6b"}, r.reference_date.slice(0, 7)));
    }
  });

  var c = card("");
  c.appendChild(s);
  var first = rows[0], last = rows[rows.length - 1];
  var diff = last.value - first.value;
  var rate = first.value ? (diff / first.value * 100) : 0;
  var p = document.createElement("p");
  p.style.fontSize = ".85rem"; p.style.margin = "12px 0 0";
  p.textContent = first.reference_date + " の " + fmt(first.value) + "人 から "
                + last.reference_date + " の " + fmt(last.value) + "人へ、"
                + (diff >= 0 ? "+" : "") + fmt(diff) + "人（"
                + (rate >= 0 ? "+" : "") + rate.toFixed(2) + "％）。対象 " + rows.length + " か月、"
                + fmt(last.areas) + " 町丁。";
  c.appendChild(p);

  if ((d.annotations || []).length){
    (d.annotations || []).forEach(function(a){
      var f = document.createElement("div");
      f.className = "flag";
      f.textContent = a.reference_date.slice(0, 7) + "："
        + (a.kind === "series_break" ? "定義変更あり。" : a.kind === "upstream_missing" ? "上流に存在しない欠測。" : "取込未完了。")
        + a.reason;
      c.insertBefore(f, c.firstChild);
    });
  }
  box.appendChild(c);
}

/* ---------- ② 年齢構成 ---------- */
function ageKey(a){
  if (a === "unknown" || a === "不詳") return 9999;
  var m = String(a).match(/^(\\d+)/);
  return m ? parseInt(m[1], 10) : 9998;
}
function drawPyramid(d, box){
  var byAge = {};
  d.rows.forEach(function(r){
    if (!byAge[r.age_class]) byAge[r.age_class] = {male: 0, female: 0};
    if (r.sex === "male" || r.sex === "female") byAge[r.age_class][r.sex] += r.value;
  });
  var ages = Object.keys(byAge).sort(function(a, b){ return ageKey(a) - ageKey(b); });
  if (!ages.length){ box.appendChild(card("<p>該当する行がありません。</p>")); return; }

  var rowH = ages.length > 40 ? 8 : 18;
  var W = 900, H = ages.length * rowH + 60, cx = W / 2, half = 340, mt = 30;
  var mx = 0;
  ages.forEach(function(a){ mx = Math.max(mx, byAge[a].male, byAge[a].female); });
  var s = svgRoot(W, H);

  s.appendChild(el("text", {x: cx - half / 2, y: 16, "text-anchor": "middle",
                            "font-size": 12, fill: "#6b6b6b"}, "男"));
  s.appendChild(el("text", {x: cx + half / 2, y: 16, "text-anchor": "middle",
                            "font-size": 12, fill: "#6b6b6b"}, "女"));

  ages.forEach(function(a, i){
    var yy = mt + i * rowH;
    var mw = mx ? half * byAge[a].male / mx : 0;
    var fw = mx ? half * byAge[a].female / mx : 0;
    s.appendChild(el("rect", {x: cx - 30 - mw, y: yy, width: mw, height: rowH - 2, fill: "#2b5a8a", opacity: .85}));
    s.appendChild(el("rect", {x: cx + 30, y: yy, width: fw, height: rowH - 2, fill: "#b4552d", opacity: .85}));
    if (rowH >= 14 || i % 5 === 0){
      s.appendChild(el("text", {x: cx, y: yy + rowH - 4, "text-anchor": "middle",
                                "font-size": 10, fill: "#6b6b6b"}, a));
    }
  });

  var tot = 0, tm = 0, tf = 0;
  ages.forEach(function(a){ tm += byAge[a].male; tf += byAge[a].female; });
  tot = tm + tf;

  var c = card("");
  c.appendChild(s);
  var p = document.createElement("p");
  p.style.fontSize = ".85rem"; p.style.margin = "12px 0 0";
  p.textContent = "合計 " + fmt(tot) + "人（男 " + fmt(tm) + " / 女 " + fmt(tf) + "）。"
                + "年齢区分 " + ages.length + " 段階（" + (d.grain_label || "") + "）。";
  c.appendChild(p);
  box.appendChild(c);
}

/* ---------- ③ ランキング ---------- */
function drawRank(d, box){
  if (!d.rows.length){ box.appendChild(card("<p>比較できる町丁がありません。</p>")); return; }
  var rows = d.rows;

  /* 定義変更をまたいでいる場合、数字より先にこれを出す。
     表は整った形で出てくるので、後ろに置くと読まれない。 */
  (d.annotations || []).forEach(function(a){
    var f = document.createElement("div");
    f.className = "flag";
    f.textContent = "この比較期間には " + a.reference_date.slice(0, 7) + " の"
      + (a.kind === "series_break" ? "定義変更" : "欠測")
      + "が挟まっています。" + a.reason;
    box.appendChild(f);
  });
  if (d.safe_from){
    var fix = document.createElement("div");
    fix.className = "flag";
    var b = document.createElement("button");
    b.className = "go"; b.style.marginLeft = "8px"; b.style.padding = "4px 12px";
    b.textContent = "開始を " + d.safe_from.slice(0, 7) + " に切り直す";
    b.addEventListener("click", function(){
      $("r-from").value = d.safe_from;
      run("rank");
    });
    fix.appendChild(document.createTextNode("定義を揃えて比較するには、開始時点を定義変更後にしてください。"));
    fix.appendChild(b);
    box.appendChild(fix);
  }
  var top = rows.slice(0, 10), bot = rows.slice(-10).reverse();

  function tbl(title, arr){
    var h = "<h2 style='font-size:.95rem;margin:0 0 8px'>" + title + "</h2>"
          + "<table><thead><tr><th>町丁</th><th>コード</th><th>開始</th><th>終了</th><th>増減</th><th>増減率</th></tr></thead><tbody>";
    arr.forEach(function(r){
      var cls = r.rate >= 0 ? "up" : "dn";
      h += "<tr><td>" + r.area_name + "</td><td>" + r.key_code + "</td><td>" + fmt(r.v_from)
         + "</td><td>" + fmt(r.v_to) + "</td><td class='" + cls + "'>"
         + (r.diff >= 0 ? "+" : "") + fmt(r.diff) + "</td><td class='" + cls + "'>"
         + (r.rate >= 0 ? "+" : "") + r.rate.toFixed(2) + "％</td></tr>";
    });
    return h + "</tbody></table>";
  }
  box.appendChild(card(tbl("増加率 上位10", top)));
  box.appendChild(card(tbl("減少率 上位10", bot)));

  var inc = rows.filter(function(r){ return r.diff > 0; }).length;
  box.appendChild(card("<p style='font-size:.85rem;margin:0'>対象 " + rows.length
    + " 町丁のうち、増加 " + inc + " / 減少 " + (rows.length - inc)
    + "。町丁単位で見ると区全体の増減とは向きが揃わないことがあります。</p>"));
}

/* ---------- 実行 ---------- */
function run(kind){
  var out, url;
  if (kind === "trend"){
    out = $("t-out");
    /* 区全体モードのときは、リストに選択が残っていても無視する。
       画面の見た目と送るパラメータが食い違わないようにする。 */
    var pick = document.querySelector("input[name=t-scope]:checked").value === "pick";
    var sel = pick
      ? [].slice.call($("t-area").selectedOptions).map(function(o){ return o.value; })
      : [];
    url = "/api/q/trend?dataset=" + encodeURIComponent(DS)
        + "&from=" + $("t-from").value + "&to=" + $("t-to").value
        + (sel.length ? "&key_code=" + sel.join(",") : "");
  } else if (kind === "pyramid"){
    out = $("y-out");
    url = "/api/q/pyramid?dataset=" + encodeURIComponent(DS)
        + "&date=" + $("y-date").value
        + ($("y-area").value ? "&key_code=" + $("y-area").value : "");
  } else {
    out = $("r-out");
    url = "/api/q/ranking?dataset=" + encodeURIComponent(DS)
        + "&from=" + $("r-from").value + "&to=" + $("r-to").value;
  }
  out.innerHTML = "<p class='busy'>集計中…</p>";
  api(url).then(function(d){
    out.innerHTML = "";
    if (kind === "trend") drawTrend(d, out);
    else if (kind === "pyramid") drawPyramid(d, out);
    else drawRank(d, out);
    meta(out, d);
  }).catch(function(e){
    out.innerHTML = "<div class='card'><p>取得に失敗しました：" + e.message + "</p></div>";
  });
}

document.querySelectorAll(".tab").forEach(function(b){
  b.addEventListener("click", function(){
    document.querySelectorAll(".tab").forEach(function(x){ x.setAttribute("aria-selected", "false"); });
    b.setAttribute("aria-selected", "true");
    document.querySelectorAll(".panel").forEach(function(p){ p.classList.remove("on"); });
    $("p-" + b.dataset.p).classList.add("on");
  });
});
$("t-go").addEventListener("click", function(){ run("trend"); });
$("y-go").addEventListener("click", function(){ run("pyramid"); });
$("r-go").addEventListener("click", function(){ run("rank"); });

/* 区全体 / 町丁選択の切替。
   区全体に戻したら選択も消す。「選んだまま無効」の状態を残さない。 */
function syncScope(){
  var pick = document.querySelector("input[name=t-scope]:checked").value === "pick";
  $("t-area").disabled = !pick;
  $("t-clear").disabled = !pick;
  if (!pick) $("t-area").selectedIndex = -1;
}
document.querySelectorAll("input[name=t-scope]").forEach(function(r){
  r.addEventListener("change", syncScope);
});
$("t-clear").addEventListener("click", function(){ $("t-area").selectedIndex = -1; });

/* 町丁をクリックしたら自動で「町丁を選ぶ」に切り替える。
   リストが無効なので通常は起きないが、キーボード操作の保険。 */
$("t-area").addEventListener("change", function(){
  if ($("t-area").selectedOptions.length){
    document.querySelector("input[name=t-scope][value=pick]").checked = true;
    syncScope();
  }
});

api("/api/q/meta?dataset=" + encodeURIComponent(DS)).then(function(m){
  META = m;
  $("ttl").textContent = m.dataset.muni_name + " " + m.dataset.title + " — 集計・可視化";
  var ms = m.months;
  if (!ms.length){ $("ttl").textContent += "（データがありません）"; return; }
  var first = ms[0], last = ms[ms.length - 1];
  var back = ms.length > 12 ? ms[ms.length - 13] : first;

  fill($("t-from"), ms, null, null, first);
  fill($("t-to"), ms, null, null, last);
  fill($("y-date"), ms, null, null, last);
  fill($("r-from"), ms, null, null, back);
  fill($("r-to"), ms, null, null, last);

  var areaOpts = m.areas.slice();
  fill($("t-area"), areaOpts, "key_code", "area_name", null);
  $("t-area").selectedIndex = -1;   // 環境によって先頭が選択済みになるのを防ぐ
  syncScope();
  fill($("y-area"), [{key_code: "", area_name: "区全体"}].concat(areaOpts), "key_code", "area_name", "");

  var a = m.dataset.attribution || "（出典表示が未設定です）";
  $("attr").textContent = a + "　ライセンス：" + (m.dataset.license || "未確認");

  run("trend");
}).catch(function(e){
  $("ttl").textContent = "読み込みに失敗しました：" + e.message;
});
</script></body></html>`;
}

/* =====================================================================
 *  ルーティング
 *    該当しなければ null を返す。index.js 側で素通りさせる。
 * ===================================================================== */
export async function handleAnalysis(env, url) {
  const p = url.pathname;
  try {
    if (p === "/analyze") {
      const key = url.searchParams.get("dataset") || "";
      if (!/^[a-z0-9_]{1,64}$/.test(key)) {
        return new Response("データセットを指定してください", { status: 400 });
      }
      return new Response(analyzePage(key), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (p === "/api/q/meta") return apiMeta(env, url);
    if (p === "/api/q/trend") return apiTrend(env, url);
    if (p === "/api/q/pyramid") return apiPyramid(env, url);
    if (p === "/api/q/ranking") return apiRanking(env, url);
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
  return null;
}
