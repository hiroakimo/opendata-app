/* =====================================================================
 *  patch_lab_measure.js —— lab.js に measure パラメータを追加する
 *
 *  使い方（opendata-app ディレクトリで）
 *      node patch_lab_measure.js
 *
 *  動作
 *    - src/lab.js.bak を作ってから src/lab.js を書き換える
 *    - 編集箇所を1つずつ照合し、見つからなければ何も書かずに停止する
 *    - 既に適用済みなら「適用済み」と表示して終了する（二重適用しない）
 *
 *  変更するのは apiTrend のみ。apiPyramid / apiRanking / apiSeasonality
 *  には触れない。指標軸を1本ずつ通して切り分けができる状態を保つため。
 * ===================================================================== */

const fs = require("fs");
const path = require("path");

const FILE = path.join("src", "lab.js");
const BAK = path.join("src", "lab.js.bak");

if (!fs.existsSync(FILE)) {
  console.error("✗ " + FILE + " が見つかりません。opendata-app ディレクトリで実行してください。");
  process.exit(1);
}

const original = fs.readFileSync(FILE, "utf8");
const EOL = original.includes("\r\n") ? "\r\n" : "\n";
let lines = original.split(/\r?\n/);

/* 二重適用の防止 --------------------------------------------------- */
if (original.includes("VIEW_BY_GRAIN_MEASURE")) {
  console.log("… 既に適用済みです。変更しません。");
  process.exit(0);
}

/* 補助 ------------------------------------------------------------- */
function findLine(pred, what, from = 0, to = lines.length) {
  const hits = [];
  for (let i = from; i < to; i++) if (pred(lines[i])) hits.push(i);
  if (hits.length === 0) fail(what + " が見つかりません");
  if (hits.length > 1) fail(what + " が " + hits.length + " 箇所あります（1箇所のはず）");
  return hits[0];
}
function findAll(pred, from, to) {
  const hits = [];
  for (let i = from; i < to; i++) if (pred(lines[i])) hits.push(i);
  return hits;
}
function fail(msg) {
  console.error("✗ " + msg);
  console.error("  ファイルは変更していません。");
  process.exit(1);
}

/* apiTrend の範囲を確定 --------------------------------------------
   ds.view は apiMeta / apiPyramid / apiRanking でも使われている。
   置換範囲を関数内に限定しないと、他のAPIまで巻き込む。            */
const trendStart = findLine((l) => l.includes("async function apiTrend"), "apiTrend の定義");
const trendEnd = findLine(
  (l) => l.includes("async function apiPyramid"),
  "apiPyramid の定義",
  trendStart
);

/* --- ① 定数表と resolveMeasure を挿入 ------------------------------ */
const grainIdx = findLine((l) => l.includes("const VIEW_BY_GRAIN ="), "VIEW_BY_GRAIN の定義");

const BLOCK = [
  "",
  "/* 指標の許可リスト。1リクエストで扱う measure は必ず1つ。",
  "   単位の違うものを同じ SUM に入れない。 */",
  "const MEASURES = {",
  '  population: { label: "人口",   unit: "人",   hasAge: true,  sumOk: true },',
  '  households: { label: "世帯数", unit: "世帯", hasAge: false, sumOk: true },',
  "};",
  "/* 粒度 × 指標 → ビュー名。ユーザー入力から組み立てず、この表からのみ引く。",
  "   1歳階級に世帯数は存在しない。意図的な空白なのでフォールバックさせない。 */",
  "const VIEW_BY_GRAIN_MEASURE = {",
  '  "5y": { population: "v_population_5y", households: "v_households_5y" },',
  '  "1y": { population: "v_population_1y" },',
  "};",
  "/* v_households_5y は measure='households' でしか絞っていない。",
  "   人口側ビューのような total 除外が入っていないため、明示的に付ける。",
  "   将来 households に内訳が入ったとき、黙って二重計上になるのを防ぐ。 */",
  "const EXTRA_WHERE = { households: \" AND age_class='total' AND sex='total'\" };",
  "/* ds.view は人口用。measure 指定があればここで解決し直す。",
  "   ds そのものは書き換えない（他のAPIが同じ ds を参照しているため）。 */",
  "function resolveMeasure(ds, raw) {",
  "  const key = MEASURES[raw] ? raw : \"population\";",
  "  const view = (VIEW_BY_GRAIN_MEASURE[ds.granularity] || {})[key];",
  "  if (!view) return null;",
  "  return { key, ...MEASURES[key], view, extraWhere: EXTRA_WHERE[key] || \"\" };",
  "}",
];

