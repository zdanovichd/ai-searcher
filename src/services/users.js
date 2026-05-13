import { getPool, withTransaction } from "../db.js";
import { hashPassword, verifyPassword, validatePasswordStrength } from "../auth/password.js";
import { generateOpaqueToken, hashOpaqueToken } from "../auth/jwt.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "./email.js";
import { writeAudit } from "./audit.js";

const EMAIL_TOKEN_TTL_HOURS = Math.max(1, Number(process.env.EMAIL_TOKEN_TTL_HOURS) || 48);
const RESET_TOKEN_TTL_HOURS = Math.max(1, Number(process.env.RESET_TOKEN_TTL_HOURS) || 2);

export function isEmailVerificationRequired() {
  return process.env.EMAIL_VERIFICATION_REQUIRED === "1";
}

/**
 * @typedef {{ id: string, email: string, role: 'user' | 'admin', is_active: boolean, email_verified_at: string | null, created_at: string, updated_at: string }} UserRow
 */

/**
 * @param {UserRow} row
 */
export function toPublicUser(row) {
  return {
    id: row.id != null ? String(row.id) : row.id,
    email: row.email,
    role: row.role,
    isActive: row.is_active,
    emailVerified: Boolean(row.email_verified_at),
    createdAt: row.created_at,
  };
}

/**
 * @param {string} email
 */
