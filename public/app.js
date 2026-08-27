const $ = (selector) => document.querySelector(selector);
const el = (tag, attrs = {}, text = "") => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text) node.textContent = text;
  return node;
};

async function api(path, options) {
  const response = await fetch(path, options);
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(data?.error?.message || data?.error || `请求失败 (${response.status})`);
  return data;
}

const EVENT_TYPES = [
  "run.started", "plan.created", "skill.started", "skill.completed", "tool.started", "tool.completed",
  "evidence.added", "answer.delta", "validation.completed", "clarification.required", "clarification.resolved",
  "run.fallback", "run.completed", "run.failed", "run.cancelled",
];
const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"]);
const ACTIVE_STATUSES = new Set(["queued", "planning", "running", "validating", "needs_clarification"]);
const EVENT_LABELS = {
  "run.started": "开始运行",
  "plan.created": "生成执行计划",
  "skill.started": "启动 Skill",
  "skill.completed": "完成 Skill",
  "tool.started": "调用工具",
  "tool.completed": "工具返回",
  "evidence.added": "记录证据",
  "answer.delta": "生成回答",
  "validation.completed": "完成校验",
  "clarification.required": "等待澄清",
  "clarification.resolved": "恢复原计划",
  "run.fallback": "切换确定性模式",
  "run.completed": "运行完成",
  "run.failed": "运行失败",
  "run.cancelled": "运行已停止",
};

let catalog;
let lastRun;
let conversationId;
const streams = new Map();

function showPage(id) {
  document.querySelectorAll(".page").forEach((page) => page.classList.toggle("active", page.id === id));
  document.querySelectorAll("nav button").forEach((button) => button.classList.toggle("active", button.dataset.page === id));
}

function renderCatalog(model) {
  const grid = $("#metric-grid");
  grid.replaceChildren();
  for (const [key, metric] of Object.entries(model.metrics)) {
    const card = el("article", { class: "card" });
    card.append(el("span", { class: "tag" }, metric.type === "atomic" ? "原子指标" : "复合指标"));
    card.append(el("h3", {}, metric.label));
    card.append(el("p", {}, metric.description));
    card.append(el("code", {}, key));
    grid.append(card);
  }
  const content = $("#semantic-content");
  content.replaceChildren();
  const summary = el("div", { class: "panel" });
  summary.append(el("h3", {}, model.label));
  summary.append(el("p", {}, `事实表：${model.table} · 时间字段：${model.timeColumn} · 支持粒度：${model.timeGrains.join(" / ")}`));
  content.append(summary);
  const tablePanel = el("div", { class: "panel" });
  const table = el("table");
  const header = el("tr");
  ["语义名称", "业务名称", "物理字段", "类型"].forEach((item) => header.append(el("th", {}, item)));
  table.append(header);
  for (const [key, dimension] of Object.entries(model.dimensions)) {
    const row = el("tr");
    [key, dimension.label, dimension.column, dimension.type].forEach((item) => row.append(el("td", {}, item)));
    table.append(row);
  }
  tablePanel.append(el("h3", {}, "维度"), table);
  content.append(tablePanel);
}

function eventDetail(type, payload = {}) {
  if (type === "plan.created") return payload.goal || "计划已生成";
  if (type === "skill.started" || type === "skill.completed") return payload.skill || "Skill";
  if (type === "tool.started" || type === "tool.completed") return payload.tool || "Tool";
  if (type === "evidence.added") return payload.sourceKey || payload.sourcePath || "来源已绑定";
  if (type === "validation.completed") return payload.valid ? `校验通过 · ${payload.evidenceCount || 0} 条证据` : `需要复核 · ${(payload.findings || []).join("、")}`;
  if (type === "run.fallback") return payload.reason || "模型不可用，使用本地确定性路径";
  if (type === "run.failed") return payload.error?.message || "运行失败";
  if (type === "run.cancelled") return `已完成 ${payload.completedStepCount || 0} 个工具步骤`;
  return "";
}

