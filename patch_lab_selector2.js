/* =====================================================================
 *  patch_lab_selector2.js —— 推移タブに指標セレクタを追加する（修正版）
 *
 *  使い方（opendata-app ディレクトリで）
 *      node patch_lab_selector2.js
 *
 *  前回版からの変更
 *    - 単位ラベルの挿入をやめた。drawTrend / drawTrendSplit への挿入は
 *      位置判断を伴い、そこが破損源になった。単位は notes に出ている。
 *    - 改行を含む文字列置換をやめた。置換文字列内の \n が展開されず、
 *      + "&measure=" が独立した文になってパラメータが飛ばなかった。
 *      1行を2行に「分割」する操作として書く。
 *
 *  変更点は2つだけ。どちらも位置判断が要らない。
 *    ① #p-trend の ctl 先頭に #t-measure を置く
 *    ② run("trend") の URL 末尾に &measure= を足す（セミコロンを移す）
 * ===================================================================== */

const fs = require("fs");
const path = require("path");

const FILE = path.join("src", "lab.js");
const BAK = path.join("src", "lab.js.bak3");

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

/* --- 事前検査 -------------------------------------------------------
   壊れた状態に当てると被害が広がる。健全であることを先に確かめる。 */
if (original.includes('id="t-measure"')) fail("既に適用済みです");
if (!original.includes("VIEW_BY_GRAIN_MEASURE")) fail("先に patch_lab_measure.js を適用してください");

const runCount = lines.filter((l) => l.includes("function run(kind)")).length;
if (runCount !== 1) fail("run(kind) が " + runCount + " 個あります（1個のはず）。lab.js が壊れています");

const svgCount = lines.filter((l) => l.includes("var s = svgRoot")).length;
if (svgCount !== 3) fail("var s = svgRoot が " + svgCount + " 個あります（3個のはず）。lab.js が壊れています");

function findLine(pred, what, from = 0, to = lines.length) {
  const hits = [];
  for (let i = from; i < to; i++) if (pred(lines[i])) hits.push(i);
  if (hits.length === 0) fail(what + " が見つかりません");
  if (hits.length > 1) fail(what + " が " + hits.length + " 箇所あります（1箇所のはず）");
  return hits[0];
}

/* --- ① マークアップ -------------------------------------------------
   指標は他の選択の前提になるので ctl の先頭に置く。制約が左から右へ
   流れる並びにしておくと、後で年齢粒度セレクタを足したときに
   「世帯数を選ぶと粒度が無効」という関係が読み取りやすい。          */
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

/* --- ② URL 構築 -----------------------------------------------------
   元の行はセミコロンで終わっている。そのセミコロンを外して次の行へ
   移さないと、&measure= が url に連結されず捨てられる。             */
const runIdx = findLine((l) => l.includes("function run(kind)"), "run(kind) の定義");
const urlIdx = findLine(
  (l) => l.includes('$("t-view").value === "split" ? "&split=1" : ""'),
  "trend の URL 末尾",
  runIdx,
  runIdx + 40
);

const tail = lines[urlIdx];
if (!tail.trimEnd().endsWith(";")) fail("trend の URL 末尾がセミコロンで終わっていません");

const SPLIT_LINES = [
  tail.replace(/;\s*$/, ""),
  '        + "&measure=" + $("t-measure").value;',
];

/* =====================================================================
 *  適用。行番号がずれないよう、後ろから当てる。
 * ===================================================================== */

lines.splice(urlIdx, 1, ...SPLIT_LINES);
lines.splice(ctlIdx + 1, 0, ...MARKUP);

/* --- 事後検査 ------------------------------------------------------- */
const after = lines.join(EOL);
const mCount = lines.filter((l) => l.includes("t-measure")).length;
if (mCount !== 2) fail("適用後の t-measure が " + mCount + " 個です（2個のはず）");
if (lines.filter((l) => l.includes("function run(kind)")).length !== 1) {
  fail("適用後に run(kind) が増えています");
}

fs.writeFileSync(BAK, original, "utf8");
fs.writeFileSync(FILE, after, "utf8");

console.log("✓ 適用しました");
console.log("  バックアップ : " + BAK);
console.log("  変更箇所     : マークアップ（6行挿入） / URL構築（1行を2行に分割）");
console.log("");
console.log("  検査結果");
console.log("    t-measure       2 箇所");
console.log("    run(kind)       1 個");
console.log("    var s = svgRoot 3 個");
console.log("");
console.log("  次の手順");
console.log("    npx wrangler deploy --dry-run");
console.log("    npx wrangler deploy");
console.log("");
console.log("  戻すとき");
console.log("    Copy-Item src\\lab.js.bak3 src\\lab.js -Force");
