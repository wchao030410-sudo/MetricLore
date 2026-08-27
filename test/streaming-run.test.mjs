import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { ConversationService } from "../lib/conversation.mjs";
import { closeDatabase, openDatabase } from "../lib/database.mjs";
import { IngestionService } from "../lib/ingest/service.mjs";
import { runMigrations } from "../lib/migrations.mjs";
import { Ontology } from "../lib/ontology.mjs";
import { SemanticLayer } from "../lib/semantic-layer.mjs";
import { SkillRegistry } from "../lib/skill-registry.mjs";
import { WikiIndex } from "../lib/wiki.mjs";
import { createAppServer } from "../server.mjs";

function pause(ms, signal) {
  return new Promise((resolvePause, reject) => {
    const timer = setTimeout(resolvePause, ms);
    const cancel = () => {
      clearTimeout(timer);
      const error = new Error("运行已取消");
      error.name = "AbortError";
      error.code = "RUN_CANCELLED";
      reject(error);
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  });
}

class SlowAgent {
  constructor() {
    this.runtime = {
      resolve: () => ({ metrics: ["revenue"], capability: "data" }),
    };
  }

  async answer(_message, _history, context, { onTrace, signal } = {}) {
    const callId = `call_${randomUUID()}`;
    const evidenceId = `evid_${randomUUID()}`;
    const plan = {
      goal: "查询收入",
      capability: "data",
      skill: "metric-query",
      steps: [{ tool: "metric_query" }],
      budget: { maxSteps: 2, timeoutMs: 1000 },
      evidenceRequirement: "回答绑定查询来源",
      completionCondition: "校验通过",
      contextUsed: { metrics: ["revenue"], dimensions: [], range: null, filters: {} },
    };
    onTrace?.({ state: "RECEIVED", at: Date.now() });
    onTrace?.({ state: "PLANNING", ...plan, at: Date.now() });
    onTrace?.({ state: "SELECTING_SKILL", stepId: "skill-1", skill: "metric-query", maxSteps: 2, at: Date.now() });
    await pause(30, signal);
    onTrace?.({ state: "RUNNING_TOOL", stepId: "skill-1", callId, tool: "metric_query", publicArgs: { metrics: ["revenue"] }, at: Date.now() });
    await pause(30, signal);
    onTrace?.({ state: "COLLECTING_EVIDENCE", stepId: "skill-1", callId, tool: "metric_query", status: "ok", elapsedMs: 30, resultSummary: { rowCount: 1 }, scope: { rowCount: 1 }, at: Date.now() });
    onTrace?.({ state: "EVIDENCE_ADDED", evidenceId, sourceType: "query", sourceKey: "query:metric_query", sourcePath: null, locator: { rowCount: 1 }, at: Date.now() });
    await pause(30, signal);
    onTrace?.({ state: "ANSWER_DELTA", delta: "收入：¥100。", offset: 0, at: Date.now() });
    onTrace?.({ state: "VALIDATING", valid: true, findings: [], evidenceCount: 1, at: Date.now() });
    onTrace?.({ state: "SKILL_COMPLETED", stepId: "skill-1", skill: "metric-query", status: "verified", outputSummary: { sourceCount: 1, toolCount: 1 }, at: Date.now() });
    onTrace?.({ state: "COMPLETED", at: Date.now() });
    return {
      answer: "收入：¥100。",
      status: "verified",
      skill: "metric-query",
      mode: "data",
      provider: "deterministic",
      sources: [{ evidenceId, key: "query:metric_query", scope: { rowCount: 1 } }],
      validation: { valid: true, findings: [] },
      evidence: { accepted: true },
      publicTrace: [],
      toolCalls: [{ id: callId, name: "metric_query", args: { metrics: ["revenue"] }, scope: { rowCount: 1 }, status: "ok" }],
      plan,
      context: { metrics: ["revenue"], dimensions: context.dimensions || [], range: context.timeRange || null, filters: context.filters || {} },
    };
  }
}

function buildDeps() {
  const db = openDatabase(resolve(mkdtempSync(resolve(tmpdir(), "ml-m4-")), "test.db"));
  runMigrations(db);
  const ontology = new Ontology();
  const semantic = new SemanticLayer();
  const skills = new SkillRegistry();
  const wiki = new WikiIndex(undefined, ontology);
  const agent = new SlowAgent();
  const ingestion = new IngestionService({ db, ontology, wiki });
  const conversations = new ConversationService({ db, agent, semantic });
  return { db, semantic, ontology, skills, wiki, agent, ingestion, conversations };
}

async function listen(server) {
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen(`http://127.0.0.1:${server.address().port}`));
  });
}

