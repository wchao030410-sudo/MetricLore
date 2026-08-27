import { json, newId, nowIso } from "./ingest/util.mjs";

const EVENT_MAP = {
  RECEIVED: "run.started",
  RESOLVING_CAPABILITY: "plan.created",
  SELECTING_SKILL: "skill.started",
  PLANNING: "plan.created",
  RUNNING_TOOL: "tool.started",
  COLLECTING_EVIDENCE: "tool.completed",
  VALIDATING: "validation.completed",
  LLM_FALLBACK: "run.fallback",
  COMPLETED: "run.completed",
};

const ASKS_DATA = /多少|怎么样|趋势|下降|增长|波动|变化|对比|分析|拆|看/;

export class ConversationService {
  constructor({ db, agent, semantic }) {
    this.db = db;
    this.agent = agent;         // MetricLoreAgent（暴露 runtime）
    this.semantic = semantic;
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
      messages: this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC").all(id).map((row) => this.decorateMessage(row)),
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
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    return true;
  }

  // ---------- 上下文 ----------

  loadContext(conversationId) {
    const row = this.db.prepare("SELECT * FROM conversation_context WHERE conversation_id = ?").get(conversationId);
    if (!row) return { metrics: [], dimensions: [], timeRange: null, filters: {}, entities: [], pendingClarification: null };
    return {
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
    this.db.prepare("UPDATE conversation_context SET version = ?, metrics_json = ?, dimensions_json = ?, time_range_json = ?, filters_json = ?, entities_json = ?, pending_clarification_json = ?, updated_at = ? WHERE conversation_id = ?")
      .run(version, json(context.metrics || []), json(context.dimensions || []), context.timeRange ? json(context.timeRange) : null, json(context.filters || {}), json(context.entities || []), context.pendingClarification ? json(context.pendingClarification) : null, nowIso(), conversationId);
  }

  mergeContext(base, patch = {}) {
    return {
      metrics: patch.metrics || base.metrics || [],
      dimensions: patch.dimensions || base.dimensions || [],
      timeRange: patch.timeRange || base.timeRange || null,
      filters: { ...(base.filters || {}), ...(patch.filters || {}) },
      entities: patch.entities || base.entities || [],
      pendingClarification: patch.pendingClarification ?? base.pendingClarification ?? null,
    };
  }

  history(conversationId) {
    return this.db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC").all(conversationId).map((row) => ({ role: row.role, content: row.content }));
  }

  // ---------- 消息与运行 ----------

  clarificationFor(content, context) {
    if (!ASKS_DATA.test(content)) return null;
    const resolution = this.agent.runtime.resolve(content, context);
    if (resolution.metrics.length === 0 && resolution.capability !== "safety") {
      return { prompt: "请选择要查询的指标：", options: Object.entries(this.semantic.model.metrics).map(([id, metric]) => ({ id, label: metric.label })) };
    }
    return null;
  }

  async submitMessage(conversationId, content, { contextPatch = {} } = {}) {
    const conv = this.getConversation(conversationId);
    if (!conv) throw new Error(`会话不存在: ${conversationId}`);
    if (typeof content !== "string" || !content.trim()) throw new Error("message 不能为空");

    const history = this.history(conversationId);
    const before = this.mergeContext(conv.context, contextPatch);
    const clarification = this.clarificationFor(content, before);
    const userMsgId = newId("msg_");
    const now = nowIso();
    this.db.prepare("INSERT INTO messages (id, conversation_id, role, content, status, created_at) VALUES (?, ?, 'user', ?, 'completed', ?)").run(userMsgId, conversationId, content, now);
    this.db.prepare("UPDATE conversations SET updated_at = ?, last_message_at = ? WHERE id = ?").run(now, now, conversationId);

    if (clarification) {
      const runId = newId("run_");
      this.db.prepare("INSERT INTO agent_runs (id, conversation_id, user_message_id, status, capability, context_before_json, plan_json, created_at) VALUES (?, ?, ?, 'needs_clarification', 'data', ?, ?, ?)")
        .run(runId, conversationId, userMsgId, json(before), json({ clarification }), now);
      const prompt = `${clarification.prompt}\n${clarification.options.map((option) => `- ${option.label}（${option.id}）`).join("\n")}`;
      const assistantMsgId = newId("msg_");
      this.db.prepare("INSERT INTO messages (id, conversation_id, run_id, role, content, status, created_at) VALUES (?, ?, ?, 'assistant', ?, 'completed', ?)").run(assistantMsgId, conversationId, runId, prompt, now);
      this.db.prepare("UPDATE agent_runs SET assistant_message_id = ?, completed_at = ? WHERE id = ?").run(assistantMsgId, now, runId);
      this.saveContext(conversationId, { ...before, pendingClarification: clarification });
      return { userMessage: this.getMessage(userMsgId), assistantMessage: this.getMessage(assistantMsgId), run: this.getRun(runId) };
    }

    const { assistantMessage, run } = await this.runTurn(conversationId, userMsgId, content, before, history);
    return { userMessage: this.getMessage(userMsgId), assistantMessage, run };
  }

  async runTurn(conversationId, userMsgId, content, context, history = []) {
    const runId = newId("run_");
    this.db.prepare("INSERT INTO agent_runs (id, conversation_id, user_message_id, status, context_before_json, created_at) VALUES (?, ?, ?, 'planning', ?, ?)")
      .run(runId, conversationId, userMsgId, json(context), nowIso());

    let result;
    try {
      result = await this.agent.answer(content, history, context);
    } catch (error) {
      this.db.prepare("UPDATE agent_runs SET status = 'failed', error_json = ?, completed_at = ? WHERE id = ?").run(json({ message: error.message }), nowIso(), runId);
      throw error;
    }

    this.persistRun(runId, result);
    const after = {
      metrics: result.context.metrics,
      dimensions: result.context.dimensions,
      timeRange: result.context.range,
      filters: result.context.filters,
      entities: context.entities || [],
      pendingClarification: context.pendingClarification || null,
    };
    this.saveContext(conversationId, after);

    const assistantMsgId = newId("msg_");
    this.db.prepare("INSERT INTO messages (id, conversation_id, run_id, role, content, status, created_at) VALUES (?, ?, ?, 'assistant', ?, 'completed', ?)")
      .run(assistantMsgId, conversationId, runId, result.answer, nowIso());
    this.db.prepare("UPDATE agent_runs SET assistant_message_id = ?, context_after_json = ? WHERE id = ?").run(assistantMsgId, json(after), runId);
    this.db.prepare("UPDATE conversations SET updated_at = ?, last_message_at = ? WHERE id = ?").run(nowIso(), nowIso(), conversationId);
    return { assistantMessage: this.getMessage(assistantMsgId), run: this.getRun(runId) };
  }

  persistRun(runId, result) {
    const now = nowIso();
    const insertEvent = this.db.prepare("INSERT INTO agent_run_events (id, run_id, sequence, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    (result.publicTrace || []).forEach((entry, index) => {
      const { state, ...payload } = entry;
      insertEvent.run(newId("evt_"), runId, index + 1, EVENT_MAP[state] || state.toLowerCase(), json(payload), now);
    });
    const insertCall = this.db.prepare("INSERT INTO tool_calls (id, run_id, sequence, skill_name, tool_name, args_json, result_summary_json, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    (result.toolCalls || []).forEach((call, index) => {
      insertCall.run(newId("tool_"), runId, index + 1, result.skill, call.name, json(call.args || {}), json(call.scope || {}), call.status || "ok", now, now);
    });
    const insertEvidence = this.db.prepare("INSERT INTO evidence_records (id, run_id, claim_index, source_type, source_key, source_path, locator_json, snippet, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    (result.sources || []).forEach((source, index) => {
      const sourceType = source.key?.startsWith("wiki") ? "wiki" : "query";
      insertEvidence.run(newId("evid_"), runId, index, sourceType, source.key || null, source.path || null, source.scope ? json(source.scope) : null, null, now);
    });
    this.db.prepare("UPDATE agent_runs SET status = 'completed', capability = ?, provider = ?, plan_json = ?, budget_json = ?, validation_json = ?, completed_at = ? WHERE id = ?")
      .run(result.mode, result.provider, json(result.plan), json(result.plan?.budget || {}), json(result.validation), now, runId);
  }

  async resolveClarification(runId, { optionId } = {}) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`运行不存在: ${runId}`);
    if (run.status !== "needs_clarification") throw new Error("该运行不需要澄清");
    const userMessage = this.getMessage(run.userMessageId);
    const context = this.loadContext(run.conversationId);
    const next = this.mergeContext(context, { metrics: [optionId], pendingClarification: null });
    const history = this.history(run.conversationId);
    const { assistantMessage, run: newRun } = await this.runTurn(run.conversationId, userMessage.id, userMessage.content, next, history);
    return { assistantMessage, run: newRun };
  }

  // ---------- 运行 ----------

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

  decorateRun(row) {
    const events = this.db.prepare("SELECT * FROM agent_run_events WHERE run_id = ? ORDER BY sequence ASC").all(row.id)
      .map((event) => ({ id: event.id, sequence: event.sequence, type: event.event_type, payload: JSON.parse(event.payload_json || "{}"), createdAt: event.created_at }));
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
      error: row.error_json ? JSON.parse(row.error_json) : null,
      events, toolCalls, evidence,
      startedAt: row.started_at, completedAt: row.completed_at, createdAt: row.created_at,
    };
  }

  cancelRun(runId) {
    const run = this.getRun(runId);
    if (!run) return null;
    if (["queued", "planning", "running", "needs_clarification"].includes(run.status)) {
      this.db.prepare("UPDATE agent_runs SET status = 'cancelled', completed_at = ? WHERE id = ?").run(nowIso(), runId);
    }
    return this.getRun(runId);
  }

  async retryMessage(messageId) {
    const message = this.getMessage(messageId);
    if (!message || message.role !== "user") throw new Error("只能重试用户消息");
    return this.submitMessage(message.conversationId, message.content);
  }
}
