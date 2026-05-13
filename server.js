import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import swaggerUi from "swagger-ui-express";
import { initDatabase } from "./src/db.js";
import {
  PROVIDER_IDS,
  PROVIDER_LABELS,
  getConfiguredProviders,
} from "./src/providers.js";
import { getOutboundProxyUrl } from "./src/proxyFetch.js";
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
import { protectHtmlPages, requireUserApiKey } from "./src/auth/middleware.js";
import { assertWithinLimits, recordUsage } from "./src/services/limits.js";
import { chargeForQueries } from "./src/services/balance.js";
import {
  addSearchHistory,
  createStreamHistorySummary,
  consumeStreamHistoryEvent,
  summarizeSearchOutcomeForHistory,
} from "./src/services/history.js";
import authRoutes from "./src/routes/auth.js";
import cabinetRoutes from "./src/routes/cabinet.js";
import cabinetSearchRoutes from "./src/routes/cabinetSearch.js";
import adminRoutes from "./src/routes/admin.js";
import paymentsRoutes from "./src/routes/payments.js";

registerGlobalErrorHandlers();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3847;
const publicDir = join(__dirname, "public");

app.set("trust proxy", process.env.TRUST_PROXY !== "0");
app.use(requestLoggerMiddleware);
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  res.setHeader("X-AI-Searcher", "1");
  if (req.requestId) {
    res.setHeader("X-Request-Id", req.requestId);
  }
  next();
});

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

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

