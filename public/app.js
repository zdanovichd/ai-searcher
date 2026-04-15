const q = document.getElementById("q");
const runBtn = document.getElementById("run");
const exportBtn = document.getElementById("export-xlsx");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const providerList = document.getElementById("provider-list");
const allCheckbox = document.querySelector('input[name="all"]');

const MAX_BATCH_QUERIES = 120;
const EXCEL_CELL_MAX = 32000;

/** Совпадает с сервером (без /api/meta): id для POST /api/query. */
const UI_PROVIDERS = [
  { id: "chatgpt", label: "ChatGPT" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "perplexity", label: "Perplexity" },
  { id: "google", label: "Google AI (Gemini)" },
  { id: "alice", label: "Алиса AI (Yandex)" },
];

/** @type {{ queries: string[], response: object } | null} */
let lastSnapshot = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function setExportEnabled(on) {
  exportBtn.disabled = !on;
  exportBtn.setAttribute("aria-disabled", String(!on));
}

/**
 * Каждый непустой после trim ряд — отдельный запрос (новая строка = новый запрос).
 * @param {string} raw
 * @returns {string[]}
 */
function splitInputQueries(raw) {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function renderProviderChips() {
  providerList.innerHTML = "";
  for (const p of UI_PROVIDERS) {
    const label = document.createElement("label");
    label.className = "chip";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "provider";
    input.value = p.id;
    input.checked = false;
    const span = document.createElement("span");
    span.textContent = p.label;
    label.append(input, span);
    providerList.append(label);
  }
  allCheckbox.dispatchEvent(new Event("change"));
}

allCheckbox.addEventListener("change", () => {
  const on = allCheckbox.checked;
  providerList.querySelectorAll('input[name="provider"]').forEach((inp) => {
    if (!inp.disabled) inp.checked = false;
    inp.disabled = on;
  });
});

providerList.addEventListener("change", () => {
  const any = [...providerList.querySelectorAll('input[name="provider"]:checked')].length;
  if (any) {
    allCheckbox.checked = false;
    providerList.querySelectorAll('input[name="provider"]').forEach((inp) => {
      inp.disabled = false;
    });
  }
});

function selectedProviders() {
  if (allCheckbox.checked) return ["all"];
  const ids = [
    ...providerList.querySelectorAll('input[name="provider"]:checked'),
  ].map((el) => el.value);
  return ids.length ? ids : ["all"];
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTok(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return String(n);
}

function truncateCell(s, max = EXCEL_CELL_MAX) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function appendUsageBlock(card, usage) {
  const block = document.createElement("div");
  block.className = "card-usage";

  const title = document.createElement("div");
  title.className = "card-usage-title";
  title.textContent = "Токены (за этот запрос)";
  block.append(title);

  const has =
    usage &&
    (usage.input != null || usage.output != null || usage.total != null);

  if (!has) {
    const p = document.createElement("p");
    p.className = "card-usage-missing";
    p.textContent =
      "Провайдер не вернул разбивку токенов в ответе (или ответ без поля usage).";
    block.append(p);
    card.append(block);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "usage-grid";
  const rows = [
    ["Вход (prompt)", fmtTok(usage.input)],
    ["Выход (completion)", fmtTok(usage.output)],
    ["Всего", fmtTok(usage.total)],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement("span");
    dt.className = "usage-k";
    dt.textContent = k;
    const dd = document.createElement("span");
    dd.className = "usage-v";
    dd.textContent = v;
    grid.append(dt, dd);
  }
  block.append(grid);
  card.append(block);
}

/**
 * @param {object} r
 * @returns {HTMLElement}
 */
function buildProviderCard(r) {
  const card = document.createElement("article");
  card.className = "card";

  const h2 = document.createElement("h2");
  h2.textContent = r.label;
  card.append(h2);

  const sub = document.createElement("div");
  sub.className = "card-subhead";
  sub.textContent = r.error
    ? "ошибка"
    : `${r.durationMs} мс · ссылок: ${r.links?.length ?? 0}`;
  card.append(sub);

  if (r.error) {
    const err = document.createElement("p");
    err.className = "err";
    err.textContent = r.error;
    card.append(err);
  } else {
    appendUsageBlock(card, r.usage);

    const body = document.createElement("div");
    body.className = "body";
    body.textContent = r.text;
    card.append(body);

    const lb = document.createElement("div");
    lb.className = "links-block";
    const h3 = document.createElement("h3");
    h3.textContent = "Ссылки из ответа";
    lb.append(h3);
    if (!r.links?.length) {
      const empty = document.createElement("p");
      empty.className = "meta";
      empty.textContent = "Явных URL в тексте нет.";
      lb.append(empty);
    } else {
      const ul = document.createElement("ul");
      for (const url of r.links) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = url;
        li.append(a);
        ul.append(li);
      }
      lb.append(ul);
    }
    card.append(lb);
  }

  return card;
}

function appendSkippedHint(container, data) {
  if (!data.skippedLabels?.length) return;
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.innerHTML =
    "В <code>.env</code> не заданы ключи для: <strong>" +
    escapeHtml(data.skippedLabels.join(", ")) +
    "</strong>. Скопируйте <code>.env.example</code> → <code>.env</code> и заполните.";
  container.append(hint);
}

/**
 * @param {object} data — ответ /api/query
 */
function renderResults(data) {
  resultsEl.innerHTML = "";
  appendSkippedHint(resultsEl, data);

  if (data.batch) {
    const items = data.items || [];
    items.forEach((item, idx) => {
      const section = document.createElement("section");
      section.className = "batch-block";

      const head = document.createElement("header");
      head.className = "batch-head";
      const h2 = document.createElement("h2");
      h2.className = "batch-title";
      h2.textContent = `Запрос ${idx + 1} из ${items.length}`;
      const preview = document.createElement("p");
      preview.className = "batch-preview";
      preview.textContent = item.query;

      head.append(h2, preview);
      section.append(head);

      if (item.error) {
        const ep = document.createElement("p");
        ep.className = "err";
        ep.textContent = item.error;
        section.append(ep);
      }
      for (const r of item.results || []) {
        section.append(buildProviderCard(r));
      }
      resultsEl.append(section);
    });
  } else {
    for (const r of data.results || []) {
      resultsEl.append(buildProviderCard(r));
    }
  }
}

/**
 * @param {{ queries: string[], response: object }} snap
 * @returns {string[][]}
 */
function buildExportRows(snap) {
  const header = [
    "Запрос",
    "Модель",
    "Ошибка",
    "мс",
    "Токены вход",
    "Токены выход",
    "Токены всего",
    "Ссылок",
    "Ответ",
    "Ссылки (URL)",
  ];
  /** @param {string} queryText @param {object} r */
  function rowFromResult(queryText, r) {
    const u = r.usage || {};
    const linksStr = (r.links || []).join("\n");
    return [
      truncateCell(queryText),
      r.label,
      r.error || "",
      r.durationMs ?? "",
      u.input ?? "",
      u.output ?? "",
      u.total ?? "",
      r.links?.length ?? 0,
      truncateCell(r.text || ""),
      truncateCell(linksStr),
    ];
  }

  const rows = [header];
  const resp = snap.response;

  if (resp.batch) {
    for (const item of resp.items || []) {
      if (item.error) {
        rows.push([
          truncateCell(item.query),
          "—",
          item.error,
          "",
          "",
          "",
          "",
          "",
          "",
          "",
        ]);
        continue;
      }
      for (const r of item.results || []) {
        rows.push(rowFromResult(item.query, r));
      }
    }
  } else {
    const q0 = snap.queries[0] || "";
    for (const r of resp.results || []) {
      rows.push(rowFromResult(q0, r));
    }
  }
  return rows;
}

exportBtn.addEventListener("click", async () => {
  if (!lastSnapshot) return;
  setStatus("Готовим Excel…");
  try {
    const mod = await import("/vendor/xlsx.mjs");
    const { utils, write } = mod;
    const rows = buildExportRows(lastSnapshot);
    const wb = utils.book_new();
    const ws = utils.aoa_to_sheet(rows);
    utils.book_append_sheet(wb, ws, "Результаты");
    const out = write(wb, { bookType: "xlsx", type: "array" });
    const name = `ai-searcher-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const blob = new Blob([out], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus("Файл скачан.");
  } catch (e) {
    setStatus(e?.message || "Не удалось собрать Excel", true);
  }
});

runBtn.addEventListener("click", async () => {
  const list = splitInputQueries(q.value);
  if (!list.length) {
    setStatus("Введите запрос", true);
    return;
  }
  if (list.length > MAX_BATCH_QUERIES) {
    setStatus(`Слишком много запросов (макс. ${MAX_BATCH_QUERIES}).`, true);
    return;
  }

  runBtn.disabled = true;
  setExportEnabled(false);
  lastSnapshot = null;
  const batch = list.length > 1;
  setStatus(batch ? `Пакет: ${list.length} запросов (параллельно на сервере)…` : "Запрос отправлен…");
  resultsEl.innerHTML = "";

  try {
    const body =
      list.length === 1
        ? { query: list[0], providers: selectedProviders() }
        : { queries: list, providers: selectedProviders() };

    const res = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || "Ошибка запроса", true);
      if (data.results) renderResults(data);
      if (data.batch && data.items) {
        renderResults(data);
        lastSnapshot = { queries: list, response: data };
        setExportEnabled(true);
      }
      return;
    }

    lastSnapshot = { queries: list, response: data };
    setExportEnabled(true);
    setStatus(
      data.batch
        ? `Готово: ${data.items?.length ?? 0} запросов.`
        : "Готово."
    );
    renderResults(data);
  } catch (e) {
    setStatus(e.message || "Сеть недоступна", true);
  } finally {
    runBtn.disabled = false;
  }
});

setExportEnabled(false);
renderProviderChips();
