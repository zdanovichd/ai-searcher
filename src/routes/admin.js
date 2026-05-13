import { Router } from "express";
import { requireAccessAuth, requireAdmin } from "../auth/middleware.js";
import { verifyPassword } from "../auth/password.js";
import { getPool } from "../db.js";
import { adjustUserBalance, getUserBalance } from "../services/balance.js";
import {
  replaceUserLimits,
  getUserLimits,
  getUsageSnapshot,
} from "../services/limits.js";
import { listSearchHistoryAdmin } from "../services/history.js";
import { findUserById, toPublicUser } from "../services/users.js";
import { listApiKeys, revokeApiKey } from "../services/apiKeys.js";
import { writeAudit } from "../services/audit.js";
import { getRequestLogContext, logEvent } from "../logger.js";

const router = Router();

const UUID_PARAM_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

router.use(requireAccessAuth, requireAdmin);

function pickQueryUserId(req) {
  const raw = req.query.userId;
  if (Array.isArray(raw)) return String(raw[0] ?? "").trim();
  if (raw == null) return "";
  return String(raw).trim();
}

router.get(
  "/history",
  asyncRoute(async (req, res) => {
    const uid = pickQueryUserId(req);
    if (
      uid &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uid)
    ) {
      res.status(400).json({ error: "Некорректный userId." });
      return;
    }
    const items = await listSearchHistoryAdmin({
      userId: uid || undefined,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ items });
  })
);

router.get(
  "/users",
  asyncRoute(async (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const { rows } = await getPool().query(
      `SELECT id, email, role, is_active, email_verified_at, created_at, updated_at
       FROM users
       ORDER BY created_at ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const { rows: countRows } = await getPool().query(`SELECT COUNT(*)::int AS c FROM users`);
    res.json({
      total: countRows[0]?.c || 0,
      items: rows.map(toPublicUser),
    });
  })
);

router.get(
  "/users/:id",
  asyncRoute(async (req, res) => {
    let id = String(req.params.id ?? "").trim();
    try {
      id = decodeURIComponent(id);
    } catch {
      /* оставляем как есть */
    }
    if (!id) {
      res.status(400).json({ error: "Не указан id пользователя." });
      return;
    }
    if (!UUID_PARAM_RE.test(id)) {
      res.status(400).json({ error: "Некорректный id пользователя." });
      return;
    }
    let user;
    try {
      user = await findUserById(id);
    } catch (e) {
      logEvent("warn", "admin:user_lookup_invalid_id", {
        ...getRequestLogContext(req),
        message: e?.message || String(e),
      });
      res.status(400).json({ error: "Некорректный id пользователя." });
      return;
    }
    if (!user) {
      res.status(404).json({ error: "Пользователь не найден." });
      return;
    }
    res.json({ user: toPublicUser(user) });
  })
);

router.get(
  "/users/:id/api-keys",
  asyncRoute(async (req, res) => {
    const user = await findUserById(req.params.id);
    if (!user) {
      res.status(404).json({ error: "Пользователь не найден." });
      return;
    }
    res.json({ items: await listApiKeys(req.params.id) });
  })
);

router.delete(
  "/users/:id/api-keys/:keyId",
  asyncRoute(async (req, res) => {
    const user = await findUserById(req.params.id);
    if (!user) {
      res.status(404).json({ error: "Пользователь не найден." });
      return;
    }
    const ok = await revokeApiKey({ userId: req.params.id, apiKeyId: req.params.keyId });
    if (!ok) {
      res.status(404).json({ error: "Ключ не найден." });
      return;
    }
    writeAudit("admin.api_key_revoked", {
      actorUserId: req.authUser.id,
      userId: req.params.id,
      apiKeyId: req.params.keyId,
    });
    res.json({ ok: true });
  })
);

router.patch(
  "/users/:id",
  asyncRoute(async (req, res) => {
    const userId = req.params.id;
    const { role, isActive, adminPassword } = req.body || {};
    const { rows: currentRows } = await getPool().query(
      `SELECT id, role, is_active FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    const current = currentRows[0];
    if (!current) {
      res.status(404).json({ error: "Пользователь не найден." });
      return;
    }

    const newRole = role !== undefined && role !== null ? String(role) : undefined;
    if (newRole !== undefined && newRole !== "admin" && newRole !== "user") {
      res.status(400).json({ error: "Недопустимая роль." });
      return;
    }

    const roleChanging = newRole !== undefined && newRole !== current.role;

    if (roleChanging) {
      if (!adminPassword || typeof adminPassword !== "string") {
        res.status(400).json({ error: "Для смены роли введите свой пароль администратора." });
        return;
      }
      const actor = await findUserById(req.authUser.id);
      if (!actor) {
        res.status(401).json({ error: "Сессия недействительна." });
        return;
      }
      const passOk = await verifyPassword(adminPassword, actor.password_hash);
      if (!passOk) {
        res.status(400).json({ error: "Неверный пароль." });
        return;
      }
      if (newRole === "user" && current.role === "admin") {
        const { rows: ac } = await getPool().query(
          `SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin' AND is_active = TRUE`
        );
        const activeAdmins = ac[0]?.c || 0;
        const targetIsActiveAdmin = current.role === "admin" && current.is_active;
        if (targetIsActiveAdmin && activeAdmins <= 1) {
          res.status(400).json({ error: "Нельзя снять единственного активного администратора." });
          return;
        }
      }
    }

    const fields = [];
    const values = [];
    let idx = 1;
    if (roleChanging && newRole === "admin") {
      fields.push(`role = $${idx++}`);
      values.push("admin");
    }
    if (roleChanging && newRole === "user") {
      fields.push(`role = $${idx++}`);
      values.push("user");
    }
    if (typeof isActive === "boolean") {
      fields.push(`is_active = $${idx++}`);
      values.push(isActive);
    }
    if (!fields.length) {
      res.status(400).json({ error: "Нет полей для обновления." });
      return;
    }
    fields.push("updated_at = NOW()");
    values.push(userId);
    const { rows } = await getPool().query(
      `UPDATE users SET ${fields.join(", ")} WHERE id = $${idx}
       RETURNING id, email, role, is_active, email_verified_at, created_at, updated_at`,
      values
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Пользователь не найден." });
      return;
    }
    writeAudit("admin.user_updated", {
      actorUserId: req.authUser.id,
      userId,
      role: rows[0].role,
      isActive: rows[0].is_active,
    });
    res.json({ user: toPublicUser(rows[0]) });
  })
);

router.get(
  "/users/:id/balance",
  asyncRoute(async (req, res) => {
    res.json(await getUserBalance(req.params.id));
  })
);

router.post(
  "/users/:id/balance",
  asyncRoute(async (req, res) => {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount)) {
      res.status(400).json({ error: "Укажите числовую сумму." });
      return;
    }
    const balance = await adjustUserBalance({
      userId: req.params.id,
      amount,
      reason: req.body?.reason || "admin_adjustment",
      actorUserId: req.authUser.id,
    });
    res.json(balance);
  })
);