/* --- ② split の直後で measure を解決 ------------------------------- */
const splitIdx = findLine(
  (l) => l.includes('url.searchParams.get("split")'),
  "split の取得行",
  trendStart,
  trendEnd
);

const RESOLVE = [
  "  const ms = resolveMeasure(ds, url.searchParams.get(\"measure\"));",
  "  if (!ms) return bad(\"この粒度では指定された指標を扱えません\");",
];

/* --- ③ notes の差し替え -------------------------------------------
   現状は "measure='population' のみ" が固定文字列で書かれている。
   世帯数を選ぶとこの記述が嘘になるので、定義から生成する形にする。
   実行したルールを画面に出す原則は、指標を増やしても崩せない。      */
const notesAnchor = findLine(
  (l) => l.includes("measure='population' のみ"),
  "notes の固定文字列",
  trendStart,
  trendEnd
);
let notesStart = notesAnchor;
while (notesStart > trendStart && !lines[notesStart].includes("const notes = [")) notesStart--;
if (!lines[notesStart].includes("const notes = [")) fail("notes の開始行が見つかりません");
let notesEnd = notesAnchor;
while (notesEnd < trendEnd && lines[notesEnd].trim() !== "];") notesEnd++;
if (lines[notesEnd].trim() !== "];") fail("notes の終了行が見つかりません");

const NOTES = [
  "  const notes = [",
  '    ms.view + " を参照（total 行を除外済みのため、SUMしても二重計上にならない）",',
  "    `指標は「${ms.label}」（単位：${ms.unit}）のみ。他の指標は含まない`,",
  '    "2012-08 の系列断絶は人口・世帯数の両系列で確認済み（住基法改正による外国人の算入）",',
  "  ];",
  '  if (ms.hasAge) notes.push("年齢階級・男女を合算した値");',
];

/* --- ④ FROM と WHERE の差し替え（apiTrend 内のみ） ------------------ */
const fromIdxs = findAll((l) => l.includes("FROM ${ds.view}"), trendStart, trendEnd);
if (fromIdxs.length !== 2) fail("apiTrend 内の FROM ${ds.view} が " + fromIdxs.length + " 箇所です（2箇所のはず）");

const whereIdxs = findAll(
  (l) => l.includes("WHERE reference_date BETWEEN ?1 AND ?2`;"),
  trendStart,
  trendEnd
);
if (whereIdxs.length !== 2) fail("apiTrend 内の WHERE 行が " + whereIdxs.length + " 箇所です（2箇所のはず）");

/* --- ⑤ レスポンスに measure と unit を載せる ------------------------
   縦軸ラベルが「人」のままだと、世帯数を描いても人口に見える。      */
const retIdx = findLine(
  (l) => l.includes("return json({ rows: rs.results || [], split,"),
  "apiTrend の return",
  trendStart,
  trendEnd
);

const RETURN = [
  "  return json({",
  "    rows: rs.results || [], split, sql, params, notes,",
  "    measure: ms.key, measure_label: ms.label, unit: ms.unit,",
  "    annotations: gaps.results || [],",
  "  });",
];

/* =====================================================================
 *  適用。行番号がずれないよう、後ろから当てる。
 * ===================================================================== */

lines.splice(retIdx, 1, ...RETURN);

for (const i of whereIdxs.slice().reverse()) {
  lines[i] = lines[i].replace(
    "WHERE reference_date BETWEEN ?1 AND ?2`;",
    "WHERE reference_date BETWEEN ?1 AND ?2` + ms.extraWhere;"
  );
}
for (const i of fromIdxs.slice().reverse()) {
  lines[i] = lines[i].replace("FROM ${ds.view}", "FROM ${ms.view}");
}

lines.splice(notesStart, notesEnd - notesStart + 1, ...NOTES);
lines.splice(splitIdx + 1, 0, ...RESOLVE);
lines.splice(grainIdx + 1, 0, ...BLOCK);

/* 書き出し --------------------------------------------------------- */
fs.writeFileSync(BAK, original, "utf8");
fs.writeFileSync(FILE, lines.join(EOL), "utf8");

console.log("✓ 適用しました");
console.log("  バックアップ : " + BAK);
console.log("  変更箇所     : 定数表の挿入 / measure 解決 / notes / FROM×2 / WHERE×2 / return");
console.log("");
console.log("  次の手順");
console.log("    npx wrangler deploy --dry-run   構文確認");
console.log("    npx wrangler deploy             反映");
console.log("");
console.log("  戻すとき");
console.log("    Copy-Item src\\lab.js.bak src\\lab.js -Force");
