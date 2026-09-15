/* =====================================================================
 *  patch_lab_season2.js —— 季節変動タブに指標セレクタを追加する（修正版）
 *
 *  使い方（opendata-app ディレクトリで）
 *      node patch_lab_season2.js
 *
 *  前提
 *      sql/seasonality_households.sql を実行済みであること
 *      （v_nl_seasonality_hh / v_nl_seasonality_hh_strength が必要）
 *
 *  前回版からの変更
 *    - URL 末尾の照合を run(kind) 内に限定した。$("s-month").value; は
 *      loadInsight にも同じ形であり、範囲を絞らないと一意に決まらない。
 *    - AIインサイトを人口固定にした。季節変動の結果を入力にしているため、
 *      世帯数を選ぶと画面のグラフとAIの語る内容が食い違う。
 *      measure を通すには apiInsight 側（要件5・6の2つのLLM呼び出し）の
 *      対応が要り、工数が読めない。今回は対応していないことを明示する。
 *      → 締切後に対応。known_issues 候補。
 *
 *  変更点
 *    ① SEASON_VIEWS 定数（指標 → 前計算ビュー）
 *    ② seasonalityQuery に ms を渡す
 *    ③ apiSeasonality で measure を解決する
 *    ④ #p-season の ctl 先頭に #s-measure
 *    ⑤ run("season") の URL に &measure=
 *    ⑥ 世帯数のとき age モードを無効化
 *    ⑦ 世帯数のとき AIインサイトを出さない
 * ===================================================================== */

const fs = require("fs");
const path = require("path");

const FILE = path.join("src", "lab.js");
const BAK = path.join("src", "lab.js.bak4");

if (!fs.existsSync(FILE)) {
  console.error("✗ " + FILE + " が見つかりません。opendata-app ディレクトリで実行してください。");
  process.exit(1);
}

const original = fs.readFileSync(FILE, "utf8");
const EOL = original.includes("\r\n") ? "\r\n" : "\n";
let lines = original.split(/\r?\n/);

function fail(msg) {
  console.error("✗ " + msg);
  console.error("  ファイルは変更していません。");
  process.exit(1);
}

/* --- 事前検査 ------------------------------------------------------- */
if (original.includes('id="s-measure"')) fail("既に適用済みです");
if (!original.includes("VIEW_BY_GRAIN_MEASURE")) fail("先に patch_lab_measure.js を適用してください");
if (!original.includes('id="t-measure"')) fail("先に patch_lab_selector2.js を適用してください");

const runCount = lines.filter((l) => l.includes("function run(kind)")).length;
if (runCount !== 1) fail("run(kind) が " + runCount + " 個あります（1個のはず）。lab.js が壊れています");

function findLine(pred, what, from = 0, to = lines.length) {
  const hits = [];
  for (let i = from; i < to; i++) if (pred(lines[i])) hits.push(i);
  if (hits.length === 0) fail(what + " が見つかりません");
  if (hits.length > 1) fail(what + " が " + hits.length + " 箇所あります（1箇所のはず）");
  return hits[0];
}

/* --- 位置の特定（適用は後でまとめて行う） ---------------------------- */

/* ① SEASON_VIEWS の挿入位置 */
const measuresIdx = findLine((l) => l.includes("const MEASURES = {"), "MEASURES の定義");
let measuresEnd = measuresIdx;
while (measuresEnd < measuresIdx + 20 && lines[measuresEnd].trim() !== "};") measuresEnd++;
if (lines[measuresEnd].trim() !== "};") fail("MEASURES の終端が見つかりません");

/* ② seasonalityQuery */
const sqIdx = findLine(
  (l) => l.includes("async function seasonalityQuery(env, ds, mode, key, month)"),
  "seasonalityQuery の定義"
);

/* ③ apiSeasonality */
const apiIdx = findLine(
  (l) => l.includes("async function apiSeasonality(env, url)"),
  "apiSeasonality の定義"
);
const callIdx = findLine(
  (l) => l.includes("await seasonalityQuery(env, ds, mode, key, month)"),
  "seasonalityQuery の呼び出し",
  apiIdx,
  apiIdx + 20
);

