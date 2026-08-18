/* =====================================================================
 *  patch_lab_rank.js —— 増減率ランキングタブに指標セレクタを追加する
 *
 *  使い方（opendata-app ディレクトリで）
 *      node patch_lab_rank.js
 *
 *  apiRanking は推移と同じく ds.view を直接引いている。前計算テーブルを
 *  使う季節変動と違い、ビューの差し替えだけで通る。
 *
 *  変更点
 *    ① apiRanking で measure を解決する（ds の定義より後に置く）
 *    ② SQL の FROM を ms.view に
 *    ③ notes を ms から生成する
 *    ④ #p-rank の ctl 先頭に #r-measure
 *    ⑤ run() の rank ブロックの URL に &measure=
 *
 *  ①の位置に注意。apiSeasonality では ms を ds より前に挿入してしまい、
 *  未定義の ds を参照して例外になった。同じ失敗を繰り返さない。
 * ===================================================================== */

const fs = require("fs");
const path = require("path");

const FILE = path.join("src", "lab.js");
const BAK = path.join("src", "lab.js.bak5");

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
if (original.includes('id="r-measure"')) fail("既に適用済みです");
if (!original.includes("VIEW_BY_GRAIN_MEASURE")) fail("先に patch_lab_measure.js を適用してください");
if (!original.includes('id="s-measure"')) fail("先に patch_lab_season2.js を適用してください");

const runCount = lines.filter((l) => l.includes("function run(kind)")).length;
if (runCount !== 1) fail("run(kind) が " + runCount + " 個あります（1個のはず）。lab.js が壊れています");

function findLine(pred, what, from = 0, to = lines.length) {
  const hits = [];
  for (let i = from; i < to; i++) if (pred(lines[i])) hits.push(i);
  if (hits.length === 0) fail(what + " が見つかりません");
  if (hits.length > 1) fail(what + " が " + hits.length + " 箇所あります（1箇所のはず）");
  return hits[0];
}

/* --- 位置の特定 ------------------------------------------------------- */

/* ① measure の解決位置。ds の検証が済んだ直後に置く。 */
const apiIdx = findLine((l) => l.includes("async function apiRanking(env, url)"), "apiRanking の定義");
const dsCheckIdx = findLine(
  (l) => l.includes('if (!ds) return bad("データセットが見つかりません");'),
  "apiRanking の ds 検証",
  apiIdx,
  apiIdx + 6
);

/* ② SQL の FROM。apiRanking 内に限定する。 */
const apiEnd = findLine((l) => l.includes("function apiInsight") || l.includes("async function apiInsight"),
  "apiRanking の次の関数", apiIdx, lines.length);
const fromIdxs = [];
for (let i = apiIdx; i < apiEnd; i++) if (lines[i].includes("FROM ${ds.view}")) fromIdxs.push(i);
if (fromIdxs.length !== 1) fail("apiRanking 内の FROM ${ds.view} が " + fromIdxs.length + " 箇所です（1箇所のはず）");

/* ③ notes の1行目 */
const notesIdx = findLine(
  (l) => l.trim() === 'ds.view + " を参照",',
  "apiRanking の notes 1行目",
  apiIdx,
  apiEnd
);

/* ④ マークアップ */
const panelIdx = findLine((l) => l.includes('id="p-rank"'), "#p-rank のパネル");
const ctlIdx = findLine((l) => l.includes('<div class="ctl">'), "ctl の開始", panelIdx, panelIdx + 5);

/* ⑤ URL 構築 */
const runIdx = findLine((l) => l.includes("function run(kind)"), "run(kind) の定義");
const urlIdx = findLine(
  (l) => l.includes('+ "&from=" + $("r-from").value + "&to=" + $("r-to").value;'),
  "rank の URL 末尾",
  runIdx,
  runIdx + 80
);

/* --- 挿入する内容 ----------------------------------------------------- */

const API_HEAD = [
  '  const ms = resolveMeasure(ds, url.searchParams.get("measure"));',
  '  if (!ms) return bad("この粒度では指定された指標を扱えません");',
];

const NOTES = [
  "    `${ms.view} を参照（${ms.why}）`,",
  "    `指標は「${ms.label}」（単位：${ms.unit}）`,",
];

const MARKUP = [
  "    <div><label>指標</label>",
  '      <select id="r-measure">',
  '        <option value="population">人口（人）</option>',
  '        <option value="households">世帯数（世帯）</option>',
  "      </select>",
  "    </div>",
];

/* =====================================================================
 *  適用。行番号がずれないよう、後ろから当てる。
 * ===================================================================== */

lines[urlIdx] = lines[urlIdx].replace(
  '+ "&from=" + $("r-from").value + "&to=" + $("r-to").value;',
  '+ "&from=" + $("r-from").value + "&to=" + $("r-to").value'
);
lines.splice(urlIdx + 1, 0, '        + "&measure=" + $("r-measure").value;');

lines.splice(ctlIdx + 1, 0, ...MARKUP);

lines.splice(notesIdx, 1, ...NOTES);
lines[fromIdxs[0]] = lines[fromIdxs[0]].replace("FROM ${ds.view}", "FROM ${ms.view}");
lines.splice(dsCheckIdx + 1, 0, ...API_HEAD);

/* --- 事後検査 ---------------------------------------------------------- */
const out = lines.join(EOL);
const outLines = out.split(/\r?\n/);
if (outLines.filter((l) => l.includes("function run(kind)")).length !== 1) {
  fail("適用後に run(kind) が増えています");
}
if (outLines.filter((l) => l.includes("r-measure")).length !== 2) {
  fail("r-measure が " + outLines.filter((l) => l.includes("r-measure")).length + " 箇所です（2箇所のはず）");
}

/* ms が ds より後にあることを確かめる。前回はここで失敗した。 */
const a = outLines.findIndex((l) => l.includes("async function apiRanking(env, url)"));
const dsAt = outLines.findIndex((l, i) => i > a && l.includes("const ds = await dataset"));
const msAt = outLines.findIndex((l, i) => i > a && l.includes("const ms = resolveMeasure"));
if (!(dsAt > 0 && msAt > dsAt)) fail("ms の解決が ds の定義より前にあります");

fs.writeFileSync(BAK, original, "utf8");
fs.writeFileSync(FILE, out, "utf8");

console.log("✓ 適用しました");
console.log("  バックアップ : " + BAK);
console.log("");
console.log("  変更箇所");
console.log("    apiRanking で measure 解決（ds の後）");
console.log("    SQL の FROM を ms.view に");
console.log("    notes を ms から生成");
console.log("    マークアップ #r-measure");
console.log("    URL に &measure=");
console.log("");
console.log("  検査");
console.log("    ds → ms の順序 OK");
console.log("    r-measure 2 箇所");
console.log("");
console.log("  次の手順");
console.log("    npx wrangler deploy --dry-run");
console.log("    npx wrangler deploy");
console.log("");
console.log("  戻すとき");
console.log("    Copy-Item src\\lab.js.bak5 src\\lab.js -Force");
