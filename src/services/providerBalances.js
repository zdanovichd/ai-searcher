import { readFile } from "node:fs/promises";
import jwt from "jsonwebtoken";

import { PROVIDER_IDS, PROVIDER_LABELS } from "../providers.js";
import { fetchForProvider } from "../proxyFetch.js";
import { explainNetworkError } from "../networkError.js";
import { logEvent } from "../logger.js";

const TIMEOUT_MS = 15_000;
const POLZA_BALANCE_URL = "https://polza.ai/api/v1/balance";
const YANDEX_IAM_URL = "https://iam.api.cloud.yandex.net/iam/v1/tokens";
const YANDEX_BILLING_URL = "https://billing.api.cloud.yandex.net/billing/v1/billingAccounts";
const YANDEX_IAM_AUDIENCE = "https://iam.api.cloud.yandex.net/iam/v1/tokens";

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   configured: boolean,
 *   supported: boolean,
 *   remaining: number | null,
 *   currency: string | null,
 *   available: boolean | null,
 *   note?: string,
 *   details?: Record<string, unknown>,
 *   error?: string
 * }} ProviderBalance
 */

function env(name) {
  return process.env[name]?.trim() || "";
}

function envOrPolza(field) {
  return env(field) || env("POLZA_API_KEY");
}

function emptyBalance(id, extra = {}) {
  return {
    id,
    label: PROVIDER_LABELS[id] ?? id,
    configured: false,
    supported: false,
    remaining: null,
    currency: null,
    available: null,
    ...extra,
  };
}

