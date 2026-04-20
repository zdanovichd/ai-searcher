import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };

/** Каталог по умолчанию: `<корень проекта>/logs` (рядом с `server.js`). */
const LOG_DIR =
  process.env.LOG_DIR?.trim() || path.join(__dirname, "..", "logs");
const LOG_FILE_NAME = process.env.LOG_FILE?.trim() || "app.log";
const LOG_PATH = path.isAbsolute(LOG_FILE_NAME)
  ? LOG_FILE_NAME
  : path.join(LOG_DIR, LOG_FILE_NAME);

const _lvl = String(process.env.LOG_LEVEL || "info").toLowerCase();
const MIN_LEVEL = LEVEL_RANK[_lvl] ?? LEVEL_RANK.info;

/** Последовательная запись: не теряем строки при параллельных запросах. */
let writeChain = Promise.resolve();

/**
 * @param {string} level
 */
function shouldLog(level) {
  const r = LEVEL_RANK[level];
  if (r == null) return true;
  return r >= MIN_LEVEL;
}

/**
 * @param {Record<string, unknown>} record
 */
function appendRecord(record) {
  const line = JSON.stringify(record) + "\n";
  writeChain = writeChain.then(
    () =>
      new Promise((resolve) => {
        try {
          fs.mkdirSync(LOG_DIR, { recursive: true });
          fs.appendFile(LOG_PATH, line, { encoding: "utf8" }, (err) => {
            if (err) {
              console.error("[logger] appendFile:", err.message || String(err));
            }
            resolve();
          });
        } catch (e) {
          console.error("[logger] mkdir/append:", e?.message || String(e));
          resolve();
        }
      })
  );
}

/**
 * @param {import('express').Request | null | undefined} req
 */
export function getRequestLogContext(req) {
  if (!req) {
    return {};
  }
  const xf = req.headers["x-forwarded-for"];
  const xff = typeof xf === "string" ? xf.split(",")[0]?.trim() : null;
  return {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl ?? req.url,
    ip: req.ip || null,
    forwardedFor: typeof xf === "string" ? xf : null,
    clientIpHint: xff || req.headers["x-real-ip"] || req.socket?.remoteAddress || null,
    remoteAddress: req.socket?.remoteAddress || null,
    userAgent: req.headers["user-agent"] || null,
    referer: req.headers.referer || null,
    origin: req.headers.origin || null,
    host: req.headers.host || null,
    protocol: req.protocol,
    secure: req.secure,
    contentType: req.headers["content-type"] || null,
    contentLength: req.headers["content-length"] || null,
    accept: req.headers.accept || null,
  };
}

/**
 * Краткое описание тела POST /api/query* без секретов (длины и усечённые превью).
 * @param {unknown} body
 */
export function summarizeQueryBody(body) {
  if (!body || typeof body !== "object") return { bodyKind: typeof body };
  /** @type {Record<string, unknown>} */
  const out = { bodyKind: "json" };
  if (Array.isArray(body.providers)) {
    out.providers = body.providers;
  }
  if (typeof body.query === "string") {
    out.mode = "single";
    out.queryChars = body.query.length;
    out.queryPreview = body.query.slice(0, 160).replace(/\s+/g, " ");
  }
  if (Array.isArray(body.queries)) {
    out.mode = "batch";
    out.batchCount = body.queries.length;
    out.queryLengths = body.queries.map((q) =>
      typeof q === "string" ? q.length : 0
    );
    const first = body.queries.find((q) => typeof q === "string" && q.trim());
    if (typeof first === "string") {
      out.firstQueryPreview = first.slice(0, 160).replace(/\s+/g, " ");
    }
  }
  return out;
}

/**
 * @param {string} level
 * @param {string} event
 * @param {Record<string, unknown>} [meta]
 */
export function logEvent(level, event, meta = {}) {
  if (!shouldLog(level)) return;
  appendRecord({
    ts: new Date().toISOString(),
    level,
    event,
    ...meta,
  });
}

/**
 * @param {unknown} err
 * @param {import('express').Request | null} [req]
 * @param {Record<string, unknown>} [extra]
 */
export function logError(err, req = null, extra = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  appendRecord({
    ts: new Date().toISOString(),
    level: "error",
    event: "error",
    message: e.message,
    name: e.name,
    stack: e.stack,
    ...getRequestLogContext(req),
    ...extra,
  });
}

/** Старт процесса (в файл + консоль). */
export function logStartup(meta = {}) {
  logEvent("info", "process:startup", {
    node: process.version,
    pid: process.pid,
    cwd: process.cwd(),
    logPath: LOG_PATH,
    logLevel: process.env.LOG_LEVEL || "info",
    ...meta,
  });
}

/**
 * Express: присвоить requestId и залогировать вход запроса; по `finish` — ответ.
 */
/** Регистрация логов на сбои процесса (один раз при старте приложения). */
export function registerGlobalErrorHandlers() {
  process.on("uncaughtException", (err) => {
    logError(err, null, { source: "uncaughtException" });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logError(
      reason instanceof Error ? reason : new Error(String(reason)),
      null,
      { source: "unhandledRejection" }
    );
  });
  process.on("warning", (w) => {
    logEvent("warn", "process:warning", {
      name: w.name,
      message: w.message,
      stack: w.stack,
    });
  });
}

export function requestLoggerMiddleware(req, res, next) {
  req.requestId = randomUUID();
  req._logStartedAt = Date.now();
  logEvent("info", "http:request", getRequestLogContext(req));
  res.on("finish", () => {
    logEvent("info", "http:response", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl ?? req.url,
      statusCode: res.statusCode,
      durationMs: Date.now() - req._logStartedAt,
      contentLengthOut: res.getHeader("content-length") || null,
    });
  });
  next();
}