async function runAuthorizedSearch(req, queryCount) {
  const userId = req.apiAuth.userId;
  await assertWithinLimits({ userId, queryCount });
  await chargeForQueries({ userId, queryCount });
  return null;
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

app.use("/api/auth", authRoutes);
app.use("/api/cabinet", cabinetRoutes);
app.use("/api/cabinet", cabinetSearchRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/payments", paymentsRoutes);

app.get("/api/meta", requireUserApiKey, asyncRoute(async (req, res) => {
  const configured = getConfiguredProviders(null);
  const providers = PROVIDER_IDS.map((id) => ({
    id,
    label: PROVIDER_LABELS[id] ?? id,
    configured: Boolean(configured[id]),
    proxy: Boolean(getOutboundProxyUrl(id)),
  }));
  res.json({ providers });
}));

const openApiPath = join(__dirname, "openapi", "openapi.json");
let openApiSpec = null;
try {
  openApiSpec = JSON.parse(readFileSync(openApiPath, "utf8"));
} catch (e) {
  logEvent("warn", "openapi:load_failed", {
    message: e?.message || String(e),
    stack: e instanceof Error ? e.stack : undefined,
  });
}
if (openApiSpec) {
  app.get("/openapi.json", requireUserApiKey, (_req, res) => {
    res.json(openApiSpec);
  });
  app.use(
    "/api-docs/",
    requireUserApiKey,
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, {
      customSiteTitle: "AI Searcher API",
      customCss: ".swagger-ui .topbar { display: none }",
    })
  );
}

app.post(
  "/api/query/stream",
  requireUserApiKey,
  asyncRoute(async (req, res) => {
    const parsed = parseQueryBody(req.body);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }
    const { queries, selected } = parsed;
    let userSecrets;
    try {
      userSecrets = await runAuthorizedSearch(req, queries.length);
    } catch (e) {
      res.status(e?.status || 500).json({ error: e?.message || "Ошибка доступа" });
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    try {
      const streamHist = createStreamHistorySummary();
      await streamSearchProgress(
        queries,
        selected,
        (ev) => {
          consumeStreamHistoryEvent(streamHist, ev);
          try {
            sseWrite(res, ev);
          } catch (writeErr) {
            logError(writeErr, req, { phase: "sseWrite" });
          }
        },
        { requestId: req.requestId, userId: req.apiAuth.userId },
        userSecrets
      );
      await recordUsage({ userId: req.apiAuth.userId, queryCount: queries.length });
      await addSearchHistory({
        userId: req.apiAuth.userId,
        queryText: queries.length === 1 ? queries[0] : null,
        providers: selected,
        batch: queries.length > 1,
        queryCount: queries.length,
        resultSummary: streamHist,
      });
      res.end();
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
  requireUserApiKey,
  asyncRoute(async (req, res) => {
    const parsed = parseQueryBody(req.body);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }
    const { queries, selected, batchInput } = parsed;
    let userSecrets;
    try {
      userSecrets = await runAuthorizedSearch(req, queries.length);
    } catch (e) {
      res.status(e?.status || 500).json({ error: e?.message || "Ошибка доступа" });
      return;
    }
    const logMeta = { requestId: req.requestId, userId: req.apiAuth.userId };
    try {
      const out = batchInput
        ? await searchBatchAcrossProviders(queries, selected, logMeta, userSecrets)
        : await searchAcrossProviders(queries[0], selected, logMeta, userSecrets);
      await recordUsage({ userId: req.apiAuth.userId, queryCount: queries.length });
      await addSearchHistory({
        userId: req.apiAuth.userId,
        queryText: batchInput ? null : queries[0],
        providers: selected,
        batch: batchInput,
        queryCount: queries.length,
        resultSummary: summarizeSearchOutcomeForHistory({ batch: batchInput, out }),
      });
      res.json(out);
    } catch (e) {
      logError(e, req, { phase: "api:query" });
      res.status(e?.status || 500).json({ error: e?.message || "Внутренняя ошибка" });
    }
  })
);

app.get("/login", (_req, res) => {
  res.sendFile(join(publicDir, "auth", "login.html"));
});
app.get("/register", (_req, res) => {
  res.sendFile(join(publicDir, "auth", "register.html"));
});
app.get("/forgot-password", (_req, res) => {
  res.sendFile(join(publicDir, "auth", "forgot-password.html"));
});
app.get("/reset-password", (_req, res) => {
  res.sendFile(join(publicDir, "auth", "reset-password.html"));
});
app.get("/verify-email", (_req, res) => {
  res.sendFile(join(publicDir, "auth", "verify-email.html"));
});
app.get(["/legal", "/legal/"], (_req, res) => {
  res.sendFile(join(publicDir, "legal", "index.html"));
});
app.get(["/legal/oferta", "/legal/oferta/"], (_req, res) => {
  res.sendFile(join(publicDir, "legal", "oferta.html"));
});
function sendCabinetIndex(_req, res) {
  res.sendFile(join(publicDir, "cabinet", "index.html"));
}

function sendAdminIndex(_req, res) {
  res.sendFile(join(publicDir, "admin", "index.html"));
}

app.get(["/cabinet", "/cabinet/"], sendCabinetIndex);
app.get("/cabinet/search", (_req, res) => {
  res.sendFile(join(publicDir, "cabinet", "search.html"));
});
function sendAdminUserPage(_req, res) {
  res.sendFile(join(publicDir, "admin", "user", "index.html"));
}

app.get(["/admin", "/admin/"], sendAdminIndex);
app.get("/admin/user", sendAdminUserPage);
app.get("/admin/user/", sendAdminUserPage);

app.get("/", (_req, res) => {
  res.redirect(302, "/cabinet/");
});
app.use(protectHtmlPages);
app.use(express.static(publicDir));

app.use((req, res) => {
  logEvent("warn", "http:404", getRequestLogContext(req));
  const path = req.path || "/";
  if (path.startsWith("/api/")) {
    res.status(404).json({
      error: "Маршрут API не найден.",
      path,
      method: req.method,
    });
    return;
  }
  res.status(404).type("html").send(`<!DOCTYPE html>
<html lang="ru"><meta charset="utf-8"><title>404</title>
<body style="font:15px system-ui;padding:1.5rem;max-width:40rem">
<h1>404</h1>
<p>Путь: <code>${escapeHtml(req.path)}</code></p>
<p><a href="/cabinet/">Кабинет</a> · <a href="/login">Вход</a></p>
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

async function start() {
  await initDatabase();
  app.listen(PORT, () => {
    logStartup({ port: PORT });
    const base = `http://localhost:${PORT}`;
    console.log(`AI Searcher: ${base}`);
    console.log(`  Кабинет: ${base}/cabinet/`);
    console.log(`  API:     POST ${base}/api/query (API-ключ пользователя)`);
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
