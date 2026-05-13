import crypto from "node:crypto";
import { getPool } from "../db.js";
import { isEmailVerificationRequired } from "./users.js";
import { hashOpaqueToken } from "../auth/jwt.js";
import { writeAudit } from "./audit.js";

const API_KEY_PREFIX = "ais_";

/**
 * @param {string} userId
 * @param {string} [name]
 */
export async function createApiKey(userId, name = "") {
  const secret = crypto.randomBytes(24).toString("base64url");
  const fullKey = `${API_KEY_PREFIX}${secret}`;
  const prefix = fullKey.slice(0, 12);
  const keyHash = hashOpaqueToken(fullKey);
  const { rows } = await getPool().query(
    `INSERT INTO api_keys (user_id, name, key_prefix, key_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, name, key_prefix, created_at, last_used_at, revoked_at`,
    [userId, name.trim(), prefix, keyHash]
  );
  writeAudit("api_key.created", { userId, apiKeyId: rows[0].id, prefix });
  return { record: rows[0], secret: fullKey };
}

/**
 * @param {string} userId
 */
export async function listApiKeys(userId) {
  const { rows } = await getPool().query(
    `SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
     FROM api_keys
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    active: !row.revoked_at,
  }));
}

/**
 * @param {{ userId: string, apiKeyId: string }} input
 */
export async function revokeApiKey(input) {
  const { rows } = await getPool().query(
    `UPDATE api_keys
     SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id, key_prefix`,
    [input.apiKeyId, input.userId]
  );
  if (!rows[0]) return false;
  writeAudit("api_key.revoked", { userId: input.userId, apiKeyId: rows[0].id, prefix: rows[0].key_prefix });
  return true;
}

/**
 * @param {string} rawKey
 */
export async function resolveApiKey(rawKey) {
  const key = rawKey?.trim();
  if (!key || !key.startsWith(API_KEY_PREFIX)) return null;
  const keyHash = hashOpaqueToken(key);
  const { rows } = await getPool().query(
    `SELECT k.id, k.user_id, k.revoked_at, u.role, u.is_active, u.email_verified_at
     FROM api_keys k
     JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = $1
     LIMIT 1`,
    [keyHash]
  );
  const row = rows[0];
  if (!row || row.revoked_at) return null;
  if (!row.is_active || (isEmailVerificationRequired() && !row.email_verified_at)) return null;
  await getPool().query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [row.id]);
  return {
    apiKeyId: row.id,
    userId: row.user_id,
    role: row.role,
  };
}
