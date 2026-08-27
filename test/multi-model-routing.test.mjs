import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { MetricLoreAgent } from "../lib/agent.mjs";
import { ConversationService } from "../lib/conversation.mjs";
import { closeDatabase, openDatabase } from "../lib/database.mjs";
import { runMigrations } from "../lib/migrations.mjs";
import { Ontology } from "../lib/ontology.mjs";
import { SemanticLayer } from "../lib/semantic-layer.mjs";
import { SkillRegistry } from "../lib/skill-registry.mjs";
import { WikiIndex } from "../lib/wiki.mjs";

function createRouting() {
  const db = openDatabase(resolve(mkdtempSync(resolve(tmpdir(), "ml-m4-")), "test.db"));
  runMigrations(db);
  const ontology = new Ontology();
  const semantic = new SemanticLayer(undefined, db);
  const skills = new SkillRegistry();
  const wiki = new WikiIndex(undefined, ontology);
  const agent = new MetricLoreAgent({ db, ontology, semantic, wiki, skills });
  const conversations = new ConversationService({ db, agent, semantic });
  return { db, semantic, conversations, close: () => closeDatabase() };
}

function registerSalesModel(semantic, id, label, key) {
  semantic.registerModel({ id, label, table: "daily_metrics", timeColumn: "date", dimensionColumns: ["region", "channel"] });
  semantic.registerMetric({ modelId: id, key, label: "区域销售", description: `${label}的区域销售`, type: "atomic", column: "revenue", aggregation: "SUM", format: "currency" });
}

test("auto-routes to the unique semantic model owning the metric", async () => {
  const { semantic, conversations, close } = createRouting();
  registerSalesModel(semantic, "model_b", "区域模型 B", "regional_sales");
  const conv = conversations.createConversation({ title: "自动路由" });
  const { run } = await conversations.submitMessage(conv.id, "近 7 天区域销售是多少？");
  assert.equal(run.status, "completed");
  assert.equal(run.contextAfter.modelId, "model_b");
  assert.ok(run.data?.rows?.length > 0);
  close();
});

test("follow-up inherits the routed model and its dimensions", async () => {
  const { semantic, conversations, close } = createRouting();
  registerSalesModel(semantic, "model_b", "区域模型 B", "regional_sales");
  const conv = conversations.createConversation({ title: "追问继承" });
  await conversations.submitMessage(conv.id, "近 7 天区域销售是多少？");
  const follow = await conversations.submitMessage(conv.id, "那按地区拆一下。");
  assert.equal(follow.run.contextAfter.modelId, "model_b");
  assert.ok(follow.run.contextAfter.dimensions.includes("region"));
  close();
});

test("ambiguous metric across models asks for clarification and resumes with the chosen model", async () => {
  const { semantic, conversations, close } = createRouting();
  registerSalesModel(semantic, "model_b", "区域模型 B", "regional_sales");
  registerSalesModel(semantic, "model_c", "区域模型 C", "c_sales");
  const conv = conversations.createConversation({ title: "歧义澄清" });
  const first = await conversations.submitMessage(conv.id, "区域销售是多少？");
  assert.equal(first.run.status, "needs_clarification");
  assert.ok(first.assistantMessage.content.includes("请选择"));

  const resumed = await conversations.resolveClarification(first.run.id, { optionId: "model_c" });
  assert.equal(resumed.run.status, "completed");
  assert.equal(resumed.run.contextAfter.modelId, "model_c");
  close();
});

test("prefers the active model when the metric exists in multiple models", async () => {
  const { semantic, conversations, close } = createRouting();
  // 收入 exists in commerce_daily (active) and model_b
  semantic.registerModel({ id: "model_b", label: "区域模型 B", table: "daily_metrics", timeColumn: "date", dimensionColumns: ["region"] });
  semantic.registerMetric({ modelId: "model_b", key: "b_income", label: "收入", description: "B模型收入", type: "atomic", column: "revenue", aggregation: "SUM", format: "currency" });
  const conv = conversations.createConversation({ title: "当前模型优先" });
  const { run } = await conversations.submitMessage(conv.id, "近 7 天收入是多少？");
  assert.equal(run.contextAfter.modelId, "commerce_daily");
  close();
});
