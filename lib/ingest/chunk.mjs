import { estimateTokens } from "./util.mjs";

function splitLong(text, maxTokens) {
  const paragraphs = text.split(/\n{2,}|\n/).map((part) => part.trim()).filter(Boolean);
  if (!paragraphs.length) return [{ text, start: 0, end: text.length }];
  const parts = [];
  let buffer = "";
  let start = 0;
  const flush = (end) => { if (buffer.trim()) parts.push({ text: buffer.trim(), start, end }); };
  let cursor = 0;
  for (const paragraph of paragraphs) {
    const at = text.indexOf(paragraph, cursor);
    if (at < 0) continue;
    cursor = at + paragraph.length;
    const candidate = buffer ? `${buffer}\n${paragraph}` : paragraph;
    if (estimateTokens(candidate) > maxTokens && buffer) {
      flush(at);
      buffer = paragraph;
      start = at;
    } else {
      if (!buffer) start = at;
      buffer = candidate;
    }
  }
  flush(text.length);
  return parts;
}

export function chunkSegments(segments, { maxTokens = 800 } = {}) {
  const chunks = [];
  for (const segment of segments || []) {
    const text = (segment.text || "").trim();
    if (!text) continue;
    const tokens = estimateTokens(text);
    if (tokens <= maxTokens) {
      chunks.push({ text, locator: { ...(segment.locator || {}) }, tokenCount: tokens });
    } else {
      for (const part of splitLong(text, maxTokens)) {
        chunks.push({ text: part.text, locator: { ...(segment.locator || {}), startOffset: part.start, endOffset: part.end }, tokenCount: estimateTokens(part.text) });
      }
    }
  }
  return chunks;
}
