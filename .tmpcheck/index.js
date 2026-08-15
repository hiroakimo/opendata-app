var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/analysis.js
function getDb(env) {
  const db = env.DB || env.D1 || env.DATABASE || env.TOKYO_POPULATION;
  if (!db) throw new Error("D1\u30D0\u30A4\u30F3\u30C7\u30A3\u30F3\u30B0\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\uFF08wrangler.toml \u306E binding \u540D\u3092\u78BA\u8A8D\uFF09");
  return db;
}
__name(getDb, "getDb");
var esc = /* @__PURE__ */ __name((s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]), "esc");
var json = /* @__PURE__ */ __name((obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
}), "json");
var bad = /* @__PURE__ */ __name((msg) => json({ error: msg }, 400), "bad");
var isDate = /* @__PURE__ */ __name((s) => /^\d{4}-\d{2}-\d{2}$/.test(s || ""), "isDate");
var isKey = /* @__PURE__ */ __name((s) => /^\d{6,13}$/.test(s || ""), "isKey");
var VIEW_BY_GRAIN = { "5y": "v_population_5y", "1y": "v_population_1y" };
async function dataset(env, key) {
  const row = await getDb(env).prepare(
    `SELECT dataset_key, title, granularity, grain_label, muni_code,
              muni_name, license, attribution
         FROM datasets
        WHERE dataset_key = ?1 AND is_public = 1`
  ).bind(key).first();
  if (!row) return null;
  const view = VIEW_BY_GRAIN[row.granularity];
  if (!view) return null;
  return { ...row, view };
}
__name(dataset, "dataset");
async function apiMeta(env, url) {
  const ds = await dataset(env, url.searchParams.get("dataset") || "");
  if (!ds) return bad("\u30C7\u30FC\u30BF\u30BB\u30C3\u30C8\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093");
  const db = getDb(env);
  const months = await db.prepare(
    `SELECT reference_date
         FROM dataset_periods
        WHERE dataset_key = ?1 AND obs_rows > 0
        ORDER BY reference_date`
  ).bind(ds.dataset_key).all();
  const list = (months.results || []).map((r) => r.reference_date);
  const latest = list[list.length - 1];
  let areas = { results: [] };
  if (latest) {
    areas = await db.prepare(
      `SELECT key_code, area_name
           FROM ${ds.view}
          WHERE reference_date = ?1
          GROUP BY key_code, area_name
          ORDER BY key_code`
    ).bind(latest).all();
  }
  const gaps = await db.prepare(
    `SELECT reference_date, kind, reason
         FROM dataset_gaps
        WHERE dataset_key = ?1
        ORDER BY reference_date`
  ).bind(ds.dataset_key).all();
  return json({
    dataset: {
      key: ds.dataset_key,
      title: ds.title,
      grain_label: ds.grain_label,
      muni_name: ds.muni_name,
      license: ds.license,
      attribution: ds.attribution
    },
    months: list,
    areas: areas.results || [],
    gaps: gaps.results || []
  });
}
__name(apiMeta, "apiMeta");
async function apiTrend(env, url) {
  const ds = await dataset(env, url.searchParams.get("dataset") || "");
  if (!ds) return bad("\u30C7\u30FC\u30BF\u30BB\u30C3\u30C8\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!isDate(from) || !isDate(to)) return bad("\u671F\u9593\u306E\u6307\u5B9A\u304C\u4E0D\u6B63\u3067\u3059");
  const keys = (url.searchParams.get("key_code") || "").split(",").map((s) => s.trim()).filter(isKey).slice(0, 20);
  const notes = [
    ds.view + " \u3092\u53C2\u7167\uFF08age_class='total' \u3068 sex='total' \u3092\u9664\u5916\u6E08\u307F\u306E\u305F\u3081\u3001SUM\u3057\u3066\u3082\u4E8C\u91CD\u8A08\u4E0A\u306B\u306A\u3089\u306A\u3044\uFF09",
    "measure='population' \u306E\u307F\u3002\u4E16\u5E2F\u6570\u30FB\u5916\u56FD\u4EBA\u4EBA\u53E3\u306F\u542B\u307E\u306A\u3044",
    "\u7537\u5973\u3092\u5408\u7B97\u3057\u305F\u5024"
  ];
  let sql = `SELECT reference_date, SUM(value) AS value, COUNT(DISTINCT key_code) AS areas
  FROM ${ds.view}
 WHERE reference_date BETWEEN ?1 AND ?2`;
  const params = [from, to];
  if (keys.length) {
    const ph = keys.map((_, i) => "?" + (i + 3)).join(", ");
    sql += `
   AND key_code IN (${ph})`;
    params.push(...keys);
    notes.push(`\u753A\u4E01 ${keys.length} \u4EF6\u306B\u9650\u5B9A`);
  } else {
    notes.push("\u533A\u5168\u4F53\uFF08\u5168\u753A\u4E01\u306E\u5408\u8A08\uFF09");
  }
  sql += `
 GROUP BY reference_date
 ORDER BY reference_date`;
  const rs = await getDb(env).prepare(sql).bind(...params).all();
  const gaps = await getDb(env).prepare(
    `SELECT reference_date, kind, reason
         FROM dataset_gaps
        WHERE dataset_key = ?1 AND reference_date BETWEEN ?2 AND ?3
        ORDER BY reference_date`
  ).bind(ds.dataset_key, from, to).all();
  return json({ rows: rs.results || [], sql, params, notes, annotations: gaps.results || [] });
}
__name(apiTrend, "apiTrend");
async function apiPyramid(env, url) {
  const ds = await dataset(env, url.searchParams.get("dataset") || "");
  if (!ds) return bad("\u30C7\u30FC\u30BF\u30BB\u30C3\u30C8\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093");
  const date = url.searchParams.get("date");
  if (!isDate(date)) return bad("\u57FA\u6E96\u65E5\u306E\u6307\u5B9A\u304C\u4E0D\u6B63\u3067\u3059");
  const key = url.searchParams.get("key_code") || "";
  const notes = [
    ds.view + " \u3092\u53C2\u7167",
    "\u5E74\u9F62\u5225\u306F\u7537\u5973\u5225\u306B\u3057\u304B\u4FDD\u5B58\u3055\u308C\u3066\u3044\u306A\u3044\uFF08\u6027\u5225\u5408\u8A08\u306F\u8449\u30CE\u30FC\u30C9\u3067\u306F\u306A\u3044\u305F\u3081\u6301\u305F\u306A\u3044\uFF09"
  ];
  let sql = `SELECT age_class, sex, SUM(value) AS value
  FROM ${ds.view}
 WHERE reference_date = ?1`;
  const params = [date];
  if (isKey(key)) {
    sql += `
   AND key_code = ?2`;
    params.push(key);
    notes.push("\u753A\u4E01\u30921\u4EF6\u306B\u9650\u5B9A");
  } else {
    notes.push("\u533A\u5168\u4F53\uFF08\u5168\u753A\u4E01\u306E\u5408\u8A08\uFF09");
  }
  sql += `
 GROUP BY age_class, sex`;
  const rs = await getDb(env).prepare(sql).bind(...params).all();
  return json({ rows: rs.results || [], sql, params, notes, grain_label: ds.grain_label });
}
__name(apiPyramid, "apiPyramid");
async function apiRanking(env, url) {
  const ds = await dataset(env, url.searchParams.get("dataset") || "");
  if (!ds) return bad("\u30C7\u30FC\u30BF\u30BB\u30C3\u30C8\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!isDate(from) || !isDate(to)) return bad("\u671F\u9593\u306E\u6307\u5B9A\u304C\u4E0D\u6B63\u3067\u3059");
  if (from >= to) return bad("\u958B\u59CB\u65E5\u306F\u7D42\u4E86\u65E5\u3088\u308A\u524D\u306B\u3057\u3066\u304F\u3060\u3055\u3044");
  const sql = `SELECT key_code,
       MAX(area_name) AS area_name,
       SUM(CASE WHEN reference_date = ?1 THEN value ELSE 0 END) AS v_from,
       SUM(CASE WHEN reference_date = ?2 THEN value ELSE 0 END) AS v_to
  FROM ${ds.view}
 WHERE reference_date IN (?1, ?2)
 GROUP BY key_code
HAVING v_from > 0 AND v_to > 0
 ORDER BY key_code`;
  const rs = await getDb(env).prepare(sql).bind(from, to).all();
  const rows = (rs.results || []).map((r) => ({
    ...r,
    diff: r.v_to - r.v_from,
    rate: r.v_from ? (r.v_to - r.v_from) / r.v_from * 100 : null
  }));
  rows.sort((a, b) => b.rate - a.rate);
  const notes = [
    ds.view + " \u3092\u53C2\u7167",
    "2\u6642\u70B9\u306E\u6BD4\u8F03\u3002\u9593\u306E\u6708\u306F\u898B\u3066\u3044\u306A\u3044",
    "\u3069\u3061\u3089\u304B\u306E\u6642\u70B9\u30670\u306E\u753A\u4E01\u306F\u9664\u5916\uFF08\u753A\u540D\u5909\u66F4\u30FB\u533A\u753B\u6574\u7406\u3067\u5225\u884C\u306B\u306A\u3063\u305F\u53EF\u80FD\u6027\u304C\u3042\u308B\u305F\u3081\uFF09",
    "\u753A\u540D\u306E\u540C\u4E00\u6027\u306F key_code \u3067\u5224\u5B9A\u3002\u8868\u8A18\u304C\u5909\u308F\u3063\u3066\u3082\u8FFD\u3048\u308B"
  ];
  const gaps = await getDb(env).prepare(
    `SELECT reference_date, kind, reason
         FROM dataset_gaps
        WHERE dataset_key = ?1
          AND reference_date > ?2
          AND reference_date <= ?3
        ORDER BY reference_date`
  ).bind(ds.dataset_key, from, to).all();
  const breaks = (gaps.results || []).filter((g) => g.kind === "series_break");
  if (breaks.length) {
    notes.push(
      "\u3053\u306E\u671F\u9593\u306B\u306F\u5B9A\u7FA9\u5909\u66F4\uFF08" + breaks.map((b) => b.reference_date).join("\u3001") + "\uFF09\u304C\u631F\u307E\u3063\u3066\u3044\u308B\u3002\u5897\u6E1B\u7387\u306F\u5B9A\u7FA9\u5909\u66F4\u5206\u3092\u542B\u3080"
    );
  }
  return json({
    rows,
    sql,
    params: [from, to],
    notes,
    annotations: gaps.results || [],
    safe_from: breaks.length ? breaks[breaks.length - 1].reference_date : null
  });
}
__name(apiRanking, "apiRanking");
function analyzePage(datasetKey) {
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>\u96C6\u8A08\u30FB\u53EF\u8996\u5316</title>
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

<h1 id="ttl">\u8AAD\u307F\u8FBC\u307F\u4E2D\u2026</h1>
<div class="sub"><a href="/dataset/${esc(datasetKey)}">\u30C7\u30FC\u30BF\u30BB\u30C3\u30C8\u8A73\u7D30\u3078\u623B\u308B</a></div>

<div class="tabs" role="tablist">
  <button class="tab" role="tab" data-p="trend" aria-selected="true">\u4EBA\u53E3\u63A8\u79FB</button>
  <button class="tab" role="tab" data-p="pyramid" aria-selected="false">\u5E74\u9F62\u69CB\u6210</button>
  <button class="tab" role="tab" data-p="rank" aria-selected="false">\u5897\u6E1B\u7387\u30E9\u30F3\u30AD\u30F3\u30B0</button>
</div>

<section class="panel on" id="p-trend">
  <div class="ctl">
    <div><label>\u958B\u59CB</label><select id="t-from"></select></div>
    <div><label>\u7D42\u4E86</label><select id="t-to"></select></div>
    <div class="scope">
      <label>\u5BFE\u8C61</label>
      <div class="radios">
        <label class="rd"><input type="radio" name="t-scope" value="all" checked> \u533A\u5168\u4F53</label>
        <label class="rd"><input type="radio" name="t-scope" value="pick"> \u753A\u4E01\u3092\u9078\u3076</label>
      </div>
    </div>
    <div><label>\u753A\u4E01\uFF08Ctrl\u30AF\u30EA\u30C3\u30AF\u3067\u8907\u6570\uFF09</label>
      <select id="t-area" multiple disabled></select>
      <button type="button" class="mini" id="t-clear">\u9078\u629E\u3092\u89E3\u9664</button>
    </div>
    <button class="go" id="t-go">\u63CF\u753B</button>
  </div>
  <div id="t-out"></div>
</section>

<section class="panel" id="p-pyramid">
  <div class="ctl">
    <div><label>\u57FA\u6E96\u65E5</label><select id="y-date"></select></div>
    <div><label>\u753A\u4E01</label><select id="y-area"></select></div>
    <button class="go" id="y-go">\u63CF\u753B</button>
  </div>
  <div id="y-out"></div>
</section>

<section class="panel" id="p-rank">
  <div class="ctl">
    <div><label>\u6BD4\u8F03\u958B\u59CB</label><select id="r-from"></select></div>
    <div><label>\u6BD4\u8F03\u7D42\u4E86</label><select id="r-to"></select></div>
    <button class="go" id="r-go">\u96C6\u8A08</button>
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
  s.textContent = "\u5B9F\u884C\u3057\u305FSQL\u3068\u9069\u7528\u3057\u305F\u30EB\u30FC\u30EB";
  w.appendChild(s);
  var ul = document.createElement("ul");
  ul.className = "notes";
  (d.notes || []).forEach(function(n){
    var li = document.createElement("li"); li.textContent = n; ul.appendChild(li);
  });
  w.appendChild(ul);
  var pre = document.createElement("pre");
  pre.textContent = d.sql + "\\n\\n-- \u30D1\u30E9\u30E1\u30FC\u30BF: " + JSON.stringify(d.params);
  w.appendChild(pre);
  box.appendChild(w);
}
function card(html){
  var c = document.createElement("div"); c.className = "card";
  if (html) c.innerHTML = html;
  return c;
}

/* ---------- \u2460 \u63A8\u79FB ---------- */
function drawTrend(d, box){
  var rows = d.rows;
  if (!rows.length){ box.appendChild(card("<p>\u8A72\u5F53\u3059\u308B\u6708\u304C\u3042\u308A\u307E\u305B\u3093\u3002</p>")); return; }

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

  /* \u6B20\u6E2C\u30FB\u7CFB\u5217\u65AD\u7D76\u3002\u7DDA\u3092\u5F15\u304F\u524D\u306B\u63CF\u3044\u3066\u80CC\u9762\u306B\u7F6E\u304F */
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
                     a.kind === "series_break" ? "\u5B9A\u7FA9\u5909\u66F4" : "\u6B20\u6E2C"));
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
  p.textContent = first.reference_date + " \u306E " + fmt(first.value) + "\u4EBA \u304B\u3089 "
                + last.reference_date + " \u306E " + fmt(last.value) + "\u4EBA\u3078\u3001"
                + (diff >= 0 ? "+" : "") + fmt(diff) + "\u4EBA\uFF08"
                + (rate >= 0 ? "+" : "") + rate.toFixed(2) + "\uFF05\uFF09\u3002\u5BFE\u8C61 " + rows.length + " \u304B\u6708\u3001"
                + fmt(last.areas) + " \u753A\u4E01\u3002";
  c.appendChild(p);

  if ((d.annotations || []).length){
    (d.annotations || []).forEach(function(a){
      var f = document.createElement("div");
      f.className = "flag";
      f.textContent = a.reference_date.slice(0, 7) + "\uFF1A"
        + (a.kind === "series_break" ? "\u5B9A\u7FA9\u5909\u66F4\u3042\u308A\u3002" : a.kind === "upstream_missing" ? "\u4E0A\u6D41\u306B\u5B58\u5728\u3057\u306A\u3044\u6B20\u6E2C\u3002" : "\u53D6\u8FBC\u672A\u5B8C\u4E86\u3002")
        + a.reason;
      c.insertBefore(f, c.firstChild);
    });
  }
  box.appendChild(c);
}