async function fetchJson(providerId, url, init = {}) {
  const res = await fetchForProvider(providerId, url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...init,
    headers: { Accept: "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 400) };
  }
  return { res, data };
}

function httpErrorMessage(res, data) {
  const fromJson =
    (data && typeof data === "object" && (data.error?.message || data.message || data.error)) || "";
  const msg = typeof fromJson === "string" ? fromJson : "";
  return msg || `${res.status} ${res.statusText || "error"}`.trim();
}

function parseNumber(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** @param {string} id */
function isPolzaRouted(id) {
  if (!env("POLZA_API_KEY")) return false;
  const bases = {
    chatgpt: env("OPENAI_BASE_URL"),
    deepseek: env("DEEPSEEK_BASE_URL"),
    perplexity: env("PERPLEXITY_BASE_URL"),
    google: env("GOOGLE_BASE_URL"),
    alice: env("ALICE_BASE_URL"),
  };
  const base = bases[id];
  if (base && /polza\.ai/i.test(base)) return true;
  if (id === "alice") return Boolean(env("ALICE_BASE_URL"));
  const directKeys = {
    chatgpt: "OPENAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    perplexity: "PERPLEXITY_API_KEY",
    google: "GOOGLE_AI_API_KEY",
  };
  return !env(directKeys[id]);
}

function isProviderConfigured(id) {
  switch (id) {
    case "chatgpt":
      return Boolean(envOrPolza("OPENAI_API_KEY"));
    case "deepseek":
      return Boolean(envOrPolza("DEEPSEEK_API_KEY"));
    case "perplexity":
      return Boolean(envOrPolza("PERPLEXITY_API_KEY"));
    case "google":
      return Boolean(envOrPolza("GOOGLE_AI_API_KEY"));
    case "alice":
      return Boolean(
        (env("ALICE_BASE_URL") && envOrPolza("ALICE_API_KEY")) ||
          (env("YANDEX_CLOUD_API_KEY") && env("YANDEX_CLOUD_FOLDER_ID"))
      );
    case "alice_search":
      return Boolean(
        (env("YANDEX_GEN_SEARCH_API_KEY") || env("YANDEX_CLOUD_API_KEY")) &&
          (env("YANDEX_GEN_SEARCH_FOLDER_ID") || env("YANDEX_CLOUD_FOLDER_ID"))
      );
    default:
      return false;
  }
}

/**
 * @returns {Promise<{ remaining: number | null, currency: string, available: boolean | null, details?: Record<string, unknown>, error?: string, configured: boolean } | null>}
 */
async function fetchPolzaBalanceRaw() {
  const apiKey = env("POLZA_API_KEY");
  if (!apiKey) return null;
  const { res, data } = await fetchJson("chatgpt", POLZA_BALANCE_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    return {
      configured: true,
      remaining: null,
      currency: "RUB",
      available: null,
      error: httpErrorMessage(res, data),
    };
  }
  const remaining = parseNumber(data?.amount);
  return {
    configured: true,
    remaining,
    currency: "RUB",
    available: remaining == null ? null : remaining > 0,
    details: {
      reserved: parseNumber(data?.reservedAmount),
      spent: parseNumber(data?.spentAmount),
      updatedAt: data?.updatedAt ?? null,
      source: "GET /api/v1/balance",
    },
  };
}

/** @param {string} id @param {NonNullable<Awaited<ReturnType<typeof fetchPolzaBalanceRaw>>>} polza */
function polzaProviderBalance(id, polza) {
  if (polza.error) {
    return emptyBalance(id, {
      configured: true,
      supported: true,
      error: polza.error,
      note: "Баланс Polza.ai (GET /api/v1/balance)",
    });
  }
  return {
    id,
    label: PROVIDER_LABELS[id],
    configured: true,
    supported: true,
    remaining: polza.remaining,
    currency: polza.currency,
    available: polza.available,
    note: "Баланс Polza.ai — общий для всех моделей через агрегатор",
    details: polza.details,
  };
}

async function fetchDeepSeek() {
  const id = "deepseek";
  if (isPolzaRouted(id)) {
    return emptyBalance(id, { note: "Маршрут через Polza — см. общий баланс Polza" });
  }
  const apiKey = envOrPolza("DEEPSEEK_API_KEY");
  if (!apiKey) return emptyBalance(id, { note: "Нет DEEPSEEK_API_KEY" });
  const base = (env("DEEPSEEK_BASE_URL") || "https://api.deepseek.com").replace(/\/$/, "");
  const { res, data } = await fetchJson(id, `${base}/user/balance`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    return emptyBalance(id, {
      configured: true,
      supported: true,
      error: httpErrorMessage(res, data),
      note: "GET /user/balance (DeepSeek)",
    });
  }
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
  const usd = infos.find((x) => String(x?.currency || "").toUpperCase() === "USD");
  const picked = usd || infos[0] || {};
  return {
    id,
    label: PROVIDER_LABELS[id],
    configured: true,
    supported: true,
    remaining: parseNumber(picked.total_balance),
    currency: picked.currency ? String(picked.currency) : null,
    available: typeof data?.is_available === "boolean" ? data.is_available : null,
    note: "GET /user/balance (DeepSeek)",
    details: {
      granted: parseNumber(picked.granted_balance),
      toppedUp: parseNumber(picked.topped_up_balance),
    },
  };
}

async function fetchOpenAi() {
  const id = "chatgpt";
  if (isPolzaRouted(id)) {
    return emptyBalance(id, { note: "Маршрут через Polza — см. общий баланс Polza" });
  }
  const apiKey = envOrPolza("OPENAI_API_KEY");
  if (!apiKey) return emptyBalance(id, { note: "Нет OPENAI_API_KEY" });
  const base = (env("OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/$/, "");
  const urls = [
    `${base}/dashboard/billing/credit_grants`,
    "https://api.openai.com/dashboard/billing/credit_grants",
  ];
  let lastError = "";
  for (const url of urls) {
    const { res, data } = await fetchJson(id, url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const remaining = parseNumber(data?.total_available ?? data?.total_granted);
      return {
        id,
        label: PROVIDER_LABELS[id],
        configured: true,
        supported: remaining != null,
        remaining,
        currency: remaining != null ? "USD" : null,
        available: remaining == null ? null : remaining > 0,
        note: remaining == null ? "Ключ живой, остаток кредитов в ответе не найден." : "OpenAI credit_grants",
        details: {
          totalGranted: parseNumber(data?.total_granted),
          totalUsed: parseNumber(data?.total_used),
        },
      };
    }
    lastError = httpErrorMessage(res, data);
    if (res.status !== 404) break;
  }
  return emptyBalance(id, {
    configured: true,
    supported: false,
    error: lastError,
    note: "Официального остатка у API-ключа нет. Смотрите billing.openai.com.",
  });
}

async function fetchPerplexity() {
  const id = "perplexity";
  if (isPolzaRouted(id)) {
    return emptyBalance(id, { note: "Маршрут через Polza — см. общий баланс Polza" });
  }
  const apiKey = envOrPolza("PERPLEXITY_API_KEY");
  if (!apiKey) return emptyBalance(id, { note: "Нет PERPLEXITY_API_KEY" });
  const urls = ["https://api.perplexity.ai/models", "https://api.perplexity.ai/v1/models"];
  let last = null;
  for (const url of urls) {
    last = await fetchJson(id, url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (last.res.ok) break;
  }
  const res = last.res;
  const data = last.data;
  if (!res.ok) {
    return emptyBalance(id, {
      configured: true,
      supported: false,
      note: "Официального API остатка нет. Баланс — в кабинете Perplexity.",
      error: res.status === 404 ? undefined : httpErrorMessage(res, data),
    });
  }
  const remainingHeader =
    res.headers.get("x-tokens-remaining") ||
    res.headers.get("x-credits-remaining") ||
    res.headers.get("x-ratelimit-remaining");
  const remaining = parseNumber(remainingHeader);
  return {
    id,
    label: PROVIDER_LABELS[id],
    configured: true,
    supported: remaining != null,
    remaining,
    currency: remaining != null ? "credits" : null,
    available: remaining == null ? true : remaining > 0,
    note:
      remaining == null
        ? "Официального API остатка нет; ключ отвечает. Баланс — в perplexity.ai/settings."
        : "Заголовок x-credits-remaining",
  };
}

async function fetchGoogle() {
  const id = "google";
  if (isPolzaRouted(id)) {
    return emptyBalance(id, { note: "Маршрут через Polza — см. общий баланс Polza" });
  }
  const apiKey = envOrPolza("GOOGLE_AI_API_KEY");
  if (!apiKey) return emptyBalance(id, { note: "Нет GOOGLE_AI_API_KEY" });
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const { res, data } = await fetchJson(id, url, { method: "GET" });
  if (!res.ok) {
    return emptyBalance(id, {
      configured: true,
      supported: false,
      error: httpErrorMessage(res, data),
    });
  }
  return emptyBalance(id, {
    configured: true,
    supported: false,
    note: "У Gemini AI Studio нет API остатка денег — квоты в Google AI Studio.",
  });
}

async function fetchYandexIamToken() {
  const staticToken = env("YANDEX_IAM_TOKEN");
  if (staticToken) return { token: staticToken, error: null };

  const saKeyFile = env("YANDEX_SERVICE_ACCOUNT_KEY_FILE");
  if (saKeyFile) {
    try {
      const raw = await readFile(saKeyFile, "utf8");
      const key = JSON.parse(raw);
      const privateKey = typeof key?.private_key === "string" ? key.private_key : "";
      const keyId = typeof key?.id === "string" ? key.id : "";
      const serviceAccountId =
        typeof key?.service_account_id === "string" ? key.service_account_id : "";

      if (!privateKey || !keyId || !serviceAccountId) {
        return {
          token: null,
          error:
            "В YANDEX_SERVICE_ACCOUNT_KEY_FILE не хватает полей private_key, id или service_account_id",
        };
      }

      const now = Math.floor(Date.now() / 1000);
      const signedJwt = jwt.sign(
        {
          iss: serviceAccountId,
          aud: YANDEX_IAM_AUDIENCE,
          iat: now,
          exp: now + 3600,
        },
        privateKey,
        {
          algorithm: "PS256",
          keyid: keyId,
        }
      );

      const { res, data } = await fetchJson("alice_search", YANDEX_IAM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jwt: signedJwt }),
      });
      if (!res.ok) {
        return {
          token: null,
          error: httpErrorMessage(res, data) || "Не удалось обменять JWT сервисного аккаунта на IAM-токен",
        };
      }
      const token = typeof data?.iamToken === "string" ? data.iamToken : null;
      if (!token) {
        return { token: null, error: "IAM-токен не найден в ответе iam.api.cloud.yandex.net" };
      }
      return { token, error: null };
    } catch (e) {
      return {
        token: null,
        error: explainNetworkError(e),
      };
    }
  }

  const oauth = env("YANDEX_OAUTH_TOKEN");
  if (!oauth) {
    return {
      token: null,
      error: null,
    };
  }

  const { res, data } = await fetchJson("alice_search", YANDEX_IAM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yandexPassportOauthToken: oauth }),
  });
  if (!res.ok) {
    return {
      token: null,
      error: httpErrorMessage(res, data) || "Не удалось обменять OAuth на IAM-токен",
    };
  }
  const token = typeof data?.iamToken === "string" ? data.iamToken : null;
  if (!token) {
    return { token: null, error: "IAM-токен не найден в ответе iam.api.cloud.yandex.net" };
  }
  return { token, error: null };
}

