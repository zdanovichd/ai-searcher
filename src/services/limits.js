import { getPool } from "../db.js";
import { MAX_BATCH_QUERIES } from "../searchService.js";

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function monthStartUtc() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * @param {string} userId
 */
export async function getUserLimits(userId) {
  const { rows } = await getPool().query(
    `SELECT daily_queries, monthly_queries, max_batch_size FROM user_limits WHERE user_id = $1`,
    [userId]
  );
  const row = rows[0] || {};
  return {
    dailyQueries: row.daily_queries ?? null,
    monthlyQueries: row.monthly_queries ?? null,
    maxBatchSize: row.max_batch_size ?? MAX_BATCH_QUERIES,
  };
}

/**
 * @param {string} userId
 */
export async function getUsageSnapshot(userId) {
  const day = todayUtc();
  const month = monthStartUtc();
  const { rows } = await getPool().query(
    `SELECT period_type, period_start, query_count
     FROM usage_counters
     WHERE user_id = $1 AND ((period_type = 'day' AND period_start = $2) OR (period_type = 'month' AND period_start = $3))`,
    [userId, day, month]
  );
  const dayCount = rows.find((r) => r.period_type === "day")?.query_count || 0;
  const monthCount = rows.find((r) => r.period_type === "month")?.query_count || 0;
  return { dayCount, monthCount, day, month };
}

/**
 * @param {{ userId: string, queryCount: number }} input
 */
export async function assertWithinLimits(input) {
  const limits = await getUserLimits(input.userId);
  const usage = await getUsageSnapshot(input.userId);
  if (limits.maxBatchSize && input.queryCount > limits.maxBatchSize) {
    const err = new Error(`Превышен лимит размера пакета (макс. ${limits.maxBatchSize}).`);
    Object.assign(err, { status: 429 });
    throw err;
  }
  if (limits.dailyQueries != null && usage.dayCount + input.queryCount > limits.dailyQueries) {
    const err = new Error("Превышен дневной лимит запросов.");
    Object.assign(err, { status: 429 });
    throw err;
  }
  if (limits.monthlyQueries != null && usage.monthCount + input.queryCount > limits.monthlyQueries) {
    const err = new Error("Превышен месячный лимит запросов.");
    Object.assign(err, { status: 429 });
    throw err;
  }
}

/**
 * @param {{ userId: string, queryCount: number }} input
 */
export async function recordUsage(input) {
  const day = todayUtc();
  const month = monthStartUtc();
  const count = Math.max(1, input.queryCount);
  await getPool().query(
    `INSERT INTO usage_counters (user_id, period_type, period_start, query_count)
     VALUES ($1, 'day', $2, $3)
     ON CONFLICT (user_id, period_type, period_start)
     DO UPDATE SET query_count = usage_counters.query_count + EXCLUDED.query_count`,
    [input.userId, day, count]
  );
  await getPool().query(
    `INSERT INTO usage_counters (user_id, period_type, period_start, query_count)
     VALUES ($1, 'month', $2, $3)
     ON CONFLICT (user_id, period_type, period_start)
     DO UPDATE SET query_count = usage_counters.query_count + EXCLUDED.query_count`,
    [input.userId, month, count]
  );
}

/**
 * @param {{ userId: string, dailyQueries?: number | null, monthlyQueries?: number | null, maxBatchSize?: number | null }} input
 */
export async function updateUserLimits(input) {
  await getPool().query(
    `INSERT INTO user_limits (user_id, daily_queries, monthly_queries, max_batch_size, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET
       daily_queries = COALESCE(EXCLUDED.daily_queries, user_limits.daily_queries),
       monthly_queries = COALESCE(EXCLUDED.monthly_queries, user_limits.monthly_queries),
       max_batch_size = COALESCE(EXCLUDED.max_batch_size, user_limits.max_batch_size),
       updated_at = NOW()`,
    [input.userId, input.dailyQueries ?? null, input.monthlyQueries ?? null, input.maxBatchSize ?? null]
  );
}

/**
 * Полная замена лимитов (null = без лимита по дню/месяцу). Для админки.
 * @param {{ userId: string, dailyQueries?: number | null, monthlyQueries?: number | null, maxBatchSize?: number | null }} input
 */
export async function replaceUserLimits(input) {
  const maxBatch =
    input.maxBatchSize != null && Number.isFinite(input.maxBatchSize)
      ? input.maxBatchSize
      : MAX_BATCH_QUERIES;
  await getPool().query(
    `INSERT INTO user_limits (user_id, daily_queries, monthly_queries, max_batch_size, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET
       daily_queries = EXCLUDED.daily_queries,
       monthly_queries = EXCLUDED.monthly_queries,
       max_batch_size = EXCLUDED.max_batch_size,
       updated_at = NOW()`,
    [input.userId, input.dailyQueries ?? null, input.monthlyQueries ?? null, maxBatch]
  );
}