function parseSse(text) {
  return text.trim().split(/\n\n+/).filter(Boolean).map((block) => {
    const lines = block.split("\n");
    const value = (prefix) => lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
    return { id: value("id: "), type: value("event: "), data: JSON.parse(value("data: ") || "{}") };
  });
}

test("deferred run publishes and persists live events", async () => {
  const deps = buildDeps();
  const conversation = deps.conversations.createConversation({ title: "流式" });
  let resolveToolStarted;
  const toolStarted = new Promise((resolveStarted) => { resolveToolStarted = resolveStarted; });
  deps.conversations.events.on("event", (event) => {
    if (event.type === "tool.started") resolveToolStarted(event);
  });

  const submitted = await deps.conversations.submitMessage(conversation.id, "近 7 天收入是多少？", { defer: true, idempotencyKey: "stream-1" });
  assert.equal(submitted.run.status, "queued");
  assert.equal(submitted.assistantMessage.status, "pending");
  const duplicate = await deps.conversations.submitMessage(conversation.id, "近 7 天收入是多少？", { defer: true, idempotencyKey: "stream-1" });
  assert.equal(duplicate.run.id, submitted.run.id);

  await toolStarted;
  assert.equal(deps.conversations.getRun(submitted.run.id).status, "running");
  const run = await deps.conversations.waitForRun(submitted.run.id);
  assert.equal(run.status, "completed");
  assert.deepEqual(run.events.map((event) => event.sequence), run.events.map((_, index) => index + 1));
  assert.ok(run.events.some((event) => event.type === "answer.delta"));
  assert.equal(run.events.at(-1).type, "run.completed");
  assert.equal(deps.conversations.getMessage(run.assistantMessageId).content, "收入：¥100。");
  assert.equal(deps.conversations.getConversation(conversation.id).messages.length, 2);
  closeDatabase();
});

test("cancel aborts an active run and emits one terminal event", async () => {
  const deps = buildDeps();
  const conversation = deps.conversations.createConversation({ title: "取消" });
  let resolveTool;
  const toolCompleted = new Promise((resolveCompleted) => { resolveTool = resolveCompleted; });
  deps.conversations.events.on("event", (event) => {
    if (event.type === "tool.completed") resolveTool(event);
  });
  const submitted = await deps.conversations.submitMessage(conversation.id, "近 7 天收入是多少？", { defer: true });
  await toolCompleted;
  const cancelled = deps.conversations.cancelRun(submitted.run.id);
  assert.equal(cancelled.status, "cancelled");
  const run = await deps.conversations.waitForRun(submitted.run.id);
  assert.equal(run.status, "cancelled");
  assert.equal(run.events.filter((event) => event.type === "run.cancelled").length, 1);
  assert.equal(run.events.at(-1).type, "run.cancelled");
  assert.equal(run.toolCalls.length, 1);
  assert.equal(run.toolCalls[0].status, "ok");
  assert.equal(run.evidence.length, 1);
  closeDatabase();
});

test("HTTP SSE replays persisted events and resumes after Last-Event-ID", async () => {
  const deps = buildDeps();
  const server = createAppServer(deps);
  const base = await listen(server);
  try {
    const created = await fetch(`${base}/api/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "SSE" }) });
    const conversationId = (await created.json()).data.conversation.id;
    const request = { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "http-stream-1" }, body: JSON.stringify({ content: "近 7 天收入是多少？" }) };
    const submittedResponse = await fetch(`${base}/api/conversations/${conversationId}/messages`, request);
    assert.equal(submittedResponse.status, 202);
    const submitted = (await submittedResponse.json()).data;

    const duplicateResponse = await fetch(`${base}/api/conversations/${conversationId}/messages`, request);
    assert.equal((await duplicateResponse.json()).data.run.id, submitted.run.id);

    const stream = await fetch(`${base}${submitted.run.eventsUrl}`);
    assert.equal(stream.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const events = parseSse(await stream.text());
    assert.equal(events[0].type, "run.started");
    assert.equal(events.at(-1).type, "run.completed");
    assert.ok(events.some((event) => event.type === "tool.started"));
    assert.ok(events.every((event) => event.data.schemaVersion === "0.2" && event.data.runId === submitted.run.id));

    const checkpoint = events.find((event) => event.type === "skill.started");
    const replay = await fetch(`${base}${submitted.run.eventsUrl}`, { headers: { "last-event-id": checkpoint.id } });
    const resumed = parseSse(await replay.text());
    assert.ok(resumed.length > 0);
    assert.ok(resumed.every((event) => event.data.sequence > checkpoint.data.sequence));
    assert.equal(resumed.at(-1).type, "run.completed");

    const detail = await (await fetch(`${base}/api/conversations/${conversationId}`)).json();
    assert.equal(detail.data.conversation.messages.length, 2);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    closeDatabase();
  }
});