async function fetchYandexBilling() {
  const hasBillingCreds = Boolean(env("YANDEX_IAM_TOKEN") || env("YANDEX_OAUTH_TOKEN"));
  const hasSearch =
    env("YANDEX_CLOUD_API_KEY") ||
    env("YANDEX_GEN_SEARCH_API_KEY") ||
    env("YANDEX_BILLING_ACCOUNT_ID");
  if (!hasBillingCreds && !hasSearch) {
    return { configured: false, error: null, accounts: [], iamError: null };
  }
  if (!hasBillingCreds) {
    return {
      configured: true,
      error: "Нет YANDEX_OAUTH_TOKEN / YANDEX_IAM_TOKEN",
      accounts: [],
      iamError: "Ключ Search API не подходит для биллинга. Нужен OAuth или IAM.",
    };
  }

  const iam = await fetchYandexIamToken();
  if (!iam.token) {
    return {
      configured: true,
      error: iam.error || "Задайте YANDEX_IAM_TOKEN или ключ с правом на IAM",
      accounts: [],
      iamError: iam.error,
    };
  }

  const billingAccountId = env("YANDEX_BILLING_ACCOUNT_ID");
  const url = billingAccountId
    ? `${YANDEX_BILLING_URL}/${encodeURIComponent(billingAccountId)}`
    : YANDEX_BILLING_URL;

  const { res, data } = await fetchJson("alice_search", url, {
    method: "GET",
    headers: { Authorization: `Bearer ${iam.token}` },
  });

  if (!res.ok) {
    return {
      configured: true,
      error: httpErrorMessage(res, data),
      accounts: [],
      iamError: null,
    };
  }

  if (billingAccountId && data && typeof data === "object" && data.id) {
    return { configured: true, error: null, accounts: [data], iamError: null };
  }

  const accounts = Array.isArray(data?.billingAccounts)
    ? data.billingAccounts
    : Array.isArray(data?.billing_accounts)
      ? data.billing_accounts
      : [];
  return { configured: true, error: null, accounts, iamError: null };
}

