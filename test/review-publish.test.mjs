import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { closeDatabase, openDatabase } from "../lib/database.mjs";
import { IngestionService } from "../lib/ingest/service.mjs";
import { runMigrations } from "../lib/migrations.mjs";
import { Ontology } from "../lib/ontology.mjs";
import { WikiIndex } from "../lib/wiki.mjs";
import { mdEntity } from "./helpers/fixtures.mjs";

const verifiedMetric = `---
key: metric-gmv
type: Metric
title: 成交总额
status: verified
aliases: [GMV]
sources: [dict.md]
relations: []
---

成交总额是支付成功订单的含税收入。
`;

function createServiceWithWiki(seed) {
  const db = openDatabase(resolve(mkdtempSync(resolve(tmpdir(), "ml-m2-")), "test.db"));
  runMigrations(db);
  const wikiDir = mkdtempSync(resolve(tmpdir(), "ml-wiki-"));
  if (seed) {
    mkdirSync(join(wikiDir, "metrics"), { recursive: true });
    writeFileSync(join(wikiDir, "metrics", "metric-gmv.md"), seed);
  }
  const ontology = new Ontology();
  const wiki = new WikiIndex(wikiDir, ontology);
  const service = new IngestionService({ db, ontology, wiki });
  return { db, service, wiki, wikiDir, close: () => closeDatabase() };
}

async function ingestAndApprove(service, key = "metric-aov", title = "客单价") {
  const job = service.createJob({ name: "M2", extractionMode: "rules" });
  await service.runJob(job.id, [{ relativePath: "dict.md", buffer: Buffer.from(mdEntity({ key, title, aliases: ["平均订单金额"], relations: [] })) }]);
  const candidates = service.listCandidates({ jobId: job.id });
  const candidate = service.reviewCandidate(candidates.items[0].id, { revision: candidates.items[0].revision, decision: "approve" });
  return { job, candidate };
}

test("migration 002 creates review and publication tables", () => {
  const db = openDatabase(resolve(mkdtempSync(resolve(tmpdir(), "ml-mig2-")), "test.db"));
  runMigrations(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('review_decisions','wiki_publications','wiki_versions')").all();
  assert.equal(tables.length, 3);
  runMigrations(db);
  closeDatabase();
});

test("updateCandidate applies patch, re-validates and bumps revision", async () => {
  const { service, close } = createServiceWithWiki();
  const { candidate } = await ingestAndApprove(service);
  const updated = service.updateCandidate(candidate.id, { revision: candidate.revision, patch: { title: "平均订单金额", definition: "收入除以订单量" } });
  assert.equal(updated.title, "平均订单金额");
  assert.equal(updated.revision, candidate.revision + 1);
  assert.equal(updated.validation.valid, true);
  close();
});

test("updateCandidate with stale revision throws revision conflict", async () => {
  const { service, close } = createServiceWithWiki();
  const { candidate } = await ingestAndApprove(service);
  assert.throws(() => service.updateCandidate(candidate.id, { revision: candidate.revision - 1, patch: { title: "x" } }), (error) => error.code === "CANDIDATE_REVISION_CONFLICT");
  close();
});

test("review decisions transition candidate status and are recorded", async () => {
  const { service, db, close } = createServiceWithWiki();
  const job = service.createJob({ name: "审核" });
  await service.runJob(job.id, [{ relativePath: "dict.md", buffer: Buffer.from(mdEntity({ key: "metric-aov", relations: [] })) }]);
  const candidate = service.listCandidates({ jobId: job.id }).items[0];

  service.reviewCandidate(candidate.id, { revision: candidate.revision, decision: "reject", note: "无来源" });
  let current = service.getCandidate(candidate.id);
  assert.equal(current.status, "rejected");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM review_decisions WHERE candidate_id = ?").get(candidate.id).count, 1);

  // request_changes 回到 needs_review
  service.reviewCandidate(candidate.id, { revision: current.revision, decision: "request_changes" });
  current = service.getCandidate(candidate.id);
  assert.equal(current.status, "needs_review");

  // merge 需要目标
  service.reviewCandidate(candidate.id, { revision: current.revision, decision: "merge", mergeTargetKey: "metric-gmv" });
  current = service.getCandidate(candidate.id);
  assert.equal(current.status, "merged");
  close();
});

test("batchReview processes items independently", async () => {
  const { service, close } = createServiceWithWiki();
  const job = service.createJob({ name: "批量" });
  await service.runJob(job.id, [
    { relativePath: "a.md", buffer: Buffer.from(mdEntity({ key: "metric-a", relations: [] })) },
    { relativePath: "b.md", buffer: Buffer.from(mdEntity({ key: "metric-b", relations: [] })) },
  ]);
  const candidates = service.listCandidates({ jobId: job.id }).items;
  const results = service.batchReview({ decision: "approve", items: [{ id: candidates[0].id, revision: candidates[0].revision }, { id: candidates[1].id, revision: candidates[1].revision - 1 }] });
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].code, "CANDIDATE_REVISION_CONFLICT");
  assert.equal(service.getCandidate(candidates[0].id).status, "approved");
  assert.equal(service.getCandidate(candidates[1].id).status, "extracted");
  close();
});

