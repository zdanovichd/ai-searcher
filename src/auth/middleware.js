import { verifyJwt } from "./jwt.js";
import { readRefreshCookie, validateStoredRefreshToken } from "./sessions.js";
import { resolveApiKey } from "../services/apiKeys.js";
import { findUserById, toPublicUser, isEmailVerificationRequired } from "../services/users.js";
import { getRequestLogContext, logEvent } from "../logger.js";

/**
 * @param {import('express').Request} req
 */
function readBearerToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth !== "string") return null;
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return auth.trim();
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function requireAccessAuth(req, res, next) {
  const token = readBearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Требуется авторизация (Bearer access JWT)." });
    return;
  }
  try {
    const payload = verifyJwt(token);
    if (payload.typ !== "access") {
      res.status(401).json({ error: "Нужен access JWT." });
      return;
    }
    const user = await findUserById(payload.sub);
    if (!user || !user.is_active) {
      res.status(401).json({ error: "Пользователь недоступен." });
      return;
    }
    if (isEmailVerificationRequired() && !user.email_verified_at) {
      res.status(403).json({ error: "Подтвердите email." });
      return;
    }
    req.authUser = toPublicUser(user);
    next();
  } catch (e) {
    logEvent("warn", "auth:jwt_rejected", { ...getRequestLogContext(req), message: e?.message });
    res.status(401).json({ error: "Недействительный или просроченный токен." });
  }
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireAdmin(req, res, next) {
  if (!req.authUser || req.authUser.role !== "admin") {
    res.status(403).json({ error: "Доступ только для администратора." });
    return;
  }
  next();
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function requireUserApiKey(req, res, next) {
  const bearer = readBearerToken(req);
  const headerKey = req.headers["x-api-key"];
  const raw = typeof headerKey === "string" && headerKey.trim() ? headerKey.trim() : bearer;
  if (!raw) {
    res.status(401).json({
      error: "Нужен API-ключ: заголовок X-API-Key или Authorization: Bearer <ключ>.",
    });
    return;
  }
  const resolved = await resolveApiKey(raw);
  if (!resolved) {
    logEvent("warn", "auth:api_key_rejected", getRequestLogContext(req));
    res.status(401).json({ error: "Недействительный API-ключ." });
    return;
  }
  req.apiAuth = resolved;
  const user = await findUserById(resolved.userId);
  if (!user) {
    res.status(401).json({ error: "Пользователь API-ключа не найден." });
    return;
  }
  req.authUser = toPublicUser(user);
  next();
}

/**
 * Публичные пути без JWT (страницы auth и их API).
 * @param {string} path
 */
export function isPublicWebPath(path) {
  return (
    path === "/login" ||
    path === "/register" ||
    path === "/forgot-password" ||
    path === "/reset-password" ||
    path === "/verify-email" ||
    path === "/legal" ||
    path.startsWith("/legal/") ||
    path.startsWith("/auth/") ||
    path.startsWith("/api/auth/")
  );
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function protectHtmlPages(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    next();
    return;
  }
  const path = req.path || "/";
  if (path.startsWith("/api/")) {
    next();
    return;
  }
  if (isPublicWebPath(path)) {
    next();
    return;
  }
  if (
    path === "/cabinet" ||
    path === "/cabinet/" ||
    path === "/cabinet/search" ||
    path === "/admin" ||
    path === "/admin/" ||
    path === "/admin/user" ||
    path === "/admin/user/" ||
    path === "/legal" ||
    path.startsWith("/legal/")
  ) {
    next();
    return;
  }
  if (
    path.startsWith("/vendor/") ||
    path.startsWith("/shared/") ||
    path === "/openapi.json" ||
    path.startsWith("/api-docs") ||
    path.endsWith(".css") ||
    path.endsWith(".js") ||
    path.endsWith(".mjs") ||
    path === "/robots.txt"
  ) {
    next();
    return;
  }
  const refresh = readRefreshCookie(req);
  if (!refresh) {
    res.redirect(302, "/login");
    return;
  }
  validateStoredRefreshToken(refresh)
    .then(() => next())
    .catch(() => {
      res.redirect(302, "/login");
    });
}
