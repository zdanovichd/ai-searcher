import { extractLinks } from "./extractLinks.js";
import { explainNetworkError } from "./networkError.js";
import { logEvent } from "./logger.js";
import { fetchForProvider, getOutboundProxyUrl } from "./proxyFetch.js";
import {
  extractResponsesOutputText,
  usageHarvestChatCompletions,
  usageHarvestGemini,
  usageHarvestResponses,
} from "./tokenUsage.js";

export const PROVIDER_IDS = [
  "chatgpt",
  "deepseek",
  "perplexity",
  "google",
  "alice",
  "alice_search",
];

export const PROVIDER_LABELS = {
  chatgpt: "ChatGPT",
  deepseek: "DeepSeek",
  perplexity: "Perplexity",
  google: "Google AI (Gemini)",
  alice: "Алиса AI (Yandex Cloud LLM)",
  alice_search: "Алиса в Поиске (Yandex Search API)",
};

const TIMEOUT_MS = 120_000;

/**
 * @param {unknown} err
 * @param {number} status
 */
function attachHttpStatus(err, status) {
  if (err instanceof Error && Number.isFinite(status)) {
    Object.assign(err, { httpStatus: status });
  }
}

export function getConfiguredProviders() {
  return {
    chatgpt: Boolean(process.env.OPENAI_API_KEY?.trim()),
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
    perplexity: Boolean(process.env.PERPLEXITY_API_KEY?.trim()),
    google: Boolean(process.env.GOOGLE_AI_API_KEY?.trim()),
    alice: Boolean(
      process.env.YANDEX_CLOUD_API_KEY?.trim() && process.env.YANDEX_CLOUD_FOLDER_ID?.trim()
    ),
    alice_search: Boolean(
      (process.env.YANDEX_GEN_SEARCH_API_KEY?.trim() || process.env.YANDEX_CLOUD_API_KEY?.trim()) &&
        (process.env.YANDEX_GEN_SEARCH_FOLDER_ID?.trim() || process.env.YANDEX_CLOUD_FOLDER_ID?.trim())
    ),
  };
}

/**
 * @typedef {{ input: number | null, output: number | null, total: number | null }} TokenUsage
 */

/**
 * @typedef {{ requestId?: string }} ProviderLogMeta
 */

/**
 * @param {string} id
 * @param {string} query
 * @param {ProviderLogMeta} [logMeta]
 * @returns {Promise<{ id: string, label: string, text: string, links: string[], usage?: TokenUsage | null, error?: string, durationMs: number }>}
 */