export async function findUserByEmail(email) {
  const { rows } = await getPool().query(
    `SELECT id, email, password_hash, role, is_active, email_verified_at, created_at, updated_at
     FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email.trim()]
  );
  return rows[0] || null;
}

/**
 * @param {string} id
 */
export async function findUserById(id) {
  const { rows } = await getPool().query(
    `SELECT id, email, password_hash, role, is_active, email_verified_at, created_at, updated_at
     FROM users WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * @param {{ email: string, password: string }} input
 */
export async function registerUser(input) {
  const email = input.email?.trim();
  const password = input.password;
  const emailErr = validateEmail(email);
  if (emailErr) throw new UserFacingError(emailErr, 400);
  const passErr = validatePasswordStrength(password);
  if (passErr) throw new UserFacingError(passErr, 400);

  const existing = await findUserByEmail(email);
  if (existing) throw new UserFacingError("Пользователь с таким email уже существует.", 409);

  const passwordHash = await hashPassword(password);
  const { rows: countRows } = await getPool().query(`SELECT COUNT(*)::int AS c FROM users`);
  const isFirst = (countRows[0]?.c || 0) === 0;
  const role = isFirst ? "admin" : "user";

  const user = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, role, email_verified_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, password_hash, role, is_active, email_verified_at, created_at, updated_at`,
      [email, passwordHash, role, isEmailVerificationRequired() ? null : new Date()]
    );
    const row = rows[0];
    await client.query(
      `INSERT INTO user_balances (user_id, balance) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [row.id, Number(process.env.DEFAULT_STARTING_BALANCE) || 100]
    );
    await client.query(
      `INSERT INTO user_limits (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [row.id]
    );
    return row;
  });

  let verificationTokenForTests;
  if (isEmailVerificationRequired()) {
    const token = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(token);
    const expiresAt = new Date(Date.now() + EMAIL_TOKEN_TTL_HOURS * 3600 * 1000);
    await getPool().query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt.toISOString()]
    );
    await sendVerificationEmail({ email: user.email, token });
    if (process.env.NODE_ENV === "test") verificationTokenForTests = token;
  }
  writeAudit("user.registered", { userId: user.id, email: user.email, role: user.role });
  return { user, verificationTokenForTests };
}

/**
 * @param {string} token
 */
export async function verifyEmailToken(token) {
  if (!token?.trim()) throw new UserFacingError("Токен не указан.", 400);
  const tokenHash = hashOpaqueToken(token.trim());
  const { rows } = await getPool().query(
    `SELECT t.id, t.user_id, t.expires_at, t.used_at, u.email
     FROM email_verification_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1
     LIMIT 1`,
    [tokenHash]
  );
  const row = rows[0];
  if (!row) throw new UserFacingError("Недействительная ссылка подтверждения.", 400);
  if (row.used_at) throw new UserFacingError("Ссылка уже использована.", 400);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new UserFacingError("Срок действия ссылки истёк.", 400);
  }
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [row.user_id]
    );
    await client.query(`UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1`, [row.id]);
  });
  writeAudit("user.email_verified", { userId: row.user_id, email: row.email });
}

/**
 * @param {string} email
 */
export async function resendVerificationEmail(email) {
  const user = await findUserByEmail(email);
  if (!user) return;
  if (user.email_verified_at) return;
  const token = generateOpaqueToken();
  const tokenHash = hashOpaqueToken(token);
  const expiresAt = new Date(Date.now() + EMAIL_TOKEN_TTL_HOURS * 3600 * 1000);
  await getPool().query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.id, tokenHash, expiresAt.toISOString()]
  );
  await sendVerificationEmail({ email: user.email, token });
  writeAudit("user.verification_resent", { userId: user.id, email: user.email });
}

/**
 * @param {string} email
 */
export async function requestPasswordReset(email) {
  const user = await findUserByEmail(email);
  if (!user) return;
  const token = generateOpaqueToken();
  const tokenHash = hashOpaqueToken(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_HOURS * 3600 * 1000);
  await getPool().query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.id, tokenHash, expiresAt.toISOString()]
  );
  await sendPasswordResetEmail({ email: user.email, token });
  writeAudit("user.password_reset_requested", { userId: user.id, email: user.email });
}

/**
 * @param {{ token: string, password: string }} input
 */
export async function resetPasswordWithToken(input) {
  const token = input.token?.trim();
  const password = input.password;
  const passErr = validatePasswordStrength(password);
  if (passErr) throw new UserFacingError(passErr, 400);
  if (!token) throw new UserFacingError("Токен не указан.", 400);
  const tokenHash = hashOpaqueToken(token);
  const { rows } = await getPool().query(
    `SELECT t.id, t.user_id, t.expires_at, t.used_at, u.email
     FROM password_reset_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1
     LIMIT 1`,
    [tokenHash]
  );
  const row = rows[0];
  if (!row) throw new UserFacingError("Недействительная ссылка сброса.", 400);
  if (row.used_at) throw new UserFacingError("Ссылка уже использована.", 400);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new UserFacingError("Срок действия ссылки истёк.", 400);
  }
  const passwordHash = await hashPassword(password);
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [passwordHash, row.user_id]
    );
    await client.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`, [row.id]);
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [row.user_id]
    );
  });
  writeAudit("user.password_reset_completed", { userId: row.user_id, email: row.email });
}

/**
 * @param {{ userId: string, currentPassword: string, newPassword: string }} input
 */
export async function changePassword(input) {
  const user = await findUserById(input.userId);
  if (!user) throw new UserFacingError("Пользователь не найден.", 404);
  const ok = await verifyPassword(input.currentPassword, user.password_hash);
  if (!ok) throw new UserFacingError("Неверный текущий пароль.", 400);
  const passErr = validatePasswordStrength(input.newPassword);
  if (passErr) throw new UserFacingError(passErr, 400);
  const passwordHash = await hashPassword(input.newPassword);
  await getPool().query(
    `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
    [passwordHash, user.id]
  );
  writeAudit("user.password_changed", { userId: user.id, email: user.email });
}

/**
 * @param {string} email
 */
function validateEmail(email) {
  if (!email || typeof email !== "string") return "Укажите email.";
  const trimmed = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "Некорректный email.";
  return null;
}

export class UserFacingError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   */
  constructor(message, status) {
    super(message);
    this.name = "UserFacingError";
    this.status = status;
  }
}
