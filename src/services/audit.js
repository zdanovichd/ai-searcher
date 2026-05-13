import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AUDIT_DIR = process.env.AUDIT_LOG_DIR?.trim() || path.join(__dirname, "..", "..", "logs");
const AUDIT_FILE = process.env.AUDIT_LOG_FILE?.trim() || "audit.log";
const AUDIT_PATH = path.isAbsolute(AUDIT_FILE) ? AUDIT_FILE : path.join(AUDIT_DIR, AUDIT_FILE);

let writeChain = Promise.resolve();

/**
 * @param {string} action
 * @param {Record<string, unknown>} [meta]
 */
export function writeAudit(action, meta = {}) {
  const record = {
    ts: new Date().toISOString(),
    audit: true,
    action,
    ...meta,
  };
  const line = JSON.stringify(record) + "\n";
  writeChain = writeChain.then(
    () =>
      new Promise((resolve) => {
        try {
          fs.mkdirSync(AUDIT_DIR, { recursive: true });
          fs.appendFile(AUDIT_PATH, line, { encoding: "utf8" }, (err) => {
            if (err) {
              console.error("[audit] appendFile:", err.message || String(err));
            }
            resolve();
          });
        } catch (e) {
          console.error("[audit] mkdir/append:", e?.message || String(e));
          resolve();
        }
      })
  );
}