/* ---------- \u2461 \u5E74\u9F62\u69CB\u6210 ---------- */
function ageKey(a){
  if (a === "unknown" || a === "\u4E0D\u8A73") return 9999;
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
  if (!ages.length){ box.appendChild(card("<p>\u8A72\u5F53\u3059\u308B\u884C\u304C\u3042\u308A\u307E\u305B\u3093\u3002</p>")); return; }

  var rowH = ages.length > 40 ? 8 : 18;
  var W = 900, H = ages.length * rowH + 60, cx = W / 2, half = 340, mt = 30;
  var mx = 0;
  ages.forEach(function(a){ mx = Math.max(mx, byAge[a].male, byAge[a].female); });
  var s = svgRoot(W, H);

  s.appendChild(el("text", {x: cx - half / 2, y: 16, "text-anchor": "middle",
                            "font-size": 12, fill: "#6b6b6b"}, "\u7537"));
  s.appendChild(el("text", {x: cx + half / 2, y: 16, "text-anchor": "middle",
                            "font-size": 12, fill: "#6b6b6b"}, "\u5973"));

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
  p.textContent = "\u5408\u8A08 " + fmt(tot) + "\u4EBA\uFF08\u7537 " + fmt(tm) + " / \u5973 " + fmt(tf) + "\uFF09\u3002"
                + "\u5E74\u9F62\u533A\u5206 " + ages.length + " \u6BB5\u968E\uFF08" + (d.grain_label || "") + "\uFF09\u3002";
  c.appendChild(p);
  box.appendChild(c);
}

