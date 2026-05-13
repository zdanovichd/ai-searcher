import { Router } from "express";
import { requireAccessAuth } from "../auth/middleware.js";
import { assertWithinLimits, recordUsage } from "../services/limits.js";
import { chargeForQueries } from "../services/balance.js";
import { addSearchHistory, createStreamHistorySummary, consumeStreamHistoryEvent, summarizeSearchOutcomeForHistory } from "../services/history.js";
import {
  MAX_BATCH_QUERIES,
  searchAcrossProviders,
  searchBatchAcrossProviders,
  streamSearchProgress,
} from "../searchService.js";
import { PROVIDER_IDS } from "../providers.js";
import { logError } from "../logger.js";

const router = Router();

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * @param {unknown} body
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

async function prepareSearch(req, queryCount) {
  await assertWithinLimits({ userId: req.authUser.id, queryCount });
  await chargeForQueries({ userId: req.authUser.id, queryCount });
  return null;
}

router.use(requireAccessAuth);

router.post(
  "/query/stream",
  asyncRoute(async (req, res) => {
    const parsed = parseQueryBody(req.body);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }
    const { queries, selected } = parsed;
    const userSecrets = await prepareSearch(req, queries.length);
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
            logError(writeErr, req, { phase: "cabinet_sseWrite" });
          }
        },
        { requestId: req.requestId, userId: req.authUser.id },
        userSecrets
      );
      await recordUsage({ userId: req.authUser.id, queryCount: queries.length });
      await addSearchHistory({
        userId: req.authUser.id,
        queryText: queries.length === 1 ? queries[0] : null,
        providers: selected,
        batch: queries.length > 1,
        queryCount: queries.length,
        resultSummary: streamHist,
      });
      res.end();
    } catch (e) {
      const status = e?.status || 500;
      if (!res.headersSent) {
        res.status(status).json({ error: e?.message || "Ошибка поиска" });
        return;
      }
      sseWrite(res, { type: "error", message: e?.message || String(e) });
      res.end();
    }
  })
);

router.post(
  "/query",
  asyncRoute(async (req, res) => {
    const parsed = parseQueryBody(req.body);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }
    const { queries, selected, batchInput } = parsed;
    const userSecrets = await prepareSearch(req, queries.length);
    const logMeta = { requestId: req.requestId, userId: req.authUser.id };
    try {
      const out = batchInput
        ? await searchBatchAcrossProviders(queries, selected, logMeta, userSecrets)
        : await searchAcrossProviders(queries[0], selected, logMeta, userSecrets);
      await recordUsage({ userId: req.authUser.id, queryCount: queries.length });
      await addSearchHistory({
        userId: req.authUser.id,
        queryText: batchInput ? null : queries[0],
        providers: selected,
        batch: batchInput,
        queryCount: queries.length,
        resultSummary: summarizeSearchOutcomeForHistory({ batch: batchInput, out }),
      });
      res.json(out);
    } catch (e) {
      res.status(e?.status || 500).json({ error: e?.message || "Внутренняя ошибка" });
    }
  })
);

export default router;
