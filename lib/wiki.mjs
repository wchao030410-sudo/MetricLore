import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

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

  search(query, limit = 5, entityTypes = []) {
    const wanted = tokens(query);
    if (!wanted.length) return [];
    const typeSet = new Set(entityTypes || []);
    return this.documents.map((doc) => {
      if (typeSet.size && (!doc.type || !typeSet.has(doc.type))) return null;
      const title = doc.title.toLowerCase();
      const aliases = (doc.aliases || []).join(" ").toLowerCase();
      const body = doc.content.toLowerCase();
      let score = doc.status === "verified" ? 2 : 0;
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