/* ---------- \u2462 \u30E9\u30F3\u30AD\u30F3\u30B0 ---------- */
function drawRank(d, box){
  if (!d.rows.length){ box.appendChild(card("<p>\u6BD4\u8F03\u3067\u304D\u308B\u753A\u4E01\u304C\u3042\u308A\u307E\u305B\u3093\u3002</p>")); return; }
  var rows = d.rows;

  /* \u5B9A\u7FA9\u5909\u66F4\u3092\u307E\u305F\u3044\u3067\u3044\u308B\u5834\u5408\u3001\u6570\u5B57\u3088\u308A\u5148\u306B\u3053\u308C\u3092\u51FA\u3059\u3002
     \u8868\u306F\u6574\u3063\u305F\u5F62\u3067\u51FA\u3066\u304F\u308B\u306E\u3067\u3001\u5F8C\u308D\u306B\u7F6E\u304F\u3068\u8AAD\u307E\u308C\u306A\u3044\u3002 */
  (d.annotations || []).forEach(function(a){
    var f = document.createElement("div");
    f.className = "flag";
    f.textContent = "\u3053\u306E\u6BD4\u8F03\u671F\u9593\u306B\u306F " + a.reference_date.slice(0, 7) + " \u306E"
      + (a.kind === "series_break" ? "\u5B9A\u7FA9\u5909\u66F4" : "\u6B20\u6E2C")
      + "\u304C\u631F\u307E\u3063\u3066\u3044\u307E\u3059\u3002" + a.reason;
    box.appendChild(f);
  });
  if (d.safe_from){
    var fix = document.createElement("div");
    fix.className = "flag";
    var b = document.createElement("button");
    b.className = "go"; b.style.marginLeft = "8px"; b.style.padding = "4px 12px";
    b.textContent = "\u958B\u59CB\u3092 " + d.safe_from.slice(0, 7) + " \u306B\u5207\u308A\u76F4\u3059";
    b.addEventListener("click", function(){
      $("r-from").value = d.safe_from;
      run("rank");
    });
    fix.appendChild(document.createTextNode("\u5B9A\u7FA9\u3092\u63C3\u3048\u3066\u6BD4\u8F03\u3059\u308B\u306B\u306F\u3001\u958B\u59CB\u6642\u70B9\u3092\u5B9A\u7FA9\u5909\u66F4\u5F8C\u306B\u3057\u3066\u304F\u3060\u3055\u3044\u3002"));
    fix.appendChild(b);
    box.appendChild(fix);
  }
  var top = rows.slice(0, 10), bot = rows.slice(-10).reverse();

  function tbl(title, arr){
    var h = "<h2 style='font-size:.95rem;margin:0 0 8px'>" + title + "</h2>"
          + "<table><thead><tr><th>\u753A\u4E01</th><th>\u30B3\u30FC\u30C9</th><th>\u958B\u59CB</th><th>\u7D42\u4E86</th><th>\u5897\u6E1B</th><th>\u5897\u6E1B\u7387</th></tr></thead><tbody>";
    arr.forEach(function(r){
      var cls = r.rate >= 0 ? "up" : "dn";
      h += "<tr><td>" + r.area_name + "</td><td>" + r.key_code + "</td><td>" + fmt(r.v_from)
         + "</td><td>" + fmt(r.v_to) + "</td><td class='" + cls + "'>"
         + (r.diff >= 0 ? "+" : "") + fmt(r.diff) + "</td><td class='" + cls + "'>"
         + (r.rate >= 0 ? "+" : "") + r.rate.toFixed(2) + "\uFF05</td></tr>";
    });
    return h + "</tbody></table>";
  }
  box.appendChild(card(tbl("\u5897\u52A0\u7387 \u4E0A\u4F4D10", top)));
  box.appendChild(card(tbl("\u6E1B\u5C11\u7387 \u4E0A\u4F4D10", bot)));

  var inc = rows.filter(function(r){ return r.diff > 0; }).length;
  box.appendChild(card("<p style='font-size:.85rem;margin:0'>\u5BFE\u8C61 " + rows.length
    + " \u753A\u4E01\u306E\u3046\u3061\u3001\u5897\u52A0 " + inc + " / \u6E1B\u5C11 " + (rows.length - inc)
    + "\u3002\u753A\u4E01\u5358\u4F4D\u3067\u898B\u308B\u3068\u533A\u5168\u4F53\u306E\u5897\u6E1B\u3068\u306F\u5411\u304D\u304C\u63C3\u308F\u306A\u3044\u3053\u3068\u304C\u3042\u308A\u307E\u3059\u3002</p>"));
}

