const q = document.getElementById("q");
const runBtn = document.getElementById("run");
const exportBtn = document.getElementById("export-xlsx");
const statusEl = document.getElementById("status");
const resultsTableHost = document.getElementById("results-table-host");
const streamProgressWrap = document.getElementById("stream-progress");
const streamProgressFill = document.getElementById("stream-progress-fill");
const streamProgressPct = document.getElementById("stream-progress-pct");
const streamProgressTrack = streamProgressWrap?.querySelector(".stream-progress-track");
const scrollTopBtn = document.getElementById("scroll-top-btn");
const streamProgressDock = document.getElementById("stream-progress-dock");
const streamProgressDockFill = document.getElementById("stream-progress-dock-fill");
const streamProgressDockPct = document.getElementById("stream-progress-dock-pct");
const streamProgressDockTrack = streamProgressDock?.querySelector(
  ".stream-progress-track--dock"
);
const providerList = document.getElementById("provider-list");
const allCheckbox = document.querySelector('input[name="all"]');

/** Пока идёт поток SSE — для нижней плашки прогресса при скролле. */
let streamActive = false;

const MAX_BATCH_QUERIES = 120;
const EXCEL_CELL_MAX = 32000;
const ANSWER_PREVIEW_LINES = 4;
const LINK_TILES_VISIBLE = 5;

/** Fallback до ответа GET /api/meta (тот же порядок id, что на сервере). */
const UI_PROVIDERS = [
  { id: "chatgpt", label: "ChatGPT" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "perplexity", label: "Perplexity" },
  { id: "google", label: "Google AI (Gemini)" },
  { id: "alice", label: "Алиса AI (Yandex Cloud LLM)" },
  { id: "alice_search", label: "Алиса в Поиске (Yandex Search API)" },
];

/** @type {{ id: string, label: string, configured: boolean, proxy?: boolean }[]} */
let providerMeta = UI_PROVIDERS.map((p) => ({ ...p, configured: true, proxy: false }));

/**
 * @type {{
 *   queries: string[],
 *   providerIds: string[],
 *   response: { batch: boolean, items: { query: string, results: object[] }[] }
 * } | null}
 */
let lastSnapshot = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function setExportEnabled(on) {
  exportBtn.disabled = !on;
  exportBtn.setAttribute("aria-disabled", String(!on));
}

function setStreamProgress(percent) {
  const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  if (streamProgressFill) streamProgressFill.style.width = `${p}%`;
  if (streamProgressPct) streamProgressPct.textContent = `${p}%`;
  if (streamProgressTrack) {
    streamProgressTrack.setAttribute("aria-valuenow", String(p));
  }
  if (streamProgressDockFill) streamProgressDockFill.style.width = `${p}%`;
  if (streamProgressDockPct) streamProgressDockPct.textContent = `${p}%`;
  if (streamProgressDockTrack) {
    streamProgressDockTrack.setAttribute("aria-valuenow", String(p));
  }
  updateFloatingChrome();
}

function updateFloatingChrome() {
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  if (scrollTopBtn) {
    scrollTopBtn.classList.toggle("is-hidden", y < 280);
  }
  const showDock = Boolean(streamActive && streamProgressDock && y > 120);
  document.body.classList.toggle("has-progress-dock", showDock);
  if (streamProgressDock) {
    streamProgressDock.classList.toggle("is-hidden", !showDock);
    streamProgressDock.setAttribute("aria-hidden", showDock ? "false" : "true");
  }
}

/** @type {Promise<{ marked: { parse: (s: string, o?: object) => string; setOptions: (o: object) => void }; DOMPurify: { sanitize: (s: string, o?: object) => string } }> | null} */
let markdownLibsPromise = null;

function loadMarkdownLibs() {
  if (!markdownLibsPromise) {
    markdownLibsPromise = Promise.all([
      import("https://esm.sh/marked@12.0.2"),
      import("https://esm.sh/dompurify@3.1.7"),
    ]).then(([mk, dp]) => {
      const marked = mk.marked ?? mk.default;
      const DOMPurify = dp.default ?? dp;
      marked.setOptions({ breaks: true, gfm: true });
      return { marked, DOMPurify };
    });
  }
  return markdownLibsPromise;
}

