import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  getConfiguredProviders,
  PROVIDER_IDS,
  PROVIDER_LABELS,
} from "./src/providers.js";
import { searchAcrossProviders } from "./src/searchService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3847;

app.use(express.json({ limit: "64kb" }));

app.use((_req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});

app.get("/api/meta", (_req, res) => {
  const configured = getConfiguredProviders();
  const providers = PROVIDER_IDS.map((id) => ({
    id,
    label: PROVIDER_LABELS[id],
    configured: configured[id],
  }));
  res.json({ providers });
});

app.post("/api/query", async (req, res) => {
  const raw = req.body?.query;
  const providers = req.body?.providers;

  const query = typeof raw === "string" ? raw.trim() : "";
  if (!query) {
    res.status(400).json({ error: "Пустой запрос" });
    return;
  }
  if (query.length > 8000) {
    res.status(400).json({ error: "Запрос слишком длинный (макс. 8000 символов)" });
    return;
  }

  let selected = Array.isArray(providers) ? providers : ["all"];
  selected = selected.filter((p) => p === "all" || PROVIDER_IDS.includes(p));
  if (!selected.length) selected = ["all"];

  try {
    const out = await searchAcrossProviders(query, selected);
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

app.use(express.static(join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`AI Searcher: http://localhost:${PORT}`);
});
