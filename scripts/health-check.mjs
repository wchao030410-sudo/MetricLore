import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ROOT } from "../lib/config.mjs";
import { Ontology } from "../lib/ontology.mjs";
import { WikiIndex } from "../lib/wiki.mjs";

const ontology = new Ontology();
const wiki = new WikiIndex(undefined, ontology);
const errors = [];
const warnings = [];

for (const entity of wiki.entities.values()) {
  for (const error of ontology.validateEntity(entity)) errors.push(`${entity.key}: ${error}`);
}
for (const entity of wiki.entities.values()) {
  for (const error of ontology.validateRelations(entity, wiki.entities)) errors.push(`${entity.key}: ${error}`);
  for (const source of entity.sources || []) {
    const local = resolve(ROOT, source);
    if (!existsSync(local)) warnings.push(`${entity.key}: source path not found: ${source}`);
  }
  if (entity.status === "verified" && !(entity.sources || []).length) errors.push(`${entity.key}: verified entity must have a source`);
}

const report = { generatedAt: new Date().toISOString(), entityCount: wiki.entities.size, documentCount: wiki.documents.length, errors, warnings };
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
