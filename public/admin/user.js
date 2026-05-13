import { authFetch, logout, requireAuthPage } from "/shared/session.js";
import { formatDateTime, formatLimitUsage, formatMoney, formatRole } from "/shared/copy.js";
import { promptAdminPassword } from "/shared/prompt-password.js?v=1";
import { mountHistoryAnswersCell } from "/shared/history-summary.js?v=1";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Извлекает UUID из query (декодирование, обрезка; при необходимости — первая подстрока UUID). */
function parseUserIdFromLocation() {
  const raw = new URLSearchParams(window.location.search).get("id");
  if (raw == null) return "";
  let s = "";
  try {
    s = decodeURIComponent(raw.trim());
  } catch {
    s = raw.trim();
  }
  if (UUID_RE.test(s)) return s.toLowerCase();
  const m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0].toLowerCase() : "";
}

function safeJsonParse(text) {
  const t = String(text ?? "").trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return { ok: false, data: {} };
  try {
    return { ok: true, data: JSON.parse(t) };
  } catch {
    return { ok: false, data: {} };
  }
}

await requireAuthPage();

const meRes = await authFetch("/api/cabinet/me");
const me = await meRes.json().catch(() => ({}));

if (me.user?.role !== "admin") {
  window.location.href = "/cabinet/";
} else {
  const userId = parseUserIdFromLocation();
  if (!userId) {
    window.location.href = "/admin/";
  } else {
    const uidEnc = encodeURIComponent(userId);

    let currentUser = null;

    document.getElementById("logout").addEventListener("click", () => logout());

    async function loadAll() {
      const uRes = await authFetch(`/api/admin/users/${uidEnc}`);
      const rawBody = await uRes.text();
      const parsed = safeJsonParse(rawBody);
      const uData = parsed.data;
      if (!uRes.ok || !uData.user) {
        const bodyTxt = String(rawBody ?? "").trim();
        const looksLikeHtml = /^<!doctype html/i.test(bodyTxt) || /^<html/i.test(bodyTxt);
        let msg;
        if (uRes.status === 403) {
          msg = "Нет доступа к админ-API (нужна роль администратора).";
        } else if (uRes.status === 400) {
          msg = uData.error || "Некорректный id пользователя.";
        } else if (uRes.status === 404) {
          if (looksLikeHtml) {
            msg =
              "Ответ 404 пришёл как HTML, а не JSON: до Node-приложения запрос не дошёл или его перехватил прокси/статический хостинг. Откройте в браузере тот же URL, что в Network для запроса к API, и убедитесь, что запущен актуальный `node server.js` из этого проекта.";
          } else if (!parsed.ok && bodyTxt) {
            msg =
              "Ответ 404 не удалось разобрать как JSON (часто прокси или другой сервер). Проверьте вкладку Network: фактический URL и тело ответа.";
          } else if (!bodyTxt) {
            msg =
              "Пустой ответ 404: часто это другой процесс на том же порту или обрезание пути прокси. Проверьте, что страница и API идут на один и тот же origin.";
          } else if (uData.error) {
            msg = uData.path ? `${uData.error} (${uData.path})` : uData.error;
          } else {
            msg = "Пользователь не найден в базе (нет строки с таким id).";
          }
        } else {
          msg = uData.error || `Не удалось загрузить профиль (${uRes.status}).`;
        }
        document.getElementById("profile").innerHTML = `<p class="status error">${escapeHtml(msg)}</p>`;
        return;
      }
      const { user } = uData;
      currentUser = user;
      document.getElementById("user-headline").textContent = user.email;
      document.getElementById("profile").innerHTML = `<strong>ID</strong><br><code class="mono">${escapeHtml(
        String(user.id)
      )}</code><br><br><strong>Email</strong><br>${escapeHtml(user.email)}<br><br><span class="badge ${
        user.role === "admin" ? "badge-admin" : "badge-user"
      }">${escapeHtml(formatRole(user.role))}</span> · ${
        user.isActive ? "Активен" : "Заблокирован"
      } · ${user.emailVerified ? "Email подтверждён" : "Email не подтверждён"}`;

      const promote = document.getElementById("btn-promote");
      const demote = document.getElementById("btn-demote");
      const block = document.getElementById("btn-block");
      const isSelf = String(user.id) === String(me.user?.id);
      promote.classList.toggle("hidden", user.role === "admin" || isSelf);
      demote.classList.toggle("hidden", user.role !== "admin" || isSelf);
      block.classList.toggle("hidden", isSelf);
      if (!isSelf) {
        block.textContent = user.isActive ? "Заблокировать" : "Разблокировать";
        block.className = user.isActive ? "btn-danger" : "btn-secondary";
      }

      const [balanceRes, limitsRes, keysRes] = await Promise.all([
        authFetch(`/api/admin/users/${uidEnc}/balance`),
        authFetch(`/api/admin/users/${uidEnc}/limits`),
        authFetch(`/api/admin/users/${uidEnc}/api-keys`),
      ]);
      const balance = await balanceRes.json().catch(() => ({}));
      const limData = await limitsRes.json().catch(() => ({}));
      const keysData = await keysRes.json().catch(() => ({}));

      if (!balanceRes.ok) {
        document.getElementById("balance").textContent = balance.error || "—";
      } else {
        document.getElementById("balance").textContent = formatMoney(balance.balance, balance.currency);
      }

      const l = limData.limits || {};
      const u = limData.usage || { dayCount: 0, monthCount: 0 };
      document.getElementById("lim-day").value = l.dailyQueries ?? "";
      document.getElementById("lim-month").value = l.monthlyQueries ?? "";
      document.getElementById("lim-batch").value = l.maxBatchSize ?? "";

      const usageLine = document.createElement("p");
      usageLine.className = "metric-label";
      usageLine.style.marginTop = "0.5rem";
      usageLine.textContent = `Сегодня: ${formatLimitUsage(u.dayCount, l.dailyQueries)} · За месяц: ${formatLimitUsage(
        u.monthCount,
        l.monthlyQueries
      )}`;
      const balCard = document.getElementById("balance").closest(".app-card");
      balCard.querySelector(".admin-usage-line")?.remove();
      usageLine.classList.add("admin-usage-line");
      balCard.append(usageLine);

      let historyItems = [];
      let historyError = null;
      try {
        const histRes = await authFetch(`/api/admin/history?userId=${uidEnc}&limit=80`);
        const histData = await histRes.json().catch(() => ({}));
        if (!histRes.ok) {
          historyError = histData.error || `Не удалось загрузить историю (${histRes.status}).`;
        } else if (!Array.isArray(histData.items)) {
          historyError = "Некорректный ответ сервера при загрузке истории.";
        } else {
          historyItems = histData.items;
        }
      } catch (e) {
        historyError = e instanceof Error ? e.message : String(e);
      }

      renderKeys(keysData.items || []);
      renderHistory(historyItems, historyError);
    }

    function renderKeys(items) {
      const tbody = document.getElementById("api-keys");
      tbody.replaceChildren();
      if (!items.length) {
        const tr = document.createElement("tr");
        tr.innerHTML = '<td colspan="5" class="empty">Ключей нет.</td>';
        tbody.append(tr);
        return;
      }
      for (const item of items) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${escapeHtml(item.name || "—")}</td><td><code>${escapeHtml(
          item.keyPrefix
        )}</code></td><td>${formatDateTime(item.createdAt)}</td><td>${
          item.active ? "Активен" : "Отозван"
        }</td><td></td>`;
        if (item.active) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "btn-danger";
          btn.textContent = "Отозвать";
          btn.addEventListener("click", async () => {
            await authFetch(`/api/admin/users/${uidEnc}/api-keys/${encodeURIComponent(item.id)}`, {
              method: "DELETE",
            });
            await loadAll();
          });
          tr.lastElementChild.append(btn);
        }
        tbody.append(tr);
      }
    }

    function renderHistory(items, loadError) {
      const tbody = document.getElementById("history");
      tbody.replaceChildren();
      if (loadError) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="5" class="empty status error">${escapeHtml(loadError)}</td>`;
        tbody.append(tr);
        return;
      }
      if (!items.length) {
        const tr = document.createElement("tr");
        tr.innerHTML = '<td colspan="5" class="empty">История пуста.</td>';
        tbody.append(tr);
        return;
      }
      for (const item of items) {
        const tr = document.createElement("tr");
        const tdDate = document.createElement("td");
        tdDate.className = "admin-h-date";
        tdDate.textContent = formatDateTime(item.created_at);

        const tdQuery = document.createElement("td");
        tdQuery.className = "admin-h-query";
        tdQuery.textContent = item.query_text || "Пакетный запрос";

        const tdAns = document.createElement("td");
        mountHistoryAnswersCell(tdAns, item);

        const tdBatch = document.createElement("td");
        tdBatch.textContent = item.batch ? "Да" : "Нет";

        const tdCount = document.createElement("td");
        tdCount.textContent = String(item.query_count ?? "");

        tr.append(tdDate, tdQuery, tdAns, tdBatch, tdCount);
        tbody.append(tr);
      }
    }

    document.getElementById("btn-topup").addEventListener("click", async () => {
      await authFetch(`/api/admin/users/${uidEnc}/balance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 100, reason: "admin_topup" }),
      });
      await loadAll();
    });

    document.getElementById("btn-block").addEventListener("click", async () => {
      if (!currentUser || String(currentUser.id) === String(me.user?.id)) return;
      await authFetch(`/api/admin/users/${uidEnc}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !currentUser.isActive }),
      });
      await loadAll();
    });

    async function patchRole(role) {
      const pwd = await promptAdminPassword({
        title: role === "admin" ? "Назначить администратором" : "Сделать обычным пользователем",
        message:
          role === "admin"
            ? "Введите свой пароль, чтобы назначить пользователя администратором."
            : "Введите свой пароль, чтобы снять роль администратора.",
        confirmLabel: "Выполнить",
      });
      if (!pwd) return;
      const res = await authFetch(`/api/admin/users/${uidEnc}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, adminPassword: pwd }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Не удалось изменить роль.");
        return;
      }
      await loadAll();
    }

    document.getElementById("btn-promote").addEventListener("click", () => patchRole("admin"));
    document.getElementById("btn-demote").addEventListener("click", () => patchRole("user"));

    document.getElementById("limits-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const status = document.getElementById("limits-status");
      status.classList.remove("ok", "error");
      const dayRaw = document.getElementById("lim-day").value.trim();
      const monthRaw = document.getElementById("lim-month").value.trim();
      const batchRaw = document.getElementById("lim-batch").value.trim();
      const dailyQueries = dayRaw === "" ? null : Number(dayRaw);
      const monthlyQueries = monthRaw === "" ? null : Number(monthRaw);
      const maxBatchSize = batchRaw === "" ? null : Number(batchRaw);
      if (
        (dayRaw !== "" && !Number.isFinite(dailyQueries)) ||
        (monthRaw !== "" && !Number.isFinite(monthlyQueries))
      ) {
        status.textContent = "Некорректные числа в лимитах.";
        status.classList.add("error");
        return;
      }
      if (!Number.isFinite(maxBatchSize) || maxBatchSize < 1) {
        status.textContent = "Укажите размер пакета (число ≥ 1).";
        status.classList.add("error");
        return;
      }
      const res = await authFetch(`/api/admin/users/${uidEnc}/limits`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dailyQueries, monthlyQueries, maxBatchSize }),
      });
      const data = await res.json().catch(() => ({}));
      status.textContent = res.ok ? "Лимиты сохранены." : data.error || "Ошибка сохранения.";
      status.classList.toggle("ok", res.ok);
      status.classList.toggle("error", !res.ok);
      if (res.ok) await loadAll();
    });

    await loadAll();
  }
}
