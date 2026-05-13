import crypto from "node:crypto";

function getEncryptionKey() {
  const raw = process.env.APP_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error("APP_ENCRYPTION_KEY не задан.");
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

/**
 * @param {Record<string, string>} payload
 */
export function encryptJson(payload) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const json = JSON.stringify(payload);
  const enc = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/**
 * @param {string} encoded
 * @returns {Record<string, string>}
 */
export function decryptJson(encoded) {
  const key = getEncryptionKey();
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const json = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Некорректные зашифрованные данные.");
  }
  return parsed;
}
