import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { logEvent } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {pg.Pool | null} */
let pool = null;

/**
 * @returns {pg.Pool}
 */
export function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("Не задан DATABASE_URL для PostgreSQL.");
  }
  pool = new pg.Pool({
    connectionString,
    max: Math.max(2, Math.min(20, Number(process.env.PG_POOL_MAX) || 10)),
  });
  pool.on("error", (err) => {
    logEvent("error", "db:pool_error", { message: err?.message || String(err) });
  });
  return pool;
}

export async function initDatabase() {
  const p = getPool();
  const schemaPath = path.join(__dirname, "..", "schema", "init.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  await p.query(sql);
  logEvent("info", "db:schema_ready", {});
}

/**
 * @template T
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
