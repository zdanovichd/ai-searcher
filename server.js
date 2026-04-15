import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import swaggerUi from "swagger-ui-express";
import { PROVIDER_IDS } from "./src/providers.js";
import {
  MAX_BATCH_QUERIES,
  searchAcrossProviders,
  searchBatchAcrossProviders,
  streamSearchProgress,
} from "./src/searchService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3847;

app.use(express.json({ limit: "1mb" }));

app.use((_req, res, next) => {
  res.setHeader("X-AI-Searcher", "1");
  next();
});

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

const openApiPath = join(__dirname, "openapi", "openapi.json");
let openApiSpec = null;
try {
  openApiSpec = JSON.parse(readFileSync(openApiPath, "utf8"));
} catch (e) {
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
app.post("/api/query/stream", requireApiSecret, async (req, res) => {
  const parsed = parseQueryBody(req.body);
  if (!parsed.ok) {
    res.status(parsed.status).json({ error: parsed.error });
    return;
  }
  const { queries, selected } = parsed;
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  try {
    await streamSearchProgress(queries, selected, (ev) => {
      sseWrite(res, ev);
    });
    res.end();
  } catch (e) {
    try {
      sseWrite(res, { type: "error", message: e?.message || String(e) });
    } catch (_) {
      /* ignore */
    }
    res.end();
  }
});

app.post("/api/query", requireApiSecret, async (req, res) => {
  const parsed = parseQueryBody(req.body);
  if (!parsed.ok) {
    res.status(parsed.status).json({ error: parsed.error });
    return;
  }
  const { queries, selected, batchInput } = parsed;

  if (batchInput) {
    try {
      const out = await searchBatchAcrossProviders(queries, selected);
      res.json(out);
    } catch (e) {
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
    const out = await searchAcrossProviders(queries[0], selected);
    if (out.error) {
      res.status(400).json(out);
      return;
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({
      error: e?.message || "Внутренняя ошибка",
      results: [],
      skippedLabels: [],
    });
  }
});

const publicDir = join(__dirname, "public");
app.get("/", (_req, res) => {
  res.sendFile(join(publicDir, "index.html"));
});
app.use(express.static(publicDir));

app.use((req, res) => {
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

app.listen(PORT, () => {
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
