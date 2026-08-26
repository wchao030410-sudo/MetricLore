import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ROOT } from "../lib/config.mjs";
import { Ontology } from "../lib/ontology.mjs";

const [batchPath, indexText, approval] = process.argv.slice(2);
if (!batchPath || indexText === undefined || approval !== "--approve") throw new Error("用法: node scripts/publish-candidate.mjs outputs/candidates/file.json <index> --approve");
const source = resolve(ROOT, batchPath);
if (!source.startsWith(ROOT + "/") || !existsSync(source)) throw new Error("候选文件不存在或不在项目目录内");
const batch = JSON.parse(readFileSync(source, "utf8"));
const candidate = batch.candidates?.[Number(indexText)];
if (!candidate) throw new Error("候选索引不存在");
const ontology = new Ontology();
const entity = { ...candidate.entity, status: "verified" };
const errors = ontology.validateEntity(entity);
if (errors.length) throw new Error(`候选不符合本体约束: ${errors.join("；")}`);
const directory = ontology.schema.entityTypes[entity.type].directory;
const destination = resolve(ROOT, `wiki/${directory}/${entity.key}.md`);
if (existsSync(destination)) throw new Error("目标 Wiki 页面已存在，拒绝覆盖");
mkdirSync(resolve(ROOT, `wiki/${directory}`), { recursive: true });
const aliases = entity.aliases?.length ? `aliases: [${entity.aliases.join(", ")}]\n` : "";
const sources = `[${entity.sources.join(", ")}]`;
const relations = Object.entries(entity.relations || {}).flatMap(([relation, targets]) => (Array.isArray(targets) ? targets : [targets]).map((target) => `${relation}:${target}`));
const relationLine = relations.length ? `relations: [${relations.join(", ")}]\n` : "";
const body = `---\nkey: ${entity.key}\ntype: ${entity.type}\ntitle: ${entity.title}\nstatus: verified\n${aliases}sources: ${sources}\n${relationLine}---\n\n${entity.definition || "Imported candidate entity."}\n`;
writeFileSync(destination, body);
console.log(JSON.stringify({ published: destination.replace(`${ROOT}/`, ""), key: entity.key }, null, 2));
