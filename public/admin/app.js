import { authFetch, logout, requireAuthPage } from "/shared/session.js";
import { formatDateTime, formatMoney, formatRole } from "/shared/copy.js";
import { promptAdminPassword } from "/shared/prompt-password.js?v=1";

await requireAuthPage();

const meRes = await authFetch("/api/cabinet/me");
const me = await meRes.json();
if (me.user?.role !== "admin") {
  window.location.href = "/cabinet/";
}

document.getElementById("logout").addEventListener("click", () => logout());

async function patchUserRole(userId, role) {
  const pwd = await promptAdminPassword({
    title: role === "admin" ? "Назначить администратором" : "Сделать обычным пользователем",
    message:
      role === "admin"
        ? "Введите свой пароль, чтобы назначить пользователя администратором."
        : "Введите свой пароль, чтобы снять роль администратора.",
    confirmLabel: "Выполнить",
  });
  if (!pwd) return;
  const res = await authFetch(`/api/admin/users/${userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, adminPassword: pwd }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || "Не удалось изменить роль.");
    return;
  }
  await loadUsers();
}

async function loadStats() {
  const res = await authFetch("/api/admin/stats");
  const data = await res.json();
  const host = document.getElementById("stats");
  host.replaceChildren();
  const cards = [
    ["Пользователи", data.users?.total_users ?? 0],
    ["Администраторы", data.users?.admins ?? 0],
    ["Подтверждённые", data.users?.verified ?? 0],
    ["Запросы", data.history?.total_queries ?? 0],
    ["API-ключи", data.apiKeys?.active_api_keys ?? 0],
  ];
  for (const [label, value] of cards) {
    const card = document.createElement("article");
    card.className = "app-card";
    card.innerHTML = `<p class="metric-label">${label}</p><p class="metric-value">${value}</p>`;
    host.append(card);
  }
}

async function loadUsers() {
  const res = await authFetch("/api/admin/users");
  const data = await res.json();
  const tbody = document.getElementById("users");
  tbody.replaceChildren();
  const myId = me.user?.id;
  for (const user of data.items || []) {
    const tr = document.createElement("tr");
    const balanceRes = await authFetch(`/api/admin/users/${user.id}/balance`);
    const balance = await balanceRes.json();
    const isSelf = myId && user.id === myId;
    const profileUrl = `/admin/user/?id=${encodeURIComponent(user.id)}`;
    tr.innerHTML = `<td><code class="mono">${escapeHtml(user.id)}</code></td><td>${escapeHtml(
      user.email
    )}</td><td><span class="badge ${
      user.role === "admin" ? "badge-admin" : "badge-user"
    }">${escapeHtml(formatRole(user.role))}</span></td><td>${
      user.isActive ? "Активен" : "Заблокирован"
    }</td><td><span class="badge ${user.emailVerified ? "badge-ok" : "badge-muted"}">${
      user.emailVerified ? "Подтверждён" : "Не подтверждён"
    }</span></td><td>${escapeHtml(formatMoney(balance.balance, balance.currency))}</td><td></td>`;
    const cell = tr.lastElementChild;
    if (!isSelf) {
      const open = document.createElement("a");
      open.className = "btn-secondary";
      open.href = profileUrl;
      open.textContent = "Управление";
      cell.append(open);
    }

    if (user.role !== "admin" && !isSelf) {
      const roleBtn = document.createElement("button");
      roleBtn.type = "button";
      roleBtn.className = "btn-secondary";
      roleBtn.textContent = "Назначить администратором";
      roleBtn.addEventListener("click", () => patchUserRole(user.id, "admin"));
      cell.append(roleBtn);
    } else if (user.role === "admin" && !isSelf) {
      const demoteBtn = document.createElement("button");
      demoteBtn.type = "button";
      demoteBtn.className = "btn-secondary";
      demoteBtn.textContent = "Сделать обычным пользователем";
      demoteBtn.addEventListener("click", () => patchUserRole(user.id, "user"));
      cell.append(demoteBtn);
    }
    const topup = document.createElement("button");
    topup.type = "button";
    topup.className = "btn-secondary";
    topup.textContent = "Пополнить +100";
    topup.addEventListener("click", async () => {
      await authFetch(`/api/admin/users/${user.id}/balance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 100, reason: "admin_topup" }),
      });
      await loadUsers();
    });
    const actions = document.createElement("div");
    actions.className = "btn-row";
    if (!isSelf) {
      const blockBtn = document.createElement("button");
      blockBtn.type = "button";
      blockBtn.className = "btn-danger";
      blockBtn.textContent = user.isActive ? "Заблокировать" : "Разблокировать";
      blockBtn.addEventListener("click", async () => {
        await authFetch(`/api/admin/users/${user.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: !user.isActive }),
        });
        await loadUsers();
      });
      actions.append(blockBtn);
    }
    actions.append(topup);
    cell.append(actions);
    tbody.append(tr);
  }
}

async function loadHistory() {
  const res = await authFetch("/api/admin/history?limit=50");
  const data = await res.json();
  const tbody = document.getElementById("history");
  tbody.replaceChildren();
  const items = data.items || [];
  if (!items.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="4" class="empty">История пока пуста.</td>';
    tbody.append(tr);
    return;
  }
  for (const item of items) {
    const tr = document.createElement("tr");
    const uid = item.user_id;
    const userUrl = uid ? `/admin/user/?id=${encodeURIComponent(uid)}` : "#";
    tr.innerHTML = `<td>${formatDateTime(item.created_at)}</td><td><a href="${escapeHtml(
      userUrl
    )}" class="mono"><code>${escapeHtml(uid || "—")}</code></a></td><td>${escapeHtml(
      item.query_text || "Пакетный запрос"
    )}</td><td>${item.query_count}</td>`;
    tbody.append(tr);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

await loadStats();
await loadUsers();
await loadHistory();
