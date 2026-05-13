import { getPool } from "../db.js";

const HIST_SNIPPET = 2800;
const HIST_QUERY = 700;
const HIST_STREAM_MAX_CELLS = 150;

function truncateHist(s, max) {
  const t = typeof s === "string" ? s : String(s ?? "");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/**
 * Снимок ответов для записи в search_history.result_summary (ограниченный по размеру).
 * @param {{ batch: boolean, out: { results?: unknown[], items?: unknown[], error?: string | null } }} param0
 */
export function summarizeSearchOutcomeForHistory({ batch, out }) {
  if (!out) return { v: 1 };
  try {
    if (batch && Array.isArray(out.items)) {
      return {
        v: 1,
        batch: true,
        rows: out.items.map((it) => ({
          query: truncateHist(it.query || "", HIST_QUERY),
          planError: it.error || null,
          providers: (it.results || []).map((r) => ({
            id: r.id,
            label: r.label,
            text: truncateHist(r.text || "", HIST_SNIPPET),
            error: r.error || null,
          })),
        })),
      };
    }
    if (!batch && Array.isArray(out.results)) {
      return {
        v: 1,
        batch: false,
        providers: out.results.map((r) => ({
          id: r.id,
          label: r.label,
          text: truncateHist(r.text || "", HIST_SNIPPET),
          error: r.error || null,
        })),
      };
    }
  } catch {
    return { v: 1, error: "snapshot_failed" };
  }
  return { v: 1 };
}

/** Накопление данных для addSearchHistory после SSE-поиска. */
export function createStreamHistorySummary() {
  return { v: 1, mode: "stream", metaQueries: null, cells: [] };
}

/**
 * @param {Record<string, unknown>} summary
 * @param {Record<string, unknown>} ev
 */
export function consumeStreamHistoryEvent(summary, ev) {
  if (!summary || !ev) return;
  if (ev.type === "meta" && Array.isArray(ev.queries)) {
    summary.metaQueries = ev.queries.map((q) => truncateHist(String(q ?? ""), HIST_QUERY));
  }
  if (ev.type === "result" && ev.result && summary.cells.length < HIST_STREAM_MAX_CELLS) {
    summary.cells.push({
      qi: typeof ev.queryIndex === "number" ? ev.queryIndex : 0,
      pid: ev.providerId,
      label: ev.result.label,
      text: truncateHist(ev.result.text || "", HIST_SNIPPET),
      error: ev.result.error || null,
    });
  }
}

/**
 * @param {{ userId: string, queryText?: string, providers: string[], batch: boolean, queryCount: number, resultSummary?: unknown }} input
 */
export async function addSearchHistory(input) {
  await getPool().query(
    `INSERT INTO search_history (user_id, query_text, providers, batch, query_count, result_summary)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb)`,
    [
      input.userId,
      input.queryText || null,
      JSON.stringify(input.providers || []),
      input.batch,
      input.queryCount,
      input.resultSummary ? JSON.stringify(input.resultSummary) : null,
    ]
  );
}

/**
 * @param {{ userId: string, limit?: number, offset?: number }} input
 */
export async function listSearchHistory(input) {
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
  const offset = Math.max(0, Number(input.offset) || 0);
  const { rows } = await getPool().query(
    `SELECT id, query_text, providers, batch, query_count, result_summary, created_at
     FROM search_history
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [input.userId, limit, offset]
  );
  return rows.map((row) => ({
    id: row.id,
    queryText: row.query_text,
    providers: row.providers,
    batch: row.batch,
    queryCount: row.query_count,
    resultSummary: row.result_summary,
    createdAt: row.created_at,
  }));
}

/**
 * @param {{ userId?: string, limit?: number, offset?: number }} input
 */
export async function listSearchHistoryAdmin(input) {
  const limit = Math.max(1, Math.min(200, Number(input.limit) || 50));
  const offset = Math.max(0, Number(input.offset) || 0);
  const uid = input.userId != null ? String(input.userId).trim() : "";
  if (uid) {
    const { rows } = await getPool().query(
      `SELECT id, user_id, query_text, providers, batch, query_count, result_summary, created_at
       FROM search_history
       WHERE user_id = $1::uuid
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [uid, limit, offset]
    );
    return rows;
  }
  const { rows } = await getPool().query(
    `SELECT id, user_id, query_text, providers, batch, query_count, result_summary, created_at
     FROM search_history
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}
