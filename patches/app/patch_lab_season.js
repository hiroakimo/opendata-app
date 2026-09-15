/* =====================================================================
 *  patch_lab_season.js —— 季節変動タブに指標セレクタを追加する
 *
 *  使い方（opendata-app ディレクトリで）
 *      node patch_lab_season.js
 *
 *  前提
 *      sql/seasonality_households.sql を実行済みであること
 *      （v_nl_seasonality_hh / v_nl_seasonality_hh_strength が必要）
 *
 *  変更点
 *    ① SEASON_VIEWS 定数を置く（指標 → ビュー名）
 *    ② seasonalityQuery に measure を渡し、ビューを差し替える
 *    ③ apiSeasonality で measure を受けて検証する
 *    ④ #p-season の ctl 先頭に #s-measure を置く
 *    ⑤ run("season") の URL に &measure= を足す
 *    ⑥ 世帯数を選んだら「年齢階級別の内訳」を無効化する
 *
 *  age モードは世帯数で成立しない。世帯数は年齢の内訳を持たないので、
 *  選択肢として残すと嘘になる。空の結果を返すのではなく選ばせない。
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

/* --- ① SEASON_VIEWS -------------------------------------------------
   季節指数は事前計算済みのテーブルを引いている。推移のように
   ds.view を差し替えるだけでは通らないので、専用の写像を持つ。
   人口版のビューには触れない。公開版が参照しているため。          */
const measuresIdx = findLine((l) => l.includes("const MEASURES = {"), "MEASURES の定義");
let measuresEnd = measuresIdx;
while (measuresEnd < measuresIdx + 20 && lines[measuresEnd].trim() !== "};") measuresEnd++;
if (lines[measuresEnd].trim() !== "};") fail("MEASURES の終端が見つかりません");

const SEASON_VIEWS = [
  "/* 季節指数は前計算テーブルから引く。指標ごとに別テーブルなので、",
  "   推移のように ds.view を差し替える形にはならない。",
  "   age は世帯数に存在しない（年齢の内訳を持たないため）。 */",
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

/* --- ② seasonalityQuery ---------------------------------------------- */
const sqIdx = findLine(
  (l) => l.includes("async function seasonalityQuery(env, ds, mode, key, month)"),
  "seasonalityQuery の定義"
);

/* --- ③ apiSeasonality ------------------------------------------------ */
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

/* --- ④ マークアップ --------------------------------------------------- */
const panelIdx = findLine((l) => l.includes('id="p-season"'), "#p-season のパネル");
const ctlIdx = findLine((l) => l.includes('<div class="ctl">'), "ctl の開始", panelIdx, panelIdx + 5);

const MARKUP = [
  "    <div><label>指標</label>",
  '      <select id="s-measure">',
  '        <option value="population">人口（人）</option>',
  '        <option value="households">世帯数（世帯）</option>',
  "      </select>",
  "    </div>",
];

/* --- ⑤ URL 構築 ------------------------------------------------------- */
const urlIdx = findLine(
  (l) => l.includes('+ "&month=" + $("s-month").value;'),
  "season の URL 末尾",
  0,
  lines.length
);

/* --- ⑥ age モードの無効化 --------------------------------------------
   マークアップの直後に置くと DOM 構築前に走る。script 末尾の
   初期化と同じ場所に置きたいので、s-mode のリスナがある位置を探す。 */
const goIdx = findLine((l) => l.includes('$("s-go").addEventListener'), "s-go のリスナ登録");

const TOGGLE = [
  "/* 世帯数は年齢の内訳を持たない。age モードを選ばせない。",
  "   選択中に切り替えられたら strength に戻す。 */",
  'function syncSeasonMeasure(){',
  '  var hh = $("s-measure").value === "households";',
  '  var opt = $("s-mode").querySelector(\'option[value="age"]\');',
  "  if (opt){",
  "    opt.disabled = hh;",
  '    if (hh && $("s-mode").value === "age"){ $("s-mode").value = "strength"; }',
  "  }",
  '  var n = $("s-measure").parentNode.querySelector(".hint");',
  "  if (hh && !n){",
  '    var p = document.createElement("div");',
  '    p.className = "hint";',
  '    p.style.cssText = "font-size:11px;color:#6b6b6b;margin-top:4px";',
  '    p.textContent = "世帯数に年齢の内訳はありません";',
  '    $("s-measure").parentNode.appendChild(p);',
  "  } else if (!hh && n){ n.remove(); }",
  "}",
  '$("s-measure").addEventListener("change", function(){ syncSeasonMeasure(); });',
  "syncSeasonMeasure();",
];

/* =====================================================================
 *  適用。行番号がずれないよう、後ろから当てる。
 * ===================================================================== */

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
lines.splice(apiIdx + 1, 0,
  '  const ms = resolveMeasure(ds, url.searchParams.get("measure"));',
  '  if (!ms) return bad("この粒度では指定された指標を扱えません");'
);

lines[sqIdx] = lines[sqIdx].replace(
  "async function seasonalityQuery(env, ds, mode, key, month)",
  "async function seasonalityQuery(env, ds, mode, key, month, ms)"
);
lines.splice(sqIdx + 1, 0,
  '  ms = ms || { key: "population", label: "人口", unit: "人" };',
  "  const sv = SEASON_VIEWS[ms.key] || SEASON_VIEWS.population;",
  '  if (!sv[mode]) return { sql: "", params: [], rows: [],',
  '    notes: ["「" + ms.label + "」にこの表示は使えません"] };'
);

lines.splice(measuresEnd + 1, 0, ...SEASON_VIEWS);

/* --- ビュー名の差し替え ---------------------------------------------
   seasonalityQuery 内の直書きを sv[mode] から引く形に変える。      */
const after0 = lines.join(EOL);
const replaced = after0
  .replace("FROM v_nl_seasonality_strength s\n", "FROM ${sv.strength} s\n")
  .replace("  FROM v_nl_seasonality\n", "  FROM ${sv.profile}\n")
  .replace("  FROM v_nl_seasonality_age\n", "  FROM ${sv.age}\n");

/* --- 事後検査 -------------------------------------------------------- */
const outLines = replaced.split(/\r?\n/);
if (outLines.filter((l) => l.includes("function run(kind)")).length !== 1) {
  fail("適用後に run(kind) が増えています");
}
if (outLines.filter((l) => l.includes("s-measure")).length < 4) {
  fail("s-measure の挿入が不足しています");
}

fs.writeFileSync(BAK, original, "utf8");
fs.writeFileSync(FILE, replaced, "utf8");

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
console.log("");
console.log("  ★ ビュー名の差し替えは要確認");
console.log("    Select-String -Path src\\lab.js -Encoding UTF8 -Pattern 'sv.strength|sv.profile|sv.age'");
console.log("    3件出れば成功。0件なら手で直す必要があります。");
console.log("");
console.log("  次の手順");
console.log("    npx wrangler deploy --dry-run");
console.log("");
console.log("  戻すとき");
console.log("    Copy-Item src\\lab.js.bak4 src\\lab.js -Force");
