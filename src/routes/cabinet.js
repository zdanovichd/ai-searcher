import { Router } from "express";
import { requireAccessAuth } from "../auth/middleware.js";
import { PROVIDER_IDS, PROVIDER_LABELS, getConfiguredProviders } from "../providers.js";
import { getOutboundProxyUrl } from "../proxyFetch.js";
import { changePassword, toPublicUser, findUserById } from "../services/users.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/apiKeys.js";
import { getUserBalance } from "../services/balance.js";
import { getUsageSnapshot, getUserLimits } from "../services/limits.js";
import { listSearchHistory } from "../services/history.js";
import { UserFacingError } from "../services/users.js";
import { buildRobokassaPayUrl, isRobokassaConfigured, rubToTokens } from "../services/robokassa.js";
import { getPool } from "../db.js";

const router = Router();

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

router.use(requireAccessAuth);

router.get(
  "/meta",
  asyncRoute(async (req, res) => {
    const configured = getConfiguredProviders(null);
    const providers = PROVIDER_IDS.map((id) => ({
      id,
      label: PROVIDER_LABELS[id] ?? id,
      configured: Boolean(configured[id]),
      proxy: Boolean(getOutboundProxyUrl(id)),
    }));
    res.json({ providers });
  })
);

router.get(
  "/me",
  asyncRoute(async (req, res) => {
    const user = await findUserById(req.authUser.id);
    if (!user) {
      res.status(404).json({ error: "Пользователь не найден." });
      return;
    }
    res.json({ user: toPublicUser(user) });
  })
);

router.post(
  "/change-password",
  asyncRoute(async (req, res) => {
    try {
      await changePassword({
        userId: req.authUser.id,
        currentPassword: req.body?.currentPassword,
        newPassword: req.body?.newPassword,
      });
      res.json({ message: "Пароль изменён." });
    } catch (e) {
      if (e instanceof UserFacingError) {
        res.status(e.status).json({ error: e.message });
        return;
      }
      throw e;
    }
  })
);

router.get(
  "/balance",
  asyncRoute(async (req, res) => {
    res.json(await getUserBalance(req.authUser.id));
  })
);

router.post(
  "/topup/robokassa",
  asyncRoute(async (req, res) => {
    if (!isRobokassaConfigured()) {
      res.status(503).json({ error: "Оплата Robokassa не настроена на сервере." });
      return;
    }
    const rubRaw = req.body?.rub ?? 100;
    const rub = Number(rubRaw);
    if (!Number.isFinite(rub) || rub <= 0) {
      res.status(400).json({ error: "Некорректная сумма." });
      return;
    }
    const amountRub = Math.round(rub * 100) / 100;
    const tokens = rubToTokens(amountRub);
    const { rows } = await getPool().query(
      `INSERT INTO robokassa_invoices (user_id, amount_rub, tokens)
       VALUES ($1, $2, $3)
       RETURNING inv_id`,
      [req.authUser.id, amountRub, tokens]
    );
    const invId = rows[0]?.inv_id;
    const payUrl = buildRobokassaPayUrl({
      invId,
      amountRub,
      tokens,
      userId: req.authUser.id,
      description: `Пополнение баланса: ${tokens} токенов`,
    });
    res.json({ invId, amountRub, tokens, payUrl });
  })
);

router.get(
  "/limits",
  asyncRoute(async (req, res) => {
    const limits = await getUserLimits(req.authUser.id);
    const usage = await getUsageSnapshot(req.authUser.id);
    res.json({ limits, usage });
  })
);

router.get(
  "/api-keys",
  asyncRoute(async (req, res) => {
    res.json({ items: await listApiKeys(req.authUser.id) });
  })
);

router.post(
  "/api-keys",
  asyncRoute(async (req, res) => {
    const created = await createApiKey(req.authUser.id, req.body?.name || "");
    res.status(201).json({
      item: {
        id: created.record.id,
        name: created.record.name,
        keyPrefix: created.record.key_prefix,
        createdAt: created.record.created_at,
      },
      secret: created.secret,
    });
  })
);

router.delete(
  "/api-keys/:id",
  asyncRoute(async (req, res) => {
    const ok = await revokeApiKey({ userId: req.authUser.id, apiKeyId: req.params.id });
    if (!ok) {
      res.status(404).json({ error: "Ключ не найден." });
      return;
    }
    res.json({ ok: true });
  })
);

router.get(
  "/history",
  asyncRoute(async (req, res) => {
    const items = await listSearchHistory({
      userId: req.authUser.id,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ items });
  })
);

export default router;
