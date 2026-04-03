const q = document.getElementById("q");
const runBtn = document.getElementById("run");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const providerList = document.getElementById("provider-list");
const allCheckbox = document.querySelector('input[name="all"]');

let meta = { providers: [] };

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function renderProviderChips() {
  providerList.innerHTML = "";
  for (const p of meta.providers) {
    const label = document.createElement("label");
    label.className = "chip" + (p.configured ? "" : " off");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "provider";
    input.value = p.id;
    input.disabled = !p.configured;
    if (p.configured) input.checked = false;
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
    inp.disabled = on || !meta.providers.find((x) => x.id === inp.value)?.configured;
  });
});

providerList.addEventListener("change", () => {
  const any = [...providerList.querySelectorAll('input[name="provider"]:checked')].length;
  if (any) {
    allCheckbox.checked = false;
    providerList.querySelectorAll('input[name="provider"]').forEach((inp) => {
      if (meta.providers.find((x) => x.id === inp.value)?.configured) {
        inp.disabled = false;
      }
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

function renderResults(data) {
  resultsEl.innerHTML = "";

  if (data.skippedLabels?.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.innerHTML =
      "В <code>.env</code> не заданы ключи для: <strong>" +
      escapeHtml(data.skippedLabels.join(", ")) +
      "</strong>. Скопируйте <code>.env.example</code> → <code>.env</code> и заполните.";
    resultsEl.append(hint);
  }

  for (const r of data.results || []) {
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
      if (r.links.length === 0) {
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

    resultsEl.append(card);
  }
}

async function loadMeta() {
  const res = await fetch("/api/meta");
  meta = await res.json();
  renderProviderChips();
}

runBtn.addEventListener("click", async () => {
  const query = q.value.trim();
  if (!query) {
    setStatus("Введите запрос", true);
    return;
  }
  runBtn.disabled = true;
  setStatus("Запрос отправлен…");
  resultsEl.innerHTML = "";

  try {
    const res = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, providers: selectedProviders() }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "Ошибка запроса", true);
      if (data.results) renderResults(data);
      return;
    }
    setStatus("Готово.");
    renderResults(data);
  } catch (e) {
    setStatus(e.message || "Сеть недоступна", true);
  } finally {
    runBtn.disabled = false;
  }
});

loadMeta().catch(() => {
  setStatus("Не удалось загрузить список моделей", true);
});
