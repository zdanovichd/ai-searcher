export const PROVIDER_LABELS = {
  chatgpt: "ChatGPT",
  deepseek: "DeepSeek",
  perplexity: "Perplexity",
  google: "Google Gemini",
  alice: "Алиса AI",
  alice_search: "Алиса в Поиске",
};

export const ROLE_LABELS = {
  admin: "Администратор",
  user: "Пользователь",
};

export function formatRole(role) {
  return ROLE_LABELS[role] || role;
}

export function formatProvider(providerId) {
  return PROVIDER_LABELS[providerId] || providerId;
}

export function formatMoney(amount, currency = "RUB") {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatLimitUsage(used, limit) {
  if (limit == null) return `${used} (без лимита)`;
  return `${used} из ${limit}`;
}