export async function runProvider(id, query, logMeta = {}) {
  const label = PROVIDER_LABELS[id] ?? id;
  const t0 = Date.now();
  logEvent("info", "provider:start", {
    providerId: id,
    label,
    queryChars: typeof query === "string" ? query.length : 0,
    outboundProxy: Boolean(getOutboundProxyUrl(id)),
    ...logMeta,
  });
  try {
    /** @type {string} */
    let text = "";
    /** @type {TokenUsage | null} */
    let usage = null;
    /** @type {number | null} */
    let httpStatus = null;
    switch (id) {
      case "chatgpt": {
        const out = await chatCompletionsViaFetch({
          providerId: "chatgpt",
          apiKey: process.env.OPENAI_API_KEY,
          baseURL: process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          query,
        });
        text = out.text;
        usage = out.usage;
        httpStatus = out.httpStatus ?? null;
        break;
      }
      case "deepseek": {
        const out = await chatCompletionsViaFetch({
          providerId: "deepseek",
          apiKey: process.env.DEEPSEEK_API_KEY,
          baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
          model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
          query,
        });
        text = out.text;
        usage = out.usage;
        httpStatus = out.httpStatus ?? null;
        break;
      }
      case "perplexity": {
        const out = await perplexitySonar(query);
        text = out.text;
        usage = out.usage;
        httpStatus = out.httpStatus ?? null;
        break;
      }
      case "google": {
        const out = await geminiChat(query, logMeta);
        text = out.text;
        usage = out.usage;
        httpStatus = out.httpStatus ?? null;
        break;
      }
      case "alice": {
        const out = await yandexAlice(query);
        text = out.text;
        usage = out.usage;
        httpStatus = out.httpStatus ?? null;
        break;
      }
      case "alice_search": {
        const out = await yandexGenSearch(query);
        text = out.text;
        usage = out.usage;
        httpStatus = out.httpStatus ?? null;
        break;
      }
      default:
        throw new Error(`Неизвестный провайдер: ${id}`);
    }
    const durationMs = Date.now() - t0;
    const links = extractLinks(text);
    logEvent("info", "provider:ok", {
      providerId: id,
      label,
      durationMs,
      httpStatus,
      responseChars: text.trim().length,
      linksCount: links.length,
      usageInput: usage?.input ?? null,
      usageOutput: usage?.output ?? null,
      usageTotal: usage?.total ?? null,
      ...logMeta,
    });
    return { id, label, text: text.trim(), links, usage, durationMs };
  } catch (e) {
    const durationMs = Date.now() - t0;
    const httpStatus =
      e && typeof e === "object" && "httpStatus" in e && Number.isFinite(/** @type {any} */ (e).httpStatus)
        ? /** @type {any} */ (e).httpStatus
        : null;
    let msg = explainNetworkError(e);
    if (id === "deepseek" && /402|Insufficient Balance|insufficient balance/i.test(msg)) {
      msg =
        "402: на счёте DeepSeek нет средств. Пополните баланс в личном кабинете platform.deepseek.com.";
    } else {
      msg = enrichGeoAndAuthHints(id, msg);
    }
    logEvent("warn", "provider:fail", {
      providerId: id,
      label,
      durationMs,
      httpStatus,
      errorMessage: msg.slice(0, 2000),
      errorName: e instanceof Error ? e.name : typeof e,
      stack: e instanceof Error ? e.stack : undefined,
      ...logMeta,
    });
    return { id, label, text: "", links: [], usage: null, error: msg, durationMs };
  }
}

/**
 * Пояснения к типичным 403 (гео, IAM) без раскрытия внутренностей API.
 */
function enrichGeoAndAuthHints(id, msg) {
  const m = String(msg);
  if (id === "chatgpt" && /403|401|country|region|territory|unsupported/i.test(m)) {
    return `${m} — У OpenAI действуют ограничения по стране/региону для запроса (часто по IP сервера). VPS в РФ или в «заблокированной» зоне даёт такую ошибку. Варианты: хостинг в поддерживаемой стране, исходящий прокси/VPN на стороне сервера, или вызов API не с этого IP.`;
  }
  if (id === "google" && /403|401|location|not supported|User location|unsupported/i.test(m)) {
    return `${m} — Google Gemini для AI Studio часто отклоняет запросы с IP из недоступных регионов (в т.ч. РФ). Запрос идёт с IP вашего сервера. Варианты: сервер/прокси в поддерживаемом регионе, Vertex AI в GCP вместо AI Studio, или другой способ вызова API.`;
  }
  if (id === "alice" && /403|Forbidden|401|permission|access/i.test(m)) {
    return `${m} — Для Yandex Cloud: проверьте, что ключ не отозван и тип подходит (API-ключ сервисного аккаунта); у аккаунта есть роль вроде ai.languageModels.user; YANDEX_CLOUD_FOLDER_ID — id именно того каталога, где включён доступ к модели Alice; модель доступна в каталоге. Запрос с зарубежного VPS иногда даёт отказ — при необходимости вызывайте API с IP/из окружения, разрешённого политикой облака.`;
  }
  if (id === "alice_search" && /403|Forbidden|401|permission|access|api key|IAM/i.test(m)) {
    return `${m} — Для Yandex Search API (генеративный поиск): нужен API-ключ или IAM-токен, каталог с подключённым Search API и права вроде search-api.editor / search-api.viewer на каталог. Переменные YANDEX_GEN_SEARCH_* или те же YANDEX_CLOUD_API_KEY и YANDEX_CLOUD_FOLDER_ID. URL по умолчанию: searchapi.api.cloud.yandex.net/v2/gen/search.`;
  }
  return m;
}

/**
 * Perplexity Sonar API: официальный путь `POST /v1/sonar` с полем `usage`.
 * Вызов через OpenAI SDK на `/v1/chat/completions` часто приходит без нормальной разбивки токенов.
 *
 * @returns {Promise<{ text: string, usage: TokenUsage | null, httpStatus: number }>}
 */
