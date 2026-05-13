import { Router } from "express";
import { getPool } from "../db.js";
import { writeAudit } from "../services/audit.js";
import { verifyRobokassaResult } from "../services/robokassa.js";

const router = Router();

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function pickRobokassaParams(req) {
  return { ...(req.query || {}), ...(req.body || {}) };
}

router.all(
  "/robokassa/result",
  asyncRoute(async (req, res) => {
    const params = pickRobokassaParams(req);
    const ver = verifyRobokassaResult(params);
    if (!ver.ok) {
      writeAudit("robokassa.result_rejected", { error: ver.error });
      res.status(ver.error === "not_configured" ? 503 : 400).send("bad signature");
      return;
    }

    const invId = ver.invId;
    const outSumRub = Number(ver.outSum);
    if (!Number.isFinite(invId) || !Number.isFinite(outSumRub) || outSumRub <= 0) {
      res.status(400).send("bad params");
      return;
    }

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT inv_id, user_id, amount_rub, tokens, status
         FROM robokassa_invoices
         WHERE inv_id = $1
         FOR UPDATE`,
        [invId]
      );
      const row = rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        writeAudit("robokassa.result_unknown_invoice", { invId });
        res.status(404).send("unknown invoice");
        return;
      }

      if (String(row.user_id) !== String(ver.userId)) {
        await client.query("ROLLBACK");
        writeAudit("robokassa.result_user_mismatch", {
          invId,
          expectedUserId: String(row.user_id),
          gotUserId: String(ver.userId),
        });
        res.status(400).send("user mismatch");
        return;
      }

      if (row.status === "paid") {
        await client.query("COMMIT");
        res.type("text/plain").send(`OK${invId}`);
        return;
      }

      const expectedRub = Number(row.amount_rub);
      if (Number.isFinite(expectedRub) && Math.abs(expectedRub - outSumRub) > 0.009) {
        await client.query("ROLLBACK");
        writeAudit("robokassa.result_amount_mismatch", { invId, expectedRub, outSumRub });
        res.status(400).send("amount mismatch");
        return;
      }

      await client.query(
        `UPDATE robokassa_invoices
         SET status = 'paid', paid_at = NOW(), raw_result = $2::jsonb
         WHERE inv_id = $1`,
        [invId, JSON.stringify(params)]
      );

      const tokens = Number(row.tokens);
      await client.query(
        `INSERT INTO user_balances (user_id, balance)
         VALUES ($1, $2)
         ON CONFLICT (user_id)
         DO UPDATE SET balance = user_balances.balance + EXCLUDED.balance, updated_at = NOW()`,
        [String(row.user_id), tokens]
      );

      await client.query("COMMIT");

      writeAudit("robokassa.paid", {
        invId,
        userId: String(row.user_id),
        rub: outSumRub,
        tokens,
      });

      res.type("text/plain").send(`OK${invId}`);
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }
  })
);

export default router;

