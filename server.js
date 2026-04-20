import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import swaggerUi from "swagger-ui-express";
import {
  PROVIDER_IDS,
  PROVIDER_LABELS,
  getConfiguredProviders,
} from "./src/providers.js";
import {
  MAX_BATCH_QUERIES,
  searchAcrossProviders,
  searchBatchAcrossProviders,
  streamSearchProgress,
} from "./src/searchService.js";
import {
  getRequestLogContext,
  logError,
  logEvent,
  logStartup,
  registerGlobalErrorHandlers,
  requestLoggerMiddleware,
  summarizeQueryBody,
} from "./src/logger.js";

registerGlobalErrorHandlers();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3847;

/** За nginx / балансировщиком — для `req.ip` и X-Forwarded-For. Отключить: `TRUST_PROXY=0`. */
app.set("trust proxy", process.env.TRUST_PROXY !== "0");

app.use(requestLoggerMiddleware);

/**
 * HTTP Basic для UI, статики, Swagger и openapi — не для `/api/*`, чтобы не мешать `Authorization: Bearer` у POST API.
 * Задайте оба: SITE_BASIC_AUTH_USER и SITE_BASIC_AUTH_PASSWORD (в .env на проде).
 */
function siteBasicAuthMiddleware(req, res, next) {
  const user = process.env.SITE_BASIC_AUTH_USER?.trim();
  const passRaw = process.env.SITE_BASIC_AUTH_PASSWORD;
  const pass = typeof passRaw === "string" ? passRaw : "";
  if (!user || !pass) {
    next();
    return;
  }
  if (req.path.startsWith("/api/")) {
    next();
    return;
  }

  const auth = req.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Basic ")) {
    reject();
    return;
  }
  let decoded = "";
  try {
    decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  } catch {
    reject();
    return;
  }
  const colon = decoded.indexOf(":");
  const u = colon >= 0 ? decoded.slice(0, colon) : decoded;
  const p = colon >= 0 ? decoded.slice(colon + 1) : "";
  try {
    const userBuf = Buffer.from(user, "utf8");
    const uBuf = Buffer.from(u, "utf8");
    const passBuf = Buffer.from(pass, "utf8");
    const pBuf = Buffer.from(p, "utf8");
    const uOk = uBuf.length === userBuf.length && crypto.timingSafeEqual(uBuf, userBuf);
    const pOk = pBuf.length === passBuf.length && crypto.timingSafeEqual(pBuf, passBuf);
    if (uOk && pOk) {
      next();
      return;
    }
  } catch {
    reject();
    return;
  }
  reject();

  function reject() {
    logEvent("warn", "site_basic_auth:rejected", {
      ...getRequestLogContext(req),
      path: req.path,
      method: req.method,
    });
    res.status(401);
    res.setHeader("WWW-Authenticate", 'Basic realm="AI Searcher"');
    res.end("Unauthorized");
  }
}

app.use(siteBasicAuthMiddleware);

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("X-AI-Searcher", "1");
  if (req.requestId) {
    res.setHeader("X-Request-Id", req.requestId);
  }
  next();
});

/**
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => unknown | Promise<unknown>} fn
 */
function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Если задан API_SECRET — POST /api/query только с заголовком (интеграции, Postman). */
function requireApiSecret(req, res, next) {
  const secret = process.env.API_SECRET?.trim();
  if (!secret) {
    next();
    return;
  }
  const bearer = req.headers.authorization;
  const key = req.headers["x-api-key"];
  let ok = false;
  if (typeof bearer === "string") {
    if (bearer.startsWith("Bearer ")) {
      ok = bearer.slice(7) === secret;
    } else if (bearer === secret) {
      ok = true;
    }
  }
  if (!ok && typeof key === "string" && key === secret) ok = true;
  if (!ok) {
    logEvent("warn", "auth:rejected", {
      ...getRequestLogContext(req),
      hasAuthorization: Boolean(req.headers.authorization),
      hasXApiKey: Boolean(req.headers["x-api-key"]),
    });
    res.status(401).json({
      error:
        "Нужна авторизация: в .env задан API_SECRET. Передайте заголовок Authorization: Bearer <секрет> или X-API-Key: <секрет>.",
    });
    return;
  }
  next();
}

/**
 * @param {unknown} body
 * @returns {{ ok: true, queries: string[], selected: string[], batchInput: boolean } | { ok: false, status: number, error: string }}
 */
