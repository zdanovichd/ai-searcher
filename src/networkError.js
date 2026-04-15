/**
 * Разбор цепочки cause / AggregateError для undici fetch в Node (часто только «fetch failed»).
 * @param {unknown} e
 * @returns {string}
 */
export function explainNetworkError(e) {
  const parts = [];
  const seen = new Set();

  function push(s) {
    const t = String(s).trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    parts.push(t);
  }

  /**
   * @param {unknown} x
   * @param {number} depth
   */
  function walk(x, depth) {
    if (depth > 8 || x == null) return;

    if (typeof x === "object" && x instanceof AggregateError) {
      const ae = /** @type {AggregateError & { cause?: unknown }} */ (x);
      if (Array.isArray(ae.errors)) {
        for (const sub of ae.errors) walk(sub, depth + 1);
      }
      if (ae.cause != null) walk(ae.cause, depth + 1);
      return;
    }

    if (typeof x === "object" && x instanceof Error) {
      const er = /** @type {Error & { cause?: unknown } & Record<string, unknown>} */ (x);
      if (er.name === "AbortError") {
        push(`${er.message || "aborted"} (AbortError)`);
        return;
      }
      if (typeof er.message === "string") push(er.message);
      const o = /** @type {Record<string, unknown>} */ (er);
      if (typeof o.code === "string") push(`code=${o.code}`);
      if (typeof o.errno === "number") push(`errno=${o.errno}`);
      if (typeof o.syscall === "string") push(`syscall=${o.syscall}`);
      if (typeof o.address === "string") push(`host=${o.address}`);
      if (typeof o.port === "number") push(`port=${o.port}`);
      if (er.cause != null) walk(er.cause, depth + 1);
      return;
    }

    if (typeof x === "object" && x !== null) {
      const o = /** @type {Record<string, unknown>} */ (x);
      if (typeof o.message === "string") push(o.message);
      if (typeof o.code === "string") push(`code=${o.code}`);
      if (typeof o.errno === "number") push(`errno=${o.errno}`);
      if (typeof o.syscall === "string") push(`syscall=${o.syscall}`);
      if (typeof o.address === "string") push(`host=${o.address}`);
      if (typeof o.port === "number") push(`port=${o.port}`);
      if (o.cause != null) walk(o.cause, depth + 1);
      return;
    }

    push(String(x));
  }

  walk(e, 0);

  let out = parts.join(" · ");
  if (out.length > 520) out = out.slice(0, 517) + "…";

  const blob = out.toLowerCase();
  if (/fetch failed/.test(blob) || /networkerror|failed to fetch/i.test(out)) {
    if (/enotfound/.test(blob)) {
      out += " — DNS не разрешил имя.";
    } else if (/econnrefused/.test(blob)) {
      out += " — соединение отклонено (порт, прокси, файрвол).";
    } else if (/econnreset|etimedout|eai_again/.test(blob)) {
      out += " — обрыв или таймаут на уровне TCP.";
    } else if (/certificate|cert_|ssl|tls|unable_to_verify/i.test(blob)) {
      out += " — ошибка TLS (прокси, антивирус, время на ПК).";
    } else if (/eperm|eacces/.test(blob)) {
      out += " — ОС запретила сокет.";
    } else if (/enetunreach|ehostunreach/.test(blob)) {
      out += " — сеть до хоста недоступна (маршрут, IPv6).";
    } else {
      out +=
        " — проверьте исходящий HTTPS с машины, где запущен Node (curl к API провайдера), файрвол и VPN.";
    }
  }

  return out || String(e);
}
