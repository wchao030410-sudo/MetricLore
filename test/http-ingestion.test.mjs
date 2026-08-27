import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { MetricLoreAgent } from "../lib/agent.mjs";
import { closeDatabase, openDatabase } from "../lib/database.mjs";
import { IngestionService } from "../lib/ingest/service.mjs";
import { runMigrations } from "../lib/migrations.mjs";
import { Ontology } from "../lib/ontology.mjs";
import { SemanticLayer } from "../lib/semantic-layer.mjs";
import { SkillRegistry } from "../lib/skill-registry.mjs";
import { WikiIndex } from "../lib/wiki.mjs";
import { createAppServer } from "../server.mjs";
import { mdEntity } from "./helpers/fixtures.mjs";

function buildDeps() {
  const db = openDatabase(resolve(mkdtempSync(resolve(tmpdir(), "ml-http-")), "test.db"));
  runMigrations(db);
  const ontology = new Ontology();
  const semantic = new SemanticLayer();
  const skills = new SkillRegistry();
  const wikiDir = mkdtempSync(resolve(tmpdir(), "ml-http-wiki-"));
  const wiki = new WikiIndex(wikiDir, ontology);
  const agent = new MetricLoreAgent({ semantic, wiki, db, ontology, skills });
  const ingestion = new IngestionService({ db, ontology, wiki });
  return { db, semantic, ontology, skills, wiki, wikiDir, agent, ingestion };
}

async function listen(server) {
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen(`http://127.0.0.1:${server.address().port}`));
  });
}

async function waitForJob(base, jobId) {
  for (let i = 0; i < 50; i += 1) {
    const res = await fetch(`${base}/api/knowledge/jobs/${jobId}`);
    const body = await res.json();
    if (["awaiting_review", "failed", "cancelled"].includes(body.data.job.status)) return body.data.job;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
  throw new Error("任务未在超时内完成");
}

test("HTTP ingestion endpoints accept multipart upload and expose candidates", async () => {
  const deps = buildDeps();
  const server = createAppServer(deps);
  const base = await listen(server);
  try {
    const form = new FormData();
    form.append("name", "HTTP 导入");
    form.append("extractionMode", "rules");
    form.append("files", new Blob([mdEntity()], { type: "text/markdown" }), "dict.md");

    const created = await fetch(`${base}/api/knowledge/jobs`, { method: "POST", body: form });
    assert.equal(created.status, 202);
    const createdBody = await created.json();
    assert.equal(createdBody.schemaVersion, "0.2");
    const jobId = createdBody.data.job.id;
    assert.match(jobId, /^job_/);

    const job = await waitForJob(base, jobId);
    assert.equal(job.status, "awaiting_review");
    assert.equal(job.candidateCount, 1);

    const candidatesRes = await fetch(`${base}/api/knowledge/jobs/${jobId}/candidates`);
    const candidatesBody = await candidatesRes.json();
    assert.equal(candidatesBody.data.candidates.length, 1);
    const candidateId = candidatesBody.data.candidates[0].id;

    const detailRes = await fetch(`${base}/api/knowledge/candidates/${candidateId}`);
    const detailBody = await detailRes.json();
    assert.equal(detailBody.data.candidate.entityKey, "metric-gmv");

    const jobsRes = await fetch(`${base}/api/knowledge/jobs`);
    const jobsBody = await jobsRes.json();
    assert.equal(jobsBody.data.jobs.length, 1);
  } finally {
    server.close();
    closeDatabase();
  }
});

test("HTTP review and publish endpoints complete the closed loop", async () => {
  const deps = buildDeps();
  const server = createAppServer(deps);
  const base = await listen(server);
  try {
    const form = new FormData();
    form.append("name", "闭环");
    form.append("files", new Blob([mdEntity({ key: "metric-aov", title: "客单价", aliases: ["平均订单金额"], relations: [] })], { type: "text/markdown" }), "dict.md");
    const created = await fetch(`${base}/api/knowledge/jobs`, { method: "POST", body: form });
    const jobId = (await created.json()).data.job.id;
    await waitForJob(base, jobId);

    const candidatesRes = await fetch(`${base}/api/knowledge/jobs/${jobId}/candidates`);
    const candidate = (await candidatesRes.json()).data.candidates[0];

    // PATCH 编辑
    const patched = await fetch(`${base}/api/knowledge/candidates/${candidate.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: candidate.revision, patch: { definition: "收入除以订单量" } }) });
    assert.equal(patched.status, 200);
    const patchedCandidate = (await patched.json()).data.candidate;
    assert.equal(patchedCandidate.revision, candidate.revision + 1);

    // review approve
    const review = await fetch(`${base}/api/knowledge/candidates/${candidate.id}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: patchedCandidate.revision, decision: "approve" }) });
    assert.equal((await review.json()).data.candidate.status, "approved");

    // publish
    const publish = await fetch(`${base}/api/knowledge/jobs/${jobId}/publish`, { method: "POST" });
    const publication = (await publish.json()).data.publication;
    assert.equal(publication.summary.created, 1);
    assert.ok(existsSync(join(deps.wikiDir, "metrics", "metric-aov.md")));
    assert.ok(readFileSync(join(deps.wikiDir, "metrics", "metric-aov.md"), "utf8").includes("客单价"));

    // stale revision → 409
    const conflict = await fetch(`${base}/api/knowledge/candidates/${candidate.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 1, patch: { title: "x" } }) });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "CANDIDATE_REVISION_CONFLICT");
  } finally {
    server.close();
    closeDatabase();
  }
});

test("HTTP ingestion rejects non-multipart uploads", async () => {
  const deps = buildDeps();
  const server = createAppServer(deps);
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/api/knowledge/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 415);
    const body = await res.json();
    assert.equal(body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  } finally {
    server.close();
    closeDatabase();
  }
});
