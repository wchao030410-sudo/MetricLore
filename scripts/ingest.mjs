import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { ROOT } from "../lib/config.mjs";
import { Ontology } from "../lib/ontology.mjs";

const input = process.argv[2];
if (!input) throw new Error("用法: node scripts/ingest.mjs raw/example.md");
const path = resolve(ROOT, input);
if (!path.startsWith(ROOT + "/")) throw new Error("输入文件必须位于项目目录内");
const content = readFileSync(path, "utf8");
const ontology = new Ontology();
const candidates = [];
for (const block of content.split(/^#\s+/m).filter(Boolean)) {
  const [heading, ...rest] = block.split("\n");
  const match = heading.match(/^(Metric|Dimension|BusinessProcess|BusinessRule):\s*(.+)$/i);
  if (!match) continue;
  const [, rawType, title] = match;
  const type = rawType[0].toUpperCase() + rawType.slice(1).toLowerCase();
  const key = `${type.toLowerCase()}-${title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const aliases = rest.join("\n").match(/^Aliases:\s*(.+)$/mi)?.[1].split(",").map((item) => item.trim()).filter(Boolean) || [];
  const definition = rest.join("\n").match(/^Definition:\s*(.+)$/mi)?.[1] || "";
  const entity = { key, type, title: title.trim(), status: "candidate", aliases, sources: [input], definition, relations: {} };
  candidates.push({ entity, validation: ontology.validateEntity(entity) });
}
const outputDir = resolve(ROOT, "outputs/candidates");
mkdirSync(outputDir, { recursive: true });
const output = resolve(outputDir, `${basename(input, ".md")}.json`);
writeFileSync(output, JSON.stringify({ input, generatedAt: new Date().toISOString(), candidates }, null, 2));
console.log(JSON.stringify({ output: output.replace(`${ROOT}/`, ""), candidateCount: candidates.length }, null, 2));
