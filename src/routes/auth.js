import { Router } from "express";
import { verifyPassword } from "../auth/password.js";
import { signAccessToken } from "../auth/jwt.js";
import {
  clearRefreshCookie,
  readRefreshCookie,
  revokeRefreshToken,
  setRefreshCookie,
  signRefreshToken,
  storeRefreshToken,
  validateStoredRefreshToken,
} from "../auth/sessions.js";
import {
  UserFacingError,
  findUserByEmail,
  registerUser,
  requestPasswordReset,
  resendVerificationEmail,
  resetPasswordWithToken,
  toPublicUser,
  verifyEmailToken,
  isEmailVerificationRequired,
} from "../services/users.js";
import { writeAudit } from "../services/audit.js";

const router = Router();

/**
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => unknown | Promise<unknown>} fn
 */
function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * @param {unknown} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function handleUserError(err, req, res, next) {
  if (err instanceof UserFacingError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
}

router.use(handleUserError);

router.post(
  "/register",
  asyncRoute(async (req, res) => {
    const { email, password } = req.body || {};
    const result = await registerUser({ email, password });
    res.status(201).json({
      message: isEmailVerificationRequired()
        ? "Регистрация выполнена. Проверьте почту для подтверждения email."
        : "Регистрация выполнена. Можно войти в личный кабинет.",
      user: toPublicUser(result.user),
    });
  })
);

router.post(
  "/login",
  asyncRoute(async (req, res) => {
    const email = req.body?.email?.trim();
    const password = req.body?.password;
    if (!email || !password) {
      res.status(400).json({ error: "Укажите email и пароль." });
      return;
    }
    const user = await findUserByEmail(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      writeAudit("auth.login_failed", { email });
      res.status(401).json({ error: "Неверный email или пароль." });
      return;
    }
    if (!user.is_active) {
      res.status(403).json({ error: "Учётная запись заблокирована." });
      return;
    }
    const accessToken = signAccessToken({ userId: user.id, role: user.role });
    const refreshToken = signRefreshToken({ userId: user.id, role: user.role });
    const decoded = JSON.parse(Buffer.from(refreshToken.split(".")[1], "base64url").toString("utf8"));
    const expiresAt = new Date((decoded.exp || 0) * 1000);
    await storeRefreshToken({ userId: user.id, role: user.role, refreshToken, expiresAt });
    setRefreshCookie(res, refreshToken);
    writeAudit("auth.login", { userId: user.id, email: user.email });
    res.json({
      accessToken,
      user: toPublicUser(user),
    });
  })
);

router.post(
  "/refresh",
  asyncRoute(async (req, res) => {
    const refreshToken = readRefreshCookie(req) || req.body?.refreshToken;
    if (!refreshToken) {
      res.status(401).json({ error: "Refresh-токен не найден." });
      return;
    }
    const payload = await validateStoredRefreshToken(refreshToken);
    const accessToken = signAccessToken({ userId: payload.sub, role: payload.role });
    res.json({ accessToken });
  })
);

router.post(
  "/logout",
  asyncRoute(async (req, res) => {
    const refreshToken = readRefreshCookie(req);
    if (refreshToken) {
      await revokeRefreshToken(refreshToken);
    }
    clearRefreshCookie(res);
    writeAudit("auth.logout", { userId: req.authUser?.id || null });
    res.json({ ok: true });
  })
);

router.post(
  "/verify-email",
  asyncRoute(async (req, res) => {
    const token = req.body?.token || req.query?.token;
    await verifyEmailToken(String(token || ""));
    res.json({ message: "Email подтверждён." });
  })
);

router.post(
  "/resend-verification",
  asyncRoute(async (req, res) => {
    const email = req.body?.email?.trim();
    if (!email) {
      res.status(400).json({ error: "Укажите email." });
      return;
    }
    await resendVerificationEmail(email);
    res.json({ message: "Если аккаунт существует и не подтверждён, письмо отправлено." });
  })
);

router.post(
  "/forgot-password",
  asyncRoute(async (req, res) => {
    const email = req.body?.email?.trim();
    if (!email) {
      res.status(400).json({ error: "Укажите email." });
      return;
    }
    await requestPasswordReset(email);
    res.json({ message: "Если аккаунт существует, письмо со ссылкой отправлено." });
  })
);

router.post(
  "/reset-password",
  asyncRoute(async (req, res) => {
    const { token, password } = req.body || {};
    await resetPasswordWithToken({ token, password });
    res.json({ message: "Пароль обновлён." });
  })
);

export default router;