async function perplexitySonar(query) {
  const apiKey = process.env.PERPLEXITY_API_KEY?.trim();
  if (!apiKey) throw new Error("Не задан PERPLEXITY_API_KEY");

  const model = process.env.PERPLEXITY_MODEL?.trim() || "sonar";
  const url =
    process.env.PERPLEXITY_API_URL?.trim() || "https://api.perplexity.ai/v1/sonar";

  const res = await fetchForProvider("perplexity", url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: query }],
      temperature: 0.35,
      max_tokens: 2048,
      stream: false,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(perplexityErrorMessage(data) || res.statusText || "Perplexity API error");
    attachHttpStatus(err, res.status);
    throw err;
  }

  const text = data.choices?.[0]?.message?.content ?? "";
  const usage = usageHarvestChatCompletions(data);

  return { text, usage, httpStatus: res.status };
}

function perplexityErrorMessage(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.detail === "string") return data.detail;
  if (Array.isArray(data.detail)) {
    return data.detail
      .map((d) => (d && typeof d.msg === "string" ? d.msg : JSON.stringify(d)))
      .join("; ");
  }
  if (data.error && typeof data.error.message === "string") return data.error.message;
  if (typeof data.message === "string") return data.message;
  return "";
}

function openAiCompatibleErrorMessage(data) {
  if (!data || typeof data !== "object") return "";
  const e = /** @type {Record<string, unknown>} */ (data).error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof /** @type {any} */ (e).message === "string") {
    return /** @type {any} */ (e).message;
  }
  return "";
}

/**
 * Сырой POST /chat/completions — в JSON всегда есть `usage` (при успехе), без обходных путей SDK.
 *
 * @param {{ providerId: string, apiKey: string | undefined, baseURL: string, model: string, query: string }} opts
 * @returns {Promise<{ text: string, usage: TokenUsage | null, httpStatus: number }>}
 */
async function chatCompletionsViaFetch({ providerId, apiKey, baseURL, model, query }) {
  if (!apiKey) throw new Error("Не задан API-ключ");
  const root = (baseURL || "").replace(/\/$/, "");
  const url = `${root}/chat/completions`;

  const res = await fetchForProvider(providerId, url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: query }],
      temperature: 0.35,
      max_tokens: 2048,
      stream: false,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      openAiCompatibleErrorMessage(data) || res.statusText || "Chat Completions API error"
    );
    attachHttpStatus(err, res.status);
    throw err;
  }

  const text = data.choices?.[0]?.message?.content ?? "";
  const usage = usageHarvestChatCompletions(data);
  return { text, usage, httpStatus: res.status };
}

/**
 * Порядок, если GOOGLE_GEMINI_MODEL не задан или модель недоступна.
 * Без gemini-2.0-flash*: для новых ключей Google часто отдаёт «no longer available to new users».
 */
const GEMINI_MODEL_FALLBACKS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-flash-latest",
  "gemini-2.5-pro",
];

/**
 * @param {string} query
 * @param {ProviderLogMeta} [logMeta]
 * @returns {Promise<{ text: string, usage: TokenUsage | null, httpStatus: number }>}
 */
