import { extractLinks } from "./extractLinks.js";
import { explainNetworkError } from "./networkError.js";
import { SEARCH_SYSTEM_PROMPT } from "./prompt.js";
import {
  extractResponsesOutputText,
  usageHarvestChatCompletions,
  usageHarvestGemini,
  usageHarvestResponses,
} from "./tokenUsage.js";

export const PROVIDER_IDS = ["chatgpt", "deepseek", "perplexity", "google", "alice"];

export const PROVIDER_LABELS = {
  chatgpt: "ChatGPT",
  deepseek: "DeepSeek",
  perplexity: "Perplexity",
  google: "Google AI (Gemini)",
  alice: "Алиса AI (Yandex)",
};

const TIMEOUT_MS = 120_000;

export function getConfiguredProviders() {
  return {
    chatgpt: Boolean(process.env.OPENAI_API_KEY?.trim()),
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
    perplexity: Boolean(process.env.PERPLEXITY_API_KEY?.trim()),
    google: Boolean(process.env.GOOGLE_AI_API_KEY?.trim()),
    alice: Boolean(
      process.env.YANDEX_CLOUD_API_KEY?.trim() && process.env.YANDEX_CLOUD_FOLDER_ID?.trim()
    ),
  };
}

/**
 * @typedef {{ input: number | null, output: number | null, total: number | null }} TokenUsage
 */

/**
 * @param {string} id
 * @param {string} query
 * @returns {Promise<{ id: string, label: string, text: string, links: string[], usage?: TokenUsage | null, error?: string, durationMs: number }>}
 */
export async function runProvider(id, query) {
  const label = PROVIDER_LABELS[id] ?? id;
  const t0 = Date.now();
  try {
    /** @type {string} */
    let text = "";
    /** @type {TokenUsage | null} */
    let usage = null;
    switch (id) {
      case "chatgpt": {
        const out = await chatCompletionsViaFetch({
          apiKey: process.env.OPENAI_API_KEY,
          baseURL: process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          query,
        });
        text = out.text;
        usage = out.usage;
        break;
      }
      case "deepseek": {
        const out = await chatCompletionsViaFetch({
          apiKey: process.env.DEEPSEEK_API_KEY,
          baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
          model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
          query,
        });
        text = out.text;
        usage = out.usage;
        break;
      }
      case "perplexity": {
        const out = await perplexitySonar(query);
        text = out.text;
        usage = out.usage;
        break;
      }
      case "google": {
        const out = await geminiChat(query);
        text = out.text;
        usage = out.usage;
        break;
      }
      case "alice": {
        const out = await yandexAlice(query);
        text = out.text;
        usage = out.usage;
        break;
      }
      default:
        throw new Error(`Неизвестный провайдер: ${id}`);
    }
    const durationMs = Date.now() - t0;
    const links = extractLinks(text);
    return { id, label, text: text.trim(), links, usage, durationMs };
  } catch (e) {
    const durationMs = Date.now() - t0;
    let msg = explainNetworkError(e);
    if (id === "deepseek" && /402|Insufficient Balance|insufficient balance/i.test(msg)) {
      msg =
        "402: на счёте DeepSeek нет средств. Пополните баланс в личном кабинете platform.deepseek.com.";
    } else {
      msg = enrichGeoAndAuthHints(id, msg);
    }
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
  return m;
}

/**
 * Perplexity Sonar API: официальный путь `POST /v1/sonar` с полем `usage`.
 * Вызов через OpenAI SDK на `/v1/chat/completions` часто приходит без нормальной разбивки токенов.
 *
 * @returns {Promise<{ text: string, usage: TokenUsage | null }>}
 */
async function perplexitySonar(query) {
  const apiKey = process.env.PERPLEXITY_API_KEY?.trim();
  if (!apiKey) throw new Error("Не задан PERPLEXITY_API_KEY");

  const model = process.env.PERPLEXITY_MODEL?.trim() || "sonar";
  const url =
    process.env.PERPLEXITY_API_URL?.trim() || "https://api.perplexity.ai/v1/sonar";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SEARCH_SYSTEM_PROMPT },
        { role: "user", content: query },
      ],
      temperature: 0.35,
      max_tokens: 2048,
      stream: false,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(perplexityErrorMessage(data) || res.statusText || "Perplexity API error");
  }

  const text = data.choices?.[0]?.message?.content ?? "";
  const usage = usageHarvestChatCompletions(data);

  return { text, usage };
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
 * @returns {Promise<{ text: string, usage: TokenUsage | null }>}
 */
