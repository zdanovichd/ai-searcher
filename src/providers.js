import OpenAI from "openai";
import { extractLinks } from "./extractLinks.js";
import { SEARCH_SYSTEM_PROMPT } from "./prompt.js";

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
 * @param {string} id
 * @param {string} query
 * @returns {Promise<{ id: string, label: string, text: string, links: string[], error?: string, durationMs: number }>}
 */
export async function runProvider(id, query) {
  const label = PROVIDER_LABELS[id] ?? id;
  const t0 = Date.now();
  try {
    let text = "";
    switch (id) {
      case "chatgpt":
        text = await chatOpenAI({
          apiKey: process.env.OPENAI_API_KEY,
          baseURL: undefined,
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        }, query);
        break;
      case "deepseek":
        text = await chatOpenAI({
          apiKey: process.env.DEEPSEEK_API_KEY,
          baseURL: "https://api.deepseek.com",
          model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
        }, query);
        break;
      case "perplexity":
        text = await chatOpenAI({
          apiKey: process.env.PERPLEXITY_API_KEY,
          baseURL: "https://api.perplexity.ai",
          model: process.env.PERPLEXITY_MODEL || "sonar",
        }, query);
        break;
      case "google":
        text = await geminiChat(query);
        break;
      case "alice":
        text = await yandexAlice(query);
        break;
      default:
        throw new Error(`Неизвестный провайдер: ${id}`);
    }
    const durationMs = Date.now() - t0;
    const links = extractLinks(text);
    return { id, label, text: text.trim(), links, durationMs };
  } catch (e) {
    const durationMs = Date.now() - t0;
    let msg = e?.message || String(e);
    if (id === "deepseek" && /402|Insufficient Balance|insufficient balance/i.test(msg)) {
      msg =
        "402: на счёте DeepSeek нет средств. Пополните баланс в личном кабинете platform.deepseek.com.";
    }
    return { id, label, text: "", links: [], error: msg, durationMs };
  }
}

async function chatOpenAI({ apiKey, baseURL, model }, query) {
  if (!apiKey) throw new Error("Не задан API-ключ");
  const client = new OpenAI({
    apiKey,
    baseURL,
    timeout: TIMEOUT_MS,
  });
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SEARCH_SYSTEM_PROMPT },
      { role: "user", content: query },
    ],
    temperature: 0.35,
    max_tokens: 2048,
  });
  return completion.choices[0]?.message?.content ?? "";
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

async function geminiChat(query) {
  const apiKey = process.env.GOOGLE_AI_API_KEY?.trim();
  if (!apiKey) throw new Error("Не задан GOOGLE_AI_API_KEY");

  const requested = process.env.GOOGLE_GEMINI_MODEL?.trim();
  const candidates = [...new Set([...(requested ? [requested] : []), ...GEMINI_MODEL_FALLBACKS])];

  let lastMessage = "";
  for (const model of candidates) {
    try {
      return await geminiGenerateOnce(apiKey, model, query);
    } catch (e) {
      lastMessage = e?.message || String(e);
      const retry =
        /not found|is not found|not supported for generateContent|404/i.test(lastMessage);
      if (!retry) throw e;
    }
  }
  throw new Error(
    `${lastMessage} Задайте рабочую модель в GOOGLE_GEMINI_MODEL или проверьте список: GET https://generativelanguage.googleapis.com/v1beta/models?key=...`
  );
}

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
  return parts.map((p) => p.text || "").join("");
}

async function yandexAlice(query) {
  const folderId = process.env.YANDEX_CLOUD_FOLDER_ID?.trim();
  const apiKey = process.env.YANDEX_CLOUD_API_KEY?.trim();
  if (!folderId || !apiKey) throw new Error("Задайте YANDEX_CLOUD_FOLDER_ID и YANDEX_CLOUD_API_KEY");

  const modelName = process.env.YANDEX_CLOUD_MODEL?.trim() || "aliceai-llm/latest";
  const client = new OpenAI({
    apiKey,
    baseURL: "https://ai.api.cloud.yandex.net/v1",
    timeout: TIMEOUT_MS,
    defaultHeaders: {
      "OpenAI-Project": folderId,
    },
  });

  const response = await client.responses.create({
    model: `gpt://${folderId}/${modelName}`,
    instructions: SEARCH_SYSTEM_PROMPT,
    input: query,
    temperature: 0.35,
    max_output_tokens: 2048,
  });

  const text = response.output_text;
  if (!text) throw new Error("Пустой ответ Алисы");
  return text;
}
