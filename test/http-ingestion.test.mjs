import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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
  const wiki = new WikiIndex(undefined, ontology);
  const agent = new MetricLoreAgent({ semantic, wiki, db, ontology, skills });
  const ingestion = new IngestionService({ db, ontology });
  return { db, semantic, ontology, skills, wiki, agent, ingestion };
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
