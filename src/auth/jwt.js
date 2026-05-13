import crypto from "node:crypto";
import jwt from "jsonwebtoken";

function getSecret() {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET должен быть задан и не короче 32 символов.");
  }
  return secret;
}

/**
 * @typedef {{ sub: string, role: 'user' | 'admin', typ: 'access' | 'refresh' }} JwtPayload
 */

/**
 * @param {{ userId: string, role: string }} input
 */
export function signAccessToken(input) {
  const ttl = process.env.JWT_ACCESS_TTL?.trim() || "15m";
  return jwt.sign(
    { sub: input.userId, role: input.role, typ: "access" },
    getSecret(),
    { expiresIn: ttl }
  );
}

/**
 * @param {{ userId: string, role: string }} input
 */
export function signRefreshToken(input) {
  const ttl = process.env.JWT_REFRESH_TTL?.trim() || "30d";
  return jwt.sign(
    { sub: input.userId, role: input.role, typ: "refresh", jti: crypto.randomUUID() },
    getSecret(),
    { expiresIn: ttl }
  );
}

/**
 * @param {string} token
 * @returns {JwtPayload}
 */
export function verifyJwt(token) {
  const payload = jwt.verify(token, getSecret());
  if (!payload || typeof payload !== "object") {
    throw new Error("Некорректный JWT.");
  }
  const sub = payload.sub;
  const role = payload.role;
  const typ = payload.typ;
  if (typeof sub !== "string" || (role !== "user" && role !== "admin")) {
    throw new Error("Некорректный JWT.");
  }
  if (typ !== "access" && typ !== "refresh") {
    throw new Error("Некорректный тип JWT.");
  }
  return { sub, role, typ };
}

/**
 * @param {string} raw
 */
export function hashOpaqueToken(raw) {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * @param {number} [bytes]
 */
export function generateOpaqueToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}
