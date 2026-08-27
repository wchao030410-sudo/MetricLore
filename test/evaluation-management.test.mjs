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

test("creates a new Judge dataset without a key and versions an existing one with a key", () => {
  const { service } = setup();
  try {
    const fresh = service.createJudgeDatasetVersion({
      name: "业务知识问答集",
      description: "团队维护的金标问答",
      cases: [{ id: "biz-001", question: "收入如何定义？", referenceAnswer: "支付成功订单的含税收入", requiredSources: ["wiki/metrics/revenue.md"] }],
    });
    assert.match(fresh.key, /^judge_/);
    assert.equal(fresh.version, 1);
    assert.equal(fresh.origin, "user");

    // 新建评测集不影响内置 knowledge-judge 的当前版本
    const builtin = service.listDatasets().filter((item) => item.key === "knowledge-judge");
    assert.equal(builtin.length, 1);
    assert.equal(builtin[0].version, 1);

    const versioned = service.createJudgeDatasetVersion({
      key: "knowledge-judge",
      name: "知识问答质量集",
      description: "用户维护版本",
      cases: [{ id: "biz-001", question: "收入如何定义？", referenceAnswer: "支付成功订单的含税收入", requiredSources: ["wiki/metrics/revenue.md"] }],
    });
    assert.equal(versioned.version, 2);
    service.refreshDatasets();
    const current = service.listDatasets().find((item) => item.key === "knowledge-judge" && item.current);
    assert.equal(current.version, 2);
    assert.equal(service.currentJudgeDatasetContent("knowledge-judge").content.cases[0].id, "biz-001");
  } finally {
    closeDatabase();
  }
});

test("manages multiple independent Judge datasets with per-key current versions", () => {
  const { service } = setup();
  try {
    const first = service.createJudgeDatasetVersion({
      name: "客服领域集",
      description: "客服场景金标",
      cases: [{ id: "cs-001", question: "退款时效？", referenceAnswer: "48 小时内原路退回", requiredSources: [] }],
    });
    assert.match(first.key, /^judge_/);
    assert.equal(first.version, 1);

    const second = service.createJudgeDatasetVersion({
      key: first.key,
      name: "客服领域集",
      description: "补充新场景",
      cases: [
        { id: "cs-001", question: "退款时效？", referenceAnswer: "48 小时内原路退回", requiredSources: [] },
        { id: "cs-002", question: "发票开具？", referenceAnswer: "订单完成后自动开具电子发票", requiredSources: ["wiki/ops/invoice.md"] },
      ],
    });
    assert.equal(second.key, first.key);
    assert.equal(second.version, 2);
    assert.equal(second.origin, "user");

    const other = service.createJudgeDatasetVersion({
      name: "风控领域集",
      cases: [{ id: "rc-001", question: "风控拦截阈值？", referenceAnswer: "单笔金额超过 5 万元需二次校验", requiredSources: [] }],
    });
    assert.notEqual(other.key, first.key);

    const keys = new Set(service.listJudgeDatasets().map((item) => item.key));
    assert.ok(keys.has(first.key));
    assert.ok(keys.has(other.key));

    const currentA = service.currentJudgeDatasetContent(first.key);
    assert.equal(currentA.version, 2);
    assert.equal(currentA.content.cases.length, 2);
    const currentB = service.currentJudgeDatasetContent(other.key);
    assert.equal(currentB.version, 1);
    assert.equal(currentB.content.cases[0].id, "rc-001");

    // 新增评测集不影响内置 knowledge-judge 的当前版本
    assert.equal(service.currentJudgeDatasetContent("knowledge-judge").version, 1);
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

