import { authFetch, logout, requireAuthPage } from "/shared/session.js";
import {
  formatDateTime,
  formatLimitUsage,
  formatMoney,
  formatRole,
} from "/shared/copy.js";
import { mountHistoryAnswersCell } from "/shared/history-summary.js?v=1";

await requireAuthPage();

document.getElementById("logout").addEventListener("click", () => logout());

const topupStatus = document.getElementById("topup-status");
const topupBtn = document.getElementById("btn-topup-robokassa");

function renderTopupStatusFromLocation() {
  const p = new URLSearchParams(window.location.search);
  const s = p.get("topup");
  const invId = p.get("invId");
  if (!topupStatus) return;
  topupStatus.classList.remove("ok", "error");
  if (s === "success") {
    topupStatus.textContent = invId ? `Платёж принят (счёт #${invId}). Баланс будет пополнен.` : "Платёж принят.";
    topupStatus.classList.add("ok");
  } else if (s === "fail") {
    topupStatus.textContent = invId ? `Платёж не завершён (счёт #${invId}).` : "Платёж не завершён.";
    topupStatus.classList.add("error");
  } else {
    topupStatus.textContent = "";
  }
}

renderTopupStatusFromLocation();

topupBtn?.addEventListener("click", async () => {
  topupBtn.disabled = true;
  topupStatus?.classList.remove("ok", "error");
  if (topupStatus) topupStatus.textContent = "Перенаправляем на оплату…";
  try {
    const res = await authFetch("/api/cabinet/topup/robokassa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rub: 100 }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.payUrl) {
      if (topupStatus) topupStatus.textContent = data.error || "Не удалось создать платёж.";
      topupStatus?.classList.add("error");
      return;
    }
    window.location.href = data.payUrl;
  } catch (e) {
    if (topupStatus) topupStatus.textContent = e instanceof Error ? e.message : String(e);
    topupStatus?.classList.add("error");
  } finally {
    topupBtn.disabled = false;
  }
});

document.getElementById("password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = document.getElementById("password-status");
  const res = await authFetch("/api/cabinet/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      currentPassword: document.getElementById("currentPassword").value,
      newPassword: document.getElementById("newPassword").value,
    }),
  });
  const data = await res.json().catch(() => ({}));
  status.textContent = res.ok ? data.message || "Пароль обновлён." : data.error || "Не удалось сменить пароль.";
  status.classList.toggle("error", !res.ok);
  status.classList.toggle("ok", res.ok);
});

document.getElementById("api-key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const created = document.getElementById("api-key-created");
  created.classList.remove("error", "ok");
  const res = await authFetch("/api/cabinet/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: document.getElementById("apiKeyName").value }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    created.textContent = data.error || "Не удалось создать ключ.";
    created.classList.add("error");
    return;
  }
  created.innerHTML = `Сохраните ключ — он показывается один раз:<div class="secret-box mono">${escapeHtml(
    data.secret
  )}</div>`;
  created.classList.add("ok");
  await loadApiKeys();
});

async function loadProfile() {
  const res = await authFetch("/api/cabinet/me");
  const data = await res.json();
  const user = data.user;
  document.getElementById("profile").innerHTML = `${escapeHtml(user.email)}<br><span class="badge ${
    user.role === "admin" ? "badge-admin" : "badge-user"
  }">${escapeHtml(formatRole(user.role))}</span> · ${
    user.emailVerified ? "Email подтверждён" : "Email не подтверждён"
  }`;
  if (user.role === "admin") {
    document.getElementById("admin-link").classList.remove("hidden");
  }
}

async function loadBalance() {
  const [balanceRes, limitsRes] = await Promise.all([
    authFetch("/api/cabinet/balance"),
    authFetch("/api/cabinet/limits"),
  ]);
  const balance = await balanceRes.json();
  const limits = await limitsRes.json();
  document.getElementById("balance").textContent = formatMoney(balance.balance, balance.currency);
  const l = limits.limits;
  const u = limits.usage;
  document.getElementById("limits").textContent = `За сегодня: ${formatLimitUsage(
    u.dayCount,
    l.dailyQueries
  )} · За месяц: ${formatLimitUsage(u.monthCount, l.monthlyQueries)}`;
}

async function loadApiKeys() {
  const res = await authFetch("/api/cabinet/api-keys");
  const data = await res.json();
  const tbody = document.getElementById("api-keys");
  tbody.replaceChildren();
  const items = data.items || [];
  if (!items.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="4" class="empty">Ключи ещё не созданы.</td>';
    tbody.append(tr);
    return;
  }
  for (const item of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(item.name || "Без названия")}</td><td><code>${escapeHtml(
      item.keyPrefix
    )}</code></td><td>${formatDateTime(item.createdAt)}</td><td></td>`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = item.active ? "btn-danger" : "btn-secondary";
    btn.textContent = item.active ? "Отозвать" : "Отозван";
    btn.disabled = !item.active;
    btn.addEventListener("click", async () => {
      await authFetch(`/api/cabinet/api-keys/${item.id}`, { method: "DELETE" });
      await loadApiKeys();
    });
    tr.lastElementChild.append(btn);
    tbody.append(tr);
  }
}

async function loadHistory() {
  const res = await authFetch("/api/cabinet/history?limit=30");
  const data = await res.json();
  const tbody = document.getElementById("history");
  tbody.replaceChildren();
  const items = data.items || [];
  if (!items.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="5" class="empty">История пока пуста.</td>';
    tbody.append(tr);
    return;
  }
  for (const item of items) {
    const tr = document.createElement("tr");
    const tdDate = document.createElement("td");
    tdDate.className = "admin-h-date";
    tdDate.textContent = formatDateTime(item.createdAt);

    const tdQuery = document.createElement("td");
    tdQuery.className = "admin-h-query";
    tdQuery.textContent = item.queryText || "Пакетный запрос";

    const tdAns = document.createElement("td");
    mountHistoryAnswersCell(tdAns, item);

    const tdBatch = document.createElement("td");
    tdBatch.textContent = item.batch ? "Да" : "Нет";

    const tdCount = document.createElement("td");
    tdCount.textContent = String(item.queryCount ?? "");

    tr.append(tdDate, tdQuery, tdAns, tdBatch, tdCount);
    tbody.append(tr);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

await loadProfile();
await loadBalance();
await loadApiKeys();
await loadHistory();
