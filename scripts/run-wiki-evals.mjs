import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";

import { MetricLoreAgent } from "../lib/agent.mjs";
import { ROOT } from "../lib/config.mjs";
import { closeDatabase, openDatabase } from "../lib/database.mjs";
import { IngestionService } from "../lib/ingest/service.mjs";
import { UploadStore } from "../lib/ingest/storage.mjs";
import { runMigrations } from "../lib/migrations.mjs";
import { Ontology } from "../lib/ontology.mjs";
import { SemanticLayer } from "../lib/semantic-layer.mjs";
import { SkillRegistry } from "../lib/skill-registry.mjs";
import { WikiIndex } from "../lib/wiki.mjs";

const exampleRoot = resolve(ROOT, "examples/wiki-builder");
const runtimeDir = mkdtempSync(resolve(tmpdir(), "metriclore-wiki-eval-"));
const wikiDir = resolve(runtimeDir, "wiki");
const uploadDir = resolve(runtimeDir, "uploads");
mkdirSync(wikiDir, { recursive: true });

function filesIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? filesIn(path) : statSync(path).isFile() ? [{ relativePath: relative(ROOT, path), buffer: readFileSync(path) }] : [];
  });
}

const checks = [];
function check(id, pass, detail) {
  checks.push({ id, pass: Boolean(pass), detail });
}

const db = openDatabase(resolve(runtimeDir, "eval.db"));
runMigrations(db);
const ontology = new Ontology();
const wiki = new WikiIndex(wikiDir, ontology);
const service = new IngestionService({ db, ontology, wiki, storage: new UploadStore(uploadDir) });

async function ingestExample(name) {
  const directory = resolve(exampleRoot, name);
  const files = filesIn(directory);
  const job = service.createJob({ name: `M6 示例：${name}`, extractionMode: "rules" });
  const completed = await service.runJob(job.id, files);
  const candidates = service.listCandidates({ jobId: job.id, limit: 100 }).items;
  check(`${name}-ingestion`, completed.status === "awaiting_review" && completed.files.every((file) => file.status === "parsed"), `${completed.files.length} files, ${candidates.length} candidates`);
  check(`${name}-sources`, candidates.length > 0 && candidates.every((candidate) => candidate.sources.length && Object.keys(candidate.sources[0].locator || {}).length), `${candidates.filter((candidate) => candidate.sources.length).length}/${candidates.length} with source locators`);
  check(`${name}-validation`, candidates.every((candidate) => candidate.validation.valid && candidate.relationErrors.length === 0), `${candidates.filter((candidate) => candidate.validation.valid && candidate.relationErrors.length === 0).length}/${candidates.length} valid`);
  for (const candidate of candidates) service.reviewCandidate(candidate.id, { revision: candidate.revision, decision: "approve", note: "M6 automated example evaluation" });
  const publication = await service.publishJob(job.id);
  check(`${name}-publish`, publication.status === "completed" && publication.summary.failed === 0 && publication.summary.created === candidates.length, `${publication.summary.created} created, ${publication.summary.failed} failed`);
  return { job, candidates, publication };
}

try {
  const commerce = await ingestExample("ecommerce-growth");
  const subscription = await ingestExample("subscription-saas");
  const publishedCount = commerce.candidates.length + subscription.candidates.length;

  const refundSearch = wiki.search("退款率", 5);
  check("index-refresh", refundSearch.some((item) => item.key === "metric-refund-rate"), `${refundSearch.length} search results`);

  const graph = wiki.graph({ focusKey: "metric-mrr", depth: 1 });
  check("ontology-graph", graph.nodes.some((node) => node.key === "asset-subscription-daily") && graph.edges.some((edge) => edge.source === "metric-mrr" && edge.target === "asset-subscription-daily"), `${graph.nodes.length} nodes, ${graph.edges.length} edges`);

  const source = wiki.source("metric-refund-rate", 0);
  check("source-location", source.available && source.path === "examples/wiki-builder/ecommerce-growth/metric-refund-rate.md" && source.content.includes("退款率表示"), source.path);

  const versionCount = db.prepare("SELECT COUNT(*) AS count FROM wiki_versions").get().count;
  check("version-records", versionCount === publishedCount, `${versionCount}/${publishedCount} versions`);

  const conflictJob = service.createJob({ name: "M6 冲突保护", extractionMode: "rules" });
  const conflictPath = resolve(exampleRoot, "ecommerce-growth/metric-refund-rate.md");
  await service.runJob(conflictJob.id, [{ relativePath: relative(ROOT, conflictPath), buffer: readFileSync(conflictPath) }]);
  const conflictCandidate = service.listCandidates({ jobId: conflictJob.id, limit: 10 }).items[0];
  check("verified-conflict-detection", conflictCandidate?.conflict?.type === "verified_conflict", conflictCandidate?.conflict?.type || "no conflict");
  service.reviewCandidate(conflictCandidate.id, { revision: conflictCandidate.revision, decision: "approve", note: "verify overwrite protection" });
  const conflictPublication = await service.publishJob(conflictJob.id);
  check("verified-conflict-protection", conflictPublication.summary.skipped === 1 && conflictPublication.summary.created === 0 && conflictPublication.summary.updated === 0, JSON.stringify(conflictPublication.summary));

  const semantic = new SemanticLayer();
  const agent = new MetricLoreAgent({ semantic, wiki, db, ontology, skills: new SkillRegistry() });
  const answer = await agent.answer("退款率的定义是什么？");
  check("agent-wiki-citation", answer.status === "verified" && answer.toolCalls.some((call) => call.name === "wiki_search") && answer.sources.some((item) => item.path?.includes("metric-refund-rate.md")), `${answer.status}, ${answer.sources.length} sources`);
} catch (error) {
  check("fatal", false, error.stack || error.message);
} finally {
  closeDatabase();
  rmSync(runtimeDir, { recursive: true, force: true });
}

const passed = checks.filter((item) => item.pass).length;
const report = { generatedAt: new Date().toISOString(), checkCount: checks.length, passed, failed: checks.length - passed, sourceCoverageTarget: 1, checks };
mkdirSync(resolve(ROOT, "outputs/evals"), { recursive: true });
writeFileSync(resolve(ROOT, "outputs/evals/wiki-latest.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ checkCount: report.checkCount, passed, failed: report.failed, output: "outputs/evals/wiki-latest.json" }, null, 2));
if (report.failed) process.exitCode = 1;

