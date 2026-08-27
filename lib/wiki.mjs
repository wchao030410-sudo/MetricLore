import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ROOT } from "./config.mjs";
import { parseFrontmatter } from "./markdown-frontmatter.mjs";

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? walk(path) : path.endsWith(".md") ? [path] : [];
  });
}

function tokens(text) {
  const latin = text.toLowerCase().match(/[a-z0-9_-]{2,}/g) || [];
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
  constructor(dir = resolve(ROOT, "wiki"), ontology = null) {
    this.dir = dir;
    this.ontology = ontology;
    this.fts = new DatabaseSync(":memory:");
    this.fts.exec("CREATE VIRTUAL TABLE wiki_fts USING fts5(identity UNINDEXED, title, aliases, body, type UNINDEXED, status UNINDEXED, path UNINDEXED)");
    this.refresh();
  }

  refresh() {
    this.documents = walk(this.dir).map((path) => {
      const raw = readFileSync(path, "utf8");
      const { attributes, body } = parseFrontmatter(raw);
      const title = attributes.title || titleOf(body, path);
      const relations = {};
      for (const item of Array.isArray(attributes.relations) ? attributes.relations : []) {
        const [relation, target] = String(item).split(":");
        if (relation && target) (relations[relation] ||= []).push(target);
      }
      return { ...attributes, title, relations, path: relative(ROOT, path), content: body, mtime: statSync(path).mtimeMs };
    });
    this.entities = new Map(this.documents.filter((doc) => doc.key && doc.type).map((doc) => [doc.key, doc]));
    this.fts.exec("DELETE FROM wiki_fts");
    const insert = this.fts.prepare("INSERT INTO wiki_fts(identity, title, aliases, body, type, status, path) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const doc of this.documents) insert.run(doc.key || doc.path, doc.title, (doc.aliases || []).join(" "), doc.content, doc.type || "Page", doc.status || "untyped", doc.path);
    this.incoming = new Map();
    for (const entity of this.entities.values()) {
      for (const [relation, targets] of Object.entries(entity.relations || {})) {
        for (const target of targets) {
          const links = this.incoming.get(target) || [];
          links.push({ key: entity.key, relation, entity });
          this.incoming.set(target, links);
        }
      }
    }
  }

  entity(key) {
    const entity = this.entities.get(key);
    if (!entity) throw new Error(`Wiki 实体不存在: ${key}`);
    return this.publicEntity(entity);
  }

  publicEntity(entity) {
    return { key: entity.key, type: entity.type, title: entity.title, aliases: entity.aliases || [], status: entity.status || "untyped", sources: entity.sources || [], relations: entity.relations || {}, content: entity.content, path: entity.path };
  }

  identity(document) {
    return document.key || document.path;
  }

  page(identity) {
    const document = this.entities.get(identity) || this.documents.find((item) => item.path === identity);
    if (!document) throw new Error(`Wiki 页面不存在: ${identity}`);
    const outgoing = document.key ? this.neighbors(document.key, "outgoing") : [];
    const incoming = document.key ? this.neighbors(document.key, "incoming") : [];
    return {
      ...this.publicEntity(document),
      key: document.key || document.path,
      entityKey: document.key || null,
      updatedAt: new Date(document.mtime).toISOString(),
      outgoing,
      incoming,
    };
  }

  pages({ query = "", entityTypes = [], statuses = [], limit = 50, cursor = 0 } = {}) {
    const queryTokens = tokens(query);
    const typeSet = new Set(entityTypes || []);
    const statusSet = new Set(statuses || []);
    const offset = Math.max(Number(cursor) || 0, 0);
    const limitN = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const filtered = this.documents.filter((document) => {
      if (typeSet.size && !typeSet.has(document.type || "Page")) return false;
      if (statusSet.size && !statusSet.has(document.status || "untyped")) return false;
      if (!queryTokens.length) return true;
      const haystack = `${document.title} ${(document.aliases || []).join(" ")} ${document.content} ${document.key || ""}`.toLowerCase();
      return queryTokens.every((token) => haystack.includes(token));
    }).sort((a, b) => (a.type || "Page").localeCompare(b.type || "Page") || a.title.localeCompare(b.title));
    const items = filtered.slice(offset, offset + limitN).map((document) => ({
      key: this.identity(document), entityKey: document.key || null, type: document.type || "Page", title: document.title,
      status: document.status || "untyped", path: document.path, sources: document.sources || [],
      snippet: document.content.slice(0, 240).replace(/\s+/g, " ").trim(), updatedAt: new Date(document.mtime).toISOString(),
    }));
    return { items, total: filtered.length, nextCursor: offset + limitN < filtered.length ? String(offset + limitN) : null };
  }

  source(identity, sourceIndex = 0) {
    const page = this.page(identity);
    const index = Math.max(Number(sourceIndex) || 0, 0);
    const sourcePath = page.sources[index] || page.path;
    const absolute = resolve(ROOT, sourcePath);
    if (absolute !== ROOT && !absolute.startsWith(`${ROOT}/`)) throw new Error("来源路径超出项目目录");
    const available = existsSync(absolute) && statSync(absolute).isFile();
    const content = available ? readFileSync(absolute, "utf8").slice(0, 200_000) : "";
    return {
      pageKey: page.key,
      title: page.title,
      sourceIndex: index,
      path: sourcePath,
      available,
      locator: { path: sourcePath, type: extType(sourcePath), fallbackPage: sourcePath === page.path },
      content,
    };
  }

  graph({ focusKey, depth = 2, entityTypes = [], relationTypes = [], statuses = [], limit = 200 } = {}) {
    const typeSet = new Set(entityTypes || []);
    const relationSet = new Set(relationTypes || []);
    const statusSet = new Set(statuses || []);
    const maxDepth = Math.min(Math.max(Number(depth) || 2, 1), 3);
    const maxNodes = Math.min(Math.max(Number(limit) || 200, 1), 200);
    let selected = new Set(this.entities.keys());
    if (focusKey) {
      if (!this.entities.has(focusKey)) throw new Error(`Wiki 实体不存在: ${focusKey}`);
      selected = new Set([focusKey]);
      let frontier = new Set([focusKey]);
      for (let level = 0; level < maxDepth; level += 1) {
        const next = new Set();
        for (const key of frontier) {
          for (const neighbor of this.neighbors(key, "both", [...relationSet])) {
            if (!selected.has(neighbor.entity.key)) next.add(neighbor.entity.key);
          }
        }
        for (const key of next) selected.add(key);
        frontier = next;
      }
    }
    const nodes = [...selected].map((key) => this.entities.get(key)).filter(Boolean)
      .filter((entity) => !typeSet.size || typeSet.has(entity.type))
      .filter((entity) => !statusSet.size || statusSet.has(entity.status || "untyped"))
      .slice(0, maxNodes)
      .map((entity) => ({ key: entity.key, title: entity.title, type: entity.type, status: entity.status || "untyped", path: entity.path }));
    const nodeKeys = new Set(nodes.map((node) => node.key));
    const edges = [];
    for (const source of nodes) {
      const entity = this.entities.get(source.key);
      for (const [relation, targets] of Object.entries(entity.relations || {})) {
        if (relationSet.size && !relationSet.has(relation)) continue;
        for (const target of targets) if (nodeKeys.has(target)) edges.push({ id: `${source.key}:${relation}:${target}`, source: source.key, target, relation });
      }
    }
    return { nodes, edges, focusKey: focusKey || null, depth: maxDepth };
  }

  search(query, limit = 5, entityTypes = []) {
    const wanted = tokens(query);
    if (!wanted.length) return [];
    const typeSet = new Set(entityTypes || []);
    const ftsScores = new Map();
    const latinTerms = wanted.filter((token) => /^[a-z0-9_-]{2,}$/i.test(token));
    if (latinTerms.length) {
      const expression = latinTerms.map((token) => `"${token.replace(/"/g, "")}"`).join(" OR ");
      for (const row of this.fts.prepare("SELECT identity, bm25(wiki_fts) AS rank FROM wiki_fts WHERE wiki_fts MATCH ? LIMIT 20").all(expression)) {
        ftsScores.set(row.identity, Math.max(1, 20 - Number(row.rank || 0)));
      }
    }
    return this.documents.map((doc) => {
      if (typeSet.size && (!doc.type || !typeSet.has(doc.type))) return null;
      const title = doc.title.toLowerCase();
      const aliases = (doc.aliases || []).join(" ").toLowerCase();
      const body = doc.content.toLowerCase();
      let score = (doc.status === "verified" ? 2 : 0) + (ftsScores.get(doc.key || doc.path) || 0);
      for (const token of wanted) {
        if (title.includes(token)) score += 12;
        if (aliases.includes(token)) score += 10;
        if (doc.key?.includes(token)) score += 7;
        score += Math.min(body.split(token).length - 1, 8);
      }
      const first = wanted.map((token) => body.indexOf(token)).filter((at) => at >= 0).sort((a, b) => a - b)[0] || 0;
      const start = Math.max(0, first - 100);
      return { key: doc.key || null, type: doc.type || "Page", title: doc.title, path: doc.path, status: doc.status || "untyped", sources: doc.sources || [], score, snippet: doc.content.slice(start, start + 500).replace(/\s+/g, " ").trim() };
    }).filter(Boolean).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, Math.min(Number(limit) || 5, 10));
  }

  neighbors(key, direction = "both", relationTypes = []) {
    const entity = this.entities.get(key);
    if (!entity) throw new Error(`Wiki 实体不存在: ${key}`);
    const filter = new Set(relationTypes || []);
    const outgoing = [];
    if (direction === "outgoing" || direction === "both") {
      for (const [relation, targets] of Object.entries(entity.relations || {})) {
        if (filter.size && !filter.has(relation)) continue;
        for (const target of targets) if (this.entities.has(target)) outgoing.push({ direction: "outgoing", relation, entity: this.publicEntity(this.entities.get(target)) });
      }
    }
    const incoming = [];
    if (direction === "incoming" || direction === "both") {
      for (const link of this.incoming.get(key) || []) {
        if (filter.size && !filter.has(link.relation)) continue;
        incoming.push({ direction: "incoming", relation: link.relation, entity: this.publicEntity(link.entity) });
      }
    }
    return [...outgoing, ...incoming];
  }

  trace(startKey, relationTypes = [], depth = 2) {
    if (!this.entities.has(startKey)) throw new Error(`Wiki 实体不存在: ${startKey}`);
    const paths = []; const queue = [{ key: startKey, path: [startKey] }]; const seen = new Set([startKey]);
    while (queue.length) {
      const current = queue.shift();
      if (current.path.length > depth + 1) continue;
      for (const neighbor of this.neighbors(current.key, "outgoing", relationTypes)) {
        const next = neighbor.entity.key;
        paths.push([...current.path, `${neighbor.relation}:${next}`]);
        if (!seen.has(next)) { seen.add(next); queue.push({ key: next, path: [...current.path, next] }); }
      }
    }
    return paths;
  }
}

function extType(path) {
  const extension = String(path).split(".").pop()?.toLowerCase();
  if (["md", "markdown"].includes(extension)) return "markdown";
  if (["json", "sql", "csv", "txt"].includes(extension)) return extension;
  return "text";
}
