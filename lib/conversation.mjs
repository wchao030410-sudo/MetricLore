import { EventEmitter } from "node:events";

import { json, newId, nowIso } from "./ingest/util.mjs";

const EVENT_MAP = {
  RECEIVED: "run.started",
  PLANNING: "plan.created",
  SELECTING_SKILL: "skill.started",
  RUNNING_TOOL: "tool.started",
  COLLECTING_EVIDENCE: "tool.completed",
  EVIDENCE_ADDED: "evidence.added",
  ANSWER_DELTA: "answer.delta",
  VALIDATING: "validation.completed",
  SKILL_COMPLETED: "skill.completed",
  LLM_FALLBACK: "run.fallback",
};

const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const CANCELLABLE_STATUSES = new Set(["queued", "planning", "running", "validating", "needs_clarification"]);
const ASKS_DATA = /多少|怎么样|趋势|下降|增长|波动|变化|对比|分析|拆|看/;

function abortError() {
  const error = new Error("运行已取消");
  error.name = "AbortError";
  error.code = "RUN_CANCELLED";
  return error;
}

function isAbort(error) {
  return error?.name === "AbortError" || error?.code === "RUN_CANCELLED";
}

export class ConversationService {
  constructor({ db, agent, semantic }) {
    this.db = db;
    this.agent = agent;
    this.semantic = semantic;
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.controllers = new Map();
    this.runPromises = new Map();
  }

  // ---------- 会话 CRUD ----------

  createConversation({ title } = {}) {
    const id = newId("conv_");
    const now = nowIso();
    this.db.prepare("INSERT INTO conversations (id, workspace_id, title, status, created_at, updated_at) VALUES (?, 'ws_local', ?, 'active', ?, ?)").run(id, String(title || "新对话").slice(0, 200), now, now);
    this.db.prepare("INSERT INTO conversation_context (conversation_id, version, updated_at) VALUES (?, 1, ?)").run(id, now);
    return this.getConversation(id);
  }

  getConversation(id) {
    const conv = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
    if (!conv) return null;
    return {
      id: conv.id,
      workspaceId: conv.workspace_id,
      title: conv.title,
      status: conv.status,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      lastMessageAt: conv.last_message_at,
      context: this.loadContext(id),
      messages: this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid ASC").all(id).map((row) => this.decorateMessage(row)),
      runs: this.db.prepare("SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 20").all(id).map((row) => this.decorateRun(row)),
    };
  }

