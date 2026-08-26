import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ROOT } from "../lib/config.mjs";

const candidateDir = resolve(ROOT, "outputs/candidates");
const queue = [];
if (existsSync(candidateDir)) {
  for (const name of readdirSync(candidateDir).filter((item) => item.endsWith(".json"))) {
    const batch = JSON.parse(readFileSync(resolve(candidateDir, name), "utf8"));
    for (const item of batch.candidates || []) queue.push({ batch: name, entity: item.entity, validation: item.validation, decision: item.validation.length ? "reject" : "needs_review" });
  }
}
mkdirSync(resolve(ROOT, "outputs"), { recursive: true });
writeFileSync(resolve(ROOT, "outputs/review-queue.json"), JSON.stringify({ generatedAt: new Date().toISOString(), count: queue.length, items: queue }, null, 2));
console.log(JSON.stringify({ count: queue.length, output: "outputs/review-queue.json" }, null, 2));