/* ④ マークアップ */
const panelIdx = findLine((l) => l.includes('id="p-season"'), "#p-season のパネル");
const ctlIdx = findLine((l) => l.includes('<div class="ctl">'), "ctl の開始", panelIdx, panelIdx + 5);

/* ⑤ URL 構築。run(kind) 内に限定する。
      loadInsight にも同じ形の行があるため、範囲を絞らないと一意にならない。 */
const runIdx = findLine((l) => l.includes("function run(kind)"), "run(kind) の定義");
const urlIdx = findLine(
  (l) => l.includes('+ "&month=" + $("s-month").value;'),
  "season の URL 末尾",
  runIdx,
  runIdx + 60
);

/* ⑥⑦ 初期化の位置 */
const goIdx = findLine((l) => l.includes('$("s-go").addEventListener'), "s-go のリスナ登録");

/* ⑦ AIインサイトの呼び出し */
const insIdx = findLine((l) => l.includes("function loadInsight(box)"), "loadInsight の定義");

/* --- 挿入する内容 ----------------------------------------------------- */

const SEASON_VIEWS = [
  "/* 季節指数は前計算テーブルから引く。指標ごとに別テーブルなので、",
  "   推移のように ds.view を差し替える形にはならない。",
  "   人口版のビューには触れない（公開版 /analyze が参照しているため）。",
  "   age は世帯数に存在しない。世帯数は年齢の内訳を持たない。 */",
  "const SEASON_VIEWS = {",
  "  population: {",
  '    profile: "v_nl_seasonality",',
  '    strength: "v_nl_seasonality_strength",',
  '    age: "v_nl_seasonality_age",',
  "  },",
  "  households: {",
  '    profile: "v_nl_seasonality_hh",',
  '    strength: "v_nl_seasonality_hh_strength",',
  "  },",
  "};",
];

const SQ_HEAD = [
  '  ms = ms || { key: "population", label: "人口", unit: "人" };',
  "  const sv = SEASON_VIEWS[ms.key] || SEASON_VIEWS.population;",
  "  if (!sv[mode]) {",
  '    return { sql: "", params: [], rows: [],',
  '             notes: ["「" + ms.label + "」にこの表示は使えません"] };',
  "  }",
];

const API_HEAD = [
  '  const ms = resolveMeasure(ds, url.searchParams.get("measure"));',
  '  if (!ms) return bad("この粒度では指定された指標を扱えません");',
];

const MARKUP = [
  "    <div><label>指標</label>",
  '      <select id="s-measure">',
  '        <option value="population">人口（人）</option>',
  '        <option value="households">世帯数（世帯）</option>',
  "      </select>",
  "    </div>",
];

/* 世帯数のときに落とすもの2つ。
   age モード  … 年齢の内訳を持たないため成立しない
   AIインサイト … 季節変動の結果を入力にしており、人口前提のまま。
                  画面と語る内容が食い違うより、出さないほうがよい。 */
const TOGGLE = [
  "function syncSeasonMeasure(){",
  '  var hh = $("s-measure").value === "households";',
  '  var sel = $("s-mode");',
  "  var opt = sel.querySelector('option[value=\"age\"]');",
  "  if (opt){",
  "    opt.disabled = hh;",
  '    if (hh && sel.value === "age"){ sel.value = "strength"; }',
  "  }",
  '  var box = $("s-measure").parentNode;',
  '  var n = box.querySelector(".hint");',
  "  if (hh && !n){",
  '    var p = document.createElement("div");',
  '    p.className = "hint";',
  '    p.style.cssText = "font-size:11px;color:#6b6b6b;margin-top:4px;line-height:1.5";',
  '    p.textContent = "年齢の内訳とAIインサイトは人口のみ対応";',
  "    box.appendChild(p);",
  "  } else if (!hh && n){ n.remove(); }",
  "}",
  '$("s-measure").addEventListener("change", syncSeasonMeasure);',
  "syncSeasonMeasure();",
];