  listConversations({ status, limit = 20, cursor } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push("status = ?"); params.push(status); }
    if (cursor) { where.push("last_message_at < ? OR (last_message_at IS NULL AND created_at < ?)"); params.push(cursor, cursor); }
    const limitN = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM conversations ${clause} ORDER BY last_message_at DESC, created_at DESC LIMIT ?`).all(...params, limitN + 1);
    const hasMore = rows.length > limitN;
    const items = rows.slice(0, limitN).map((row) => ({
      id: row.id, workspaceId: row.workspace_id, title: row.title, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at, lastMessageAt: row.last_message_at,
    }));
    return { items, nextCursor: hasMore ? items.at(-1).lastMessageAt || items.at(-1).createdAt : null };
  }

  updateConversation(id, { title, status } = {}) {
    const conv = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
    if (!conv) return null;
    const next = { title: title ?? conv.title, status: status ?? conv.status };
    if (!["active", "archived"].includes(next.status)) throw new Error(`未知会话状态: ${next.status}`);
    this.db.prepare("UPDATE conversations SET title = ?, status = ?, updated_at = ? WHERE id = ?").run(next.title, next.status, nowIso(), id);
    return this.getConversation(id);
  }

  deleteConversation(id) {
    const conv = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
    if (!conv) return false;
    for (const row of this.db.prepare("SELECT id FROM agent_runs WHERE conversation_id = ?").all(id)) {
      this.controllers.get(row.id)?.abort(abortError());
      this.controllers.delete(row.id);
    }
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    return true;
  }

  // ---------- 上下文 ----------

  loadContext(conversationId) {
    const row = this.db.prepare("SELECT * FROM conversation_context WHERE conversation_id = ?").get(conversationId);
    if (!row) return { modelId: null, metrics: [], dimensions: [], timeRange: null, filters: {}, entities: [], pendingClarification: null };
    return {
      modelId: row.model_id || null,
      metrics: JSON.parse(row.metrics_json || "[]"),
      dimensions: JSON.parse(row.dimensions_json || "[]"),
      timeRange: row.time_range_json ? JSON.parse(row.time_range_json) : null,
      filters: JSON.parse(row.filters_json || "{}"),
      entities: JSON.parse(row.entities_json || "[]"),
      pendingClarification: row.pending_clarification_json ? JSON.parse(row.pending_clarification_json) : null,
      version: row.version,
    };
  }

  saveContext(conversationId, context) {
    const row = this.db.prepare("SELECT version FROM conversation_context WHERE conversation_id = ?").get(conversationId);
    const version = (row?.version || 0) + 1;
    this.db.prepare("UPDATE conversation_context SET version = ?, model_id = ?, metrics_json = ?, dimensions_json = ?, time_range_json = ?, filters_json = ?, entities_json = ?, pending_clarification_json = ?, updated_at = ? WHERE conversation_id = ?")
      .run(version, context.modelId || null, json(context.metrics || []), json(context.dimensions || []), context.timeRange ? json(context.timeRange) : null, json(context.filters || {}), json(context.entities || []), context.pendingClarification ? json(context.pendingClarification) : null, nowIso(), conversationId);
  }

  mergeContext(base, patch = {}) {
    return {
      modelId: patch.modelId || base.modelId || null,
      metrics: patch.metrics || base.metrics || [],
      dimensions: patch.dimensions || base.dimensions || [],
      timeRange: patch.timeRange || base.timeRange || null,
      filters: { ...(base.filters || {}), ...(patch.filters || {}) },
      entities: patch.entities || base.entities || [],
      pendingClarification: patch.pendingClarification ?? base.pendingClarification ?? null,
    };
  }

  history(conversationId) {
    return this.db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY rowid ASC").all(conversationId).map((row) => ({ role: row.role, content: row.content }));
  }

  historyBeforeMessage(messageId) {
    const message = this.db.prepare("SELECT conversation_id, rowid FROM messages WHERE id = ?").get(messageId);
    if (!message) return [];
    return this.db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? AND rowid < ? ORDER BY rowid ASC").all(message.conversation_id, message.rowid)
      .map((row) => ({ role: row.role, content: row.content }));
  }

  // ---------- 消息与运行 ----------

  clarificationFor(content, context) {
    if (!ASKS_DATA.test(content)) return null;
    const resolution = this.agent.runtime.resolve(content, context);
    if (resolution.ambiguity?.modelOptions?.length) {
      return {
        prompt: "这个指标在多个语义模型中存在，请选择要查询的模型：",
        options: resolution.ambiguity.modelOptions.map((option) => ({ id: option.id, label: `${option.label} · ${option.metricLabel}`, kind: "model" })),
      };
    }
    if (resolution.metrics.length === 0 && resolution.capability !== "safety") {
      return { prompt: "请选择要查询的指标：", options: Object.entries(this.semantic.model.metrics).map(([id, metric]) => ({ id, label: metric.label, kind: "metric" })) };
    }
    return null;
  }

  idempotentResult(scope, key) {
    if (!key) return null;
    if (String(key).length > 200) throw new Error("Idempotency-Key 不能超过 200 个字符");
    const row = this.db.prepare("SELECT response_json FROM idempotency_keys WHERE scope = ? AND key = ?").get(scope, String(key));
    return row ? JSON.parse(row.response_json) : null;
  }

  rememberIdempotent(scope, key, response) {
    if (!key) return;
    this.db.prepare("INSERT OR IGNORE INTO idempotency_keys (scope, key, response_json, created_at) VALUES (?, ?, ?, ?)").run(scope, String(key), json(response), nowIso());
  }

  createRun(conversationId, userMessageId, context, { status = "queued", capability = null, plan = null, assistantContent = "", assistantStatus = "pending" } = {}) {
    const runId = newId("run_");
    const assistantMessageId = newId("msg_");
    const now = nowIso();
    this.db.prepare("INSERT INTO agent_runs (id, conversation_id, user_message_id, assistant_message_id, status, capability, context_before_json, plan_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(runId, conversationId, userMessageId, assistantMessageId, status, capability, json(context), plan ? json(plan) : null, now);
    this.db.prepare("INSERT INTO messages (id, conversation_id, run_id, role, content, status, created_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?)")
      .run(assistantMessageId, conversationId, runId, assistantContent, assistantStatus, now);
    return { runId, assistantMessageId };
  }

  responseFor(userMessageId, assistantMessageId, runId) {
    return { userMessage: this.getMessage(userMessageId), assistantMessage: this.getMessage(assistantMessageId), run: this.getRun(runId) };
  }

  async submitMessage(conversationId, content, { contextPatch = {}, defer = false, idempotencyKey } = {}) {
    const conv = this.getConversation(conversationId);
    if (!conv) throw new Error(`会话不存在: ${conversationId}`);
    if (typeof content !== "string" || !content.trim()) throw new Error("message 不能为空");

    const scope = `conversation:${conversationId}:messages`;
    const previous = this.idempotentResult(scope, idempotencyKey);
    if (previous) return previous;

    const history = this.history(conversationId);
    const before = this.mergeContext(conv.context, contextPatch);
    const clarification = this.clarificationFor(content, before);
    const userMessageId = newId("msg_");
    const now = nowIso();
    this.db.prepare("INSERT INTO messages (id, conversation_id, role, content, status, created_at) VALUES (?, ?, 'user', ?, 'completed', ?)").run(userMessageId, conversationId, content, now);
    this.db.prepare("UPDATE conversations SET updated_at = ?, last_message_at = ? WHERE id = ?").run(now, now, conversationId);

    if (clarification) {
      const prompt = `${clarification.prompt}\n${clarification.options.map((option) => `- ${option.label}（${option.id}）`).join("\n")}`;
      const created = this.createRun(conversationId, userMessageId, before, {
        status: "needs_clarification", capability: "data", plan: { clarification }, assistantContent: prompt, assistantStatus: "completed",
      });
      this.saveContext(conversationId, { ...before, pendingClarification: clarification });
      this.appendEvent(created.runId, "run.started", { conversationId, messageId: userMessageId, provider: null });
      this.appendEvent(created.runId, "clarification.required", { ...clarification, context: before });
      const response = this.responseFor(userMessageId, created.assistantMessageId, created.runId);
      this.rememberIdempotent(scope, idempotencyKey, response);
      return response;
    }

    const created = this.createRun(conversationId, userMessageId, before);
    const response = this.responseFor(userMessageId, created.assistantMessageId, created.runId);
    this.rememberIdempotent(scope, idempotencyKey, response);
    const task = this.startRun({ runId: created.runId, assistantMessageId: created.assistantMessageId, conversationId, userMessageId, content, context: before, history });
    if (defer) return response;
    await task;
    return this.responseFor(userMessageId, created.assistantMessageId, created.runId);
  }

  startRun(input) {
    const task = this.executeRun(input);
    this.runPromises.set(input.runId, task);
    task.finally(() => {
      if (this.runPromises.get(input.runId) === task) this.runPromises.delete(input.runId);
    }).catch(() => {});
    return task;
  }

  async executeRun({ runId, assistantMessageId, conversationId, userMessageId, content, context, history }) {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const startedAt = nowIso();
    this.db.prepare("UPDATE agent_runs SET status = 'planning', started_at = COALESCE(started_at, ?), completed_at = NULL, error_json = NULL WHERE id = ?").run(startedAt, runId);
    this.db.prepare("UPDATE messages SET status = 'streaming' WHERE id = ?").run(assistantMessageId);
    const alreadyStarted = this.db.prepare("SELECT 1 FROM agent_run_events WHERE run_id = ? AND event_type = 'run.started'").get(runId);

    try {
      const result = await this.agent.answer(content, history, context, {
        signal: controller.signal,
        onTrace: (entry) => this.persistTrace(runId, assistantMessageId, entry, { skipRunStarted: Boolean(alreadyStarted) }),
      });
      if (controller.signal.aborted) throw abortError();
      this.completeRun(runId, assistantMessageId, conversationId, context, result);
      return this.getRun(runId);
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) this.finishCancelled(runId, assistantMessageId);
      else this.finishFailed(runId, assistantMessageId, error);
      throw error;
    } finally {
      if (this.controllers.get(runId) === controller) this.controllers.delete(runId);
    }
  }

  persistTrace(runId, assistantMessageId, entry, { skipRunStarted = false } = {}) {
    const eventType = EVENT_MAP[entry.state];
    if (!eventType || (eventType === "run.started" && skipRunStarted)) return null;
    const current = this.db.prepare("SELECT status FROM agent_runs WHERE id = ?").get(runId);
    if (!current || TERMINAL_STATUSES.has(current.status)) return null;
    const { state, at, ...payload } = entry;
    const eventAt = at ? new Date(at).toISOString() : nowIso();

    if (eventType === "plan.created") {
      this.db.prepare("UPDATE agent_runs SET status = 'planning', capability = ?, plan_json = ?, budget_json = ? WHERE id = ?")
        .run(payload.capability || null, json(payload), json(payload.budget || {}), runId);
    } else if (eventType === "skill.started") {
      this.db.prepare("UPDATE agent_runs SET status = 'running' WHERE id = ?").run(runId);
    } else if (eventType === "tool.started") {
      this.db.prepare("UPDATE agent_runs SET status = 'running' WHERE id = ?").run(runId);
      const sequence = this.db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE run_id = ?").get(runId).count + 1;
      const skillName = this.db.prepare("SELECT plan_json FROM agent_runs WHERE id = ?").get(runId)?.plan_json;
      const skill = skillName ? JSON.parse(skillName).skill : null;
      this.db.prepare("INSERT OR IGNORE INTO tool_calls (id, run_id, sequence, skill_name, tool_name, args_json, status, started_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)")
        .run(payload.callId, runId, sequence, skill, payload.tool, json(payload.publicArgs || {}), eventAt);
    } else if (eventType === "tool.completed") {
      this.db.prepare("UPDATE agent_runs SET status = 'running' WHERE id = ?").run(runId);
      this.db.prepare("UPDATE tool_calls SET result_summary_json = ?, status = ?, completed_at = ? WHERE id = ? AND run_id = ?")
        .run(json({ ...(payload.resultSummary || {}), scope: payload.scope || {} }), payload.status || "ok", eventAt, payload.callId, runId);
    } else if (eventType === "evidence.added") {
      const claimIndex = this.db.prepare("SELECT COUNT(*) AS count FROM evidence_records WHERE run_id = ?").get(runId).count;
      this.db.prepare("INSERT OR IGNORE INTO evidence_records (id, run_id, claim_index, source_type, source_key, source_path, locator_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(payload.evidenceId, runId, claimIndex, payload.sourceType || "wiki", payload.sourceKey || null, payload.sourcePath || null, payload.locator ? json(payload.locator) : null, eventAt);
    } else if (eventType === "answer.delta") {
      this.db.prepare("UPDATE messages SET content = content || ?, status = 'streaming' WHERE id = ?").run(payload.delta || "", assistantMessageId);
    } else if (eventType === "validation.completed") {
      this.db.prepare("UPDATE agent_runs SET status = 'validating', validation_json = ? WHERE id = ?").run(json({ valid: payload.valid, findings: payload.findings || [], evidenceCount: payload.evidenceCount || 0 }), runId);
    }
    return this.appendEvent(runId, eventType, payload, eventAt);
  }

  completeRun(runId, assistantMessageId, conversationId, context, result) {
    const now = nowIso();
    const insertCall = this.db.prepare("INSERT OR IGNORE INTO tool_calls (id, run_id, sequence, skill_name, tool_name, args_json, result_summary_json, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    (result.toolCalls || []).forEach((call, index) => {
      const callId = call.id || newId("call_");
      insertCall.run(callId, runId, index + 1, result.skill, call.name, json(call.args || {}), json(call.scope || {}), call.status || "ok", now, now);
      this.db.prepare("UPDATE tool_calls SET skill_name = ?, tool_name = ?, args_json = ?, result_summary_json = ?, status = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ? AND run_id = ?")
        .run(result.skill, call.name, json(call.args || {}), json(call.scope || {}), call.status || "ok", now, callId, runId);
    });
    const insertEvidence = this.db.prepare("INSERT OR IGNORE INTO evidence_records (id, run_id, claim_index, source_type, source_key, source_path, locator_json, snippet, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    (result.sources || []).forEach((source, index) => {
      const sourceType = source.key?.startsWith("query:") ? "query" : "wiki";
      insertEvidence.run(source.evidenceId || newId("evid_"), runId, index, sourceType, source.key || null, source.path || null, source.scope ? json(source.scope) : null, null, now);
    });

    const after = {
      modelId: result.context.modelId || context.modelId || null,
      metrics: result.context.metrics,
      dimensions: result.context.dimensions,
      timeRange: result.context.range,
      filters: result.context.filters,
      entities: context.entities || [],
      pendingClarification: null,
    };
    this.saveContext(conversationId, after);
    this.db.prepare("UPDATE messages SET content = ?, status = 'completed' WHERE id = ?").run(result.answer, assistantMessageId);
    this.db.prepare("UPDATE agent_runs SET status = 'completed', capability = ?, provider = ?, context_after_json = ?, plan_json = ?, budget_json = ?, validation_json = ?, result_json = ?, error_json = NULL, completed_at = ? WHERE id = ?")
      .run(result.mode, result.provider, json(after), json(result.plan), json(result.plan?.budget || {}), json(result.validation), result.data ? json(result.data) : null, now, runId);
    this.db.prepare("UPDATE conversations SET updated_at = ?, last_message_at = ? WHERE id = ?").run(now, now, conversationId);
    this.appendEvent(runId, "run.completed", { assistantMessageId, status: result.status, contextAfter: after });
  }

  finishFailed(runId, assistantMessageId, error) {
    if (this.hasTerminalEvent(runId)) return this.getRun(runId);
    const failure = { code: error.code || "RUN_FAILED", message: error.message || "运行失败", retryable: true };
    const now = nowIso();
    this.db.prepare("UPDATE agent_runs SET status = 'failed', error_json = ?, completed_at = ? WHERE id = ?").run(json(failure), now, runId);
    this.db.prepare("UPDATE messages SET status = 'failed', content = CASE WHEN content = '' THEN ? ELSE content END WHERE id = ?").run(`运行失败：${failure.message}`, assistantMessageId);
    this.appendEvent(runId, "run.failed", { error: failure });
    return this.getRun(runId);
  }

  finishCancelled(runId, assistantMessageId) {
    if (this.hasTerminalEvent(runId)) return this.getRun(runId);
    const run = this.getRun(runId);
    if (!run) return null;
    const completedStepCount = this.db.prepare("SELECT COUNT(*) AS count FROM agent_run_events WHERE run_id = ? AND event_type = 'tool.completed'").get(runId).count;
    const now = nowIso();
    this.db.prepare("UPDATE agent_runs SET status = 'cancelled', completed_at = ? WHERE id = ?").run(now, runId);
    this.db.prepare("UPDATE messages SET status = 'cancelled', content = CASE WHEN content = '' THEN '运行已停止。' ELSE content END WHERE id = ?").run(assistantMessageId);
    const context = this.loadContext(run.conversationId);
    if (context.pendingClarification) this.saveContext(run.conversationId, { ...context, pendingClarification: null });
    this.appendEvent(runId, "run.cancelled", { completedStepCount });
    return this.getRun(runId);
  }

  hasTerminalEvent(runId) {
    const row = this.db.prepare("SELECT event_type FROM agent_run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1").get(runId);
    return Boolean(row && TERMINAL_EVENTS.has(row.event_type));
  }

  async resolveClarification(runId, { optionId, defer = false } = {}) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`运行不存在: ${runId}`);
    if (run.status !== "needs_clarification") throw new Error("该运行不需要澄清");
    const clarification = run.plan?.clarification || this.loadContext(run.conversationId).pendingClarification;
    const option = (clarification?.options || []).find((item) => item.id === optionId);
    const context = this.loadContext(run.conversationId);
    let next;
    if (option?.kind === "model") {
      next = this.mergeContext(context, { modelId: optionId, pendingClarification: null });
    } else {
      const normalizedOptionId = this.semantic.model.metrics[optionId]
        ? optionId
        : Object.keys(this.semantic.model.metrics).find((key) => `metric-${key.replaceAll("_", "-")}` === optionId);
      if (!normalizedOptionId) throw new Error("澄清选项无效");
      next = this.mergeContext(context, { metrics: [normalizedOptionId], pendingClarification: null });
    }
    this.saveContext(run.conversationId, next);
    const userMessage = this.getMessage(run.userMessageId);
    this.db.prepare("UPDATE messages SET content = '', status = 'pending' WHERE id = ?").run(run.assistantMessageId);
    this.db.prepare("UPDATE agent_runs SET status = 'queued', capability = NULL, provider = NULL, context_before_json = ?, context_after_json = NULL, plan_json = NULL, budget_json = NULL, validation_json = NULL, result_json = NULL, error_json = NULL, completed_at = NULL WHERE id = ?")
      .run(json(next), runId);
    this.appendEvent(runId, "clarification.resolved", { optionId });
    const response = this.responseFor(userMessage.id, run.assistantMessageId, runId);
    const task = this.startRun({ runId, assistantMessageId: run.assistantMessageId, conversationId: run.conversationId, userMessageId: userMessage.id, content: userMessage.content, context: next, history: this.historyBeforeMessage(userMessage.id) });
    if (defer) return response;
    await task;
    return this.responseFor(userMessage.id, run.assistantMessageId, runId);
  }

  // ---------- 事件与运行控制 ----------

  appendEvent(runId, type, payload = {}, createdAt = nowIso()) {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_run_events WHERE run_id = ?").get(runId);
    const event = { id: newId("evt_"), runId, sequence: row.sequence + 1, type, payload, createdAt };
    this.db.prepare("INSERT INTO agent_run_events (id, run_id, sequence, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.id, runId, event.sequence, type, json(payload), createdAt);
    this.events.emit("event", event);
    this.events.emit("*", event);
    return event;
  }

  eventsAfter(runId, afterSequence = 0) {
    return this.db.prepare("SELECT * FROM agent_run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC").all(runId, afterSequence).map((row) => this.decorateEvent(row));
  }

  eventSequenceForId(runId, eventId) {
    if (!eventId) return 0;
    return this.db.prepare("SELECT sequence FROM agent_run_events WHERE run_id = ? AND id = ?").get(runId, eventId)?.sequence || 0;
  }

  getRun(id) {
    const row = this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id);
    return row ? this.decorateRun(row) : null;
  }

  getMessage(id) {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    return row ? this.decorateMessage(row) : null;
  }

  listRuns(conversationId, { limit = 20 } = {}) {
    const limitN = Math.min(Math.max(Number(limit) || 20, 1), 100);
    return this.db.prepare("SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?").all(conversationId, limitN).map((row) => this.decorateRun(row));
  }

  decorateMessage(row) {
    return { id: row.id, conversationId: row.conversation_id, runId: row.run_id, role: row.role, content: row.content, status: row.status, editedFromId: row.edited_from_id, createdAt: row.created_at };
  }

  decorateEvent(row) {
    return { id: row.id, runId: row.run_id, sequence: row.sequence, type: row.event_type, payload: JSON.parse(row.payload_json || "{}"), createdAt: row.created_at };
  }

  decorateRun(row) {
    const events = this.eventsAfter(row.id);
    const toolCalls = this.db.prepare("SELECT * FROM tool_calls WHERE run_id = ? ORDER BY sequence ASC").all(row.id)
      .map((call) => ({ id: call.id, sequence: call.sequence, skillName: call.skill_name, toolName: call.tool_name, args: JSON.parse(call.args_json || "{}"), resultSummary: JSON.parse(call.result_summary_json || "{}"), status: call.status }));
    const evidence = this.db.prepare("SELECT * FROM evidence_records WHERE run_id = ? ORDER BY claim_index ASC").all(row.id)
      .map((record) => ({ id: record.id, claimIndex: record.claim_index, sourceType: record.source_type, sourceKey: record.source_key, sourcePath: record.source_path, locator: record.locator_json ? JSON.parse(record.locator_json) : null }));
    return {
      id: row.id,
      conversationId: row.conversation_id,
      userMessageId: row.user_message_id,
      assistantMessageId: row.assistant_message_id,
      status: row.status,
      capability: row.capability,
      provider: row.provider,
      contextBefore: row.context_before_json ? JSON.parse(row.context_before_json) : null,
      contextAfter: row.context_after_json ? JSON.parse(row.context_after_json) : null,
      plan: row.plan_json ? JSON.parse(row.plan_json) : null,
      budget: row.budget_json ? JSON.parse(row.budget_json) : null,
      validation: row.validation_json ? JSON.parse(row.validation_json) : null,
      data: row.result_json ? JSON.parse(row.result_json) : null,
      error: row.error_json ? JSON.parse(row.error_json) : null,
      events, toolCalls, evidence,
      eventsUrl: `/api/conversations/${row.conversation_id}/runs/${row.id}/events`,
      startedAt: row.started_at, completedAt: row.completed_at, createdAt: row.created_at,
    };
  }

  cancelRun(runId) {
    const run = this.getRun(runId);
    if (!run) return null;
    if (!CANCELLABLE_STATUSES.has(run.status)) return run;
    this.controllers.get(runId)?.abort(abortError());
    return this.finishCancelled(runId, run.assistantMessageId);
  }

  async retryMessage(messageId, { defer = false } = {}) {
    const message = this.getMessage(messageId);
    if (!message || message.role !== "user") throw new Error("只能重试用户消息");
    const original = this.db.prepare("SELECT context_before_json FROM agent_runs WHERE user_message_id = ? ORDER BY created_at ASC LIMIT 1").get(messageId);
    const context = original?.context_before_json ? JSON.parse(original.context_before_json) : this.loadContext(message.conversationId);
    const created = this.createRun(message.conversationId, message.id, context);
    const response = this.responseFor(message.id, created.assistantMessageId, created.runId);
    const task = this.startRun({ runId: created.runId, assistantMessageId: created.assistantMessageId, conversationId: message.conversationId, userMessageId: message.id, content: message.content, context, history: this.historyBeforeMessage(message.id) });
    if (defer) return response;
    await task;
    return this.responseFor(message.id, created.assistantMessageId, created.runId);
  }

  async waitForRun(runId) {
    const task = this.runPromises.get(runId);
    if (task) {
      try { await task; }
      catch { /* 失败与取消状态已持久化，由调用方读取 Run 判断 */ }
    }
    return this.getRun(runId);
  }
}
