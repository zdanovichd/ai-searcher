import { getPool } from "../db.js";
import { encryptJson, decryptJson } from "../auth/crypto.js";
import { PROVIDER_IDS } from "../providers.js";

/**
 * @param {string} userId
 */
export async function listUserProviderCredentials(userId) {
  const { rows } = await getPool().query(
    `SELECT provider_id, updated_at FROM user_provider_credentials WHERE user_id = $1`,
    [userId]
  );
  const configured = new Set(rows.map((r) => r.provider_id));
  return PROVIDER_IDS.map((id) => ({
    providerId: id,
    configured: configured.has(id),
    updatedAt: rows.find((r) => r.provider_id === id)?.updated_at || null,
  }));
}

/**
 * @param {{ userId: string, providerId: string, values: Record<string, string> }} input
 */
export async function upsertUserProviderCredentials(input) {
  if (!PROVIDER_IDS.includes(input.providerId)) {
    throw new Error("Неизвестный провайдер.");
  }
  const encrypted = encryptJson(input.values);
  await getPool().query(
    `INSERT INTO user_provider_credentials (user_id, provider_id, encrypted_payload, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, provider_id)
     DO UPDATE SET encrypted_payload = EXCLUDED.encrypted_payload, updated_at = NOW()`,
    [input.userId, input.providerId, encrypted]
  );
}

/**
 * @param {{ userId: string, providerId: string }} input
 */
export async function deleteUserProviderCredentials(input) {
  await getPool().query(
    `DELETE FROM user_provider_credentials WHERE user_id = $1 AND provider_id = $2`,
    [input.userId, input.providerId]
  );
}

/**
 * @param {string} userId
 * @returns {Promise<Record<string, Record<string, string>>>}
 */
export async function getUserProviderSecretsMap(userId) {
  const { rows } = await getPool().query(
    `SELECT provider_id, encrypted_payload FROM user_provider_credentials WHERE user_id = $1`,
    [userId]
  );
  /** @type {Record<string, Record<string, string>>} */
  const out = {};
  for (const row of rows) {
    out[row.provider_id] = decryptJson(row.encrypted_payload);
  }
  return out;
}
