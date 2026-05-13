import bcrypt from "bcryptjs";

const ROUNDS = Math.max(10, Math.min(14, Number(process.env.BCRYPT_ROUNDS) || 12));

/**
 * @param {string} password
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, ROUNDS);
}

/**
 * @param {string} password
 * @param {string} hash
 */
export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * @param {string} password
 * @returns {string | null}
 */
export function validatePasswordStrength(password) {
  if (typeof password !== "string" || password.length < 8) {
    return "Пароль должен быть не короче 8 символов.";
  }
  return null;
}