function renderTrace(run) {
  const target = $("#trace-content");
  target.replaceChildren();
  if (!run) {
    target.append(el("p", {}, "发起一次问答后，这里会显示其执行轨迹。"));
    return;
  }
  target.append(el("h3", {}, `${run.plan?.skill || run.capability || "Agent Run"} · ${run.status}`));
  const list = el("ol", { class: "trace-list" });
  (run.events || run.publicTrace || []).forEach((event) => {
    const type = event.type || event.state;
    if (type === "answer.delta" || type === "ANSWER_DELTA") return;
    const item = el("li");
    item.append(el("strong", {}, EVENT_LABELS[type] || type));
    const detail = eventDetail(type, event.payload || event);
    if (detail) item.append(el("span", {}, detail));
    list.append(item);
  });
  target.append(list);
  const calls = (run.toolCalls || []).map((call) => call.toolName || call.name);
  target.append(el("p", { class: "meta" }, `工具调用：${calls.join(" → ") || "无"}`));
}

function renderOntology(data) {
  const entities = data.entities || [];
  const summary = $("#ontology-summary");
  summary.replaceChildren();
  summary.append(el("h3", {}, `${entities.length} 个规范实体 · ${Object.keys(data.schema.relationTypes || {}).length} 类关系`));
  summary.append(el("p", {}, "每张实体卡片都包含类型、状态与出边关系；通过消息内执行过程可查看问答实际使用的知识证据。"));
  const grid = $("#ontology-grid");
  grid.replaceChildren();
  entities.forEach((entity) => {
    const card = el("article", { class: "card" });
    card.append(el("span", { class: "tag" }, entity.type));
    card.append(el("h3", {}, entity.title));
    card.append(el("p", {}, entity.content.slice(0, 130)));
    const relations = Object.entries(entity.relations || {}).flatMap(([relation, targets]) => targets.map((target) => `${relation} → ${target}`));
    card.append(el("p", { class: "meta" }, relations.join(" · ") || "暂无关系"));
    grid.append(card);
  });
}

function renderSkills(data) {
  const grid = $("#skill-grid");
  grid.replaceChildren();
  (data.skills || []).forEach((skill) => {
    const card = el("article", { class: "card" });
    card.append(el("span", { class: "tag" }, `max ${skill.maxSteps} steps`));
    card.append(el("h3", {}, skill.name));
    card.append(el("p", {}, skill.description));
    card.append(el("p", { class: "meta" }, `Tools: ${skill.allowedTools.join(", ")}`));
    grid.append(card);
  });
}

function removeWelcome() {
  $("#conversation").querySelector(".welcome-message")?.remove();
}

function userMessage(text, id) {
  const article = el("article", { class: "user" });
  if (id) article.dataset.messageId = id;
  article.append(el("div", {}, text));
  return article;
}

function statusFromEvent(type, current) {
  if (type === "run.started" || type === "plan.created") return "planning";
  if (["skill.started", "skill.completed", "tool.started", "tool.completed", "evidence.added", "answer.delta"].includes(type)) return "running";
  if (type === "validation.completed") return "validating";
  if (type === "clarification.required") return "needs_clarification";
  if (type === "run.completed") return "completed";
  if (type === "run.failed") return "failed";
  if (type === "run.cancelled") return "cancelled";
  return current;
}

function setCardStatus(article, status) {
  article._run.status = status;
  article.querySelector(".run-status").textContent = status.replaceAll("_", " ");
  article.querySelector(".run-status").dataset.status = status;
  article.querySelector(".stop-run").hidden = !ACTIVE_STATUSES.has(status);
  article.querySelector(".retry-run").hidden = !["completed", "failed", "cancelled"].includes(status);
  article.querySelector("details").open = ACTIVE_STATUSES.has(status) || ["failed", "cancelled"].includes(status);
}

function addTimelineEvent(article, event) {
  if (event.type === "answer.delta" && article.querySelector('[data-event-type="answer.delta"]')) return;
  const item = el("li", { "data-event-type": event.type });
  item.append(el("span", { class: "event-dot" }));
  const copy = el("div");
  copy.append(el("strong", {}, EVENT_LABELS[event.type] || event.type));
  const detail = eventDetail(event.type, event.payload);
  if (detail) copy.append(el("small", {}, detail));
  item.append(copy);
  article.querySelector(".message-timeline").append(item);
}

function renderEvidence(article, evidence = []) {
  const target = article.querySelector(".message-evidence");
  target.replaceChildren();
  if (!evidence.length) return;
  target.append(el("strong", {}, "证据"));
  evidence.forEach((item) => target.append(el("span", { class: "evidence-chip" }, item.sourcePath || item.sourceKey || "数据查询")));
}

