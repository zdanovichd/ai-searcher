import {
  getConfiguredProviders,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  runProvider,
} from "./providers.js";
import { logEvent } from "./logger.js";

/** Сколько пользовательских запросов в пакете обрабатывать параллельно (каждый всё ещё дергает все модели сразу). */
const BATCH_QUERY_CONCURRENCY = Math.max(
  1,
  Math.min(16, Number(process.env.BATCH_QUERY_CONCURRENCY) || 4)
);

export const MAX_BATCH_QUERIES = 120;

/** Параллельных вызовов модели при потоковом режиме (ячейки таблицы). */
const STREAM_CELL_CONCURRENCY = Math.max(
  1,
  Math.min(24, Number(process.env.STREAM_CELL_CONCURRENCY) || 12)
);

/**
 * Порядок id, которые пользователь запросил (`all` → все известные id).
 * @param {string[]} selectedIds
 * @returns {string[]}
 */
function getRequestedProviderIds(selectedIds) {
  const raw = Array.isArray(selectedIds) ? selectedIds : ["all"];
  if (raw.includes("all") || raw.length === 0) {
    return [...PROVIDER_IDS];
  }
  const seen = new Set();
  const out = [];
  for (const id of raw) {
    if (!PROVIDER_IDS.includes(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Результат-заглушка для провайдера без ключа в .env (явно в API).
 * @param {string} id
 */
function buildDisabledProviderResult(id) {
  const label = PROVIDER_LABELS[id] ?? id;
  return {
    id,
    label,
    text: "",
    links: [],
    error: "Провайдер не настроен на сервере: не задан ключ API в .env.",
    durationMs: 0,
    usage: null,
  };
}

/**
 * @param {string[]} selectedIds
 * @returns {{
 *   ids: string[],
 *   requestedIds: string[],
 *   skippedLabels: string[],
 *   error: string | null
 * }}
 * - `ids` — только настроенные (для реальных вызовов).
 * - `requestedIds` — полный запрошенный список (включая без ключей), порядок сохранён.
 * - `skippedLabels` — подписи провайдеров из запроса, у которых нет ключа.
 */
export function resolveProviderIds(selectedIds) {
  const configured = getConfiguredProviders();
  const requestedIds = getRequestedProviderIds(selectedIds);

  if (!requestedIds.length) {
    return {
      ids: [],
      requestedIds: [],
      skippedLabels: [],
      error: "Ни один известный провайдер не выбран.",
    };
  }

  const activeIds = requestedIds.filter((id) => configured[id]);
  const skippedLabels = requestedIds
    .filter((id) => !configured[id])
    .map((id) => PROVIDER_LABELS[id] || id);

  if (!activeIds.length) {
    return {
      ids: [],
      requestedIds,
      skippedLabels,
      error: "Все выбранные провайдеры не настроены (проверьте .env).",
    };
  }

  return { ids: activeIds, requestedIds, skippedLabels, error: null };
}

/**
 * @param {{ id: string, label: string, text: string, links: string[], error?: string, durationMs: number, usage?: object | null }} r
 */
function resultToStreamPayload(r) {
  return {
    id: r.id,
    label: r.label,
    text: r.text,
    links: r.links,
    error: r.error,
    durationMs: r.durationMs,
    usage: r.usage,
  };
}

/**
 * Плоский пул задач (запрос × модель), события по мере готовности ячеек.
 * Не настроенные провайдеры тоже приходят в `meta` и сразу в `result` с полем `error`.
 *
 * @param {string[]} queries
 * @param {string[]} selectedIds
 * @param {(ev: Record<string, unknown>) => void} emit — синхронно, не ждёт записи в сокет
 * @param {{ requestId?: string }} [logMeta]
 */
export async function streamSearchProgress(queries, selectedIds, emit, logMeta = {}) {
  const { ids: activeIds, requestedIds, skippedLabels, error } = resolveProviderIds(selectedIds);

  if (!requestedIds.length) {
    emit({ type: "error", message: error || "Нет провайдеров.", skippedLabels });
    return;
  }

  const configured = getConfiguredProviders();
  const totalCells = queries.length * requestedIds.length;
  let completed = 0;

  function nextProgress() {
    completed++;
    return totalCells ? Math.min(100, Math.round((100 * completed) / totalCells)) : 100;
  }

  emit({
    type: "meta",
    queries,
    providerIds: [...requestedIds],
    totalTasks: totalCells,
    skippedLabels,
  });

  const tasks = [];
  for (let qi = 0; qi < queries.length; qi++) {
    for (const id of requestedIds) {
      if (!configured[id]) {
        logEvent("info", "provider:skip", {
          providerId: id,
          reason: "not_configured",
          queryIndex: qi,
          ...logMeta,
        });
        emit({
          type: "result",
          queryIndex: qi,
          providerId: id,
          progress: nextProgress(),
          result: resultToStreamPayload(buildDisabledProviderResult(id)),
        });
      } else {
        tasks.push({ qi, id, query: queries[qi] });
      }
    }
  }

  await mapPool(tasks, STREAM_CELL_CONCURRENCY, async ({ qi, id, query }) => {
    const r = await runProvider(id, query, { ...logMeta, queryIndex: qi });
    emit({
      type: "result",
      queryIndex: qi,
      providerId: id,
      progress: nextProgress(),
      result: resultToStreamPayload(r),
    });
  });

  emit({ type: "done", skippedLabels });
}

/**
 * @template T, R
 * @param {T[]} array
 * @param {number} poolSize
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 */
async function mapPool(array, poolSize, mapper) {
  const results = new Array(array.length);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= array.length) break;
      results[i] = await mapper(array[i], i);
    }
  }
  if (array.length === 0) return results;
  const n = Math.min(Math.max(1, poolSize), array.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/**
 * Несколько запросов: внутри пакета — ограниченный параллелизм; у каждого запроса провайдеры по-прежнему параллельно.
 *
 * @param {string[]} queries
 * @param {string[]} selectedIds
 * @param {{ requestId?: string }} [logMeta]
 */
export async function searchBatchAcrossProviders(queries, selectedIds, logMeta = {}) {
  const { skippedLabels } = resolveProviderIds(selectedIds);
  const items = await mapPool(queries, BATCH_QUERY_CONCURRENCY, async (query) => {
    const out = await searchAcrossProviders(query, selectedIds, logMeta);
    return {
      query,
      results: out.results,
      error: out.error,
    };
  });
  return { batch: true, items, skippedLabels };
}

/**
 * @param {string} query
 * @param {string[]} selectedIds — список id или ['all']
 * @param {{ requestId?: string }} [logMeta]
 */
export async function searchAcrossProviders(query, selectedIds, logMeta = {}) {
  const { ids: activeIds, requestedIds, skippedLabels, error } = resolveProviderIds(selectedIds);

  if (!requestedIds.length) {
    return {
      results: [],
      skippedLabels,
      error: error || "Нет провайдеров.",
    };
  }

  const configured = getConfiguredProviders();

  if (!activeIds.length) {
    return {
      results: requestedIds.map((id) => {
        logEvent("info", "provider:skip", {
          providerId: id,
          reason: "not_configured",
          ...logMeta,
        });
        return buildDisabledProviderResult(id);
      }),
      skippedLabels,
      error,
    };
  }

  const activeResults = await Promise.all(activeIds.map((id) => runProvider(id, query, logMeta)));
  const byId = new Map(activeResults.map((r) => [r.id, r]));
  const results = requestedIds.map((id) => {
    if (!configured[id]) {
      logEvent("info", "provider:skip", {
        providerId: id,
        reason: "not_configured",
        ...logMeta,
      });
    }
    return byId.get(id) ?? buildDisabledProviderResult(id);
  });

  return { results, skippedLabels, error: null };
}

export { getConfiguredProviders, PROVIDER_IDS } from "./providers.js";
export { PROVIDER_LABELS } from "./providers.js";
