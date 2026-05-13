/**
 * Модальное окно: ввод пароля администратора для чувствительных действий.
 * @param {{ title?: string, message?: string, confirmLabel?: string }} opts
 * @returns {Promise<string | null>} введённый пароль или null при отмене
 */
export function promptAdminPassword(opts = {}) {
  const title = opts.title || "Подтверждение";
  const message = opts.message || "Введите свой пароль администратора.";
  const confirmLabel = opts.confirmLabel || "Подтвердить";

  return new Promise((resolve) => {
    let settled = false;
    const resolveOnce = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const dlg = document.createElement("dialog");
    dlg.className = "pwd-dialog";
    dlg.innerHTML = `
      <form class="pwd-dialog-form">
        <h3 class="pwd-dialog-title">${escapeHtml(title)}</h3>
        <p class="pwd-dialog-msg muted">${escapeHtml(message)}</p>
        <label class="pwd-dialog-label">Пароль</label>
        <input type="password" class="pwd-dialog-input" autocomplete="current-password" required />
        <div class="pwd-dialog-actions">
          <button type="button" class="btn-secondary pwd-cancel">Отмена</button>
          <button type="submit" class="btn">${escapeHtml(confirmLabel)}</button>
        </div>
      </form>
    `;
    const form = dlg.querySelector("form");
    const input = dlg.querySelector(".pwd-dialog-input");
    dlg.addEventListener("cancel", () => {
      resolveOnce(null);
    });
    dlg.addEventListener("close", () => {
      dlg.remove();
    });
    dlg.querySelector(".pwd-cancel").addEventListener("click", () => {
      dlg.close();
      resolveOnce(null);
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input.value;
      dlg.close();
      resolveOnce(v || null);
    });
    document.body.append(dlg);
    dlg.showModal();
    queueMicrotask(() => input.focus());
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