async function refreshRunCard(article) {
  const detail = await api(`/api/conversations/${conversationId}`);
  const conversation = detail.data.conversation;
  const run = conversation.runs.find((item) => item.id === article.dataset.runId);
  const message = conversation.messages.find((item) => item.id === run?.assistantMessageId);
  if (!run || !message) return;
  article._run = run;
  article.querySelector(".answer-text").textContent = message.content;
  renderEvidence(article, run.evidence || []);
  setCardStatus(article, run.status);
  lastRun = run;
  renderTrace(run);
}

async function resolveClarification(article, optionId) {
  article.querySelectorAll(".clarification-options button").forEach((button) => { button.disabled = true; });
  try {
    await api(`/api/runs/${article.dataset.runId}/clarifications`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ optionId }) });
  } catch (error) {
    article.querySelector(".clarification-options").append(el("p", { class: "run-error" }, error.message));
  }
}

function renderClarification(article, payload) {
  const target = article.querySelector(".clarification-options");
  target.replaceChildren(el("p", {}, payload.prompt || "请选择后继续："));
  (payload.options || []).forEach((option) => {
    const button = el("button", { type: "button" }, option.label);
    button.addEventListener("click", () => resolveClarification(article, option.id));
    target.append(button);
  });
}

function applyStreamEvent(article, event) {
  if (article._eventIds.has(event.id)) return;
  article._eventIds.add(event.id);
  article._run.events ||= [];
  article._run.events.push(event);
  if (event.type === "clarification.resolved") {
    article.querySelector(".clarification-options").replaceChildren();
    article.querySelector(".answer-text").textContent = "";
  }
  if (event.type === "answer.delta") article.querySelector(".answer-text").textContent += event.payload.delta || "";
  if (event.type === "clarification.required") renderClarification(article, event.payload);
  addTimelineEvent(article, event);
  setCardStatus(article, statusFromEvent(event.type, article._run.status));
  lastRun = article._run;
  renderTrace(lastRun);
  if (TERMINAL_EVENTS.has(event.type)) {
    streams.get(article.dataset.runId)?.close();
    streams.delete(article.dataset.runId);
    refreshRunCard(article).catch(() => {});
  }
}

function attachStream(article) {
  const run = article._run;
  if (!run?.eventsUrl || streams.has(run.id) || !ACTIVE_STATUSES.has(run.status)) return;
  const source = new EventSource(run.eventsUrl);
  streams.set(run.id, source);
  EVENT_TYPES.forEach((type) => {
    source.addEventListener(type, (message) => {
      const data = JSON.parse(message.data);
      applyStreamEvent(article, { id: message.lastEventId, sequence: data.sequence, type, payload: data.payload || {}, createdAt: data.at });
    });
  });
  source.onerror = () => {
    if (!TERMINAL_EVENTS.has(article._run.events?.at(-1)?.type)) article.querySelector(".run-status").textContent = "reconnecting";
  };
}

async function stopRun(article) {
  try {
    await api(`/api/runs/${article.dataset.runId}/cancel`, { method: "POST" });
  } catch (error) {
    article.querySelector(".message-actions").append(el("span", { class: "run-error" }, error.message));
  }
}

async function retryRun(article) {
  const button = article.querySelector(".retry-run");
  button.disabled = true;
  try {
    const response = await api(`/api/messages/${article._run.userMessageId}/retry`, { method: "POST" });
    const next = assistantMessage(response.data.assistantMessage, response.data.run);
    article.after(next);
    attachStream(next);
  } catch (error) {
    article.querySelector(".message-actions").append(el("span", { class: "run-error" }, error.message));
  } finally {
    button.disabled = false;
  }
}

function assistantMessage(message, run) {
  const article = el("article", { class: "assistant run-message", "data-run-id": run.id, "data-message-id": message.id });
  article._run = { ...run, events: [...(run.events || [])] };
  article._eventIds = new Set((run.events || []).map((event) => event.id));
  article.append(el("div", { class: "avatar" }, "ML"));
  const box = el("div", { class: "message-body" });
  const heading = el("div", { class: "message-heading" });
  heading.append(el("strong", {}, "MetricLore"), el("span", { class: "run-status", "data-status": run.status }, run.status.replaceAll("_", " ")));
  box.append(heading, el("p", { class: "answer-text" }, message.content || ""));

  const clarification = el("div", { class: "clarification-options" });
  box.append(clarification);
  const details = el("details", { class: "message-trace" });
  details.open = ACTIVE_STATUSES.has(run.status) || ["failed", "cancelled"].includes(run.status);
  details.append(el("summary", {}, "执行过程"));
  const timeline = el("ol", { class: "message-timeline" });
  details.append(timeline);
  box.append(details, el("div", { class: "message-evidence" }));

  const actions = el("div", { class: "message-actions" });
  const stop = el("button", { type: "button", class: "stop-run" }, "停止");
  const retry = el("button", { type: "button", class: "retry-run" }, "重试");
  stop.addEventListener("click", () => stopRun(article));
  retry.addEventListener("click", () => retryRun(article));
  actions.append(stop, retry);
  box.append(actions);
  article.append(box);
  (run.events || []).forEach((event) => {
    addTimelineEvent(article, event);
    if (event.type === "clarification.required") renderClarification(article, event.payload);
  });
  renderEvidence(article, run.evidence || []);
  setCardStatus(article, run.status);
  return article;
}

