import nodemailer from "nodemailer";
import { logEvent } from "../logger.js";

/** @type {import('nodemailer').Transporter | null} */
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASSWORD;
  const secure = process.env.SMTP_SECURE === "1" || port === 465;
  if (!host) {
    transporter = {
      async sendMail(mail) {
        logEvent("info", "mail:dev", {
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
        });
        return { messageId: "dev-logged" };
      },
    };
    return transporter;
  }
  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass: typeof pass === "string" ? pass : "" } : undefined,
  });
  return transporter;
}

function getPublicBaseUrl() {
  const base = process.env.PUBLIC_BASE_URL?.trim();
  if (!base) {
    throw new Error("PUBLIC_BASE_URL не задан (например https://gpt.seo-performance.ru).");
  }
  return base.replace(/\/$/, "");
}

function getFromAddress() {
  return process.env.SMTP_FROM?.trim() || process.env.SMTP_USER?.trim() || "no-reply@localhost";
}

/**
 * @param {{ to: string, subject: string, text: string, html?: string }} input
 */
export async function sendMail(input) {
  const transport = getTransporter();
  const info = await transport.sendMail({
    from: getFromAddress(),
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html || input.text.replace(/\n/g, "<br>"),
  });
  logEvent("info", "mail:sent", { to: input.to, subject: input.subject, messageId: info.messageId });
}

/**
 * @param {{ email: string, token: string }} input
 */
export async function sendVerificationEmail(input) {
  const url = `${getPublicBaseUrl()}/verify-email?token=${encodeURIComponent(input.token)}`;
  await sendMail({
    to: input.email,
    subject: "Подтверждение email — AI Searcher",
    text: `Подтвердите email, перейдя по ссылке:\n${url}\n\nЕсли вы не регистрировались, проигнорируйте письмо.`,
  });
}

/**
 * @param {{ email: string, token: string }} input
 */
export async function sendPasswordResetEmail(input) {
  const url = `${getPublicBaseUrl()}/reset-password?token=${encodeURIComponent(input.token)}`;
  await sendMail({
    to: input.email,
    subject: "Сброс пароля — AI Searcher",
    text: `Чтобы задать новый пароль, перейдите по ссылке:\n${url}\n\nСсылка ограничена по времени. Если вы не запрашивали сброс, проигнорируйте письмо.`,
  });
}
