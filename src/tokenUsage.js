/**
 * Нормализация полей usage из разных API в { input, output, total }.
 * @typedef {{ input: number | null, output: number | null, total: number | null }} TokenUsage
 */

/**
 * OpenAI Chat Completions и совместимые (DeepSeek, часть прокси): usage в корне ответа.
 * @param {unknown} completion — объект ответа SDK или JSON
 * @returns {TokenUsage | null}
 */
export function usageFromChatCompletionObject(completion) {
  const u = completion?.usage;
  return usageFromOpenAiStyleUsage(u);
}

/**
 * Сырой объект usage (из JSON).
 * @param {unknown} u
 * @returns {TokenUsage | null}
 */
export function usageFromOpenAiStyleUsage(u) {
  if (!u || typeof u !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (u);
  const input = num(
    o.prompt_tokens,
    o.promptTokens,
    o.input_tokens,
    o.inputTokens,
    nestedNum(o.prompt_tokens_details, "total_tokens"),
    nestedNum(o.promptTokensDetails, "total_tokens")
  );
  const output = num(
    o.completion_tokens,
    o.completionTokens,
    o.output_tokens,
    o.outputTokens,
    nestedNum(o.completion_tokens_details, "total_tokens"),
    nestedNum(o.completionTokensDetails, "total_tokens")
  );
  let total = num(o.total_tokens, o.totalTokens);
  if (total == null && input != null && output != null) total = input + output;
  if (input == null && output == null && total == null) return null;
  return { input, output, total };
}

/**
 * Ищет usage в типичных местах тела ответа Chat Completions (прокси, обёртки).
 * @param {unknown} data
 * @returns {TokenUsage | null}
 */
export function usageHarvestChatCompletions(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  const candidates = [
    d.usage,
    nestedUsage(d.response),
    nestedUsage(d.body),
    nestedUsage(d.data),
    nestedUsage(d.result),
    Array.isArray(d.choices) && d.choices[0] && typeof d.choices[0] === "object"
      ? /** @type {Record<string, unknown>} */ (d.choices[0]).usage
      : null,
  ];
  for (const u of candidates) {
    const parsed = usageFromOpenAiStyleUsage(u);
    if (isNonEmptyUsage(parsed)) return parsed;
  }
  return null;
}

function nestedUsage(v) {
  if (!v || typeof v !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (v);
  return o.usage ?? null;
}

function nestedNum(obj, key) {
  if (!obj || typeof obj !== "object") return null;
  return /** @type {Record<string, unknown>} */ (obj)[key];
}

function isNonEmptyUsage(u) {
  return (
    u != null &&
    (u.input != null || u.output != null || u.total != null)
  );
}

/**
 * OpenAI Responses API и похожие обёртки (Yandex): usage в корне или внутри response.
 * @param {unknown} data
 * @returns {TokenUsage | null}
 */
export function usageHarvestResponses(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  const inner =
    d.response && typeof d.response === "object"
      ? /** @type {Record<string, unknown>} */ (d.response)
      : null;
  const candidates = [
    usageFromResponsesApi(d),
    inner ? usageFromResponsesApi(inner) : null,
    usageFromOpenAiStyleUsage(d.usage),
    usageFromOpenAiStyleUsage(d.usage_metadata),
    usageHarvestChatCompletions(d),
  ];
  for (const u of candidates) {
    if (isNonEmptyUsage(u)) return u;
  }
  return null;
}

/**
 * Gemini generateContent: usageMetadata в корне (иногда дублируется).
 * @param {unknown} data — распарсенный JSON ответа
 * @returns {TokenUsage | null}
 */
export function usageHarvestGemini(data) {
  if (!data || typeof data !== "object") return null;
  const roots = [
    data,
    /** @type {Record<string, unknown>} */ (data).data,
    /** @type {Record<string, unknown>} */ (data).response,
    /** @type {Record<string, unknown>} */ (data).result,
  ];
  for (const root of roots) {
    const u = usageFromGeminiResponse(root);
    if (isNonEmptyUsage(u)) return u;
  }
  return null;
}

export function usageFromGeminiResponse(data) {
  if (!data || typeof data !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  let um = d.usageMetadata;
  if (!um && Array.isArray(d.candidates) && d.candidates[0]) {
    const c0 = /** @type {Record<string, unknown>} */ (d.candidates[0]);
    um = c0.usageMetadata;
  }
  if (!um || typeof um !== "object") return null;
  const m = /** @type {Record<string, unknown>} */ (um);
  const input = num(m.promptTokenCount, m.prompt_token_count);
  const cand = num(m.candidatesTokenCount, m.candidates_token_count);
  const thoughts = num(m.thoughtsTokenCount, m.thoughts_token_count);
  let output = num(m.outputTokenCount, m.output_token_count);
  if (cand != null || thoughts != null) {
    output = (cand ?? 0) + (thoughts ?? 0);
  }
  let total = num(m.totalTokenCount, m.total_token_count);
  if (total == null && input != null && output != null) total = input + output;
  if (input == null && output == null && total == null) return null;
  return { input, output, total };
}

/**
 * OpenAI Responses API (в т.ч. Yandex OpenAI-compatible): response.usage
 * @param {unknown} response — объект ответа SDK
 * @returns {TokenUsage | null}
 */
export function usageFromResponsesApi(response) {
  const u = response?.usage;
  if (!u || typeof u !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (u);
  const input = num(o.input_tokens, o.inputTokens, o.prompt_tokens, o.promptTokens);
  const output = num(o.output_tokens, o.outputTokens, o.completion_tokens, o.completionTokens);
  let total = num(o.total_tokens, o.totalTokens);
  if (total == null && input != null && output != null) total = input + output;
  if (input == null && output == null && total == null) return null;
  return { input, output, total };
}

/**
 * Текст из сырого JSON OpenAI Responses API (в Wire нет поля output_text — только output[]).
 * @param {unknown} data
 * @returns {string}
 */
export function extractResponsesOutputText(data) {
  if (!data || typeof data !== "object") return "";
  const d = /** @type {Record<string, unknown>} */ (data);
  if (typeof d.output_text === "string" && d.output_text.length > 0) return d.output_text;
  const out = d.output;
  if (!Array.isArray(out)) return "";
  const parts = [];
  for (const item of out) {
    if (!item || typeof item !== "object") continue;
    const it = /** @type {Record<string, unknown>} */ (item);
    if (it.type !== "message" || !Array.isArray(it.content)) continue;
    for (const c of it.content) {
      if (!c || typeof c !== "object") continue;
      const ct = /** @type {Record<string, unknown>} */ (c);
      if (ct.type === "output_text" && typeof ct.text === "string") parts.push(ct.text);
    }
  }
  return parts.join("");
}

function num(...vals) {
  for (const v of vals) {
    const n = coerceCount(v);
    if (n !== null) return n;
  }
  return null;
}

/** API иногда отдаёт счётчики строками ("42"). */
function coerceCount(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "") {
    const x = Number(v.trim());
    if (Number.isFinite(x)) return Math.trunc(x);
  }
  return null;
}