router.get(
  "/users/:id/limits",
  asyncRoute(async (req, res) => {
    const limits = await getUserLimits(req.params.id);
    const usage = await getUsageSnapshot(req.params.id);
    res.json({ limits, usage });
  })
);

router.put(
  "/users/:id/limits",
  asyncRoute(async (req, res) => {
    await replaceUserLimits({
      userId: req.params.id,
      dailyQueries: req.body?.dailyQueries,
      monthlyQueries: req.body?.monthlyQueries,
      maxBatchSize: req.body?.maxBatchSize,
    });
    writeAudit("admin.limits_updated", { actorUserId: req.authUser.id, userId: req.params.id });
    res.json({
      limits: await getUserLimits(req.params.id),
      usage: await getUsageSnapshot(req.params.id),
    });
  })
);

router.get(
  "/stats",
  asyncRoute(async (req, res) => {
    const { rows: userRows } = await getPool().query(
      `SELECT
         COUNT(*)::int AS total_users,
         COUNT(*) FILTER (WHERE role = 'admin')::int AS admins,
         COUNT(*) FILTER (WHERE is_active = FALSE)::int AS blocked,
         COUNT(*) FILTER (WHERE email_verified_at IS NOT NULL)::int AS verified
       FROM users`
    );
    const { rows: historyRows } = await getPool().query(
      `SELECT COUNT(*)::int AS total_queries, COUNT(DISTINCT user_id)::int AS active_users
       FROM search_history`
    );
    const { rows: keyRows } = await getPool().query(
      `SELECT COUNT(*)::int AS active_api_keys
       FROM api_keys WHERE revoked_at IS NULL`
    );
    res.json({
      users: userRows[0],
      history: historyRows[0],
      apiKeys: keyRows[0],
    });
  })
);

export default router;
