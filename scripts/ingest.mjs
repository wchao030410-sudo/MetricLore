import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import { ROOT } from "../lib/config.mjs";
import { Ontology } from "../lib/ontology.mjs";

const input = process.argv[2];
if (!input) throw new Error("用法: node scripts/ingest.mjs raw/example.md");
const path = resolve(ROOT, input);
if (!path.startsWith(ROOT + "/")) throw new Error("输入文件必须位于项目目录内");
const content = readFileSync(path, "utf8");
const ontology = new Ontology();
const candidates = [];
function add(entity) { candidates.push({ entity, validation: ontology.validateEntity(entity) }); }
if (extname(path) === ".sql") {
  const table = content.match(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/i)?.[1];
  if (table) {
    const assetKey = `asset-${table.replaceAll("_", "-")}`;
    add({ key: assetKey, type: "DataAsset", title: `${table} 数据资产`, status: "candidate", aliases: [], sources: [input], definition: "从 SQL FROM 子句抽取的数据资产候选。", relations: {} });
    const select = content.match(/\bSELECT\s+([\s\S]+?)\bFROM\b/i)?.[1] || "";
    for (const item of select.split(",")) {
      const field = item.trim().match(/(?:\bAS\s+)?([A-Za-z_][A-Za-z0-9_]*)$/i)?.[1];
      if (!field || /^(sum|avg|min|max|count)$/i.test(field)) continue;
      add({ key: `field-${field.replaceAll("_", "-")}`, type: "DataField", title: `${field} 字段`, status: "candidate", aliases: [], sources: [input], definition: "从 SQL SELECT 子句抽取的字段候选。", relations: { storedIn: [assetKey] } });
    }
  }
} else {
  for (const block of content.split(/^#\s+/m).filter(Boolean)) {
    const [heading, ...rest] = block.split("\n");
    const match = heading.match(/^(Metric|Dimension|BusinessProcess|BusinessRule):\s*(.+)$/i);
    if (!match) continue;
    const [, rawType, title] = match;
    const type = rawType[0].toUpperCase() + rawType.slice(1).toLowerCase();
    const key = `${type.toLowerCase()}-${title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    const aliases = rest.join("\n").match(/^Aliases:\s*(.+)$/mi)?.[1].split(",").map((item) => item.trim()).filter(Boolean) || [];
    const definition = rest.join("\n").match(/^Definition:\s*(.+)$/mi)?.[1] || "";
    add({ key, type, title: title.trim(), status: "candidate", aliases, sources: [input], definition, relations: {} });
  }
}
const outputDir = resolve(ROOT, "outputs/candidates");
mkdirSync(outputDir, { recursive: true });
const output = resolve(outputDir, `${basename(input, ".md")}.json`);
writeFileSync(output, JSON.stringify({ input, generatedAt: new Date().toISOString(), candidates }, null, 2));
console.log(JSON.stringify({ output: output.replace(`${ROOT}/`, ""), candidateCount: candidates.length }, null, 2));
