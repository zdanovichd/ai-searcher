const URL_IN_TEXT = /https?:\/\/[^\s\)\]\}"'>]+/gi;
const MD_LINK = /\[([^\]]*)\]\((https?:[^)\s]+)\)/gi;

/**
 * Собирает уникальные URL из текста и markdown-ссылок.
 */
export function extractLinks(text) {
  if (!text || typeof text !== "string") return [];
  const set = new Set();

  let m;
  const urlRe = new RegExp(URL_IN_TEXT.source, URL_IN_TEXT.flags);
  while ((m = urlRe.exec(text)) !== null) {
    set.add(trimTrailingJunk(m[0]));
  }

  const mdRe = new RegExp(MD_LINK.source, MD_LINK.flags);
  while ((m = mdRe.exec(text)) !== null) {
    set.add(trimTrailingJunk(m[2]));
  }

  return [...set];
}

function trimTrailingJunk(url) {
  return url.replace(/[.,;:!?)>\]]+$/u, "");
}