function parseQueryBody(body) {
  const raw = body?.query;
  const rawQueries = body?.queries;
  const providers = body?.providers;
  let selected = Array.isArray(providers) ? providers : ["all"];
  selected = selected.filter((p) => p === "all" || PROVIDER_IDS.includes(p));
  if (!selected.length) selected = ["all"];

  const batchInput =
    Array.isArray(rawQueries) &&
    rawQueries.length > 0 &&
    rawQueries.some((q) => typeof q === "string" && q.trim());

  if (batchInput) {
    const queries = rawQueries
      .map((q) => (typeof q === "string" ? q.trim() : ""))
      .filter(Boolean);
    if (!queries.length) {
      return { ok: false, status: 400, error: "Пустой список запросов" };
    }
    if (queries.length > MAX_BATCH_QUERIES) {
      return {
        ok: false,
        status: 400,
        error: `Слишком много запросов в пакете (макс. ${MAX_BATCH_QUERIES}).`,
      };
    }
    for (let i = 0; i < queries.length; i++) {
      if (queries[i].length > 8000) {
        return {
          ok: false,
          status: 400,
          error: `Запрос #${i + 1} длиннее 8000 символов.`,
        };
      }
    }
    return { ok: true, queries, selected, batchInput: true };
  }

  const query = typeof raw === "string" ? raw.trim() : "";
  if (!query) {
    return { ok: false, status: 400, error: "Пустой запрос" };
  }
  if (query.length > 8000) {
    return { ok: false, status: 400, error: "Запрос слишком длинный (макс. 8000 символов)" };
  }
  return { ok: true, queries: [query], selected, batchInput: false };
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const xlsxVendorPath = join(__dirname, "node_modules", "xlsx", "xlsx.mjs");
app.get("/vendor/xlsx.mjs", (_req, res, next) => {
  if (!existsSync(xlsxVendorPath)) {
    next();
    return;
  }
  res.type("application/javascript; charset=utf-8");
  res.sendFile(xlsxVendorPath);
});

app.use((_req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});

/** Публично: какие модели есть в билде и какие настроены в .env (без секретов). */
app.get("/api/meta", (req, res, next) => {
  try {
    const configured = getConfiguredProviders();
    const providers = PROVIDER_IDS.map((id) => ({
      id,
      label: PROVIDER_LABELS[id] ?? id,
      configured: Boolean(configured[id]),
    }));
    res.json({ providers });
  } catch (e) {
    next(e);
  }
});

const openApiPath = join(__dirname, "openapi", "openapi.json");
let openApiSpec = null;
try {
  openApiSpec = JSON.parse(readFileSync(openApiPath, "utf8"));
} catch (e) {
  logEvent("warn", "openapi:load_failed", {
    message: e?.message || String(e),
    stack: e instanceof Error ? e.stack : undefined,
  });
  console.warn("OpenAPI:", e?.message || String(e));
}
if (openApiSpec) {
  app.get("/openapi.json", (_req, res) => {
    res.json(openApiSpec);
  });
  /** Без слэша Swagger UI часто не открывается — ведём на канонический путь. */
  // app.get("/api-docs", (_req, res) => {
  //   res.redirect(308, "/api-docs/");
  // });
  app.use(
    "/api-docs/",
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, {
      customSiteTitle: "AI Searcher API",
      customCss: ".swagger-ui .topbar { display: none }",
    })
  );
}

/** Поток SSE: ячейки таблицы по мере готовности (JSON в событиях `data:`). */
app.post(
  "/api/query/stream",
  requireApiSecret,
  asyncRoute(async (req, res) => {
    logEvent("debug", "api:query_stream:body", {
      ...getRequestLogContext(req),
      ...summarizeQueryBody(req.body),
    });
    const parsed = parseQueryBody(req.body);
    if (!parsed.ok) {
      logEvent("warn", "api:query_stream:validation", {
        ...getRequestLogContext(req),
        status: parsed.status,
        error: parsed.error,
        ...summarizeQueryBody(req.body),
      });
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }
    const { queries, selected } = parsed;
    logEvent("info", "api:query_stream:start", {
      ...getRequestLogContext(req),
      queryCount: queries.length,
      providers: selected,
    });
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    try {
      const logMeta = { requestId: req.requestId };
      await streamSearchProgress(queries, selected, (ev) => {
        try {
          sseWrite(res, ev);
        } catch (writeErr) {
          logError(writeErr, req, {
            phase: "sseWrite",
            eventType: ev?.type,
          });
        }
      }, logMeta);
      res.end();
      logEvent("info", "api:query_stream:done", {
        ...getRequestLogContext(req),
        queryCount: queries.length,
      });
    } catch (e) {
      logError(e, req, { phase: "api:query_stream" });
      try {
        sseWrite(res, { type: "error", message: e?.message || String(e) });
      } catch (_) {
        /* ignore */
      }
      res.end();
    }
  })
);

