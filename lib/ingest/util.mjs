import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";

export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function extensionOf(path) {
  return extname(path).replace(/^\./, "").toLowerCase();
}

export function estimateTokens(text) {
  // 中文按字符计、拉丁按词计，得到一个稳定的分段估算值。
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (text.match(/[a-zA-Z0-9]+/g) || []).length;
  return Math.max(1, cjk + latin);
}

export function json(value) {
  return JSON.stringify(value ?? null);
}
