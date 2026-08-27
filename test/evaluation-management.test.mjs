import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { closeDatabase, openDatabase } from "../lib/database.mjs";
import { EvaluationService } from "../lib/evaluation-service.mjs";
import { runMigrations } from "../lib/migrations.mjs";
import { Ontology } from "../lib/ontology.mjs";
import { SemanticLayer } from "../lib/semantic-layer.mjs";
import { WikiIndex } from "../lib/wiki.mjs";

function setup(runScript = async () => "ok") {
  const db = openDatabase(resolve(mkdtempSync(resolve(tmpdir(), "ml-eval-management-")), "test.db"));
  runMigrations(db);
  const semantic = new SemanticLayer(undefined, db);
  const wiki = new WikiIndex(undefined, new Ontology());
  return { db, semantic, wiki, service: new EvaluationService({ db, semantic, wiki, runScript }) };
}

test("versions the Judge dataset and preserves a user-managed current version", () => {
  const { service } = setup();
  try {
    const initial = service.listDatasets().filter((item) => item.key === "knowledge-judge");
    assert.equal(initial.length, 1);
    const created = service.createJudgeDatasetVersion({
      name: "业务知识问答集",
      description: "团队维护的金标问答",
      cases: [{ id: "biz-001", question: "收入如何定义？", referenceAnswer: "支付成功订单的含税收入", requiredSources: ["wiki/metrics/revenue.md"] }],
    });
    assert.equal(created.version, 2);
    assert.equal(created.origin, "user");
    service.refreshDatasets();
    const current = service.listDatasets().find((item) => item.key === "knowledge-judge" && item.current);
    assert.equal(current.version, 2);
    assert.equal(service.currentDatasetContent("knowledge-judge").cases[0].id, "biz-001");
  } finally {
    closeDatabase();
  }
});

test("captures dataset, knowledge and semantic model versions for an evaluation run", async () => {
  const called = [];
  const { service } = setup(async (script, options) => { called.push({ script, options }); return "ok"; });
  try {
    const run = service.createRun();
    let current = run;
    for (let attempt = 0; attempt < 50 && !["completed", "failed"].includes(current.status); attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      current = service.getRun(run.id);
    }
    assert.equal(current.status, "completed");
    assert.equal(called.length, 5);
    assert.equal(current.datasets.length, 5);
    assert.equal(current.knowledge.documentCount, 28);
    assert.equal(current.model.id, "commerce_daily");
    assert.equal(current.progress.completed, 5);
  } finally {
    closeDatabase();
  }
});