function renderConversation(conversation) {
  const target = $("#conversation");
  target.replaceChildren();
  if (!conversation.messages.length) {
    const welcome = el("article", { class: "assistant welcome-message" });
    welcome.append(el("div", { class: "avatar" }, "ML"), el("div", {}, "你好。你可以问指标定义、经营数据或趋势分析。每次运行都会实时展示 Skill、工具和证据。"));
    target.append(welcome);
    return;
  }
  const runs = new Map(conversation.runs.map((run) => [run.id, run]));
  conversation.messages.forEach((message) => {
    if (message.role === "user") target.append(userMessage(message.content, message.id));
    else if (message.role === "assistant" && runs.has(message.runId)) {
      const article = assistantMessage(message, runs.get(message.runId));
      target.append(article);
      attachStream(article);
    }
  });
  lastRun = conversation.runs[0] || null;
  renderTrace(lastRun);
  target.scrollTop = target.scrollHeight;
}

async function ensureConversation() {
  const stored = localStorage.getItem("metriclore.conversationId");
  if (stored) {
    try {
      const detail = await api(`/api/conversations/${stored}`);
      conversationId = stored;
      renderConversation(detail.data.conversation);
      return;
    } catch { localStorage.removeItem("metriclore.conversationId"); }
  }
  const created = await api("/api/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "本地分析" }) });
  conversationId = created.data.conversation.id;
  localStorage.setItem("metriclore.conversationId", conversationId);
  renderConversation(created.data.conversation);
}

async function ask(message) {
  if (!message.trim() || !conversationId) return;
  removeWelcome();
  $("#conversation").append(userMessage(message));
  $("#message").value = "";
  $("#conversation").scrollTop = $("#conversation").scrollHeight;
  try {
    const response = await api(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ content: message }),
    });
    const article = assistantMessage(response.data.assistantMessage, response.data.run);
    $("#conversation").append(article);
    attachStream(article);
  } catch (error) {
    const failed = el("article", { class: "assistant" });
    failed.append(el("div", { class: "avatar" }, "ML"), el("p", { class: "run-error" }, `请求失败：${error.message}`));
    $("#conversation").append(failed);
  }
}

document.querySelectorAll("nav button").forEach((button) => button.addEventListener("click", () => showPage(button.dataset.page)));
document.querySelectorAll(".suggestions button").forEach((button) => button.addEventListener("click", () => ask(button.textContent)));
$("#chat-form").addEventListener("submit", (event) => { event.preventDefault(); ask($("#message").value); });
$("#message").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); ask(event.target.value); } });
$("#wiki-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = $("#wiki-results");
  target.replaceChildren(el("p", {}, "正在检索…"));
  try {
    const data = await api(`/api/wiki/search?q=${encodeURIComponent($("#wiki-query").value)}`);
    target.replaceChildren();
    if (!data.results.length) target.append(el("p", {}, "没有找到相关页面。"));
    data.results.forEach((item) => {
      const card = el("article", { class: "result" });
      card.append(el("h3", {}, item.title), el("small", {}, item.path), el("p", {}, item.snippet));
      target.append(card);
    });
  } catch (error) { target.replaceChildren(el("p", {}, error.message)); }
});

Promise.all([api("/api/health"), api("/api/catalog"), api("/api/ontology"), api("/api/skills"), ensureConversation()]).then(([health, model, ontology, skills]) => {
  $("#health").textContent = `本地服务正常 · ${health.wikiDocuments} 篇知识`;
  catalog = model;
  renderCatalog(model);
  renderOntology(ontology);
  renderSkills(skills);
}).catch((error) => { $("#health").textContent = error.message; });
