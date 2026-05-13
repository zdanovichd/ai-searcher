import { getPool } from "../db.js";
import { writeAudit } from "./audit.js";

const DEFAULT_QUERY_COST = Number(process.env.DEFAULT_QUERY_COST) || 1;

/**
 * @param {string} userId
 */
export async function getUserBalance(userId) {
  const { rows } = await getPool().query(
    `SELECT balance, currency, updated_at FROM user_balances WHERE user_id = $1`,
    [userId]
  );
  const row = rows[0];
  return {
    balance: row ? Number(row.balance) : 0,
    currency: row?.currency || "RUB",
    updatedAt: row?.updated_at || null,
  };
}

/**
 * @param {{ userId: string, amount: number, reason?: string, actorUserId?: string }} input
 */
export async function adjustUserBalance(input) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error("Сумма должна быть ненулевым числом.");
  }
  const { rows } = await getPool().query(
    `UPDATE user_balances
     SET balance = balance + $2, updated_at = NOW()
     WHERE user_id = $1
     RETURNING balance, currency`,
    [input.userId, amount]
  );
  if (!rows[0]) {
    await getPool().query(`INSERT INTO user_balances (user_id, balance) VALUES ($1, $2)`, [
      input.userId,
      amount,
    ]);
  }
  writeAudit("balance.adjusted", {
    userId: input.userId,
    amount,
    reason: input.reason || null,
    actorUserId: input.actorUserId || null,
  });
  return getUserBalance(input.userId);
}

/**
 * @param {{ userId: string, queryCount: number }} input
 */
export async function chargeForQueries(input) {
  const cost = DEFAULT_QUERY_COST * Math.max(1, input.queryCount);
  const balance = await getUserBalance(input.userId);
  if (balance.balance < cost) {
    const err = new Error("Недостаточно средств на балансе.");
    Object.assign(err, { status: 402 });
    throw err;
  }
  await getPool().query(
    `UPDATE user_balances SET balance = balance - $2, updated_at = NOW() WHERE user_id = $1`,
    [input.userId, cost]
  );
  writeAudit("balance.charged", { userId: input.userId, cost, queryCount: input.queryCount });
  return cost;
}

export function getDefaultQueryCost() {
  return DEFAULT_QUERY_COST;
}
