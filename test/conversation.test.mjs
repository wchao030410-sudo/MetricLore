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

function createConversations() {
  const db = openDatabase(resolve(mkdtempSync(resolve(tmpdir(), "ml-m3-")), "test.db"));
  runMigrations(db);
  const ontology = new Ontology();
  const semantic = new SemanticLayer();
  const skills = new SkillRegistry();
  const wiki = new WikiIndex(undefined, ontology);
  const agent = new MetricLoreAgent({ db, ontology, semantic, wiki, skills });
  const conversations = new ConversationService({ db, agent, semantic });
  return { db, conversations, close: () => closeDatabase() };
}

test("multi-turn dialogue inherits metric, dimension, range and filter context", async () => {
  const { conversations, close } = createConversations();
  const conv = conversations.createConversation({ title: "收入分析" });

  const t1 = await conversations.submitMessage(conv.id, "近 14 天收入怎么样？");
  assert.equal(t1.run.capability, "data");
  assert.deepEqual(t1.run.contextAfter.metrics, ["revenue"]);
  assert.ok(t1.run.contextAfter.timeRange.startDate);

  const t2 = await conversations.submitMessage(conv.id, "那按地区拆一下。");
  assert.deepEqual(t2.run.contextAfter.metrics, ["revenue"]);
  assert.deepEqual(t2.run.contextAfter.dimensions, ["region"]);

  const t3 = await conversations.submitMessage(conv.id, "华东为什么下降？");
  assert.equal(t3.run.capability, "analysis");
  assert.deepEqual(t3.run.contextAfter.filters, { region: ["华东"] });
  assert.ok(t3.assistantMessage.content.includes("华东"));

  const t4 = await conversations.submitMessage(conv.id, "这个指标口径是什么？");
  assert.equal(t4.run.capability, "definition");
  assert.ok(t4.assistantMessage.content.includes("收入"));

  const reloaded = conversations.getConversation(conv.id);
  assert.equal(reloaded.messages.length, 8);
  assert.equal(reloaded.runs.length, 4);
  close();
});

test("run persists plan, budget, events, tool calls and evidence", async () => {
  const { conversations, close } = createConversations();
  const conv = conversations.createConversation({ title: "追踪" });
  const { run } = await conversations.submitMessage(conv.id, "近 7 天收入为什么下降？");
  assert.ok(run.plan.goal.includes("收入"));
  assert.ok(run.budget.maxSteps > 0);
  assert.ok(run.events.some((event) => event.type === "run.started"));
  assert.ok(run.events.some((event) => event.type === "run.completed"));
  assert.ok(run.toolCalls.some((call) => call.toolName === "metric_query"));
  assert.ok(run.toolCalls.some((call) => call.toolName === "compare_periods"));
  assert.ok(run.evidence.length > 0);
  close();
});

test("conversations are isolated from each other", async () => {
  const { conversations, close } = createConversations();
  const a = conversations.createConversation({ title: "订单" });
  const b = conversations.createConversation({ title: "访客" });
  await conversations.submitMessage(a.id, "近 7 天订单量是多少？");
  await conversations.submitMessage(b.id, "近 7 天访客数是多少？");

  const convA = conversations.getConversation(a.id);
  const convB = conversations.getConversation(b.id);
  assert.deepEqual(convA.context.metrics, ["orders"]);
  assert.deepEqual(convB.context.metrics, ["visitors"]);
  assert.equal(convA.messages.length, 2);
  assert.equal(convB.messages.length, 2);
  assert.ok(!convA.messages.some((message) => message.content.includes("访客数")));
  close();
});

test("ambiguous data question asks for clarification and resumes", async () => {
  const { conversations, close } = createConversations();
  const conv = conversations.createConversation({ title: "澄清" });
  const first = await conversations.submitMessage(conv.id, "最近怎么样？");
  assert.equal(first.run.status, "needs_clarification");
  assert.ok(first.assistantMessage.content.includes("请选择"));

  const resumed = await conversations.resolveClarification(first.run.id, { optionId: "revenue" });
  assert.equal(resumed.run.id, first.run.id);
  assert.equal(resumed.run.capability, "data");
  assert.deepEqual(resumed.run.contextAfter.metrics, ["revenue"]);
  assert.equal(resumed.run.events.filter((event) => event.type === "run.started").length, 1);
  assert.ok(resumed.run.events.some((event) => event.type === "clarification.resolved"));
  close();
});

test("retry and cancel work on persisted runs", async () => {
  const { conversations, close } = createConversations();
  const conv = conversations.createConversation({ title: "运维" });
  const first = await conversations.submitMessage(conv.id, "近 7 天订单量是多少？");
  const retried = await conversations.retryMessage(first.userMessage.id);
  assert.ok(retried.run.id !== first.run.id);

  // 已完成的同步运行不可取消；待澄清运行（新会话，无上下文）可取消
  assert.equal(conversations.cancelRun(retried.run.id).status, "completed");
  const conv2 = conversations.createConversation({ title: "澄清取消" });
  const ambiguous = await conversations.submitMessage(conv2.id, "最近怎么样？");
  assert.equal(ambiguous.run.status, "needs_clarification");
  assert.equal(conversations.cancelRun(ambiguous.run.id).status, "cancelled");
  close();
});

test("conversation update and delete work", async () => {
  const { conversations, close } = createConversations();
  const conv = conversations.createConversation({ title: "旧标题" });
  const updated = conversations.updateConversation(conv.id, { title: "新标题", status: "archived" });
  assert.equal(updated.title, "新标题");
  assert.equal(updated.status, "archived");

  assert.equal(conversations.deleteConversation(conv.id), true);
  assert.equal(conversations.getConversation(conv.id), null);
  close();
});
