import {
  getConfiguredProviders,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  runProvider,
} from "./providers.js";

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
 * @param {string[]} selectedIds
 * @returns {{ ids: string[], skippedLabels: string[], error: string | null }}
 */
export function resolveProviderIds(selectedIds) {
  const configured = getConfiguredProviders();
  const ids =
    selectedIds?.includes("all") || !selectedIds?.length
      ? PROVIDER_IDS.filter((id) => configured[id])
      : selectedIds.filter((id) => PROVIDER_IDS.includes(id) && configured[id]);
  const skippedLabels = skippedLabelsFrom(configured);
  if (!ids.length) {
    return {
      ids: [],
      skippedLabels,
      error: "Ни один провайдер не выбран или не настроен (проверьте .env).",
    };
  }
  return { ids, skippedLabels, error: null };
}

/**
 * Плоский пул задач (запрос × модель), события по мере готовности ячеек.
 *
 * @param {string[]} queries
 * @param {string[]} selectedIds
 * @param {(ev: Record<string, unknown>) => void} emit — синхронно, не ждёт записи в сокет
 */
export async function streamSearchProgress(queries, selectedIds, emit) {
  const { ids, skippedLabels, error } = resolveProviderIds(selectedIds);
  if (error) {
    emit({ type: "error", message: error, skippedLabels });
    return;
  }
  const tasks = [];
  for (let qi = 0; qi < queries.length; qi++) {
    for (const id of ids) {
      tasks.push({ qi, id, query: queries[qi] });
    }
  }
  const total = tasks.length;
  emit({
    type: "meta",
    queries,
    providerIds: [...ids],
    totalTasks: total,
    skippedLabels,
  });
  let completed = 0;
  await mapPool(tasks, STREAM_CELL_CONCURRENCY, async ({ qi, id, query }) => {
    const r = await runProvider(id, query);
    completed++;
    emit({
      type: "result",
      queryIndex: qi,
      providerId: id,
      progress: total ? Math.min(100, Math.round((100 * completed) / total)) : 100,
      result: {
        id: r.id,
        label: r.label,
        text: r.text,
        links: r.links,
        error: r.error,
        durationMs: r.durationMs,
        usage: r.usage,
      },
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
  const n = Math.min(Math.max(1, poolSize), array.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/**
 * Несколько запросов: внутри пакета — ограниченный параллелизм; у каждого запроса провайдеры по-прежнему параллельно.
 *
 * @param {string[]} queries
 * @param {string[]} selectedIds
 */
export async function searchBatchAcrossProviders(queries, selectedIds) {
  const skippedLabels = skippedLabelsFrom(getConfiguredProviders());
  const items = await mapPool(queries, BATCH_QUERY_CONCURRENCY, async (query) => {
    const out = await searchAcrossProviders(query, selectedIds);
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
 */
export async function searchAcrossProviders(query, selectedIds) {
  const { ids, skippedLabels, error } = resolveProviderIds(selectedIds);
  if (error) {
    return {
      results: [],
      skippedLabels,
      error,
    };
  }

  const results = await Promise.all(ids.map((id) => runProvider(id, query)));

  return { results, skippedLabels, error: null };
}

function skippedLabelsFrom(configured) {
  return PROVIDER_IDS.filter((id) => !configured[id]).map(
    (id) => PROVIDER_LABELS[id] || id
  );
}

export { getConfiguredProviders, PROVIDER_IDS } from "./providers.js";
export { PROVIDER_LABELS } from "./providers.js";