/**
 * Безопасный рендер Markdown в контейнер (сначала plain text, затем разметка).
 * @param {HTMLElement} el
 * @param {string} raw
 */
function fillAnswerMarkdown(el, raw) {
  const s = String(raw ?? "");
  el.textContent = s || "—";
  el.classList.add("answer-md", "answer-md--plain");
  loadMarkdownLibs()
    .then(({ marked, DOMPurify }) => {
      const html = marked.parse(s, { async: false });
      const clean = DOMPurify.sanitize(String(html ?? ""), {
        USE_PROFILES: { html: true },
      });
      el.classList.remove("answer-md--plain");
      el.innerHTML = clean;
      el.querySelectorAll("a[href]").forEach((a) => {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      });
    })
    .catch(() => {
      /* остаётся plain text */
    });
}

function showStreamProgress(on) {
  if (!streamProgressWrap) return;
  streamProgressWrap.classList.toggle("is-hidden", !on);
  streamProgressWrap.setAttribute("aria-hidden", on ? "false" : "true");
  updateFloatingChrome();
}

scrollTopBtn?.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});

let floatChromeRaf = 0;
window.addEventListener(
  "scroll",
  () => {
    if (floatChromeRaf) return;
    floatChromeRaf = requestAnimationFrame(() => {
      floatChromeRaf = 0;
      updateFloatingChrome();
    });
  },
  { passive: true }
);

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

function syncProviderChipInputs() {
  const allOn = allCheckbox.checked;
  providerList.querySelectorAll('input[name="provider"]').forEach((inp) => {
    const unavailable = inp.dataset.configured === "false";
    if (allOn) {
      inp.checked = false;
      inp.disabled = true;
    } else {
      inp.disabled = unavailable;
      if (unavailable) inp.checked = false;
    }
  });
}

function renderProviderChips() {
  providerList.innerHTML = "";
  for (const p of providerMeta) {
    const label = document.createElement("label");
    label.className = "chip";
    if (!p.configured) {
      label.classList.add("chip-unavailable");
      label.title = "Не настроено на сервере (нет ключа в .env)";
    } else if (p.proxy) {
      label.title = "Исходящие запросы к API идут через HTTP(S)-прокси из .env";
    }
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "provider";
    input.value = p.id;
    input.checked = false;
    input.dataset.configured = p.configured ? "true" : "false";
    input.disabled = !p.configured || allCheckbox.checked;
    const span = document.createElement("span");
    span.textContent = p.label;
    label.append(input, span);
    providerList.append(label);
  }
  syncProviderChipInputs();
}

async function refreshProviderMeta() {
  try {
    const r = await fetch("/api/meta");
    if (!r.ok) throw new Error("meta");
    const data = await r.json();
    if (Array.isArray(data.providers) && data.providers.length) {
      providerMeta = data.providers.map((x) => ({
        id: String(x.id),
        label: String(x.label ?? x.id),
        configured: Boolean(x.configured),
        proxy: Boolean(x.proxy),
      }));
    }
  } catch {
    /* оставляем текущий providerMeta */
  }
  renderProviderChips();
}

allCheckbox.addEventListener("change", () => {
  syncProviderChipInputs();
});