app.post(
  "/api/query",
  requireApiSecret,
  asyncRoute(async (req, res) => {
    logEvent("debug", "api:query:body", {
      ...getRequestLogContext(req),
      ...summarizeQueryBody(req.body),
    });
    const parsed = parseQueryBody(req.body);
    if (!parsed.ok) {
      logEvent("warn", "api:query:validation", {
        ...getRequestLogContext(req),
        status: parsed.status,
        error: parsed.error,
        ...summarizeQueryBody(req.body),
      });
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }
    const { queries, selected, batchInput } = parsed;

    if (batchInput) {
      try {
        logEvent("info", "api:query:batch:start", {
          ...getRequestLogContext(req),
          queryCount: queries.length,
          providers: selected,
        });
        const out = await searchBatchAcrossProviders(queries, selected, {
          requestId: req.requestId,
        });
        res.json(out);
        logEvent("info", "api:query:batch:done", {
          ...getRequestLogContext(req),
          queryCount: queries.length,
          items: out.items?.length,
        });
      } catch (e) {
        logError(e, req, { phase: "api:query:batch" });
        res.status(500).json({
          error: e?.message || "Внутренняя ошибка",
          batch: true,
          items: [],
          skippedLabels: [],
        });
      }
      return;
    }

    try {
      logEvent("info", "api:query:single:start", {
        ...getRequestLogContext(req),
        providers: selected,
        queryChars: queries[0]?.length,
      });
      const out = await searchAcrossProviders(queries[0], selected, {
        requestId: req.requestId,
      });
      if (out.error) {
        logEvent("warn", "api:query:single:provider_error", {
          ...getRequestLogContext(req),
          error: out.error,
          skippedLabels: out.skippedLabels,
        });
        res.status(400).json(out);
        return;
      }
      res.json(out);
      logEvent("info", "api:query:single:done", {
        ...getRequestLogContext(req),
        resultCount: out.results?.length,
      });
    } catch (e) {
      logError(e, req, { phase: "api:query:single" });
      res.status(500).json({
        error: e?.message || "Внутренняя ошибка",
        results: [],
        skippedLabels: [],
      });
    }
  })
);

const publicDir = join(__dirname, "public");
app.get("/", (_req, res) => {
  res.sendFile(join(publicDir, "index.html"));
});
app.use(express.static(publicDir));

app.use((req, res) => {
  logEvent("warn", "http:404", getRequestLogContext(req));
  const base = `http://127.0.0.1:${PORT}`;
  res.status(404).type("html").send(`<!DOCTYPE html>
<html lang="ru"><meta charset="utf-8"><title>404</title>
<body style="font:15px system-ui;padding:1.5rem;max-width:40rem">
<h1>404</h1>
<p>Путь: <code>${escapeHtml(req.path)}</code></p>
<p>HTTP API: <code>POST ${escapeHtml("/api/query")}</code> · <a href="${base}/api-docs/">Swagger UI</a> (или <a href="${base}/api-docs">/api-docs</a> → редирект) · <a href="${base}/openapi.json">openapi.json</a></p>
<p>Интерфейс: <a href="${base}/">главная</a>.</p>
<p>Адрес сервера: <code>http://localhost:${PORT}</code> (без <code>https://</code> для порта Node).</p>
</body></html>`);
});

app.use((err, req, res, next) => {
  logError(err, req, { phase: "express_error_handler" });
  if (res.headersSent) {
    next(err);
    return;
  }
  if (req.path?.startsWith("/api/")) {
    res.status(500).json({ error: err?.message || "Внутренняя ошибка" });
    return;
  }
  res.status(500).type("text").send(err?.message || "Internal error");
});

app.listen(PORT, () => {
  logStartup({ port: PORT });
  const base = `http://localhost:${PORT}`;
  console.log(`AI Searcher: ${base}`);
  console.log(`  API:     POST ${base}/api/query  |  POST ${base}/api/query/stream (SSE)`);
  if (openApiSpec) {
    console.log(`  Swagger: ${base}/api-docs/  (редирект с /api-docs)`);
    console.log(`  OpenAPI: ${base}/openapi.json`);
  }
});

/** @param {string} s */
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
