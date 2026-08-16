/* =====================================================================
 *  patch_lab_selector.js —— 推移タブに指標セレクタを追加する
 *
 *  使い方（opendata-app ディレクトリで）
 *      node patch_lab_selector.js
 *
 *  変更点
 *    ① マークアップ  #p-trend の ctl 先頭に #t-measure を置く
 *    ② URL 構築      run("trend") に &measure= を足す
 *    ③ 単位ラベル    drawTrend の縦軸脇に d.unit を描く
 *    ④ 単位ラベル    drawTrendSplit の上部に d.unit を描く
 *                    （指数化のときは単位が意味を持たないので出し分ける）
 *
 *  照合に失敗したら何も書かずに停止する。
 * ===================================================================== */

const fs = require("fs");
const path = require("path");

const FILE = path.join("src", "lab.js");
const BAK = path.join("src", "lab.js.bak2");

if (!fs.existsSync(FILE)) {
  console.error("✗ " + FILE + " が見つかりません。opendata-app ディレクトリで実行してください。");
  process.exit(1);
}

const original = fs.readFileSync(FILE, "utf8");
const EOL = original.includes("\r\n") ? "\r\n" : "\n";
let lines = original.split(/\r?\n/);

if (original.includes('id="t-measure"')) {
  console.log("… 既に適用済みです。変更しません。");
  process.exit(0);
}
if (!original.includes("VIEW_BY_GRAIN_MEASURE")) {
  console.error("✗ 先に patch_lab_measure.js を適用してください。");
  process.exit(1);
}

function fail(msg) {
  console.error("✗ " + msg);
  console.error("  ファイルは変更していません。");
  process.exit(1);
}
function findLine(pred, what, from = 0, to = lines.length) {
  const hits = [];
  for (let i = from; i < to; i++) if (pred(lines[i])) hits.push(i);
  if (hits.length === 0) fail(what + " が見つかりません");
  if (hits.length > 1) fail(what + " が " + hits.length + " 箇所あります（1箇所のはず）");
  return hits[0];
}

/* --- ① マークアップ -------------------------------------------------
   指標を ctl の先頭に置く。他の選択の前提になるものなので、
   制約が左から右へ流れる並びにする。                                 */
const panelIdx = findLine((l) => l.includes('id="p-trend"'), "#p-trend のパネル");
const ctlIdx = findLine((l) => l.includes('<div class="ctl">'), "ctl の開始", panelIdx, panelIdx + 5);

const MARKUP = [
  "    <div><label>指標</label>",
  '      <select id="t-measure">',
  '        <option value="population">人口（人）</option>',
  '        <option value="households">世帯数（世帯）</option>',
  "      </select>",
  "    </div>",
];

/* --- ② URL 構築 ---------------------------------------------------- */
const runIdx = findLine((l) => l.includes("function run(kind)"), "run(kind) の定義");
const splitParamIdx = findLine(
  (l) => l.includes('$("t-view").value === "split" ? "&split=1"'),
  "trend の URL 構築（split 部分）",
  runIdx,
  runIdx + 40
);

/* --- ③ drawTrend の単位ラベル ---------------------------------------
   目盛りは数値だけで単位を出していない。世帯数を選んで「146,694」と
   だけ出ていると人口に見えるので、ここは省けない。                   */
const dtIdx = findLine((l) => l.includes("function drawTrend(d, box)"), "drawTrend の定義");
const dtGridIdx = findLine(
  (l) => l.includes("var vy = mt + ph * g / 4"),
  "drawTrend の目盛りループ",
  dtIdx,
  dtIdx + 30
);
let dtLoopEnd = dtGridIdx;
while (dtLoopEnd < dtIdx + 40 && !lines[dtLoopEnd].trim().startsWith("}")) dtLoopEnd++;
if (!lines[dtLoopEnd].trim().startsWith("}")) fail("drawTrend の目盛りループの終端が見つかりません");

const DT_UNIT = [
  "  /* 単位を明示する。数値だけだと世帯数と人口が見分けられない。 */",
  '  s.appendChild(el("text", {x: ml - 8, y: mt - 6, "text-anchor": "end",',
  '                            "font-size": 11, fill: "#6b6b6b"},',
  '                  "（" + (d.unit || "人") + "）"));',
];

/* --- ④ drawTrendSplit の単位ラベル ----------------------------------
   パネルが並ぶ形なので、各パネルではなく上部に1回だけ出す。
   指数化を選んだときは元の単位が意味を持たないので出し分ける。       */
const dtsIdx = findLine((l) => l.includes("function drawTrendSplit(d, box)"), "drawTrendSplit の定義");
const scaleIdx = findLine(
  (l) => l.includes('var scale = $("t-scale").value;'),
  "drawTrendSplit の scale 取得",
  dtsIdx,
  dtsIdx + 12
);

const DTS_UNIT = [
  "  /* 指数化すると元の単位は意味を失う。何を見ているかを上部に出す。 */",
  '  var unitNote = scale === "index"',
  '    ? "指数（起点=100）／元の指標：" + (d.measure_label || "人口")',
  '    : (d.measure_label || "人口") + "（単位：" + (d.unit || "人") + "）";',
  '  var uh = document.createElement("p");',
  '  uh.className = "unit-note";',
  '  uh.style.cssText = "margin:0 0 8px;font-size:12px;color:#6b6b6b";',
  "  uh.textContent = unitNote;",
  "  box.appendChild(uh);",
];

/* =====================================================================
 *  適用。行番号がずれないよう、後ろから当てる。
 * ===================================================================== */

lines.splice(scaleIdx + 1, 0, ...DTS_UNIT);
lines.splice(dtLoopEnd + 1, 0, ...DT_UNIT);
lines[splitParamIdx] = lines[splitParamIdx].replace(
  '($("t-view").value === "split" ? "&split=1" : "")',
  '($("t-view").value === "split" ? "&split=1" : "")\n        + "&measure=" + $("t-measure").value'
);
lines.splice(ctlIdx + 1, 0, ...MARKUP);

fs.writeFileSync(BAK, original, "utf8");
fs.writeFileSync(FILE, lines.join(EOL), "utf8");

console.log("✓ 適用しました");
console.log("  バックアップ : " + BAK);
console.log("  変更箇所     : マークアップ / URL構築 / drawTrend の単位 / drawTrendSplit の単位");
console.log("");
console.log("  次の手順");
console.log("    npx wrangler deploy --dry-run");
console.log("    npx wrangler deploy");
console.log("");
console.log("  戻すとき");
console.log("    Copy-Item src\\lab.js.bak2 src\\lab.js -Force");