providerList.addEventListener("change", () => {
  const any = [...providerList.querySelectorAll('input[name="provider"]:checked')].length;
  if (any) {
    allCheckbox.checked = false;
  }
  syncProviderChipInputs();
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

function providerLabel(id) {
  return providerMeta.find((p) => p.id === id)?.label || id;
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

/**
 * Хост ссылки для подписи и фавиконки (пустая строка, если не разобрать).
 * @param {string} url
 */
function linkTileHostname(url) {
  const s = String(url ?? "").trim();
  if (!s) return "";
  try {
    const h = new URL(s).hostname;
    if (h) return h;
  } catch {
    /* без схемы, например example.com/path */
  }
  try {
    const h = new URL(`https://${s}`).hostname;
    if (h) return h;
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * Текст плитки ссылки: только хост (поддомен + домен), без схемы и пути.
 * @param {string} url
 */
function linkTileLabel(url) {
  const h = linkTileHostname(url);
  if (h) return h;
  const s = String(url ?? "").trim();
  return s || "—";
}

/** Ленивая загрузка favicon по хосту (внешний CDN, без ключа). */
function faviconUrlForHost(hostname) {
  if (!hostname) return "";
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(hostname)}.ico`;
}

/**
 * @param {object[]} results
 * @param {string[]} providerIds
 */
function sortResultsByProviderOrder(results, providerIds) {
  const order = new Map(providerIds.map((id, i) => [id, i]));
  return [...results].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
}

function appendSkippedHint(container, skippedLabels) {
  if (!skippedLabels?.length) return;
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.innerHTML =
    "В <code>.env</code> не заданы ключи для: <strong>" +
    escapeHtml(skippedLabels.join(", ")) +
    "</strong>. Скопируйте <code>.env.example</code> → <code>.env</code> и заполните.";
  container.append(hint);
}

/**
 * @param {Response} res
 * @param {(ev: Record<string, unknown>) => void} onEvent
 */
async function consumeSseJsonLines(res, onEvent) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Ответ без тела (stream).");
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    buf += dec.decode(value || new Uint8Array(), { stream: !done });
    if (done) break;
    for (;;) {
      const sep = buf.indexOf("\n\n");
      if (sep === -1) break;
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.replace(/^data:\s?/, "").trim();
        if (!payload) continue;
        onEvent(JSON.parse(payload));
      }
    }
  }
  let tail = buf;
  for (;;) {
    const sep = tail.indexOf("\n\n");
    if (sep === -1) break;
    const chunk = tail.slice(0, sep);
    tail = tail.slice(sep + 2);
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.replace(/^data:\s?/, "").trim();
      if (!payload) continue;
      onEvent(JSON.parse(payload));
    }
  }
}

/** Иконка «ещё ссылки ниже» — стрелка вниз (развернуть список). */
const SVG_LINKS_EXPAND =
  '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6-1.41-1.41z"/></svg>';

/** Иконка «свернуть лишние ссылки» — стрелка вверх. */
const SVG_LINKS_COLLAPSE =
  '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>';

/**
 * @param {HTMLElement} td
 * @param {object} r — поля как у runProvider на сервере
 */
function renderAnswerCell(td, r) {
  td.textContent = "";
  const wrap = document.createElement("div");
  wrap.className = "answer-cell";

  if (r.error) {
    const p = document.createElement("p");
    p.className = "err";
    p.textContent = r.error;
    wrap.append(p);
    td.append(wrap);
    return;
  }

  const text = String(r.text ?? "");
  const lines = text.split("\n");
  const needMoreLines = lines.length > ANSWER_PREVIEW_LINES;
  const previewMd = needMoreLines ? lines.slice(0, ANSWER_PREVIEW_LINES).join("\n") : text;
  const links = Array.isArray(r.links) ? r.links.filter(Boolean) : [];

  const meta = document.createElement("div");
  meta.className = "answer-meta";
  const u = r.usage || {};
  meta.textContent = `${r.durationMs ?? "—"} мс · токены: ${fmtTok(u.input)} / ${fmtTok(u.output)} / ${fmtTok(u.total)}`;

  const textBlock = document.createElement("div");
  textBlock.className = "answer-text-block";

  const mdShort = document.createElement("div");
  mdShort.className = "answer-md";

  if (!needMoreLines) {
    fillAnswerMarkdown(mdShort, text || "—");
    textBlock.append(mdShort);
  } else {
    mdShort.classList.add("answer-md--clamp");
    fillAnswerMarkdown(mdShort, previewMd || "—");

    const mdFull = document.createElement("div");
    mdFull.className = "answer-md answer-md--full is-hidden";
    fillAnswerMarkdown(mdFull, text || "—");

    textBlock.append(mdShort, mdFull);

    let expanded = false;
    const btnMore = document.createElement("button");
    btnMore.type = "button";
    btnMore.className = "btn-text btn-more";
    btnMore.textContent = "Подробнее";

    function applyTextExpanded() {
      btnMore.textContent = expanded ? "Свернуть" : "Подробнее";
      mdFull.classList.toggle("is-hidden", !expanded);
      mdShort.classList.toggle("is-hidden", expanded);
    }

    btnMore.addEventListener("click", () => {
      expanded = !expanded;
      applyTextExpanded();
    });
    textBlock.append(btnMore);
  }

  wrap.append(meta, textBlock);

  if (links.length) {
    const linksSection = document.createElement("div");
    linksSection.className = "answer-links-section";

    const linksTitle = document.createElement("div");
    linksTitle.className = "answer-links-title";
    linksTitle.textContent = "Ссылки из ответа";
    linksSection.append(linksTitle);

    const linksHost = document.createElement("div");
    linksHost.className = "link-tiles-host";

    let linksShowAll = false;
    function buildLinkTiles() {
      linksHost.textContent = "";
      const grid = document.createElement("div");
      grid.className = "link-tiles";
      const slice = linksShowAll ? links : links.slice(0, LINK_TILES_VISIBLE);
      for (const url of slice) {
        const a = document.createElement("a");
        a.className = "link-tile";
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title = url;
        const host = linkTileHostname(url);
        const favSrc = faviconUrlForHost(host);
        if (favSrc) {
          const img = document.createElement("img");
          img.className = "link-tile-favicon";
          img.src = favSrc;
          img.alt = "";
          img.width = 16;
          img.height = 16;
          img.loading = "lazy";
          img.decoding = "async";
          img.referrerPolicy = "no-referrer";
          img.addEventListener("error", () => {
            img.remove();
          });
          a.append(img);
        }
        const lab = document.createElement("span");
        lab.className = "link-tile-label";
        lab.textContent = linkTileLabel(url);
        a.append(lab);
        grid.append(a);
      }
      linksHost.append(grid);
      if (links.length > LINK_TILES_VISIBLE) {
        const row = document.createElement("div");
        row.className = "link-tiles-more";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-icon btn-icon--links";
        btn.setAttribute("aria-expanded", linksShowAll ? "true" : "false");
        btn.title = linksShowAll ? "Скрыть лишние ссылки" : "Показать все ссылки";
        btn.setAttribute("aria-label", btn.title);
        btn.innerHTML = linksShowAll ? SVG_LINKS_COLLAPSE : SVG_LINKS_EXPAND;
        btn.addEventListener("click", () => {
          linksShowAll = !linksShowAll;
          buildLinkTiles();
        });
        row.append(btn);
        linksHost.append(row);
      }
    }

    buildLinkTiles();
    linksSection.append(linksHost);
    wrap.append(linksSection);
  }

  td.append(wrap);
}

/**
 * @param {string[]} queries
 * @param {string[]} providerIds
 * @param {{ query: string, results: object[] }[]} items — мутабельные результаты
 */
function buildResultsTable(queries, providerIds, items) {
  if (!resultsTableHost) return;
  resultsTableHost.textContent = "";

  const frag = document.createDocumentFragment();
  const outer = document.createElement("div");
  outer.className = "results-table-outer";

  const table = document.createElement("table");
  table.className = "results-grid";
  table.setAttribute("role", "table");

  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const h of ["Запрос", "Нейронка", "Ответ"]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = h;
    hr.append(th);
  }
  thead.append(hr);
  table.append(thead);

  const tbody = document.createElement("tbody");

  for (let qi = 0; qi < queries.length; qi++) {
    const rowspan = providerIds.length;
    for (let pi = 0; pi < providerIds.length; pi++) {
      const pid = providerIds[pi];
      const tr = document.createElement("tr");
      tr.dataset.qi = String(qi);
      tr.dataset.pid = pid;

      if (pi === 0) {
        const tdQ = document.createElement("td");
        tdQ.className = "cell-query";
        tdQ.rowSpan = rowspan;
        tdQ.textContent = queries[qi];
        tr.append(tdQ);
      }

      const tdM = document.createElement("td");
      tdM.className = "cell-model";
      tdM.textContent = providerLabel(pid);
      tr.append(tdM);

      const tdA = document.createElement("td");
      tdA.className = "cell-answer";
      tdA.dataset.qi = String(qi);
      tdA.dataset.pid = pid;
      const wait = document.createElement("div");
      wait.className = "cell-wait";
      wait.textContent = "…";
      tdA.append(wait);
      tr.append(tdA);

      tbody.append(tr);
    }
  }

  table.append(tbody);
  outer.append(table);
  frag.append(outer);
  resultsTableHost.append(frag);
}

/**
 * @param {number} qi
 * @param {string} pid
 * @param {object} result
 * @param {{ query: string, results: object[] }[]} items
 */
function applyResultToTable(qi, pid, result, items) {
  const td = resultsTableHost?.querySelector(
    `td.cell-answer[data-qi="${qi}"][data-pid="${pid}"]`
  );
  if (!td) return;
  td.textContent = "";
  renderAnswerCell(td, result);
  if (items[qi]) items[qi].results.push(result);
}

/**
 * @param {{ queries: string[], providerIds: string[], response: object }} snap
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
  const pids = snap.providerIds;

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
      const list = pids?.length
        ? sortResultsByProviderOrder(item.results || [], pids)
        : item.results || [];
      for (const r of list) {
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
  if (resultsTableHost) {
    resultsTableHost.textContent = "";
    const wait = document.createElement("p");
    wait.className = "stream-table-wait";
    wait.textContent = "Строим таблицу…";
    resultsTableHost.append(wait);
  }
  setStreamProgress(0);
  showStreamProgress(true);
  streamActive = true;
  updateFloatingChrome();
  setStatus(`Поток: ${list.length} запрос(ов)…`);

  try {
    const res = await fetch("/api/query/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries: list, providers: selectedProviders() }),
    });

    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok && !ctype.includes("text/event-stream")) {
      const raw = await res.text();
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(raw);
        if (j?.error) msg = j.error;
      } catch {
        if (raw.trim()) msg = raw.trim().slice(0, 400);
      }
      setStatus(msg, true);
      streamActive = false;
      showStreamProgress(false);
      updateFloatingChrome();
      return;
    }

    if (!ctype.includes("text/event-stream")) {
      setStatus("Ожидался поток text/event-stream.", true);
      streamActive = false;
      showStreamProgress(false);
      updateFloatingChrome();
      return;
    }

    /** @type {{ query: string, results: object[] }[] | null} */
    let items = null;
    /** @type {string[] | null} */
    let providerIds = null;

    await consumeSseJsonLines(res, (ev) => {
      const t = ev?.type;
      if (t === "error") {
        setStatus(String(ev.message || "Ошибка"), true);
        streamActive = false;
        showStreamProgress(false);
        updateFloatingChrome();
        return;
      }
      if (t === "meta") {
        const queries = Array.isArray(ev.queries) ? ev.queries : list;
        providerIds = Array.isArray(ev.providerIds) ? ev.providerIds : [];
        items = queries.map((query) => ({ query, results: [] }));
        if (resultsTableHost) {
          resultsTableHost.textContent = "";
          appendSkippedHint(resultsTableHost, ev.skippedLabels);
        }
        buildResultsTable(queries, providerIds, items);
        setStreamProgress(0);
        return;
      }
      if (t === "result") {
        const qi = Number(ev.queryIndex);
        const pid = String(ev.providerId || "");
        const result = ev.result;
        if (items && result && Number.isFinite(qi) && pid) {
          applyResultToTable(qi, pid, result, items);
        }
        if (typeof ev.progress === "number") setStreamProgress(ev.progress);
        return;
      }
      if (t === "done") {
        if (items && providerIds) {
          lastSnapshot = {
            queries: items.map((i) => i.query),
            providerIds,
            response: { batch: true, items },
          };
          setExportEnabled(true);
        }
        setStreamProgress(100);
        setStatus("Готово.");
        streamActive = false;
        showStreamProgress(false);
        updateFloatingChrome();
        if (ev.skippedLabels?.length && resultsTableHost && !resultsTableHost.querySelector(".hint")) {
          appendSkippedHint(resultsTableHost, ev.skippedLabels);
        }
      }
    });

    if (!lastSnapshot) {
      streamActive = false;
      showStreamProgress(false);
      updateFloatingChrome();
    }
  } catch (e) {
    setStatus(e?.message || "Сеть или разбор потока", true);
    streamActive = false;
    showStreamProgress(false);
    updateFloatingChrome();
  } finally {
    streamActive = false;
    updateFloatingChrome();
    runBtn.disabled = false;
  }
});

setExportEnabled(false);
showStreamProgress(false);
streamActive = false;
updateFloatingChrome();
void refreshProviderMeta();
