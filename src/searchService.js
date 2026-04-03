import {
  getConfiguredProviders,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  runProvider,
} from "./providers.js";

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
