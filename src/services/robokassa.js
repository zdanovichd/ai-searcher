import crypto from "node:crypto";

const TOKEN_PER_RUB = 1;

function getEnvRequired(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} не задан.`);
  return v;
}

export function isRobokassaConfigured() {
  return Boolean(process.env.ROBOKASSA_MERCHANT_LOGIN?.trim());
}

export function getRobokassaConfig() {
  const merchantLogin = getEnvRequired("ROBOKASSA_MERCHANT_LOGIN");
  const password1 = getEnvRequired("ROBOKASSA_PASSWORD1");
  const password2 = getEnvRequired("ROBOKASSA_PASSWORD2");
  const isTest = (process.env.ROBOKASSA_IS_TEST?.trim() || "0") === "1";
  const baseUrl =
    process.env.ROBOKASSA_BASE_URL?.trim() || "https://auth.robokassa.ru/Merchant/Index.aspx";
  const publicBaseUrl = getEnvRequired("PUBLIC_BASE_URL").replace(/\/+$/, "");
  return { merchantLogin, password1, password2, isTest, baseUrl, publicBaseUrl };
}

export function rubToTokens(rub) {
  const r = Number(rub);
  if (!Number.isFinite(r) || r <= 0) throw new Error("Некорректная сумма.");
  return Math.round(r * TOKEN_PER_RUB * 10000) / 10000;
}

function md5Upper(s) {
  return crypto.createHash("md5").update(s, "utf8").digest("hex").toUpperCase();
}

function formatOutSum(rub) {
  // Robokassa принимает строку с точкой, обычно 2 знака после запятой.
  return Number(rub).toFixed(2);
}

export function buildRobokassaPayUrl(input) {
  const { merchantLogin, password1, isTest, baseUrl, publicBaseUrl } = getRobokassaConfig();
  const outSum = formatOutSum(input.amountRub);
  const invId = String(input.invId);
  const desc = input.description?.trim() || "Пополнение баланса";

  const shpUserId = String(input.userId);
  const signature = md5Upper(
    `${merchantLogin}:${outSum}:${invId}:${password1}:ShpUserId=${shpUserId}`
  );

  const successUrl = `${publicBaseUrl}/cabinet/?topup=success&invId=${encodeURIComponent(invId)}`;
  const failUrl = `${publicBaseUrl}/cabinet/?topup=fail&invId=${encodeURIComponent(invId)}`;

  const u = new URL(baseUrl);
  u.searchParams.set("MerchantLogin", merchantLogin);
  u.searchParams.set("OutSum", outSum);
  u.searchParams.set("InvId", invId);
  u.searchParams.set("Description", desc);
  u.searchParams.set("SignatureValue", signature);
  u.searchParams.set("ShpUserId", shpUserId);
  if (isTest) u.searchParams.set("IsTest", "1");
  u.searchParams.set("SuccessURL", successUrl);
  u.searchParams.set("FailURL", failUrl);
  return u.toString();
}

export function verifyRobokassaResult(params) {
  let password2;
  try {
    ({ password2 } = getRobokassaConfig());
  } catch {
    return { ok: false, error: "not_configured" };
  }
  const outSum = String(params.OutSum ?? "").trim();
  const invId = String(params.InvId ?? "").trim();
  const sig = String(params.SignatureValue ?? params.Signature ?? "").trim();
  const shpUserId = String(params.ShpUserId ?? "").trim();
  if (!outSum || !invId || !sig || !shpUserId) return { ok: false, error: "missing_fields" };

  const expected = md5Upper(`${outSum}:${invId}:${password2}:ShpUserId=${shpUserId}`);
  if (expected !== sig.toUpperCase()) return { ok: false, error: "bad_signature" };
  return { ok: true, outSum, invId: Number(invId), userId: shpUserId };
}

