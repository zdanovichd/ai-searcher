import { ProxyAgent, fetch as undiciFetch } from "undici";

/**
 * Переменные .env с URL HTTP(S)-прокси для исходящих запросов к API провайдера.
 * Формат: `http://host:port` или `https://host:port` (как в undici ProxyAgent).
 * Для `alice_search`: если `YANDEX_GEN_SEARCH_PROXY` пуст — берётся `YANDEX_CLOUD_PROXY`.
 */
const PROXY_ENV_KEYS = {
  chatgpt: ["OPENAI_PROXY"],
  deepseek: ["DEEPSEEK_PROXY"],
  perplexity: ["PERPLEXITY_PROXY"],
  google: ["GOOGLE_AI_PROXY"],
  alice: ["YANDEX_CLOUD_PROXY"],
  alice_search: ["YANDEX_GEN_SEARCH_PROXY", "YANDEX_CLOUD_PROXY"],
};

/** @type {Map<string, ProxyAgent>} */
const agentByProxyUrl = new Map();

/**
 * @param {string} providerId
 * @returns {string} непустой URL прокси или ""
 */
export function getOutboundProxyUrl(providerId) {
  const keys = PROXY_ENV_KEYS[/** @type {keyof typeof PROXY_ENV_KEYS} */ (providerId)];
  if (!keys?.length) return "";
  for (const k of keys) {
    const v = process.env[k]?.trim();
    if (v) return v;
  }
  return "";
}

/**
 * @param {string} proxyUrl
 * @returns {ProxyAgent}
 */
function getProxyAgent(proxyUrl) {
  const key = proxyUrl.trim();
  if (!agentByProxyUrl.has(key)) {
    agentByProxyUrl.set(key, new ProxyAgent(key));
  }
  return /** @type {ProxyAgent} */ (agentByProxyUrl.get(key));
}

/**
 * fetch к API провайдера: при заданном прокси в .env — через CONNECT (undici).
 * Без прокси — глобальный `fetch` Node (поведение как раньше).
 *
 * @param {string} providerId
 * @param {string | URL | Request} url
 * @param {RequestInit} [init]
 */
export async function fetchForProvider(providerId, url, init) {
  const proxyUrl = getOutboundProxyUrl(providerId);
  if (!proxyUrl) {
    return fetch(url, init);
  }
  const dispatcher = getProxyAgent(proxyUrl);
  return undiciFetch(url, { ...init, dispatcher });
}