async function geminiChat(query, logMeta = {}) {
  const apiKey = process.env.GOOGLE_AI_API_KEY?.trim();
  if (!apiKey) throw new Error("Не задан GOOGLE_AI_API_KEY");

  const requested = process.env.GOOGLE_GEMINI_MODEL?.trim();
  const candidates = [...new Set([...(requested ? [requested] : []), ...GEMINI_MODEL_FALLBACKS])];

  let lastMessage = "";
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    try {
      return await geminiGenerateOnce(apiKey, model, query);
    } catch (e) {
      lastMessage = e?.message || String(e);
      const httpStatus =
        e && typeof e === "object" && "httpStatus" in e && Number.isFinite(/** @type {any} */ (e).httpStatus)
          ? /** @type {any} */ (e).httpStatus
          : null;
      const tryNextModel =
        /not found|is not found|not supported for generateContent|404/i.test(lastMessage) ||
        /no longer available|not available to new users|deprecated|discontinued|PERMISSION_DENIED/i.test(
          lastMessage
        ) ||
        /high demand|overloaded|rate limit|too many requests|resource.?exhausted|temporarily unavailable|try again later|capacity|quota|unavailable|503|429/i.test(
          lastMessage
        );
      logEvent("warn", "provider:gemini:attempt_fail", {
        model,
        willRetry: tryNextModel && i < candidates.length - 1,
        nextModel: tryNextModel ? candidates[i + 1] ?? null : null,
        message: lastMessage.slice(0, 800),
        httpStatus,
        ...logMeta,
      });
      if (!tryNextModel) throw e;
      const hasNext = i < candidates.length - 1;
      if (hasNext && /high demand|overloaded|try again later|429|503/i.test(lastMessage)) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  }
  const finalErr = new Error(
    `${lastMessage} Переполнение/лимиты у выбранных моделей. Задайте GOOGLE_GEMINI_MODEL или повторите запрос позже. Список моделей: GET https://generativelanguage.googleapis.com/v1beta/models?key=...`
  );
  throw finalErr;
}

/**
 * @returns {Promise<{ text: string, usage: TokenUsage | null, httpStatus: number }>}
 */
async function geminiGenerateOnce(apiKey, model, query) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetchForProvider("google", url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: query }],
        },
      ],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errText = data?.error?.message || res.statusText || "Gemini API error";
    const err = new Error(errText);
    attachHttpStatus(err, res.status);
    throw err;
  }
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!parts?.length) {
    const err = new Error("Пустой ответ Gemini");
    attachHttpStatus(err, res.status);
    throw err;
  }
  const usage = usageHarvestGemini(data);
  return {
    text: parts.map((p) => p.text || "").join(""),
    usage,
    httpStatus: res.status,
  };
}

/**
 * @returns {Promise<{ text: string, usage: TokenUsage | null, httpStatus: number }>}
 */
async function yandexAlice(query) {
  const folderId = process.env.YANDEX_CLOUD_FOLDER_ID?.trim();
  const apiKey = process.env.YANDEX_CLOUD_API_KEY?.trim();
  if (!folderId || !apiKey) throw new Error("Задайте YANDEX_CLOUD_FOLDER_ID и YANDEX_CLOUD_API_KEY");

  const modelName = process.env.YANDEX_CLOUD_MODEL?.trim() || "aliceai-llm/latest";
  const url =
    process.env.YANDEX_RESPONSES_URL?.trim() ||
    "https://ai.api.cloud.yandex.net/v1/responses";

  const res = await fetchForProvider("alice", url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Project": folderId,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: `gpt://${folderId}/${modelName}`,
      input: query,
      temperature: 0.35,
      max_output_tokens: 2048,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      openAiCompatibleErrorMessage(data) || res.statusText || "Yandex Responses API error"
    );
    attachHttpStatus(err, res.status);
    throw err;
  }

  const text = extractResponsesOutputText(data);
  if (!text?.trim()) {
    const err = new Error("Пустой ответ Алисы");
    attachHttpStatus(err, res.status);
    throw err;
  }

  const usage = usageHarvestResponses(data);

  return { text, usage, httpStatus: res.status };
}

const DEFAULT_GEN_SEARCH_URL = "https://searchapi.api.cloud.yandex.net/v2/gen/search";

/**
 * Генеративный ответ по веб-поиску Яндекса (Yandex Cloud Search API, GenSearchService).
 * Это не HTML-выдача yandex.ru, а официальный API «поиск + модель» для разработчиков.
 *
 * @returns {Promise<{ text: string, usage: TokenUsage | null, httpStatus: number }>}
 */
