/**
 * src/insight.js
 *
 * 要件5（事実の要約）と要件6（示唆）のための純粋関数群。
 * D1にもLLMにも触らない。analysis.js から呼ばれる。
 *
 *  ── 設計の核 ──
 *
 *  1. LLMには結果セットを渡さない。SQL側で確定した事実の構造体を渡す。
 *     順位づけ・最大値・件数の計算はすべてここ（JS）で決定論的に済ませる。
 *     LLMがやるのは「構造体を日本語の文にする」ことだけ。
 *
 *  2. 要件5と要件6は別々の呼び出しにする。
 *     ひとつのプロンプトで両方書かせると、事実の記述に解釈が混入する。
 *     要件5の出力を要件6の入力にすることで、依存の向きも一方通行になる。
 *
 *  3. 出力に含まれる数値を機械的に検証する。
 *     渡していない数値が現れたら画面に出さない。
 *     「数値はLLM出力から取らない」を実装として担保する。
 */

/* =====================================================================
 *  事実の構造体を組み立てる
 * ===================================================================== */

const nf = (v) => (v === null || v === undefined ? null : Number(v));

/** 再現性の判定。n_above が両端に寄っているほど「毎年同じ向き」。 */
function consistencyOf(above, years) {
  if (!years) return null;
  const r = above / years;
  if (r >= 0.9) return "毎年上回る";
  if (r <= 0.1) return "毎年下回る";
  if (r >= 0.75) return "多くの年で上回る";
  if (r <= 0.25) return "多くの年で下回る";
  return "年によって異なる";
}

export function buildFacts(mode, rows, ctx) {
  const base = {
    対象: ctx.scopeLabel,
    集計期間: ctx.coverage,
    指標の定義:
      "季節指数。2×12移動平均でトレンドを除去した比率の暦月平均。0%が年間の平均的な水準",
  };

  if (mode === "strength") {
    const rs = rows.map((r) => ({
      町丁: r.area_name,
      振幅pct: nf(r.amplitude_pct),
      最高月: Number(r.peak_month),
      最低月: Number(r.trough_month),
    }));
    const top = rs[0] || null;
    const second = rs[1] || null;
    return {
      ...base,
      種別: "町丁ごとの季節変動の強さ",
      一覧: rs,
      導出値: {
        最大の町丁: top ? top.町丁 : null,
        最大の振幅pct: top ? top.振幅pct : null,
        "2位の町丁": second ? second.町丁 : null,
        "2位の振幅pct": second ? second.振幅pct : null,
        表示件数: rs.length,
      },
    };
  }

  if (mode === "profile") {
    const rs = rows.map((r) => ({
      月: Number(r.month),
      トレンド比pct: nf(r.pct_vs_trend),
      上回った年数: r.n_above,
      対象年数: r.n_years,
      再現性: consistencyOf(r.n_above, r.n_years),
    }));
    const sorted = rs.slice().sort((a, b) => b.トレンド比pct - a.トレンド比pct);
    const hi = sorted[0], lo = sorted[sorted.length - 1];
    const firm = rs.filter((r) => r.上回った年数 === 0 || r.上回った年数 === r.対象年数);
    return {
      ...base,
      種別: "1町丁の12ヶ月プロファイル",
      一覧: rs,
      導出値: {
        最高月: hi ? hi.月 : null,
        最高月pct: hi ? hi.トレンド比pct : null,
        最低月: lo ? lo.月 : null,
        最低月pct: lo ? lo.トレンド比pct : null,
        振幅pct: hi && lo ? Number((hi.トレンド比pct - lo.トレンド比pct).toFixed(2)) : null,
        例外なく同じ向きの月: firm.map((r) => r.月),
      },
    };
  }

  /* age */
  const rs = rows.map((r) => ({
    年齢階級: r.age_class,
    トレンド比pct: nf(r.pct_vs_trend),
    上回った年数: r.n_above,
    対象年数: r.n_years,
    再現性: consistencyOf(r.n_above, r.n_years),
  }));
  const sorted = rs.slice().sort((a, b) => a.トレンド比pct - b.トレンド比pct);
  const worst = sorted[0];
  const big = rs.filter((r) => Math.abs(r.トレンド比pct) >= 5);
  const flat = rs.filter((r) => Math.abs(r.トレンド比pct) < 1);
  const firm = rs.filter((r) => r.上回った年数 === 0 || r.上回った年数 === r.対象年数);
  return {
    ...base,
    種別: "1町丁・1暦月の年齢階級別内訳",
    対象月: Number(ctx.month),
    一覧: rs,
    導出値: {
      最も減少した階級: worst ? worst.年齢階級 : null,
      最も減少した階級pct: worst ? worst.トレンド比pct : null,
      "変動5pct以上の階級": big.map((r) => r.年齢階級),
      "変動1pct未満の階級数": flat.length,
      全階級数: rs.length,
      例外なく同じ向きの階級: firm.map((r) => r.年齢階級),
    },
  };
}