async function chatCompletionsViaFetch({ apiKey, baseURL, model, query }) {
  if (!apiKey) throw new Error("Не задан API-ключ");
  const root = (baseURL || "").replace(/\/$/, "");
  const url = `${root}/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SEARCH_SYSTEM_PROMPT },
        { role: "user", content: query },
      ],
      temperature: 0.35,
      max_tokens: 2048,
      stream: false,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      openAiCompatibleErrorMessage(data) || res.statusText || "Chat Completions API error"
    );
  }

  const text = data.choices?.[0]?.message?.content ?? "";
  const usage = usageHarvestChatCompletions(data);
  return { text, usage };
}

/**
 * Порядок, если GOOGLE_GEMINI_MODEL не задан или модель недоступна.
 * Сверено с актуальным ListModels (generateContent): 2.5 Flash stable, 2.0, «latest», lite.
 */
const GEMINI_MODEL_FALLBACKS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-flash-latest",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
];

/**
 * @returns {Promise<{ text: string, usage: TokenUsage | null }>}
 */
async function geminiChat(query) {
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
      const tryNextModel =
        /not found|is not found|not supported for generateContent|404/i.test(lastMessage) ||
        /high demand|overloaded|rate limit|too many requests|resource.?exhausted|temporarily unavailable|try again later|capacity|quota|unavailable|503|429/i.test(
          lastMessage
        );
      if (!tryNextModel) throw e;
      const hasNext = i < candidates.length - 1;
      if (hasNext && /high demand|overloaded|try again later|429|503/i.test(lastMessage)) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  }
  throw new Error(
    `${lastMessage} Переполнение/лимиты у выбранных моделей. Задайте GOOGLE_GEMINI_MODEL или повторите запрос позже. Список моделей: GET https://generativelanguage.googleapis.com/v1beta/models?key=...`
  );
}

/**
 * @returns {Promise<{ text: string, usage: TokenUsage | null }>}
 */
async function geminiGenerateOnce(apiKey, model, query) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: SEARCH_SYSTEM_PROMPT }],
      },
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
    throw new Error(errText);
  }
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!parts?.length) throw new Error("Пустой ответ Gemini");
  const usage = usageHarvestGemini(data);
  return {
    text: parts.map((p) => p.text || "").join(""),
    usage,
  };
}

/**
 * @returns {Promise<{ text: string, usage: TokenUsage | null }>}
 */
async function yandexAlice(query) {
  const folderId = process.env.YANDEX_CLOUD_FOLDER_ID?.trim();
  const apiKey = process.env.YANDEX_CLOUD_API_KEY?.trim();
  if (!folderId || !apiKey) throw new Error("Задайте YANDEX_CLOUD_FOLDER_ID и YANDEX_CLOUD_API_KEY");

  const modelName = process.env.YANDEX_CLOUD_MODEL?.trim() || "aliceai-llm/latest";
  const url =
    process.env.YANDEX_RESPONSES_URL?.trim() ||
    "https://ai.api.cloud.yandex.net/v1/responses";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Project": folderId,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: `gpt://${folderId}/${modelName}`,
      instructions: SEARCH_SYSTEM_PROMPT,
      input: query,
      temperature: 0.35,
      max_output_tokens: 2048,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      openAiCompatibleErrorMessage(data) || res.statusText || "Yandex Responses API error"
    );
  }

  const text = extractResponsesOutputText(data);
  if (!text?.trim()) throw new Error("Пустой ответ Алисы");

  const usage = usageHarvestResponses(data);

  return { text, usage };
}