async function yandexGenSearch(query) {
  const folderId =
    process.env.YANDEX_GEN_SEARCH_FOLDER_ID?.trim() || process.env.YANDEX_CLOUD_FOLDER_ID?.trim();
  const apiKey =
    process.env.YANDEX_GEN_SEARCH_API_KEY?.trim() || process.env.YANDEX_CLOUD_API_KEY?.trim();
  if (!folderId || !apiKey) {
    throw new Error(
      "Задайте каталог и ключ: YANDEX_GEN_SEARCH_FOLDER_ID + YANDEX_GEN_SEARCH_API_KEY или YANDEX_CLOUD_FOLDER_ID + YANDEX_CLOUD_API_KEY"
    );
  }

  const url = process.env.YANDEX_GEN_SEARCH_URL?.trim() || DEFAULT_GEN_SEARCH_URL;
  const searchType =
    process.env.YANDEX_GEN_SEARCH_SEARCH_TYPE?.trim() || "SEARCH_TYPE_RU";

  const res = await fetchForProvider("alice_search", url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      folderId,
      messages: [{ role: "ROLE_USER", content: query }],
      searchType,
      fixMisspell: true,
      getPartialResults: false,
    }),
  });

  const rawText = await res.text();
  if (!res.ok) {
    let msg = res.statusText || "Yandex Gen Search API error";
    try {
      const errJson = JSON.parse(rawText);
      if (typeof errJson?.message === "string") msg = errJson.message;
    } catch {
      if (rawText?.trim()) msg = rawText.trim().slice(0, 500);
    }
    const err = new Error(msg);
    attachHttpStatus(err, res.status);
    throw err;
  }

  const chunks = parseGenSearchNdjsonOrJson(rawText);
  const text = formatGenSearchAnswer(chunks);
  if (!text?.trim()) {
    const err = new Error("Пустой ответ генеративного поиска");
    attachHttpStatus(err, res.status);
    throw err;
  }

  return { text, usage: null, httpStatus: res.status };
}

/**
 * @param {string} rawText
 * @returns {Record<string, unknown>[]}
 */
function parseGenSearchNdjsonOrJson(rawText) {
  const t = rawText.trim();
  if (!t) return [];
  try {
    const one = JSON.parse(t);
    if (Array.isArray(one)) return one;
    if (one && typeof one === "object") return [one];
  } catch {
    // NDJSON: по строке на объект
  }
  const out = [];
  for (const line of rawText.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // пропускаем не-JSON
    }
  }
  return out;
}

/**
 * @param {Record<string, unknown>[]} chunks
 * @returns {string}
 */
function formatGenSearchAnswer(chunks) {
  let longestAssistant = "";
  let rejected = false;
  let problematic = false;
  /** @type {Map<string, { title: string, used?: boolean }>} */
  const sourcesByUrl = new Map();

  for (const c of chunks) {
    if (!c || typeof c !== "object") continue;
    if (c.isAnswerRejected === true) rejected = true;
    if (c.problematicAnswer === true) problematic = true;
    const msg = c.message;
    if (msg && typeof msg === "object") {
      const role = /** @type {any} */ (msg).role;
      const isAssistant = role === "ROLE_ASSISTANT" || role === 2;
      if (isAssistant && typeof /** @type {any} */ (msg).content === "string") {
        const content = /** @type {any} */ (msg).content;
        if (content.length > longestAssistant.length) longestAssistant = content;
      }
    }
    const sources = c.sources;
    if (Array.isArray(sources)) {
      for (const s of sources) {
        if (s && typeof s === "object" && typeof /** @type {any} */ (s).url === "string") {
          const url = /** @type {any} */ (s).url;
          const title = typeof /** @type {any} */ (s).title === "string" ? /** @type {any} */ (s).title : "";
          const used = /** @type {any} */ (s).used;
          sourcesByUrl.set(url, { title, used });
        }
      }
    }
  }

  let text = longestAssistant.trim();
  if (rejected && !text) {
    text = "Ответ отклонён политикой сервиса (isAnswerRejected).";
  }
  const notes = [];
  if (problematic) notes.push("Сервис пометил ответ как потенциально проблемный по содержанию.");
  if (notes.length) text = `${text}\n\n_${notes.join(" ")}_`.trim();

  if (sourcesByUrl.size > 0) {
    const lines = ["", "---", "**Источники (Search API):**"];
    for (const [url, { title, used }] of sourcesByUrl) {
      const label = title?.trim() || url;
      const usedNote =
        used === true ? "" : used === false ? " _(не отмечен как использованный в ответе)_" : "";
      lines.push(`- [${label}](${url})${usedNote}`);
    }
    text = `${text}\n${lines.join("\n")}`.trim();
  }

  return text;
}