/* ---------- \u5B9F\u884C ---------- */
function run(kind){
  var out, url;
  if (kind === "trend"){
    out = $("t-out");
    /* \u533A\u5168\u4F53\u30E2\u30FC\u30C9\u306E\u3068\u304D\u306F\u3001\u30EA\u30B9\u30C8\u306B\u9078\u629E\u304C\u6B8B\u3063\u3066\u3044\u3066\u3082\u7121\u8996\u3059\u308B\u3002
       \u753B\u9762\u306E\u898B\u305F\u76EE\u3068\u9001\u308B\u30D1\u30E9\u30E1\u30FC\u30BF\u304C\u98DF\u3044\u9055\u308F\u306A\u3044\u3088\u3046\u306B\u3059\u308B\u3002 */
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
  out.innerHTML = "<p class='busy'>\u96C6\u8A08\u4E2D\u2026</p>";
  api(url).then(function(d){
    out.innerHTML = "";
    if (kind === "trend") drawTrend(d, out);
    else if (kind === "pyramid") drawPyramid(d, out);
    else drawRank(d, out);
    meta(out, d);
  }).catch(function(e){
    out.innerHTML = "<div class='card'><p>\u53D6\u5F97\u306B\u5931\u6557\u3057\u307E\u3057\u305F\uFF1A" + e.message + "</p></div>";
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

/* \u533A\u5168\u4F53 / \u753A\u4E01\u9078\u629E\u306E\u5207\u66FF\u3002
   \u533A\u5168\u4F53\u306B\u623B\u3057\u305F\u3089\u9078\u629E\u3082\u6D88\u3059\u3002\u300C\u9078\u3093\u3060\u307E\u307E\u7121\u52B9\u300D\u306E\u72B6\u614B\u3092\u6B8B\u3055\u306A\u3044\u3002 */
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

/* \u753A\u4E01\u3092\u30AF\u30EA\u30C3\u30AF\u3057\u305F\u3089\u81EA\u52D5\u3067\u300C\u753A\u4E01\u3092\u9078\u3076\u300D\u306B\u5207\u308A\u66FF\u3048\u308B\u3002
   \u30EA\u30B9\u30C8\u304C\u7121\u52B9\u306A\u306E\u3067\u901A\u5E38\u306F\u8D77\u304D\u306A\u3044\u304C\u3001\u30AD\u30FC\u30DC\u30FC\u30C9\u64CD\u4F5C\u306E\u4FDD\u967A\u3002 */
$("t-area").addEventListener("change", function(){
  if ($("t-area").selectedOptions.length){
    document.querySelector("input[name=t-scope][value=pick]").checked = true;
    syncScope();
  }
});

api("/api/q/meta?dataset=" + encodeURIComponent(DS)).then(function(m){
  META = m;
  $("ttl").textContent = m.dataset.muni_name + " " + m.dataset.title + " \u2014 \u96C6\u8A08\u30FB\u53EF\u8996\u5316";
  var ms = m.months;
  if (!ms.length){ $("ttl").textContent += "\uFF08\u30C7\u30FC\u30BF\u304C\u3042\u308A\u307E\u305B\u3093\uFF09"; return; }
  var first = ms[0], last = ms[ms.length - 1];
  var back = ms.length > 12 ? ms[ms.length - 13] : first;

  fill($("t-from"), ms, null, null, first);
  fill($("t-to"), ms, null, null, last);
  fill($("y-date"), ms, null, null, last);
  fill($("r-from"), ms, null, null, back);
  fill($("r-to"), ms, null, null, last);

  var areaOpts = m.areas.slice();
  fill($("t-area"), areaOpts, "key_code", "area_name", null);
  $("t-area").selectedIndex = -1;   // \u74B0\u5883\u306B\u3088\u3063\u3066\u5148\u982D\u304C\u9078\u629E\u6E08\u307F\u306B\u306A\u308B\u306E\u3092\u9632\u3050
  syncScope();
  fill($("y-area"), [{key_code: "", area_name: "\u533A\u5168\u4F53"}].concat(areaOpts), "key_code", "area_name", "");

  var a = m.dataset.attribution || "\uFF08\u51FA\u5178\u8868\u793A\u304C\u672A\u8A2D\u5B9A\u3067\u3059\uFF09";
  $("attr").textContent = a + "\u3000\u30E9\u30A4\u30BB\u30F3\u30B9\uFF1A" + (m.dataset.license || "\u672A\u78BA\u8A8D");

  run("trend");
}).catch(function(e){
  $("ttl").textContent = "\u8AAD\u307F\u8FBC\u307F\u306B\u5931\u6557\u3057\u307E\u3057\u305F\uFF1A" + e.message;
});
<\/script></body></html>`;
}
__name(analyzePage, "analyzePage");
async function handleAnalysis(env, url) {
  const p = url.pathname;
  try {
    if (p === "/analyze") {
      const key = url.searchParams.get("dataset") || "";
      if (!/^[a-z0-9_]{1,64}$/.test(key)) {
        return new Response("\u30C7\u30FC\u30BF\u30BB\u30C3\u30C8\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044", { status: 400 });
      }
      return new Response(analyzePage(key), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
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
__name(handleAnalysis, "handleAnalysis");

// src/index.js
var COOKIE = "__Host-session";
var TTL = 60 * 60 * 12;
var te = new TextEncoder();
var b64u = /* @__PURE__ */ __name((buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "b64u");
var b64uDec = /* @__PURE__ */ __name((s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)), "b64uDec");
var hmacKey = /* @__PURE__ */ __name((secret) => crypto.subtle.importKey(
  "raw",
  te.encode(secret),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign", "verify"]
), "hmacKey");
var sign = /* @__PURE__ */ __name(async (secret, data) => b64u(await crypto.subtle.sign("HMAC", await hmacKey(secret), te.encode(data))), "sign");
var verifySig = /* @__PURE__ */ __name(async (secret, data, sig) => {
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), b64uDec(sig), te.encode(data));
  } catch {
    return false;
  }
}, "verifySig");
async function isAuthed(request, env) {
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)__Host-session=([^;]+)/);
  if (!m) return false;
  const [ver, exp, sig] = m[1].split(".");
  if (ver !== "v1" || !sig) return false;
  if (!(Number(exp) > Date.now() / 1e3)) return false;
  return verifySig(env.COOKIE_SECRET, `v1.${exp}`, sig);
}
__name(isAuthed, "isAuthed");
async function checkPassword(env, submitted) {
  const a = await sign(env.COOKIE_SECRET, `pw:${submitted}`);
  const b = await sign(env.COOKIE_SECRET, `pw:${env.APP_PASSWORD}`);
  return a === b;
}
__name(checkPassword, "checkPassword");
async function issueCookie(env) {
  const exp = Math.floor(Date.now() / 1e3) + TTL;
  const sig = await sign(env.COOKIE_SECRET, `v1.${exp}`);
  return `${COOKIE}=v1.${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL}`;
}
__name(issueCookie, "issueCookie");
var esc2 = /* @__PURE__ */ __name((s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]), "esc");
var html = /* @__PURE__ */ __name((body, status = 200, extra = {}) => new Response(body, {
  status,
  headers: {
    "Content-Type": "text/html; charset=utf-8",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    ...extra
  }
}), "html");
var json2 = /* @__PURE__ */ __name((obj, status = 200) => Response.json(obj, { status, headers: { "X-Robots-Tag": "noindex, nofollow" } }), "json");
var ymOf = /* @__PURE__ */ __name((d) => String(d).slice(0, 7), "ymOf");
function monthRange(fromYm, toYm) {
  const out = [];
  if (!fromYm || !toYm) return out;
  let [y, m] = fromYm.split("-").map(Number);
  const [ey, em] = toYm.split("-").map(Number);
  while (y < ey || y === ey && m <= em) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
__name(monthRange, "monthRange");
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const safeNext = /* @__PURE__ */ __name((v) => v && v.startsWith("/") && !v.startsWith("//") ? v : "/", "safeNext");
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
            headers: { Location: next, "Set-Cookie": await issueCookie(env) }
          });
        }
        await new Promise((r) => setTimeout(r, 800));
        return html(loginPage(next, true), 401);
      }
      return new Response("method not allowed", { status: 405 });
    }
    if (url.pathname === "/logout") {
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/login",
          "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
        }
      });
    }
    if (!await isAuthed(request, env)) {
      if (url.pathname.startsWith("/api/")) return json2({ error: "unauthorized" }, 401);
      return new Response(null, {
        status: 302,
        headers: { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` }
      });
    }
    try {
      return await router(request, url, env, ctx);
    } catch (e) {
      return html(page("\u30A8\u30E9\u30FC", `<h1>\u30A8\u30E9\u30FC</h1><pre>${esc2(e.message)}</pre>`), 500);
    }
  }
};
async function router(request, url, env) {
  if (url.pathname === "/") return catalogPage(env);
  if (url.pathname === "/api/catalog") return json2({ datasets: await loadCatalog(env) });
  const m = url.pathname.match(/^\/dataset\/([A-Za-z0-9_-]+)$/);
  if (m) return datasetPage(env, m[1]);
  const dl = url.pathname.match(/^\/download\/raw\/([0-9a-f]{64})$/);
  if (dl) return downloadRaw(env, dl[1]);
  if (url.pathname === "/download/csv") return downloadCsv(env, url);
  const an = await handleAnalysis(env, url);
  if (an) return an;
  return html(page("404", "<h1>404</h1><p><a href='/'>\u4E00\u89A7\u3078</a></p>"), 404);
}
__name(router, "router");
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
  const { results: runs } = await env.DB.prepare(
    `SELECT dataset_key,
            MAX(started_at)                                        AS last_run_at,
            MAX(CASE WHEN status IN ('ok','no_change') THEN started_at END) AS last_ok_at
       FROM sync_runs GROUP BY 1`
  ).all();
  const { results: files } = await env.DB.prepare(
    `SELECT ds.dataset_key, sf.sha256, sf.r2_key, sf.reference_date, sf.source_file,
            sf.content_bytes, sf.status, sf.row_count,
            COALESCE(sf.distributable, 1) AS distributable, sf.hold_reason
       FROM source_files sf
       JOIN dataset_sources ds
         ON ds.dataset = sf.dataset AND ds.granularity = sf.granularity
      ORDER BY sf.reference_date, sf.ingested_at`
  ).all();
  const byKey = /* @__PURE__ */ __name((rows) => Object.fromEntries(rows.map((r) => [r.dataset_key, r])), "byKey");
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
    const months = monthRange(from, to).map((ym) => {
      const p = pBy[ym];
      const state = p?.obs_rows > 0 ? "ok" : p?.file_count > 0 ? "not_loaded" : "missing";
      return { ym, state, obs_rows: p?.obs_rows ?? 0, files: p?.file_count ?? 0, gap: gapBy[ym] ?? null };
    });
    const outside = ps.filter((p) => p.obs_rows === 0 && p.file_count > 0 && !monthRange(from, to).includes(ymOf(p.reference_date))).map((p) => ({
      ym: ymOf(p.reference_date),
      state: "not_loaded",
      obs_rows: 0,
      files: p.file_count,
      gap: gapBy[ymOf(p.reference_date)] ?? null
    }));
    const all = [...months, ...outside].sort((a, b) => a.ym.localeCompare(b.ym));
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
      last_ok_at: R[d.dataset_key]?.last_ok_at ?? null
    };
  });
}
__name(loadCatalog, "loadCatalog");
var MIME = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv; charset=utf-8",
  json: "application/json"
};
async function downloadRaw(env, sha256) {
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
    return html(page("404", `<h1>\u898B\u3064\u304B\u308A\u307E\u305B\u3093</h1>
      <p>\u6307\u5B9A\u3055\u308C\u305F\u30D5\u30A1\u30A4\u30EB\u306F\u516C\u958B\u5BFE\u8C61\u3067\u306F\u3042\u308A\u307E\u305B\u3093\u3002</p>
      <p><a href="/">\u4E00\u89A7\u3078</a></p>`), 404);
  }
  if (!row.distributable) {
    return html(page("\u914D\u5E03\u505C\u6B62\u4E2D", `
      <h1>\u914D\u5E03\u505C\u6B62\u4E2D</h1>
      <p>${esc2(row.title)} / ${esc2(ymOf(row.reference_date))} \u306E\u539F\u672C\u306F\u3001\u73FE\u5728\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u3067\u304D\u307E\u305B\u3093\u3002</p>
      <div class="note">${esc2(row.hold_reason ?? "\u7406\u7531\u304C\u8A18\u9332\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002")}</div>
      <p class="mut"><code>${esc2(row.sha256)}</code></p>
      <p><a href="/dataset/${esc2(row.dataset_key)}">\u30C7\u30FC\u30BF\u30BB\u30C3\u30C8\u3078\u623B\u308B</a></p>`), 403);
  }
  const obj = await env.LAKE.get(row.r2_key);
  if (!obj) {
    return html(page("\u30A8\u30E9\u30FC", `<h1>\u539F\u672C\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093</h1>
      <p>D1\u306B\u306F\u8A18\u9332\u304C\u3042\u308A\u307E\u3059\u304C\u3001R2\u306B\u5B9F\u4F53\u304C\u3042\u308A\u307E\u305B\u3093\u3002\u540C\u671F\u306E\u4E0D\u6574\u5408\u3067\u3059\u3002</p>
      <p class="mut"><code>${esc2(row.r2_key)}</code></p>`), 502);
  }
  const name = row.source_file || `${sha256.slice(0, 12)}.bin`;
  const ext = name.split(".").pop().toLowerCase();
  const headers = new Headers();
  headers.set("Content-Type", MIME[ext] ?? "application/octet-stream");
  headers.set(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
  );
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("X-Source-SHA256", row.sha256);
  headers.set("X-Source-License", row.license ?? "unspecified");
  if (obj.size) headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
}
__name(downloadRaw, "downloadRaw");
var MAX_MONTHS = 24;
var CHUNK = 5e3;
function exportSpec(granularity, measure) {
  const ageCols = [
    "muni_code",
    "key_code",
    "area_name",
    "reference_date",
    "age_class",
    "sex",
    "value",
    "source_sha256"
  ];
  const table = {
    "5y:population": {
      view: "v_population_5y",
      cols: ageCols,
      label: "\u4EBA\u53E3\uFF085\u6B73\u968E\u7D1A\xD7\u6027\u5225\uFF09"
    },
    "5y:households": {
      view: "v_households_5y",
      cols: ["muni_code", "key_code", "area_name", "reference_date", "value", "source_sha256"],
      label: "\u4E16\u5E2F\u6570"
    },
    "5y:foreign_population": {
      view: "v_foreign_population_5y",
      cols: ["muni_code", "key_code", "area_name", "reference_date", "sex", "value", "source_sha256"],
      label: "\u5916\u56FD\u4EBA\u4EBA\u53E3"
    },
    "5y:published_totals": {
      view: "v_published_totals_5y",
      cols: ["muni_code", "key_code", "area_name", "reference_date", "measure", "value"],
      label: "\u533A\u306E\u516C\u8868\u5024\uFF08\u691C\u7B97\u7528\u30FB\u7DCF\u6570\u884C\uFF09"
    },
    "1y:population": {
      view: "v_population_1y",
      cols: ageCols,
      label: "\u4EBA\u53E3\uFF081\u6B73\u968E\u7D1A\xD7\u6027\u5225\uFF09"
    }
  };
  return table[`${granularity}:${measure}`] ?? null;
}
__name(exportSpec, "exportSpec");
var monthsBetween = /* @__PURE__ */ __name((from, to) => {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}, "monthsBetween");
var csvCell = /* @__PURE__ */ __name((v) => {
  if (v === null || v === void 0) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}, "csvCell");