test("publish writes markdown, records versions and refreshes index", async () => {
  const { service, wiki, wikiDir, close } = createServiceWithWiki();
  const { job, candidate } = await ingestAndApprove(service, "metric-aov", "客单价");
  assert.equal(candidate.status, "approved");

  const publication = await service.publishJob(job.id);
  assert.equal(publication.status, "completed");
  assert.equal(publication.summary.created, 1);

  const path = join(wikiDir, "metrics", "metric-aov.md");
  assert.ok(existsSync(path));
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("key: metric-aov"));
  assert.ok(content.includes("客单价"));

  assert.ok(wiki.entities.has("metric-aov"));
  assert.equal(service.getCandidate(candidate.id).status, "published");
  assert.equal(service.listPublications(job.id).length, 1);

  const versions = service.db.prepare("SELECT * FROM wiki_versions WHERE entity_key = 'metric-aov'").all();
  assert.equal(versions.length, 1);
  assert.equal(versions[0].action, "create");
  close();
});

test("verified entities are protected from overwrite", async () => {
  const { service, wikiDir, close } = createServiceWithWiki(verifiedMetric);
  const job = service.createJob({ name: "冲突" });
  await service.runJob(job.id, [{ relativePath: "dict.md", buffer: Buffer.from(mdEntity({ key: "metric-gmv", title: "成交总额" })) }]);
  const candidate = service.listCandidates({ jobId: job.id }).items[0];
  assert.equal(candidate.conflict.type, "verified_conflict");

  service.reviewCandidate(candidate.id, { revision: candidate.revision, decision: "approve" });
  const publication = await service.publishJob(job.id);
  assert.equal(publication.summary.skipped, 1);
  assert.equal(publication.summary.created, 0);
  // 原文件未被覆盖
  assert.ok(readFileSync(join(wikiDir, "metrics", "metric-gmv.md"), "utf8").includes("成交总额是支付成功订单的含税收入。"));
  close();
});

test("duplicate title and dangling relations are detected", async () => {
  const { service, close } = createServiceWithWiki(verifiedMetric);
  const job = service.createJob({ name: "检测" });
  await service.runJob(job.id, [
    { relativePath: "a.md", buffer: Buffer.from(mdEntity({ key: "metric-x", title: "成交总额", relations: [] })) },
    { relativePath: "b.md", buffer: Buffer.from(mdEntity({ key: "metric-y", relations: ["measures:not-a-process"] })) },
  ]);
  const candidates = service.listCandidates({ jobId: job.id }).items;
  const dup = candidates.find((candidate) => candidate.entityKey === "metric-x");
  const dangling = candidates.find((candidate) => candidate.entityKey === "metric-y");
  assert.equal(dup.conflict.type, "duplicate_title");
  assert.ok(dangling.relationErrors.length > 0);
  close();
});