function yandexToProvider(id, billing) {
  if (!billing.configured) {
    return emptyBalance(id, { note: "Нет YANDEX_CLOUD_* / YANDEX_GEN_SEARCH_*" });
  }
  if (id === "alice" && isPolzaRouted("alice")) {
    return emptyBalance(id, { note: "LLM через Polza — см. баланс Polza.ai" });
  }
  if (billing.error) {
    const hint =
      billing.iamError || /identity|Validation failed/i.test(billing.error)
        ? "Задайте YANDEX_IAM_TOKEN в .env (yc iam create-token) или ключ сервисного аккаунта с JWT. Api-Key LLM не подходит для Billing API."
        : "Yandex Billing API (billing.api.cloud.yandex.net). Нужен IAM-токен и роль billing.accounts.viewer.";
    return emptyBalance(id, {
      configured: true,
      supported: true,
      error: billing.error,
      note: hint,
    });
  }
  const acc = billing.accounts[0];
  if (!acc) {
    return emptyBalance(id, {
      configured: true,
      supported: true,
      note: "Биллинг-аккаунты не найдены. Задайте YANDEX_BILLING_ACCOUNT_ID или права list.",
    });
  }
  return {
    id,
    label: PROVIDER_LABELS[id],
    configured: true,
    supported: true,
    remaining: parseNumber(acc.balance),
    currency: acc.currency ? String(acc.currency) : "RUB",
    available: typeof acc.active === "boolean" ? acc.active : null,
    note:
      id === "alice_search"
        ? "Yandex Cloud Billing — общий счёт облака (Search API + др.)"
        : "Yandex Cloud Billing — общий счёт облака",
    details: {
      billingAccountId: acc.id || null,
      name: acc.name || null,
      source: "GET billing/v1/billingAccounts",
    },
  };
}

async function safeFetch(id, fn) {
  try {
    return await fn();
  } catch (e) {
    logEvent("warn", "provider_balance:fail", {
      providerId: id,
      message: e instanceof Error ? e.message : String(e),
    });
    return emptyBalance(id, {
      configured: isProviderConfigured(id),
      supported: false,
      error: explainNetworkError(e),
    });
  }
}

/**
 * Остаток денег/кредитов у провайдеров по ключам из `.env` сервера (живые API, без расчёта по токенам).
 * @returns {Promise<ProviderBalance[]>}
 */
export async function fetchProviderBalances() {
  const polzaRaw = env("POLZA_API_KEY")
    ? await fetchPolzaBalanceRaw().catch((e) => ({
        configured: true,
        remaining: null,
        currency: "RUB",
        available: null,
        error: explainNetworkError(e),
      }))
    : null;

  let yandexResult;
  try {
    yandexResult = await fetchYandexBilling();
  } catch (e) {
    yandexResult = {
      configured: Boolean(env("YANDEX_CLOUD_API_KEY") || env("YANDEX_GEN_SEARCH_API_KEY")),
      error: explainNetworkError(e),
      accounts: [],
      iamError: null,
    };
  }

  const directJobs = {
    chatgpt: fetchOpenAi,
    deepseek: fetchDeepSeek,
    perplexity: fetchPerplexity,
    google: fetchGoogle,
  };

  const settled = await Promise.all(
    Object.entries(directJobs).map(async ([id, fn]) => {
      if (isPolzaRouted(id) && polzaRaw) {
        return polzaProviderBalance(id, polzaRaw);
      }
      return safeFetch(id, fn);
    })
  );

  const alice =
    isPolzaRouted("alice") && polzaRaw
      ? polzaProviderBalance("alice", polzaRaw)
      : yandexToProvider("alice", yandexResult);
  const aliceSearch = yandexToProvider("alice_search", yandexResult);

  const byId = new Map([...settled, alice, aliceSearch].map((x) => [x.id, x]));
  return PROVIDER_IDS.map((id) => byId.get(id) || emptyBalance(id));
}
