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
  const configured = getConfiguredProviders();
  let ids =
    selectedIds?.includes("all") || !selectedIds?.length
      ? PROVIDER_IDS.filter((id) => configured[id])
      : selectedIds.filter((id) => PROVIDER_IDS.includes(id) && configured[id]);

  if (!ids.length) {
    return {
      results: [],
      skippedLabels: skippedLabelsFrom(configured),
      error: "Ни один провайдер не выбран или не настроен (проверьте .env).",
    };
  }

  const results = await Promise.all(ids.map((id) => runProvider(id, query)));
  const skippedLabels = skippedLabelsFrom(configured);

  return { results, skippedLabels, error: null };
}

function skippedLabelsFrom(configured) {
  return PROVIDER_IDS.filter((id) => !configured[id]).map(
    (id) => PROVIDER_LABELS[id] || id
  );
}

export { getConfiguredProviders, PROVIDER_IDS } from "./providers.js";
export { PROVIDER_LABELS } from "./providers.js";