function errPage(title, body, status) {
  return html(page(title, `<h1>${esc2(title)}</h1>${body}<p><a href="/">\u4E00\u89A7\u3078</a></p>`), status);
}
__name(errPage, "errPage");
async function downloadCsv(env, url) {
  const key = url.searchParams.get("dataset") ?? "";
  const measure = url.searchParams.get("measure") ?? "population";
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) {
    return errPage("\u671F\u9593\u306E\u6307\u5B9A\u304C\u4E0D\u6B63\u3067\u3059", "<p>YYYY-MM \u306E\u5F62\u5F0F\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002</p>", 400);
  }
  if (from > to) {
    return errPage("\u671F\u9593\u306E\u6307\u5B9A\u304C\u4E0D\u6B63\u3067\u3059", "<p>\u958B\u59CB\u304C\u7D42\u4E86\u3088\u308A\u5F8C\u306B\u306A\u3063\u3066\u3044\u307E\u3059\u3002</p>", 400);
  }
  const d = await env.DB.prepare(
    `SELECT dataset_key, title, granularity, muni_name, license, attribution
       FROM datasets WHERE dataset_key = ?1 AND is_public = 1`
  ).bind(key).first();
  if (!d) return errPage("\u30C7\u30FC\u30BF\u30BB\u30C3\u30C8\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093", "", 404);
  const spec = exportSpec(d.granularity, measure);
  if (!spec) return errPage(
    "\u6307\u5B9A\u3055\u308C\u305F\u5185\u5BB9\u306F\u51FA\u529B\u3067\u304D\u307E\u305B\u3093",
    `<p><code>${esc2(measure)}</code> \u306F ${esc2(d.granularity)} \u7C92\u5EA6\u3067\u306F\u63D0\u4F9B\u3057\u3066\u3044\u307E\u305B\u3093\u3002</p>`,
    400
  );
  const n = monthsBetween(from, to);
  if (n > MAX_MONTHS) {
    const [fy, fm] = from.split("-").map(Number);
    const endM = fm + MAX_MONTHS - 1;
    const suggest = `${fy + Math.floor((endM - 1) / 12)}-${String((endM - 1) % 12 + 1).padStart(2, "0")}`;
    return errPage("\u671F\u9593\u304C\u9577\u3059\u304E\u307E\u3059", `
      <p>\u6307\u5B9A\u306F ${n} \u30F6\u6708\u3067\u3059\u30021\u56DE\u3042\u305F\u308A ${MAX_MONTHS} \u30F6\u6708\u307E\u3067\u306B\u5236\u9650\u3057\u3066\u3044\u307E\u3059\u3002</p>
      <p>\u9014\u4E2D\u3067\u6253\u3061\u5207\u3089\u308C\u305FCSV\u306F\u4E00\u898B\u958B\u3051\u3066\u3057\u307E\u3044\u3001\u884C\u306E\u4E0D\u8DB3\u306B\u6C17\u3065\u304D\u306B\u304F\u3044\u305F\u3081\u3067\u3059\u3002</p>
      <div class="note">\u4F8B\uFF1A<code>${esc2(from)}</code> \u301C <code>${esc2(suggest)}</code> \u306B\u5206\u3051\u3066\u304F\u3060\u3055\u3044\u3002</div>`, 400);
  }
  const order = ["reference_date", "key_code", "measure", "age_class", "sex"].filter((c) => spec.cols.includes(c)).join(", ");
  const sql = `SELECT ${spec.cols.join(", ")} FROM ${spec.view}
                WHERE muni_code = ?1 AND reference_date >= ?2 AND reference_date <= ?3
                ORDER BY ${order} LIMIT ?4 OFFSET ?5`;
  const muni = (await env.DB.prepare(
    `SELECT muni_code FROM datasets WHERE dataset_key = ?1`
  ).bind(key).first())?.muni_code;
  const enc = new TextEncoder();
  let offset = 0, done = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode("\uFEFF" + spec.cols.join(",") + "\n"));
    },
    async pull(controller) {
      if (done) return;
      const { results } = await env.DB.prepare(sql).bind(muni, `${from}-01`, `${to}-01`, CHUNK, offset).all();
      if (!results.length) {
        done = true;
        controller.close();
        return;
      }
      let buf = "";
      for (const r of results) buf += spec.cols.map((c) => csvCell(r[c])).join(",") + "\n";
      controller.enqueue(enc.encode(buf));
      offset += results.length;
      if (results.length < CHUNK) {
        done = true;
        controller.close();
      }
    }
  });
  const name = `${key}_${measure}_${from}_${to}.csv`;
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Robots-Tag": "noindex, nofollow",
      "X-Source-View": spec.view,
      "X-Source-License": d.license ?? "unspecified",
      "X-Source-Attribution": d.attribution ?? "unspecified"
    }
  });
}
__name(downloadCsv, "downloadCsv");
function page(title, body) {
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc2(title)}</title>
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
<header><nav><a href="/">\u30C7\u30FC\u30BF\u30BB\u30C3\u30C8\u4E00\u89A7</a> \u30FB <a href="/logout">\u30ED\u30B0\u30A2\u30A6\u30C8</a></nav></header>
${body}</body></html>`;
}
__name(page, "page");
function loginPage(next, error) {
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>\u8A8D\u8A3C</title>
<style>body{font-family:system-ui,sans-serif;max-width:22rem;margin:6rem auto;padding:0 1rem;line-height:1.7}
input,button{width:100%;padding:.6rem;font-size:1rem;box-sizing:border-box}
button{margin-top:.75rem;cursor:pointer}.err{color:#c0392b;font-size:.9rem}
.note{color:#666;font-size:.85rem;margin-top:2rem}</style></head><body>
<h1>\u8A8D\u8A3C</h1>
${error ? '<p class="err">\u30D1\u30B9\u30EF\u30FC\u30C9\u304C\u9055\u3044\u307E\u3059\u3002</p>' : ""}
<form method="POST" action="/login">
  <input type="hidden" name="next" value="${esc2(next)}">
  <input type="password" name="password" placeholder="\u30D1\u30B9\u30EF\u30FC\u30C9" autofocus required autocomplete="current-password">
  <button type="submit">\u5165\u308B</button>
</form>
<p class="note">\u958B\u767A\u30C6\u30B9\u30C8\u4E2D\u306E\u305F\u3081\u95A2\u4FC2\u8005\u9650\u5B9A\u3067\u516C\u958B\u3057\u3066\u3044\u307E\u3059\u3002</p>
</body></html>`;
}
__name(loginPage, "loginPage");
async function catalogPage(env) {
  const cat = await loadCatalog(env);
  const rows = cat.map((d) => {
    const bad2 = d.anomalies.length;
    const health = bad2 === 0 ? '<span class="pill ok">\u6B63\u5E38</span>' : `<span class="pill warn">\u8981\u78BA\u8A8D ${bad2}</span>`;
    const lic = d.license ? esc2(d.license) : '<span class="pill bad">\u672A\u78BA\u8A8D</span>';
    return `<tr>
      <td><a href="/dataset/${esc2(d.dataset_key)}">${esc2(d.title)}</a><br>
          <span class="mut">${esc2(d.muni_name)} \xB7 ${esc2(d.grain_label)} \xB7 ${esc2(d.source_site)}</span></td>
      <td>${esc2(d.period_from ?? "\u2014")} \u301C ${esc2(d.period_to ?? "\u2014")}<br>
          <span class="mut">${d.months_present} / ${d.months_expected} \u30F6\u6708</span></td>
      <td class="num">${d.obs_rows.toLocaleString()}</td>
      <td>${health}</td>
      <td>${lic}</td>
      <td class="mut">${esc2(d.last_ok_at ?? d.last_ingested_at ?? "\u2014")}</td>
    </tr>`;
  }).join("");
  const noLicense = cat.filter((d) => !d.license).length;
  const noAttr = cat.filter((d) => d.license && !d.attribution).length;
  const noRuns = cat.filter((d) => !d.last_run_at).length;
  let issues = [];
  try {
    const r = await env.DB.prepare(
      `SELECT severity, title FROM known_issues WHERE resolved_at IS NULL
        ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`
    ).all();
    issues = r.results ?? [];
  } catch {
  }
  const warnings = [];
  if (noAttr) warnings.push(
    `<strong>\u51FA\u5178\u8868\u793A\uFF08attribution\uFF09\u304C\u672A\u8A2D\u5B9A\u306E\u30C7\u30FC\u30BF\u30BB\u30C3\u30C8\u304C ${noAttr} \u4EF6\u3042\u308A\u307E\u3059\u3002</strong>
     CC BY \u306F\u5E30\u5C5E\u8868\u793A\u304C\u7FA9\u52D9\u3067\u3059\u3002\u539F\u672C\u3092\u914D\u5E03\u3059\u308B\u524D\u306B
     <code>datasets.attribution</code> \u3092\u57CB\u3081\u3066\u304F\u3060\u3055\u3044\u3002`
  );
  if (noLicense) warnings.push(
    `<strong>\u30E9\u30A4\u30BB\u30F3\u30B9\u672A\u78BA\u8A8D\u304C ${noLicense} \u4EF6\u3042\u308A\u307E\u3059\u3002</strong>
     \u53CE\u96C6\u6642\u70B9\u3067\u8A18\u9332\u3057\u306A\u3044\u3068\u3001\u5F8C\u304B\u3089\u9061\u3063\u3066\u8ABF\u3079\u308B\u4F5C\u696D\u304C\u767A\u751F\u3057\u307E\u3059\u3002
     <code>datasets.license</code> / <code>attribution</code> \u3092\u57CB\u3081\u3066\u304F\u3060\u3055\u3044\u3002`
  );
  if (noRuns) warnings.push(
    `<strong>\u540C\u671F\u306E\u8A66\u884C\u30ED\u30B0\u304C\u3042\u308A\u307E\u305B\u3093\u3002</strong>
     \u3044\u307E\u306E\u300C\u6700\u7D42\u66F4\u65B0\u300D\u306F\u53D6\u8FBC\u306B\u6210\u529F\u3057\u305F\u30D5\u30A1\u30A4\u30EB\u306E\u6642\u523B\u306A\u306E\u3067\u3001
     \u4E0A\u6D41\u304C\u843D\u3061\u3066\u4F55\u3082\u53D6\u308C\u306A\u304B\u3063\u305F\u65E5\u306F\u75D5\u8DE1\u304C\u6B8B\u308A\u307E\u305B\u3093\u3002
     GitHub Actions \u304B\u3089 <code>sync_runs</code> \u306B1\u884C\u66F8\u304F\u3088\u3046\u306B\u3057\u3066\u304F\u3060\u3055\u3044\u3002`
  );
  return html(page("\u30C7\u30FC\u30BF\u30BB\u30C3\u30C8\u4E00\u89A7", `
<h1>\u30C7\u30FC\u30BF\u30BB\u30C3\u30C8\u4E00\u89A7</h1>
<p class="mut">\u6771\u4EAC\u90FD\u30AA\u30FC\u30D7\u30F3\u30C7\u30FC\u30BF\u7D71\u5408\u57FA\u76E4\uFF08\u8A66\u9A13\u516C\u958B\uFF09</p>

<table>
  <thead><tr><th>\u30C7\u30FC\u30BF\u30BB\u30C3\u30C8</th><th>\u671F\u9593</th><th>\u884C\u6570</th><th>\u72B6\u614B</th><th>\u30E9\u30A4\u30BB\u30F3\u30B9</th><th>\u6700\u7D42\u540C\u671F</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6">\u30C7\u30FC\u30BF\u30BB\u30C3\u30C8\u304C\u3042\u308A\u307E\u305B\u3093</td></tr>'}</tbody>
</table>

${warnings.map((w) => `<div class="note">${w}</div>`).join("")}

${issues.length ? `<h2>\u65E2\u77E5\u306E\u8AB2\u984C\uFF08${issues.length}\uFF09</h2>
<table><thead><tr><th>\u91CD\u8981\u5EA6</th><th>\u5185\u5BB9</th></tr></thead><tbody>
${issues.map((i) => `<tr>
  <td><span class="pill ${i.severity === "high" ? "bad" : "warn"}">${esc2(i.severity)}</span></td>
  <td>${esc2(i.title)}</td></tr>`).join("")}
</tbody></table>
<p class="mut">\u89E3\u6C7A\u6E08\u307F\u306E\u8AB2\u984C\u306F <code>known_issues.resolved_at</code> \u3092\u57CB\u3081\u308B\u3068\u6D88\u3048\u307E\u3059\u3002</p>` : ""}
`));
}
__name(catalogPage, "catalogPage");
async function datasetPage(env, key) {
  const cat = await loadCatalog(env);
  const d = cat.find((x) => x.dataset_key === key);
  if (!d) return html(page("404", "<h1>404</h1><p><a href='/'>\u4E00\u89A7\u3078</a></p>"), 404);
  const byYear = {};
  for (const m of d.months) (byYear[m.ym.slice(0, 4)] ||= []).push(m);
  const grid = Object.keys(byYear).sort().map((y) => {
    const cells = Array.from({ length: 12 }, (_, i) => {
      const ym = `${y}-${String(i + 1).padStart(2, "0")}`;
      const m = byYear[y].find((x) => x.ym === ym);
      if (!m) return `<div class="cell" style="background:#f0f0f0"></div>`;
      const t = m.state === "ok" ? `${m.obs_rows.toLocaleString()}\u884C` : m.state === "not_loaded" ? "\u30D5\u30A1\u30A4\u30EB\u306F\u3042\u308B\u304CDB\u672A\u53CD\u6620" : "\u6B20\u6E2C";
      const tip = `${ym} \u2014 ${t}${m.gap ? " / " + esc2(m.gap.reason) : ""}`;
      const dlable = (m.files ?? []).find((f) => f.distributable);
      const inner = `<div class="cell ${m.state}" title="${tip}">${i + 1}</div>`;
      return dlable ? `<a href="/download/raw/${esc2(dlable.sha256)}" class="celllink">${inner}</a>` : inner;
    }).join("");
    return `<div class="yr"><b>${y}</b>${cells}</div>`;
  }).join("");
  const allFiles = d.months.flatMap((m) => (m.files ?? []).map((f) => ({ ...f, ym: m.ym })));
  const fileRows = allFiles.map((f) => `<tr>
      <td>${esc2(f.ym)}</td>
      <td>${esc2(f.source_file ?? "\u2014")}</td>
      <td class="num">${f.content_bytes ? (f.content_bytes / 1024).toFixed(0) + " KB" : "\u2014"}</td>
      <td class="num">${f.row_count?.toLocaleString() ?? "\u2014"}</td>
      <td><code class="mut">${esc2(f.sha256.slice(0, 12))}</code></td>
      <td>${f.distributable ? `<a href="/download/raw/${esc2(f.sha256)}">\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9</a>` : `<span class="pill bad">\u914D\u5E03\u505C\u6B62</span><br><span class="mut">${esc2(f.hold_reason ?? "")}</span>`}</td>
    </tr>`).join("");
  const anomalies = d.anomalies.length === 0 ? '<p class="mut">\u3042\u308A\u307E\u305B\u3093\u3002</p>' : `<table><thead><tr><th>\u5E74\u6708</th><th>\u533A\u5206</th><th>\u7A2E\u5225</th><th>\u7406\u7531</th></tr></thead><tbody>` + d.anomalies.map((a) => `<tr>
        <td>${a.ym}</td>
        <td>${a.state === "not_loaded" ? '<span class="pill warn">\u30D5\u30A1\u30A4\u30EB\u6709\u30FBDB\u672A\u53CD\u6620</span>' : '<span class="pill bad">\u6B20\u6E2C</span>'}</td>
        <td>${esc2(a.gap?.kind ?? "\u672A\u5206\u985E")}</td>
        <td>${esc2(a.gap?.reason ?? "\u7406\u7531\u304C\u8A18\u9332\u3055\u308C\u3066\u3044\u307E\u305B\u3093")}</td>
      </tr>`).join("") + "</tbody></table>";
  const measures = d.granularity === "5y" ? ["population", "households", "foreign_population", "published_totals"] : ["population"];
  const measureOpts = measures.map((m) => `<option value="${m}">${esc2(exportSpec(d.granularity, m).label)}</option>`).join("");
  const defTo = d.period_to ?? "";
  const defFrom = (() => {
    if (!defTo) return "";
    let [y, m] = defTo.split("-").map(Number);
    m -= 11;
    while (m < 1) {
      m += 12;
      y--;
    }
    const cand = `${y}-${String(m).padStart(2, "0")}`;
    return d.period_from && cand < d.period_from ? d.period_from : cand;
  })();
  return html(page(d.title, `

<h1>${esc2(d.title)}</h1>
<p class="mut">${esc2(d.muni_name)}\uFF08${esc2(d.muni_code)}\uFF09\xB7 ${esc2(d.grain_label)} \xB7
   \u51FA\u5178 ${d.source_url ? `<a href="${esc2(d.source_url)}" rel="noreferrer">${esc2(d.source_site)}</a>` : esc2(d.source_site)}</p>
<p><a class="btn" href="/analyze?dataset=${esc2(d.dataset_key)}">\u96C6\u8A08\u30FB\u53EF\u8996\u5316\u3092\u958B\u304F \u2192</a></p>

<h2>\u53CE\u9332\u72B6\u6CC1</h2>
<p class="mut">${esc2(d.period_from ?? "\u2014")} \u301C ${esc2(d.period_to ?? "\u2014")} \uFF0F
   ${d.months_present} \u30F6\u6708 \uFF0F ${d.obs_rows.toLocaleString()} \u884C</p>
${grid}
<p class="mut">\u7DD1 = \u53CE\u9332\u6E08 \uFF0F \u6A59 = \u30D5\u30A1\u30A4\u30EB\u306F\u53D6\u5F97\u6E08\u3060\u304CDB\u306B\u672A\u53CD\u6620 \uFF0F \u8D64 = \u6B20\u6E2C</p>

<h2>\u30C7\u30FC\u30BF\u306E\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9</h2>
<p class="mut">long\u5F62\u5F0F\u306ECSV\u3067\u3059\u3002\u96C6\u8A08\u3057\u3066\u3088\u3044\u884C\u3060\u3051\u3092\u901A\u3059\u30D3\u30E5\u30FC\u304B\u3089\u51FA\u529B\u3057\u3066\u3044\u308B\u305F\u3081\u3001
   \u305D\u306E\u307E\u307E <code>SUM</code> \u3057\u3066\u3082\u4E8C\u91CD\u8A08\u4E0A\u306B\u306A\u308A\u307E\u305B\u3093\u30021\u56DE\u3042\u305F\u308A ${MAX_MONTHS} \u30F6\u6708\u307E\u3067\u3002</p>
<form method="GET" action="/download/csv" class="dlform">
  <input type="hidden" name="dataset" value="${esc2(d.dataset_key)}">
  <label>\u5185\u5BB9
    <select name="measure">${measureOpts}</select>
  </label>
  <label>\u958B\u59CB <input type="month" name="from" value="${esc2(defFrom)}" required></label>
  <label>\u7D42\u4E86 <input type="month" name="to"   value="${esc2(defTo)}" required></label>
  <button type="submit">CSV\u3092\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9</button>
</form>
<p class="mut">\u30E9\u30A4\u30BB\u30F3\u30B9\uFF1A${d.license ? esc2(d.license) : "\u672A\u78BA\u8A8D"}
  ${d.attribution ? "" : ' <span class="pill bad">\u51FA\u5178\u8868\u793A\u304C\u672A\u8A2D\u5B9A</span>'}</p>

<h2>\u539F\u672C\u306E\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9</h2>
<p class="mut">\u533A\u304C\u516C\u958B\u3057\u305F\u30D5\u30A1\u30A4\u30EB\u305D\u306E\u3082\u306E\u3067\u3059\u3002\u52A0\u5DE5\u3057\u3066\u3044\u307E\u305B\u3093\u3002
   \u30B0\u30EA\u30C3\u30C9\u306E\u30DE\u30B9\u304B\u3089\u3082\u76F4\u63A5\u843D\u3068\u305B\u307E\u3059\u3002</p>
<details>
  <summary>\u30D5\u30A1\u30A4\u30EB\u4E00\u89A7\uFF08${allFiles.length} \u4EF6\uFF09</summary>
  <table>
    <thead><tr><th>\u5E74\u6708</th><th>\u30D5\u30A1\u30A4\u30EB\u540D</th><th>\u30B5\u30A4\u30BA</th><th>\u884C\u6570</th><th>SHA256</th><th></th></tr></thead>
    <tbody>${fileRows || '<tr><td colspan="6">\u30D5\u30A1\u30A4\u30EB\u304C\u3042\u308A\u307E\u305B\u3093</td></tr>'}</tbody>
  </table>
</details>

<h2>\u6B20\u6E2C\u30FB\u4E0D\u6574\u5408</h2>
${anomalies}

<h2>\u540C\u671F\u306E\u72B6\u614B</h2>
<table><tbody>
<tr><th>\u6700\u7D42\u540C\u671F\u8A66\u884C</th><td>${esc2(d.last_run_at ?? "\u8A18\u9332\u306A\u3057")}</td></tr>
<tr><th>\u6700\u7D42\u540C\u671F\u6210\u529F</th><td>${esc2(d.last_ok_at ?? "\u8A18\u9332\u306A\u3057")}</td></tr>
<tr><th>\u6700\u7D42\u53D6\u8FBC\u6642\u523B</th><td>${esc2(d.last_ingested_at ?? "\u2014")}</td></tr>
<tr><th>\u53D6\u5F97\u30D5\u30A1\u30A4\u30EB\u6570</th><td>${d.files_total}\uFF08\u3046\u3061\u30B9\u30AD\u30C3\u30D7 ${d.files_skipped}\uFF09</td></tr>
</tbody></table>

<h2>\u30E9\u30A4\u30BB\u30F3\u30B9</h2>
<p>${d.license ? esc2(d.license) : '<span class="pill bad">\u672A\u78BA\u8A8D</span> \u2014 \u518D\u914D\u5E03\u3068\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u63D0\u4F9B\u306E\u524D\u306B\u78BA\u8A8D\u304C\u5FC5\u8981\u3067\u3059\u3002'}</p>
${d.attribution ? `<p class="mut">\u51FA\u5178\u8868\u793A\uFF1A${esc2(d.attribution)}</p>` : ""}
${d.notes ? `<div class="note">${esc2(d.notes)}</div>` : ""}
`));
}
__name(datasetPage, "datasetPage");
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
