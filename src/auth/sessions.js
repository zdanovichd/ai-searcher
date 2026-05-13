import { getPool } from "../db.js";
import { hashOpaqueToken, signRefreshToken, verifyJwt } from "../auth/jwt.js";

const REFRESH_COOKIE = process.env.REFRESH_COOKIE_NAME?.trim() || "ais_refresh";

/**
 * @param {{ userId: string, role: string, refreshToken: string, expiresAt: Date }} input
 */
export async function storeRefreshToken(input) {
  const tokenHash = hashOpaqueToken(input.refreshToken);
  await getPool().query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [input.userId, tokenHash, input.expiresAt.toISOString()]
  );
}

/**
 * @param {string} refreshToken
 */
export async function revokeRefreshToken(refreshToken) {
  const tokenHash = hashOpaqueToken(refreshToken);
  await getPool().query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
}

/**
 * @param {string} refreshToken
 */
export async function validateStoredRefreshToken(refreshToken) {
  const payload = verifyJwt(refreshToken);
  if (payload.typ !== "refresh") throw new Error("Неверный тип токена.");
  const tokenHash = hashOpaqueToken(refreshToken);
  const { rows } = await getPool().query(
    `SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1 LIMIT 1`,
    [tokenHash]
  );
  const row = rows[0];
  if (!row || row.revoked_at) throw new Error("Refresh-токен недействителен.");
  if (new Date(row.expires_at).getTime() < Date.now()) throw new Error("Refresh-токен истёк.");
  if (row.user_id !== payload.sub) throw new Error("Refresh-токен не совпадает с пользователем.");
  return payload;
}

export function getRefreshCookieName() {
  return REFRESH_COOKIE;
}

/**
 * @param {import('express').Response} res
 * @param {string} token
 */
export function setRefreshCookie(res, token) {
  const secure = process.env.COOKIE_SECURE === "1" || process.env.NODE_ENV === "production";
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

/**
 * @param {import('express').Response} res
 */
export function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { path: "/" });
}

/**
 * @param {import('express').Request} req
 */
export function readRefreshCookie(req) {
  const cookies = req.headers.cookie;
  if (!cookies) return null;
  const parts = cookies.split(";").map((p) => p.trim());
  for (const part of parts) {
    if (part.startsWith(`${REFRESH_COOKIE}=`)) {
      return decodeURIComponent(part.slice(REFRESH_COOKIE.length + 1));
    }
  }
  return null;
}

export { signRefreshToken };
