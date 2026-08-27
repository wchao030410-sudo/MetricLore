import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { MetricLoreAgent } from "../lib/agent.mjs";
import { closeDatabase, openDatabase } from "../lib/database.mjs";
import { SemanticLayer } from "../lib/semantic-layer.mjs";
import { WikiIndex } from "../lib/wiki.mjs";

test("runs metric query and derived metric", () => {
  const path = resolve(mkdtempSync(resolve(tmpdir(), "metriclore-")), "test.db");
  const db = openDatabase(path);
  const semantic = new SemanticLayer();
  const result = semantic.execute(db, { metrics: ["revenue", "aov"], dimensions: ["region"], startDate: "2026-08-01", endDate: "2026-08-26" });
  assert.equal(result.rows.length, 4);
  assert.ok(result.rows.every((row) => row.revenue > 0 && row.aov > 0));
  closeDatabase();
});

test("wiki retrieves metric definition", () => {
  const wiki = new WikiIndex();
  const results = wiki.search("客单价怎么算");
  assert.equal(results[0].title, "客单价");
  assert.match(results[0].path, /wiki\/metrics\/aov\.md/);
});

test("agent answers data and causal questions without overclaiming", async () => {
  const path = resolve(mkdtempSync(resolve(tmpdir(), "metriclore-")), "test.db");
  const db = openDatabase(path);
  const semantic = new SemanticLayer();
  const wiki = new WikiIndex();
  const agent = new MetricLoreAgent({ semantic, wiki, db });
  const result = await agent.answer("近14天收入为什么下降？");
  assert.equal(result.mode, "analysis");
  assert.ok(result.data.rows.length > 1);
  assert.match(result.answer, /不能单凭相关性判断原因/);
  closeDatabase();
});
