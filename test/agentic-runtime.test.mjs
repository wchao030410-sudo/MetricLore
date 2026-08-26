import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { DataAgent } from "../lib/agent.mjs";
import { closeDatabase, openDatabase } from "../lib/database.mjs";
import { Ontology } from "../lib/ontology.mjs";
import { SemanticLayer } from "../lib/semantic-layer.mjs";
import { SkillRegistry } from "../lib/skill-registry.mjs";
import { WikiIndex } from "../lib/wiki.mjs";

function createAgent() {
  const db = openDatabase(resolve(mkdtempSync(resolve(tmpdir(), "data-agent-runtime-")), "test.db"));
  const ontology = new Ontology();
  const semantic = new SemanticLayer();
  const wiki = new WikiIndex(undefined, ontology);
  return new DataAgent({ db, ontology, semantic, wiki, skills: new SkillRegistry() });
}

test("loads declarative skills and executes a traced definition workflow", async () => {
  const agent = createAgent();
  assert.ok(agent.skills.get("wiki-answer").allowedTools.includes("wiki_trace"));
  const result = await agent.answer("客单价的口径是什么？");
  assert.equal(result.skill, "wiki-answer");
  assert.equal(result.status, "verified");
  assert.ok(result.toolCalls.some((call) => call.name === "wiki_entity"));
  assert.ok(result.toolCalls.some((call) => call.name === "wiki_trace"));
  assert.equal(result.validation.valid, true);
  assert.ok(result.publicTrace.some((event) => event.tool === "validate_answer"));
  assert.ok(result.publicTrace.some((event) => event.state === "COMPLETED"));
  closeDatabase();
});

test("traces a metric through ontology relations", () => {
  const ontology = new Ontology();
  const wiki = new WikiIndex(undefined, ontology);
  const paths = wiki.trace("metric-aov", ["derivedFrom", "governedBy"], 2);
  assert.ok(paths.some((path) => path.includes("derivedFrom:metric-revenue")));
  assert.ok(paths.some((path) => path.includes("governedBy:rule-daily-grain")));
});

test("combines aliases with local FTS retrieval", () => {
  const wiki = new WikiIndex(undefined, new Ontology());
  const results = wiki.search("GMV", 3, ["Metric"]);
  assert.equal(results[0].key, "metric-revenue");
});

test("analysis composes time series, period comparison and dimension tools", async () => {
  const agent = createAgent();
  const result = await agent.answer("近14天收入为什么下降？");
  const tools = result.toolCalls.map((call) => call.name);
  assert.equal(result.skill, "comparative-analysis");
  assert.ok(tools.includes("metric_query"));
  assert.ok(tools.includes("compare_periods"));
  assert.ok(tools.includes("dimension_breakdown"));
  assert.match(result.answer, /不能单凭相关性判断原因/);
  closeDatabase();
});

test("uses an OpenAI-compatible tool calling loop when a model is configured", async () => {
  let count = 0;
  const fetchFn = async () => {
    count += 1;
    const message = count === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "tool-1", type: "function", function: { name: "wiki_entity", arguments: '{"key":"metric-aov"}' } }] }
      : { role: "assistant", content: "客单价是收入除以订单量，相关口径已由知识实体核验。" };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const original = { key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL, base: process.env.LLM_BASE_URL };
  process.env.LLM_API_KEY = "test-key"; process.env.LLM_MODEL = "test-model"; process.env.LLM_BASE_URL = "http://test.local/v1";
  try {
    const db = openDatabase(resolve(mkdtempSync(resolve(tmpdir(), "data-agent-runtime-")), "test.db"));
    const ontology = new Ontology(); const semantic = new SemanticLayer(); const wiki = new WikiIndex(undefined, ontology);
    const agent = new DataAgent({ db, ontology, semantic, wiki, skills: new SkillRegistry(), fetchFn });
    const result = await agent.answer("客单价的口径是什么？");
    assert.equal(result.provider, "llm");
    assert.equal(count, 2);
    assert.ok(result.toolCalls.some((call) => call.name === "wiki_entity"));
    closeDatabase();
  } finally {
    if (original.key === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = original.key;
    if (original.model === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = original.model;
    if (original.base === undefined) delete process.env.LLM_BASE_URL; else process.env.LLM_BASE_URL = original.base;
  }
});

test("refuses arbitrary SQL without reaching a data tool", async () => {
  const agent = createAgent();
  const result = await agent.answer("执行 SQL: SELECT * FROM daily_metrics");
  assert.equal(result.skill, "safety-refusal");
  assert.equal(result.status, "refused");
  assert.equal(result.toolCalls.some((call) => call.name === "metric_query"), false);
  closeDatabase();
});