/* =====================================================================
 *  プロンプト
 * ===================================================================== */

export const SYS_FACT = `あなたは統計データを日本語で記述する担当です。

与えられたJSONの数値だけを使い、事実の記述を書いてください。

絶対に守ること:
- 数値は与えられた値をそのまま書く。四捨五入や丸めをしない。新しい数値を計算しない。
- 原因・理由・背景・推測を一切書かない。「〜と考えられる」「〜のためだろう」「〜が影響している」は禁止。
- JSONに無い固有名詞（施設名・大学名・企業名・地名）を出さない。
- caveats のうち、この記述の読み方に関係するものには触れる。
- 見出しや箇条書きを使わず、平文で3〜5文。
- 「季節指数」「トレンド比」などの語は説明抜きで使わず、初出時に一言添える。

出力は記述の本文のみ。前置きや後書きを付けない。`;

export const SYS_INSIGHT = `あなたはデータ分析の解釈を提示する担当です。

事実の記述と、その根拠となった数値を受け取ります。そこから読み取れる解釈を書いてください。

守ること:
- 解釈は2〜4文。断定を避け、可能性として述べる。
- 新しい数値を作らない。数値に触れる場合は与えられた値をそのまま使う。
- データの外にある知識（施設の所在、制度、暦など）を使ってよい。
  ただし使った場合は必ず文中に「（データ外の情報）」と明記する。
- このデータでは検証できないことを必ず1つ以上挙げる。これは省略できない。
- 反証の可能性に触れる。この解釈が誤りだとしたら何が観測されるはずかを書く。

次のJSON形式だけを出力してください。前置きやコードフェンスを付けないこと。
{"interpretation":"解釈の本文","limits":"本データで検証できないこと","falsification":"この解釈が誤りなら観測されるはずのこと"}`;

export function userFact(facts, caveats) {
  return (
    "次のデータについて事実の記述を書いてください。\n\n" +
    "## データ\n" +
    JSON.stringify(facts, null, 1) +
    "\n\n## caveats（データの制約）\n" +
    caveats.map((c) => "- " + c).join("\n")
  );
}

export function userInsight(factText, facts, caveats) {
  return (
    "## 事実の記述\n" + factText +
    "\n\n## 根拠となった数値\n" + JSON.stringify(facts, null, 1) +
    "\n\n## データの制約\n" + caveats.map((c) => "- " + c).join("\n")
  );
}

/* =====================================================================
 *  数値の検証
 *
 *  渡していない数値が出力に現れたら不合格にする。
 *  丸めは禁止しているが、整数への丸めだけは許容する
 *  （「約31%」のような自然な書き方を全部弾くと文章にならないため）。
 * ===================================================================== */

function collectNumbers(obj, out) {
  if (obj === null || obj === undefined) return out;
  if (typeof obj === "number") { out.push(obj); return out; }
  if (typeof obj === "string") {
    const m = obj.match(/-?\d+(?:\.\d+)?/g);
    if (m) m.forEach((s) => out.push(Number(s)));
    return out;
  }
  if (Array.isArray(obj)) { obj.forEach((v) => collectNumbers(v, out)); return out; }
  if (typeof obj === "object") {
    Object.keys(obj).forEach((k) => { collectNumbers(k, out); collectNumbers(obj[k], out); });
    return out;
  }
  return out;
}

export function verifyNumbers(text, facts, caveats) {
  const allowed = collectNumbers(facts, []);
  collectNumbers(caveats, allowed);
  /* 1〜12 は月、0〜24 は年数・件数として頻出する。
     いずれも facts に入っているはずだが、文脈で言い換えられることがあるので許容する。 */
  for (let i = 0; i <= 24; i++) allowed.push(i);

  const found = (text.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const bad = found.filter((n) =>
    !allowed.some((f) =>
      Math.abs(n - f) < 0.005 ||
      n === Math.round(f) ||
      Math.abs(n - Number(f.toFixed(1))) < 0.005
    )
  );
  return { ok: bad.length === 0, bad: [...new Set(bad)] };
}