const INS_GUARD = [
  "  /* AIインサイトは季節変動の結果を入力にしており、人口前提のまま。",
  "     世帯数を選んだ状態で呼ぶと、画面のグラフとAIの語る内容が食い違う。",
  "     measure を通すには要件5・6の2つのLLM呼び出しの対応が要る。→ 締切後 */",
  '  if ($("s-measure") && $("s-measure").value !== "population"){',
  '    box.innerHTML = "<p style=\'font-size:.85rem;color:#6b6b6b;margin:0\'>'
    + 'AIインサイトは人口のみ対応しています。</p>";',
  "    return;",
  "  }",
];

/* =====================================================================
 *  適用。行番号がずれないよう、後ろから当てる。
 * ===================================================================== */

lines.splice(insIdx + 2, 0, ...INS_GUARD);
lines.splice(goIdx, 0, ...TOGGLE);

lines[urlIdx] = lines[urlIdx].replace(
  '+ "&month=" + $("s-month").value;',
  '+ "&month=" + $("s-month").value'
);
lines.splice(urlIdx + 1, 0, '        + "&measure=" + $("s-measure").value;');

lines.splice(ctlIdx + 1, 0, ...MARKUP);

lines[callIdx] = lines[callIdx].replace(
  "await seasonalityQuery(env, ds, mode, key, month)",
  "await seasonalityQuery(env, ds, mode, key, month, ms)"
);
lines.splice(apiIdx + 1, 0, ...API_HEAD);

lines[sqIdx] = lines[sqIdx].replace(
  "async function seasonalityQuery(env, ds, mode, key, month)",
  "async function seasonalityQuery(env, ds, mode, key, month, ms)"
);
lines.splice(sqIdx + 1, 0, ...SQ_HEAD);

lines.splice(measuresEnd + 1, 0, ...SEASON_VIEWS);

/* --- ビュー名の差し替え ----------------------------------------------
   SQL 内の直書きを sv[mode] から引く形に変える。
   置換できたかは呼び出し側で必ず確認すること。                      */
let out = lines.join(EOL);
let hit = 0;
[
  ["FROM v_nl_seasonality_strength s", "FROM ${sv.strength} s"],
  ["FROM v_nl_seasonality_age", "FROM ${sv.age}"],
  ["FROM v_nl_seasonality\n", "FROM ${sv.profile}\n"],
  ["FROM v_nl_seasonality\r\n", "FROM ${sv.profile}\r\n"],
].forEach(function (pair) {
  if (out.includes(pair[0])) {
    out = out.replace(pair[0], pair[1]);
    hit++;
  }
});

/* --- 事後検査 ---------------------------------------------------------- */
const outLines = out.split(/\r?\n/);
if (outLines.filter((l) => l.includes("function run(kind)")).length !== 1) {
  fail("適用後に run(kind) が増えています");
}
if (outLines.filter((l) => l.includes("s-measure")).length < 5) {
  fail("s-measure の挿入が不足しています");
}

fs.writeFileSync(BAK, original, "utf8");
fs.writeFileSync(FILE, out, "utf8");

console.log("✓ 適用しました");
console.log("  バックアップ : " + BAK);
console.log("");
console.log("  変更箇所");
console.log("    SEASON_VIEWS 定数");
console.log("    seasonalityQuery に ms 引数");
console.log("    apiSeasonality で measure 解決");
console.log("    マークアップ #s-measure");
console.log("    URL に &measure=");
console.log("    age モードの無効化");
console.log("    AIインサイトを人口固定に");
console.log("");
console.log("  ビュー名の差し替え : " + hit + " 件");
if (hit < 3) {
  console.log("  ★ 3件に満たない。残りを手で直す必要があります。");
  console.log("     Select-String -Path src\\lab.js -Encoding UTF8 -Pattern 'v_nl_seasonality'");
}
console.log("");
console.log("  次の手順");
console.log("    npx wrangler deploy --dry-run");
console.log("");
console.log("  戻すとき");
console.log("    Copy-Item src\\lab.js.bak4 src\\lab.js -Force");
