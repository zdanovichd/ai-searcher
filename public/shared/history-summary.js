function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatProviderAnswerBlock(label, text, err) {
  const errHtml = err ? `<p class="status error">${escapeHtml(err)}</p>` : "";
  const body = text ? `<pre class="admin-h-pre">${escapeHtml(text)}</pre>` : "";
  return `<div class="admin-h-block"><p class="admin-h-model">${escapeHtml(label || "—")}</p>${errHtml}${body}</div>`;
}

/**
 * @param {Record<string, unknown>} row — строка истории (camelCase из кабинета или snake_case из админки).
 */
export function formatAnswersFromSummary(row) {
  const s = row.resultSummary ?? row.result_summary;
  const qt = row.queryText ?? row.query_text ?? "";
  if (!s || typeof s !== "object") {
    return `<p class="muted">Нет сохранённого текста ответа.</p>`;
  }
  if (s.v === 1 && s.mode === "stream" && Array.isArray(s.cells)) {
    const queries = Array.isArray(s.metaQueries) ? s.metaQueries : [];
    const byQi = new Map();
    for (const c of s.cells) {
      const qi = typeof c.qi === "number" ? c.qi : 0;
      if (!byQi.has(qi)) byQi.set(qi, []);
      byQi.get(qi).push(c);
    }
    const parts = [];
    for (const qi of [...byQi.keys()].sort((a, b) => a - b)) {
      const qtext = queries[qi] || qt || `Запрос #${qi + 1}`;
      parts.push(`<p class="admin-h-q"><strong>${escapeHtml(qtext)}</strong></p>`);
      for (const c of byQi.get(qi)) {
        parts.push(formatProviderAnswerBlock(c.label || c.pid, c.text, c.error));
      }
    }
    return parts.length
      ? `<div class="admin-h-answers">${parts.join("")}</div>`
      : `<p class="muted">Нет ячеек результата.</p>`;
  }
  if (s.v === 1 && s.batch && Array.isArray(s.rows)) {
    const parts = [];
    for (const r of s.rows) {
      parts.push(`<p class="admin-h-q"><strong>${escapeHtml(r.query || "")}</strong></p>`);
      if (r.planError) parts.push(`<p class="status error">${escapeHtml(r.planError)}</p>`);
      for (const p of r.providers || []) {
        parts.push(formatProviderAnswerBlock(p.label || p.id, p.text, p.error));
      }
    }
    return parts.length
      ? `<div class="admin-h-answers">${parts.join("")}</div>`
      : `<p class="muted">Нет данных ответа.</p>`;
  }
  if (s.v === 1 && !s.batch && Array.isArray(s.providers)) {
    const parts = [];
    for (const p of s.providers) {
      parts.push(formatProviderAnswerBlock(p.label || p.id, p.text, p.error));
    }
    return parts.length
      ? `<div class="admin-h-answers">${parts.join("")}</div>`
      : `<p class="muted">Нет данных ответа.</p>`;
  }
  return `<p class="muted">Для этой записи ответы в истории не сохранялись.</p>`;
}

/** Заполняет ячейку таблицы: кнопка «Показать» или короткий текст без раскрытия. */
export function mountHistoryAnswersCell(td, row) {
  td.className = "admin-h-ans";
  const answersHtml = formatAnswersFromSummary(row);
  const expandable = answersHtml.includes("admin-h-answers");
  if (expandable) {
    const wrap = document.createElement("div");
    wrap.className = "admin-h-ans-toggle-wrap";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-secondary";
    btn.textContent = "Показать";
    btn.setAttribute("aria-expanded", "false");
    const panel = document.createElement("div");
    panel.className = "admin-h-ans-panel";
    panel.hidden = true;
    panel.innerHTML = answersHtml;
    btn.addEventListener("click", () => {
      const open = panel.hidden;
      panel.hidden = !open;
      btn.textContent = open ? "Скрыть" : "Показать";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    wrap.append(btn, panel);
    td.append(wrap);
  } else {
    const stub = document.createElement("div");
    stub.className = "admin-h-ans-inline";
    stub.innerHTML = answersHtml;
    td.append(stub);
  }
}
