import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function scalar(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value).replace(/\r?\n/g, " ");
}

function list(values) {
  const items = [...new Set((values || []).filter(Boolean).map(String))];
  return items.length ? `[${items.join(", ")}]` : "[]";
}

export function entityDirectory(entityType, ontology) {
  const directory = ontology?.schema?.entityTypes?.[entityType]?.directory;
  return directory || "assets";
}

export function candidateToMarkdown(candidate, { status = "verified" } = {}) {
  const relations = [];
  for (const [relation, targets] of Object.entries(candidate.relations || {})) {
    for (const target of Array.isArray(targets) ? targets : [targets]) {
      if (target) relations.push(`${relation}:${target}`);
    }
  }
  const sources = [...new Set((candidate.sources || []).map((source) => source?.path || source).filter(Boolean))];
  const frontmatter = [
    "---",
    `key: ${candidate.entityKey}`,
    `type: ${candidate.entityType}`,
    `title: ${scalar(candidate.title) || candidate.entityKey}`,
    `status: ${status}`,
    `aliases: ${list(candidate.aliases)}`,
    `sources: ${list(sources)}`,
    `relations: ${list(relations)}`,
    "---",
    "",
  ].join("\n");
  const definition = (candidate.definition || "").trim();
  return `${frontmatter}${definition ? `${definition}\n` : ""}`;
}

export function atomicWriteFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
  return resolve(path);
}
