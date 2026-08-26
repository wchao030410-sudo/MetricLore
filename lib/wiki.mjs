import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

import { ROOT } from "./config.mjs";

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? walk(path) : path.endsWith(".md") ? [path] : [];
  });
}

function tokens(text) {
  const latin = text.toLowerCase().match(/[a-z0-9_]{2,}/g) || [];
  const chinese = (text.match(/[\u3400-\u9fff]+/g) || []).flatMap((part) => {
    const out = [part];
    for (let i = 0; i < part.length - 1; i += 1) out.push(part.slice(i, i + 2));
    return out;
  });
  return [...new Set([...latin, ...chinese])];
}

function titleOf(content, path) {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(path, ".md");
}

export class WikiIndex {
  constructor(dir = resolve(ROOT, "wiki")) {
    this.dir = dir;
    this.refresh();
  }

  refresh() {
    this.documents = walk(this.dir).map((path) => {
      const content = readFileSync(path, "utf8");
      return { path: relative(ROOT, path), title: titleOf(content, path), content, mtime: statSync(path).mtimeMs };
    });
  }

  search(query, limit = 5) {
    const wanted = tokens(query);
    if (!wanted.length) return [];
    return this.documents.map((doc) => {
      const title = doc.title.toLowerCase();
      const body = doc.content.toLowerCase();
      let score = 0;
      for (const token of wanted) {
        if (title.includes(token)) score += 8;
        const matches = body.split(token).length - 1;
        score += Math.min(matches, 8);
      }
      const first = wanted.map((token) => body.indexOf(token)).filter((at) => at >= 0).sort((a, b) => a - b)[0] || 0;
      const start = Math.max(0, first - 100);
      return { title: doc.title, path: doc.path, score, snippet: doc.content.slice(start, start + 500).replace(/\s+/g, " ").trim() };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.min(Number(limit) || 5, 10));
  }
}
