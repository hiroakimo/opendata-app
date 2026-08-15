/**
 * src/llm.js
 *
 * Cloudflare AI Gateway 経由で Anthropic Messages API を叩く薄いラッパ。
 * SDK は入れず fetch のみ。
 *
 * 注意:
 *   claude-sonnet-5 以降は temperature を受け付けない（deprecated）。
 *   サンプリング温度で再現性を作ることはできないので、同じ入力に同じ出力を
 *   返したい場合は呼び出し側で結果を保存する必要がある。
 *
 * 設計原則との対応:
 *   原則1（実行したものを画面に出す）
 *     → logId / cacheStatus / usage を必ず返し、呼び出し側がレスポンスに載せる。
 *   原則2（数値はLLM出力から取らない）
 *     → ここは文字列を返すだけ。数値の検証は insight.js 側で行う。
 */

const ANTHROPIC_VERSION = "2023-06-01";

export const MODELS = {
  fact: "claude-sonnet-5",     // 要件5：事実の記述。指示追従が最優先
  insight: "claude-sonnet-5",  // 要件6：示唆
};

export class LlmError extends Error {
  constructor(message, { status, body, logId } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.body = body;
    this.logId = logId;
  }
}

function gatewayUrl(env) {
  if (!env.AIG_ACCOUNT_ID || !env.AIG_GATEWAY_ID) {
    throw new LlmError("AIG_ACCOUNT_ID / AIG_GATEWAY_ID が未設定です");
  }
  return `https://gateway.ai.cloudflare.com/v1/${env.AIG_ACCOUNT_ID}/${env.AIG_GATEWAY_ID}/anthropic/v1/messages`;
}

/**
 * @returns {{text, usage, stopReason, logId, cacheStatus, model, elapsedMs}}
 */
export async function callClaude(env, opts) {
  const {
    system,
    messages,
    model = MODELS.fact,
    maxTokens = 1024,
    cacheTtl = 3600,
    metadata = {},
    timeoutMs = 20000,
  } = opts;

  if (!env.ANTHROPIC_API_KEY) throw new LlmError("ANTHROPIC_API_KEY が未設定です");
  if (!env.AIG_TOKEN) throw new LlmError("AIG_TOKEN が未設定です");

  const headers = {
    "content-type": "application/json",
    "x-api-key": env.ANTHROPIC_API_KEY,
    "anthropic-version": ANTHROPIC_VERSION,
    "cf-aig-authorization": `Bearer ${env.AIG_TOKEN}`,
    "cf-aig-cache-ttl": String(cacheTtl),
    "cf-aig-request-timeout": String(timeoutMs),
    "cf-aig-max-attempts": "2",
    "cf-aig-metadata": JSON.stringify(metadata),
  };

  /* temperature / top_p は送らない。
     新しいモデルでは deprecated で、指定すると 400 が返る。 */
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;

  const started = Date.now();
  let res;
  try {
    res = await fetch(gatewayUrl(env), { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new LlmError(`AI Gateway に到達できません: ${e.message}`);
  }

  const logId = res.headers.get("cf-aig-log-id");
  const cacheStatus = res.headers.get("cf-aig-cache-status");
  const raw = await res.text();

  if (!res.ok) {
    /* 上流のメッセージをそのまま前に出す。
       握りつぶすと原因の切り分けに毎回ダッシュボードを開く手間がかかる。 */
    throw new LlmError(
      `LLM 呼び出しが失敗しました (HTTP ${res.status}): ${raw.slice(0, 300)}`,
      { status: res.status, body: raw.slice(0, 400), logId }
    );
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new LlmError("LLM 応答を JSON として解釈できません", { body: raw.slice(0, 400), logId });
  }

  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {
    text,
    usage: data.usage || null,
    stopReason: data.stop_reason || null,
    logId,
    cacheStatus,
    model: data.model || model,
    elapsedMs: Date.now() - started,
  };
}

/** JSON だけを返させたいとき。前置きやコードフェンスが混ざっても最初の {...} を拾う。 */
export async function callClaudeJson(env, opts) {
  const r = await callClaude(env, opts);
  const m = r.text.match(/\{[\s\S]*\}/);
  if (!m) throw new LlmError("LLM 応答に JSON が含まれていません", { body: r.text.slice(0, 400), logId: r.logId });
  try {
    return { ...r, json: JSON.parse(m[0]) };
  } catch (e) {
    throw new LlmError(`LLM 応答の JSON を解釈できません: ${e.message}`, {
      body: m[0].slice(0, 400), logId: r.logId,
    });
  }
}
