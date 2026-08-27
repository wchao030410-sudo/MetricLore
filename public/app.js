const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const ACTIVE_RUN = new Set(["queued", "planning", "running", "validating", "needs_clarification"]);
const TERMINAL_RUN_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"]);
const RUN_EVENTS = [
  "run.started", "plan.created", "skill.started", "tool.started", "tool.completed", "evidence.added",
  "answer.delta", "validation.completed", "skill.completed", "clarification.required",
  "clarification.resolved", "run.fallback", "run.completed", "run.failed", "run.cancelled",
];
const JOB_EVENTS = [
  "job.status", "job.started", "upload.completed", "file.started", "file.parsed", "candidate.extracted",
  "file.completed", "file.failed", "job.awaiting_review", "job.failed", "job.cancelled",
  "publish.started", "candidate.published", "publish.completed", "publish.failed",
];
const EVENT_LABELS = {
  "run.started": "收到问题", "plan.created": "制定任务计划", "skill.started": "启动 Skill",
  "tool.started": "调用工具", "tool.completed": "工具返回", "evidence.added": "绑定证据",
  "answer.delta": "生成答案", "validation.completed": "校验答案", "skill.completed": "Skill 完成",
  "clarification.required": "等待澄清", "clarification.resolved": "澄清已应用",
  "run.fallback": "切换确定性路径", "run.completed": "运行完成", "run.failed": "运行失败",
  "run.cancelled": "运行已停止", "job.started": "任务开始", "upload.completed": "上传完成",
  "file.started": "开始解析文件", "file.parsed": "文件解析完成", "candidate.extracted": "候选已抽取",
  "file.completed": "文件处理完成", "file.failed": "文件处理失败", "job.awaiting_review": "等待审核",
  "publish.started": "开始发布", "candidate.published": "实体已发布", "publish.completed": "发布完成",
  "job.failed": "任务失败", "job.cancelled": "任务取消", "publish.failed": "发布失败",
};
const TYPE_COLORS = {
  Metric: "#4f7cff", Dimension: "#22a486", BusinessProcess: "#d99a26", BusinessDomain: "#d06452",
  DataAsset: "#9d70e4", DataField: "#6f8fa8", BusinessRule: "#e16d9a", Dashboard: "#4fa7b8", Source: "#8a9189",
};

const state = {
  health: null, catalog: null, ontology: null, skills: null, conversations: [],
  currentConversation: null, selectedFiles: [], selectedCandidates: new Set(), viewToken: 0,
  streams: new Map(), pendingQuestion: null,
};

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (["checked", "disabled", "hidden", "selected", "multiple"].includes(key)) node[key] = Boolean(value);
    else if (key === "value") node.value = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  return appendChildren(node, children);
}

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return appendChildren(node, children);
}

function action(label, className = "button", onClick, attrs = {}) {
  return el("button", { type: "button", class: className, onClick, ...attrs }, label);
}

async function api(path, init = {}) {
  const response = await fetch(path, init);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("json") ? await response.json() : null;
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || `请求失败（${response.status}）`;
    const error = new Error(message);
    error.code = payload?.error?.code;
    error.details = payload?.error?.details;
    throw error;
  }
  return payload?.schemaVersion ? payload.data : payload;
}

function fmtDate(value, withTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", withTime
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function fmtBytes(bytes = 0) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function download(filename, content, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function rowsToCsv(data) {
  const rows = data?.rows || [];
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]);
  const escape = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n");
}

function escapeSelector(value) {
  return globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function statusPill(status = "unknown") {
  return el("span", { class: "status-pill", "data-status": status }, String(status).replaceAll("_", " "));
}

function pageHeader(eyebrow, title, description, actions = []) {
  return el("header", { class: "page-header" },
    el("div", {}, el("small", { class: "eyebrow" }, eyebrow), el("h1", {}, title), el("p", {}, description)),
    actions.length ? el("div", { class: "page-header-actions" }, actions) : null,
  );
}

function loading() {
  return el("div", { class: "route-loading" }, el("span"), el("p", {}, "正在读取工作区…"));
}

function emptyState(title, copy, glyph = "⌁", actions = []) {
  return el("div", { class: "empty-state" }, el("span", {}, glyph), el("h2", {}, title), el("p", {}, copy),
    actions.length ? el("div", { class: "hero-actions" }, actions) : null);
}

function errorState(error) {
  return el("div", { class: "error-state" }, `无法加载：${error.message || error}`);
}

function toast(message) {
  const target = $("#toast");
  target.textContent = message;
  target.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => target.classList.remove("show"), 2600);
}

function inlineMarkup(text) {
  const fragment = document.createDocumentFragment();
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    fragment.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    fragment.append(token.startsWith("**") ? el("strong", {}, token.slice(2, -2)) : el("code", {}, token.slice(1, -1)));
    cursor = match.index + token.length;
  }
  fragment.append(document.createTextNode(text.slice(cursor)));
  return fragment;
}

function renderMarkdown(text = "", className = "answer-prose") {
  const root = el("div", { class: className });
  const lines = String(text).split("\n");
  let list = null;
  const closeList = () => { if (list) { root.append(list); list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    if (/^###\s+/.test(line)) { closeList(); root.append(el("h3", {}, inlineMarkup(line.replace(/^###\s+/, "")))); }
    else if (/^##\s+/.test(line)) { closeList(); root.append(el("h2", {}, inlineMarkup(line.replace(/^##\s+/, "")))); }
    else if (/^#\s+/.test(line)) { closeList(); root.append(el("h2", {}, inlineMarkup(line.replace(/^#\s+/, "")))); }
    else if (/^-\s+/.test(line)) {
      list ||= el("ul");
      list.append(el("li", {}, inlineMarkup(line.replace(/^-\s+/, ""))));
    } else {
      closeList();
      root.append(el("p", {}, inlineMarkup(raw)));
    }
  }
  closeList();
  return root;
}

function section(title, ...content) {
  return el("section", { class: "context-section" }, el("h3", {}, title), content);
}

function openContext({ eyebrow = "CONTEXT", title = "Details", content = [] }) {
  $("#context-eyebrow").textContent = eyebrow;
  $("#context-title").textContent = title;
  $("#context-body").replaceChildren(...(Array.isArray(content) ? content : [content]));
  if (matchMedia("(max-width: 1180px)").matches) document.body.classList.add("context-open");
}

function defaultContext(title = "Workspace", copy = "选择执行轨迹、证据、实体或文件，查看与当前任务相关的细节。") {
  openContext({
    eyebrow: "CONTEXT", title,
    content: el("div", { class: "context-empty" }, el("span", {}, "⌁"), el("h3", {}, "上下文会出现在这里"), el("p", {}, copy)),
  });
  document.body.classList.remove("context-open");
}

function closePanels() {
  document.body.classList.remove("nav-open", "context-open");
}

function closeStreams() {
  for (const stream of state.streams.values()) stream.close();
  state.streams.clear();
}

function parseRoute() {
  const raw = (location.hash.slice(1) || "/ask");
  const [path, queryString = ""] = raw.split("?");
  return { path: path.startsWith("/") ? path : `/${path}`, query: new URLSearchParams(queryString) };
}

function navigate(path) {
  const next = path.startsWith("#") ? path : `#${path}`;
  if (location.hash === next) renderRoute();
  else location.hash = next;
}

function markActive(path) {
  $$("[data-route]").forEach((link) => {
    const route = link.dataset.route;
    const active = route === "/ask" ? path.startsWith("/ask") : path.startsWith(route);
    link.classList.toggle("active", active);
  });
  $$(".recent-chats a").forEach((link) => link.classList.toggle("active", path === `/ask/${link.dataset.id}`));
}

async function loadRecentChats() {
  try {
    const result = await api("/api/conversations?limit=8");
    state.conversations = result.conversations || [];
    const target = $("#recent-chats");
    target.replaceChildren();
    if (!state.conversations.length) target.append(el("span", { class: "rail-muted" }, "还没有对话"));
    for (const conversation of state.conversations) {
      target.append(el("a", { href: `#/ask/${encodeURIComponent(conversation.id)}`, dataset: { id: conversation.id } },
        el("strong", {}, conversation.title), el("small", {}, fmtDate(conversation.lastMessageAt || conversation.createdAt, true))));
    }
    markActive(parseRoute().path);
  } catch {
    $("#recent-chats").replaceChildren(el("span", { class: "rail-muted" }, "会话读取失败"));
  }
}

async function createConversation(question = null) {
  const title = question ? question.slice(0, 42) : "新分析";
  const result = await api("/api/conversations", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }),
  });
  state.pendingQuestion = question;
  await loadRecentChats();
  navigate(`/ask/${encodeURIComponent(result.conversation.id)}`);
  return result.conversation;
}

function contextList(items) {
  return el("ul", { class: "context-list" }, items.map((item) => el("li", {}, item)));
}

function eventDetail(type, payload = {}) {
  if (type === "plan.created") return payload.goal || payload.skill || "";
  if (type === "skill.started" || type === "skill.completed") return payload.skill || "";
  if (type === "tool.started" || type === "tool.completed") return payload.tool || "";
  if (type === "evidence.added") return payload.sourceKey || payload.sourcePath || "来源已绑定";
  if (type === "validation.completed") return payload.valid ? `校验通过 · ${payload.evidenceCount || 0} 条证据` : (payload.findings || []).join("、");
  if (type === "run.fallback") return payload.reason || "切换本地路径";
  if (type === "run.failed") return payload.error?.message || "运行失败";
  if (type === "run.cancelled") return `保留 ${payload.completedStepCount || 0} 个已完成步骤`;
  if (type.startsWith("file.")) return payload.path || payload.fileId || "";
  if (type.startsWith("candidate.")) return payload.entityKey || payload.candidateId || "";
  return "";
}

function stat(label, value, note = "") {
  return el("div", { class: "stat" }, el("small", {}, label), el("strong", {}, value), note ? el("em", {}, note) : null);
}

async function renderAskHome(token) {
  const shell = el("div", { class: "page-shell wide" });
  $("#workspace").replaceChildren(shell);
  let jobs = [];
  try { jobs = (await api("/api/knowledge/jobs?limit=3")).jobs || []; } catch { /* 空状态仍可使用 */ }
  if (token !== state.viewToken) return;

  const hero = el("section", { class: "hero-grid" });
  const lead = el("div", { class: "hero-card" },
    el("small", { class: "eyebrow" }, "ONTOLOGY-GROUNDED DATA AGENT"),
    el("h1", {}, "Ask data. Inspect every step."),
    el("p", {}, "从业务问题出发，沿语义层、Skill、工具与知识证据完成问数和分析。每次运行都留下可复核的公开轨迹。"),
    el("div", { class: "hero-actions" },
      action("Start an analysis  →", "button primary", () => createConversation()),
      action("Build your Wiki", "button secondary", () => navigate("/knowledge/builder"))));
  const side = el("div", { class: "hero-side" },
    el("button", { class: "path-card", type: "button", onClick: () => createConversation("近 14 天收入趋势怎么样？") },
      el("span", {}, "01"), el("h2", {}, "Ask sample data"), el("p", {}, "使用内置合成数据体验多轮问数、分析与证据追踪。")),
    el("button", { class: "path-card amber", type: "button", onClick: () => navigate("/knowledge/builder") },
      el("span", {}, "02"), el("h2", {}, "Build a Wiki"), el("p", {}, "导入文件，审核候选实体，发布为 Agent 可检索的本体知识。")));
  hero.append(lead, side);

  const mode = state.health?.llmConfigured ? "LLM" : "Deterministic";
  shell.append(hero, el("section", { class: "stat-grid" },
    stat("RUN MODE", mode, state.health?.llmConfigured ? "model connected" : "local governed path"),
    stat("WIKI PAGES", state.health?.wikiDocuments ?? "—", "indexed locally"),
    stat("ENTITIES", state.health?.wikiEntities ?? "—", "ontology nodes"),
    stat("RECENT JOBS", jobs.length, jobs[0] ? `latest · ${jobs[0].status}` : "ready for import")));

  const samples = [
    ["DATA", "近 14 天收入趋势怎么样？"], ["ANALYSIS", "那按地区拆一下。"],
    ["DEFINITION", "客单价的口径是什么？"], ["KNOWLEDGE", "语义层为什么限制任意 SQL？"],
  ];
  shell.append(el("div", { class: "section-heading" }, el("h2", {}, "Start with a real task"), el("small", {}, "One click creates a persistent thread")),
    el("div", { class: "sample-grid" }, samples.map(([kind, question]) =>
      el("button", { class: "sample-card", type: "button", onClick: () => createConversation(question) },
        el("small", {}, kind), el("p", {}, question)))));

  defaultContext("Ask", "首页展示两条完整路径：直接体验问数，或先构建自己的 Wiki。");
}

function scopeBar(context = {}) {
  const bar = el("div", { class: "scope-bar" }, el("strong", {}, "CURRENT SCOPE"));
  const metrics = context.metrics || [];
  const dimensions = context.dimensions || [];
  const filters = context.filters || {};
  metrics.forEach((item) => bar.append(el("span", { class: "scope-chip metric" }, state.catalog?.metrics?.[item]?.label || item)));
  dimensions.forEach((item) => bar.append(el("span", { class: "scope-chip" }, state.catalog?.dimensions?.[item]?.label || item)));
  if (context.timeRange) bar.append(el("span", { class: "scope-chip time" }, `${context.timeRange.startDate} → ${context.timeRange.endDate}`));
  Object.entries(filters).forEach(([key, values]) => bar.append(el("span", { class: "scope-chip filter" }, `${state.catalog?.dimensions?.[key]?.label || key}: ${[].concat(values).join("、")}`)));
  if (!metrics.length && !dimensions.length && !context.timeRange && !Object.keys(filters).length) {
    bar.append(el("span", { class: "scope-chip" }, "等待第一次提问"));
  }
  bar.addEventListener("click", () => openContext({
    eyebrow: "CONVERSATION SCOPE", title: "Current context",
    content: [
      section("Metrics", contextList(metrics.map((key) => state.catalog?.metrics?.[key]?.label || key).length ? metrics.map((key) => state.catalog?.metrics?.[key]?.label || key) : ["尚未选择"])),
      section("Dimensions & filters", contextList([
        ...dimensions.map((key) => state.catalog?.dimensions?.[key]?.label || key),
        ...Object.entries(filters).map(([key, value]) => `${key}: ${[].concat(value).join("、")}`),
      ].length ? [...dimensions.map((key) => state.catalog?.dimensions?.[key]?.label || key), ...Object.entries(filters).map(([key, value]) => `${key}: ${[].concat(value).join("、")}`)] : ["尚未选择"])),
      section("Time range", el("p", {}, context.timeRange ? `${context.timeRange.startDate} 至 ${context.timeRange.endDate}` : "由问题或默认范围确定")),
    ],
  }));
  return bar;
}

function runTimeline(run) {
  const list = el("ol", { class: "run-timeline" });
  let answerSeen = false;
  for (const event of run.events || []) {
    if (event.type === "answer.delta") {
      if (answerSeen) continue;
      answerSeen = true;
    }
    const detail = eventDetail(event.type, event.payload || {});
    list.append(el("li", { dataset: { eventId: event.id || "", eventType: event.type } },
      el("i"), el("div", {}, el("strong", {}, EVENT_LABELS[event.type] || event.type), detail ? el("small", {}, detail) : null)));
  }
  return list;
}

function dataView(data) {
  const rows = data?.rows || [];
  if (!rows.length) return null;
  const columns = Object.keys(rows[0]);
  const numeric = (data.metrics || []).find((key) => rows.some((row) => Number.isFinite(Number(row[key]))))
    || columns.find((key) => rows.some((row) => Number.isFinite(Number(row[key]))));
  const xKey = columns.find((key) => key !== numeric);
  const view = el("section", { class: "data-view" },
    el("div", { class: "data-view-header" }, el("strong", {}, `Data view · ${rows.length} rows`), el("small", {}, numeric || "result"),
      action("CSV", "message-action", () => download("metriclore-data.csv", rowsToCsv(data), "text/csv"))));
  if (numeric && rows.length > 1) {
    const width = 680; const height = 170; const pad = { left: 32, right: 16, top: 16, bottom: 28 };
    const values = rows.map((row) => Number(row[numeric])).filter(Number.isFinite);
    const min = Math.min(...values); const max = Math.max(...values); const spread = max - min || 1;
    const point = (row, index) => ({
      x: pad.left + index * ((width - pad.left - pad.right) / Math.max(rows.length - 1, 1)),
      y: pad.top + (max - Number(row[numeric])) / spread * (height - pad.top - pad.bottom),
    });
    const points = rows.map(point);
    const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${numeric} 趋势图` });
    [0, .5, 1].forEach((ratio) => svg.append(svgEl("line", { class: "chart-grid", x1: pad.left, x2: width - pad.right, y1: pad.top + ratio * (height - pad.top - pad.bottom), y2: pad.top + ratio * (height - pad.top - pad.bottom) })));
    svg.append(svgEl("polyline", { class: "chart-line", points: points.map((p) => `${p.x},${p.y}`).join(" ") }));
    points.forEach((p, index) => {
      const dot = svgEl("circle", { class: "chart-dot", cx: p.x, cy: p.y, r: 3.5 });
      dot.append(svgEl("title", {}, `${xKey ? rows[index][xKey] : index + 1}: ${rows[index][numeric]}`));
      svg.append(dot);
    });
    if (xKey) {
      [0, rows.length - 1].forEach((index) => svg.append(svgEl("text", { class: "chart-label", x: points[index].x, y: height - 7, "text-anchor": index ? "end" : "start" }, String(rows[index][xKey]))));
    }
    view.append(el("div", { class: "micro-chart" }, svg));
  }

  const sort = { column: null, direction: 1 };
  const tableHost = el("div", { class: "data-table-wrap" });
  const renderTable = () => {
    const sorted = [...rows];
    if (sort.column) {
      const col = sort.column;
      sorted.sort((a, b) => {
        const av = a[col]; const bv = b[col];
        const an = Number(av); const bn = Number(bv);
        const cmp = Number.isFinite(an) && Number.isFinite(bn) ? an - bn : String(av ?? "").localeCompare(String(bv ?? ""));
        return cmp * sort.direction;
      });
    }
    tableHost.replaceChildren(el("table", { class: "data-table" },
      el("thead", {}, el("tr", {}, columns.map((column) => {
        const head = el("th", { class: "sortable", role: "button", tabindex: 0 }, column, sort.column === column ? el("span", { class: "sort-arrow" }, sort.direction > 0 ? "↑" : "↓") : null);
        head.addEventListener("click", () => { if (sort.column === column) sort.direction *= -1; else { sort.column = column; sort.direction = 1; } renderTable(); });
        return head;
      }))),
      el("tbody", {}, sorted.slice(0, 50).map((row) => el("tr", {}, columns.map((column) => el("td", {}, row[column] ?? "—")))))));
  };
  renderTable();
  view.append(el("details", {}, el("summary", { class: "text-button" }, "查看数据表"), tableHost));
  return view;
}

function showRunContext(run) {
  const tools = (run.toolCalls || []).map((call) => `${call.sequence}. ${call.skillName || "skill"} → ${call.toolName} · ${call.status}`);
  const evidence = (run.evidence || []).map((item) => item.sourceKey || item.sourcePath || item.sourceType);
  openContext({
    eyebrow: "AGENT RUN", title: run.plan?.skill || run.capability || "Run",
    content: [
      section("Goal", el("p", {}, run.plan?.goal || "等待计划生成")),
      section("Status", statusPill(run.status)),
      section("Scope used", el("pre", { class: "context-code" }, JSON.stringify(run.contextAfter || run.contextBefore || {}, null, 2))),
      section("Tool calls", contextList(tools.length ? tools : ["尚未调用工具"])),
      section("Evidence", contextList(evidence.length ? evidence : ["尚未绑定来源"])),
      section("Validation", el("p", {}, run.validation ? (run.validation.valid ? `通过 · ${run.validation.evidenceCount ?? evidence.length} 条证据` : (run.validation.findings || []).join("、")) : "等待校验")),
    ],
  });
}

async function showEvidence(evidence) {
  if (evidence.sourceType === "query" || String(evidence.sourceKey).startsWith("query:")) {
    openContext({
      eyebrow: "QUERY EVIDENCE", title: evidence.sourceKey || "Governed query",
      content: [section("Locator", el("pre", { class: "context-code" }, JSON.stringify(evidence.locator || {}, null, 2))),
        section("Boundary", el("p", {}, "结果由注册指标、维度、日期范围和参数化筛选生成。这里展示公开查询范围，不展示内部 SQL。"))],
    });
    return;
  }
  const key = evidence.sourceKey;
  if (!key || key.startsWith("wiki:")) {
    openContext({ eyebrow: "WIKI EVIDENCE", title: evidence.sourcePath || "Wiki", content: section("Locator", el("p", {}, evidence.sourcePath || "wiki/")) });
    return;
  }
  openContext({ eyebrow: "SOURCE", title: "正在读取…", content: loading() });
  try {
    const [pageResult, sourceResult] = await Promise.all([
      api(`/api/wiki/pages/${encodeURIComponent(key)}`),
      api(`/api/wiki/pages/${encodeURIComponent(key)}/source`),
    ]);
    const page = pageResult.page; const source = sourceResult.source;
    openContext({
      eyebrow: "SOURCE LOCATOR", title: page.title,
      content: [
        section("Published page", el("p", {}, page.path), action("Open Wiki page", "button secondary", () => navigate(`/knowledge/wiki/${encodeURIComponent(page.key)}`))),
        section("Original source", el("p", {}, source.path), el("pre", { class: "context-code" }, source.content || "来源文件当前不可读取；页面保留了路径定位。")),
      ],
    });
  } catch (error) {
    openContext({ eyebrow: "SOURCE", title: "来源读取失败", content: errorState(error) });
  }
}

function clarificationBox(run) {
  const event = [...(run.events || [])].reverse().find((item) => item.type === "clarification.required");
  const clarification = event?.payload || run.plan?.clarification;
  if (run.status !== "needs_clarification" || !clarification) return null;
  const box = el("div", { class: "clarification-box" }, el("p", {}, clarification.prompt || "请选择后继续："));
  for (const option of clarification.options || []) {
    box.append(action(option.label, "button secondary", async (eventClick) => {
      eventClick.currentTarget.disabled = true;
      try {
        await api(`/api/runs/${run.id}/clarifications`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ optionId: option.id }),
        });
        toast("已应用选择，继续运行");
        renderRoute();
      } catch (error) { toast(error.message); eventClick.currentTarget.disabled = false; }
    }));
  }
  return box;
}

function followUpSuggestions(run) {
  if (!["completed", "failed"].includes(run.status)) return null;
  const context = run.contextAfter || run.contextBefore || {};
  const suggestions = [];
  const hasMetric = context.metrics?.length;
  const hasDimension = context.dimensions?.length;
  if (hasMetric && !hasDimension) suggestions.push({ label: "按地区拆分", question: "那按地区拆一下。" });
  if (hasMetric && ["data", "analysis"].includes(run.capability)) suggestions.push({ label: "为什么变化？", question: "为什么变化？" });
  if (hasMetric) suggestions.push({ label: "指标口径", question: "这个指标口径是什么？" });
  if (["data", "analysis"].includes(run.capability)) suggestions.push({ label: "近 30 天趋势", question: "近 30 天趋势怎么样？" });
  if (!suggestions.length) return null;
  return el("div", { class: "follow-up" }, el("small", {}, "继续追问"),
    suggestions.slice(0, 3).map((suggestion) => action(suggestion.label, "follow-up-chip", () => {
      const conversation = state.currentConversation;
      if (conversation) submitQuestion(conversation.id, suggestion.question);
    })));
}

function assistantMessage(message, run) {
  const trace = runTimeline(run);
  const details = el("details", { class: "run-summary", open: ACTIVE_RUN.has(run.status) },
    el("summary", {}, `Execution · ${run.plan?.skill || run.capability || "planning"}`), trace);
  const content = renderMarkdown(message.content || "");
  const card = el("article", { class: "message assistant", dataset: { runId: run.id } },
    el("div", { class: "message-avatar" }, "ML"),
    el("div", { class: "message-card" },
      el("header", { class: "message-meta" },
        el("div", {}, el("strong", {}, "MetricLore"), statusPill(run.status)),
        action("Open run ↗", "message-action", () => showRunContext(run))),
      content,
      clarificationBox(run),
      dataView(run.data),
      details,
      followUpSuggestions(run),
      el("div", { class: "message-tools" },
        (run.evidence || []).map((evidence) => action(`▣ ${evidence.sourcePath || evidence.sourceKey || "evidence"}`, "evidence-button", () => showEvidence(evidence))),
        action("Export .md", "message-action", () => download(`run-${run.id.slice(0, 8)}.md`, message.content || "", "text/markdown")),
        ACTIVE_RUN.has(run.status) ? action("Stop", "message-action", () => cancelRun(run.id)) : null,
        ["completed", "failed", "cancelled"].includes(run.status) ? action("Retry", "message-action", () => retryRun(run.userMessageId)) : null)));
  card._eventIds = new Set((run.events || []).map((event) => event.id));
  card._run = run;
  return card;
}

function appendTimelineEvent(card, event) {
  if (event.type === "answer.delta" && $(".run-timeline [data-event-type='answer.delta']", card)) return;
  const detail = eventDetail(event.type, event.payload || {});
  $(".run-timeline", card)?.append(el("li", { dataset: { eventId: event.id || "", eventType: event.type } },
    el("i"), el("div", {}, el("strong", {}, EVENT_LABELS[event.type] || event.type), detail ? el("small", {}, detail) : null)));
}

function streamStatus(type, current) {
  if (type === "run.started" || type === "plan.created") return "planning";
  if (["skill.started", "tool.started", "tool.completed", "evidence.added", "answer.delta"].includes(type)) return "running";
  if (type === "validation.completed") return "validating";
  if (type === "clarification.required") return "needs_clarification";
  if (type === "run.completed") return "completed";
  if (type === "run.failed") return "failed";
  if (type === "run.cancelled") return "cancelled";
  return current;
}

function attachRunStream(card, conversationId) {
  const run = card._run;
  if (!run?.eventsUrl || !ACTIVE_RUN.has(run.status) || state.streams.has(run.id)) return;
  const source = new EventSource(run.eventsUrl);
  state.streams.set(run.id, source);
  for (const type of RUN_EVENTS) {
    source.addEventListener(type, (message) => {
      if (card._eventIds.has(message.lastEventId)) return;
      card._eventIds.add(message.lastEventId);
      const data = JSON.parse(message.data);
      const event = { id: message.lastEventId, type, payload: data.payload || {}, sequence: data.sequence };
      run.events ||= []; run.events.push(event);
      run.status = streamStatus(type, run.status);
      const pill = $(".status-pill", card);
      if (pill) { pill.dataset.status = run.status; pill.textContent = run.status.replaceAll("_", " "); }
      if (type === "answer.delta") {
        const answer = $(".answer-prose", card);
        if (answer) answer.textContent += event.payload.delta || "";
      }
      appendTimelineEvent(card, event);
      if (TERMINAL_RUN_EVENTS.has(type)) {
        source.close(); state.streams.delete(run.id);
        if (parseRoute().path === `/ask/${conversationId}`) setTimeout(() => renderRoute(), 40);
      }
    });
  }
}

async function cancelRun(runId) {
  try { await api(`/api/runs/${runId}/cancel`, { method: "POST" }); toast("运行已停止"); renderRoute(); }
  catch (error) { toast(error.message); }
}

async function retryRun(messageId) {
  try { await api(`/api/messages/${messageId}/retry`, { method: "POST" }); toast("已创建新的运行"); renderRoute(); }
  catch (error) { toast(error.message); }
}

async function submitQuestion(conversationId, content) {
  const text = String(content || "").trim();
  if (!text) return;
  const submit = $("#ask-submit"); const input = $("#ask-input");
  if (submit) submit.disabled = true;
  try {
    await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ content: text }),
    });
    if (state.currentConversation?.title === "新分析") {
      api(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: text.slice(0, 42) }),
      }).then(loadRecentChats).catch(() => {});
    }
    if (input) input.value = "";
    await renderRoute();
  } catch (error) {
    toast(error.message);
    if (submit) submit.disabled = false;
  }
}

async function renderConversationRoute(conversationId, token) {
  const shell = el("div", { class: "page-shell conversation-shell" }, loading());
  $("#workspace").replaceChildren(shell);
  try {
    const result = await api(`/api/conversations/${encodeURIComponent(conversationId)}`);
    if (token !== state.viewToken) return;
    const conversation = result.conversation;
    state.currentConversation = conversation;
    const header = pageHeader("PERSISTENT THREAD", conversation.title, "消息、上下文、运行、工具与证据均保存在本地 SQLite。",
      [action("New analysis", "button secondary", () => createConversation())]);
    const messages = el("div", { class: "message-list", id: "message-list" });
    const runs = new Map(conversation.runs.map((run) => [run.id, run]));
    if (!conversation.messages.length) {
      messages.append(el("div", { class: "empty-conversation" }, el("span", { class: "signal-glyph" }, "⌁"),
        el("h2", {}, "What should we investigate?"),
        el("p", {}, "可以查询指标数值、继续追问维度拆分，也可以检查口径、血缘和 Wiki 证据。")));
    } else {
      for (const message of conversation.messages) {
        if (message.role === "user") {
          messages.append(el("article", { class: "message user" }, el("div", { class: "message-content" }, message.content), el("div", { class: "message-avatar" }, "YOU")));
        } else if (message.role === "assistant" && runs.has(message.runId)) {
          messages.append(assistantMessage(message, runs.get(message.runId)));
        }
      }
    }
    const form = el("form", { class: "composer", id: "ask-form" },
      el("textarea", { id: "ask-input", maxlength: "4000", placeholder: "追问数据、口径或分析，例如：那按地区拆一下…" }),
      el("button", { id: "ask-submit", class: "button primary", type: "submit" }, "Run  ↗"));
    form.addEventListener("submit", (event) => { event.preventDefault(); submitQuestion(conversation.id, $("#ask-input").value); });
    const input = $("#ask-input", form);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
    });
    shell.replaceChildren(header, scopeBar(conversation.context), messages,
      el("div", { class: "composer-wrap" }, form, el("small", { class: "composer-hint" }, "Enter 运行 · Shift + Enter 换行 · 公开 Trace 不包含模型私有思维链")));
    $$(".message.assistant", messages).forEach((card) => attachRunStream(card, conversation.id));
    messages.scrollTop = messages.scrollHeight;
    const latestRun = conversation.runs[0];
    if (latestRun) showRunContext(latestRun); else defaultContext("Conversation");
    await loadRecentChats();
    if (state.pendingQuestion) {
      const pending = state.pendingQuestion; state.pendingQuestion = null;
      $("#ask-input").value = pending;
      submitQuestion(conversation.id, pending);
    }
  } catch (error) {
    if (token === state.viewToken) shell.replaceChildren(errorState(error));
  }
}

function addSelectedFiles(files) {
  const existing = new Set(state.selectedFiles.map((file) => `${file.webkitRelativePath || file.name}:${file.size}`));
  for (const file of files) {
    const identity = `${file.webkitRelativePath || file.name}:${file.size}`;
    if (!existing.has(identity)) { state.selectedFiles.push(file); existing.add(identity); }
  }
}

function selectedFileStack(target) {
  target.replaceChildren();
  if (!state.selectedFiles.length) {
    target.append(el("div", { class: "empty-state" }, el("p", {}, "选择文件后，这里会显示待导入清单。")));
    return;
  }
  state.selectedFiles.forEach((file, index) => {
    const path = file.webkitRelativePath || file.name;
    const extension = file.name.split(".").pop() || "file";
    target.append(el("div", { class: "file-item" }, el("span", {}, extension),
      el("div", {}, el("strong", {}, path), el("small", {}, fmtBytes(file.size))),
      action("×", "message-action", () => { state.selectedFiles.splice(index, 1); selectedFileStack(target); })));
  });
}

async function startIngestion(form, button) {
  if (!state.selectedFiles.length) { toast("请先选择至少一个文件"); return; }
  button.disabled = true; button.textContent = "Uploading…";
  const data = new FormData();
  data.append("name", $("#job-name", form).value.trim() || `Wiki import · ${new Date().toLocaleDateString("zh-CN")}`);
  data.append("extractionMode", $('input[name="extraction-mode"]:checked', form).value);
  data.append("options", JSON.stringify({ preserveFolders: true }));
  data.append("paths", JSON.stringify(state.selectedFiles.map((file) => file.webkitRelativePath || file.name)));
  state.selectedFiles.forEach((file) => data.append("files", file, file.name));
  try {
    const result = await api("/api/knowledge/jobs", { method: "POST", body: data });
    state.selectedFiles = [];
    toast("导入任务已创建");
    navigate(`/knowledge/jobs/${encodeURIComponent(result.job.id)}`);
  } catch (error) {
    toast(error.message); button.disabled = false; button.textContent = "Start building  →";
  }
}

function jobTable(jobs) {
  if (!jobs.length) return emptyState("No imports yet", "添加文档后，任务状态与候选数量会显示在这里。", "⇧");
  return el("div", { class: "table-panel" }, el("table", { class: "work-table" },
    el("thead", {}, el("tr", {}, ["Job", "Status", "Files", "Candidates", "Created"].map((item) => el("th", {}, item)))),
    el("tbody", {}, jobs.map((job) => el("tr", {},
      el("td", {}, el("button", { class: "row-link", type: "button", onClick: () => navigate(`/knowledge/jobs/${encodeURIComponent(job.id)}`) },
        el("strong", {}, job.name), el("small", {}, job.id))),
      el("td", {}, statusPill(job.status)), el("td", {}, job.fileCount || job.files?.length || 0),
      el("td", {}, job.candidateCount || 0), el("td", {}, fmtDate(job.createdAt, true)))))));
}

async function renderBuilder(token) {
  const shell = el("div", { class: "page-shell wide" }, loading());
  $("#workspace").replaceChildren(shell);
  let jobs = [];
  try { jobs = (await api("/api/knowledge/jobs?limit=8")).jobs || []; } catch { /* builder remains available */ }
  if (token !== state.viewToken) return;
  const form = el("form", { class: "split-grid" });
  const filePicker = el("input", { class: "hidden-input", type: "file", multiple: true, accept: ".md,.markdown,.txt,.csv,.sql,.html,.htm,.pdf,.docx,.xlsx,.zip" });
  const folderPicker = el("input", { class: "hidden-input", type: "file", multiple: true, webkitdirectory: true });
  const stack = el("div", { class: "file-stack" });
  const zone = el("div", { class: "upload-zone", tabindex: "0" },
    el("span", { class: "upload-glyph" }, "⇧"), el("h2", {}, "Drop your knowledge here"),
    el("p", {}, "Markdown · TXT · CSV · SQL · HTML · PDF · DOCX · XLSX · ZIP"),
    el("p", {}, "最多 50 个文件，单文件 25 MB，单任务 100 MB"),
    el("div", { class: "upload-actions" },
      action("Choose files", "button primary", () => filePicker.click()),
      action("Choose folder", "button secondary", () => folderPicker.click())),
    filePicker, folderPicker);
  const handleFiles = (files) => { addSelectedFiles(files); selectedFileStack(stack); };
  filePicker.addEventListener("change", () => handleFiles(filePicker.files));
  folderPicker.addEventListener("change", () => handleFiles(folderPicker.files));
  ["dragenter", "dragover"].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.remove("dragging"); }));
  zone.addEventListener("drop", (event) => handleFiles(event.dataTransfer.files));
  zone.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") filePicker.click(); });

  const settings = el("div", { class: "panel panel-pad" },
    el("div", { class: "field" }, el("label", { for: "job-name" }, "Import name"),
      el("input", { id: "job-name", placeholder: "例如：电商指标词典 2026Q3" })),
    el("div", { class: "section-heading" }, el("h2", {}, "Extraction mode")),
    el("div", { class: "mode-grid" },
      el("label", { class: "mode-option" }, el("input", { type: "radio", name: "extraction-mode", value: "rules", checked: true }),
        el("strong", {}, "Local rules"), el("p", {}, "完全本地解析，适合结构化词典、Markdown frontmatter 与 SQL DDL。")),
      el("label", { class: "mode-option" }, el("input", { type: "radio", name: "extraction-mode", value: "llm_assisted" }),
        el("strong", {}, "LLM assisted"), el("p", {}, "先按本地规则处理，再调用已配置的兼容模型补充候选。"))),
    el("div", { id: "privacy-note", class: "privacy-note", hidden: true }, "LLM assisted 会把已解析的文本片段发送到 Settings 中配置的模型地址。请确认文档允许发送到该服务。"),
    el("div", { class: "section-heading" }, el("h2", {}, "Selected files"), el("small", { id: "selected-total" }, "")),
    stack,
    action("Start building  →", "button primary", null, { id: "start-ingestion", style: "margin-top:14px;width:100%" }));
  form.append(el("div", {}, zone), settings);
  form.addEventListener("submit", (event) => event.preventDefault());
  $$('input[name="extraction-mode"]', settings).forEach((input) => input.addEventListener("change", () => {
    $("#privacy-note", settings).hidden = $('input[name="extraction-mode"]:checked', settings).value !== "llm_assisted";
  }));
  $("#start-ingestion", settings).addEventListener("click", () => startIngestion(form, $("#start-ingestion", settings)));
  selectedFileStack(stack);

  shell.replaceChildren(pageHeader("KNOWLEDGE INGESTION", "Wiki Builder", "把一批文档转成可审核、可发布、可追溯的 LLM Wiki。"),
    form,
    el("div", { class: "section-heading" }, el("h2", {}, "Recent imports"), el("small", {}, `${jobs.length} jobs`)),
    jobTable(jobs));
  defaultContext("Wiki Builder", "上传后会依次完成解析、切分、实体抽取、本体校验和人工审核准备。");
}

const JOB_STAGES = [
  ["uploading", "Upload"], ["parsing", "Parse"], ["extracting", "Extract"], ["validating", "Validate"], ["awaiting_review", "Review"],
];

function jobPipeline(job) {
  const statusIndex = Math.max(0, JOB_STAGES.findIndex(([status]) => status === job.status));
  const terminal = ["completed", "publishing"].includes(job.status) ? JOB_STAGES.length : statusIndex;
  return el("div", { class: "job-pipeline" }, JOB_STAGES.map(([status, label], index) =>
    el("div", { class: `job-stage ${index < terminal ? "done" : ""} ${index === statusIndex && !["completed", "cancelled", "failed"].includes(job.status) ? "active" : ""}` },
      el("strong", {}, label), el("small", {}, status === "awaiting_review" ? "human gate" : status))));
}

function jobFileTable(files = []) {
  return el("div", { class: "table-panel" }, el("table", { class: "work-table" },
    el("thead", {}, el("tr", {}, ["File", "Type", "Size", "Status", "Diagnostic"].map((item) => el("th", {}, item)))),
    el("tbody", {}, files.map((file) => el("tr", {},
      el("td", {}, el("strong", {}, file.relative_path), el("small", {}, file.id)),
      el("td", {}, file.extension || file.media_type), el("td", {}, fmtBytes(file.size_bytes)),
      el("td", {}, statusPill(file.status)),
      el("td", {}, file.error_json ? JSON.parse(file.error_json).message || "failed" : "—"))))));
}

function appendJobEvent(log, type, payload = {}) {
  const detail = eventDetail(type, payload);
  log.append(el("p", {}, el("time", {}, new Date().toLocaleTimeString("zh-CN", { hour12: false })), EVENT_LABELS[type] || type, detail ? ` · ${detail}` : ""));
  log.scrollTop = log.scrollHeight;
}

async function jobAction(path, options = {}) {
  try { await api(path, options); toast("操作已提交"); renderRoute(); }
  catch (error) { toast(error.message); }
}

async function renderJob(jobId, token) {
  const shell = el("div", { class: "page-shell wide" }, loading());
  $("#workspace").replaceChildren(shell);
  try {
    const [jobResult, candidateResult] = await Promise.all([
      api(`/api/knowledge/jobs/${encodeURIComponent(jobId)}`),
      api(`/api/knowledge/jobs/${encodeURIComponent(jobId)}/candidates?limit=100`).catch(() => ({ candidates: [] })),
    ]);
    if (token !== state.viewToken) return;
    const job = jobResult.job; const candidates = candidateResult.candidates || [];
    const approved = candidates.filter((item) => item.status === "approved").length;
    const actions = [];
    if (job.candidateCount) actions.push(action("Review candidates", "button amber", () => navigate(`/knowledge/review?job=${encodeURIComponent(job.id)}`)));
    if (approved) actions.push(action(`Publish approved (${approved})`, "button primary", () => jobAction(`/api/knowledge/jobs/${job.id}/publish`, { method: "POST" })));
    if (["queued", "uploading", "parsing", "extracting", "validating"].includes(job.status)) {
      actions.push(action("Cancel", "button secondary", () => jobAction(`/api/knowledge/jobs/${job.id}/cancel`, { method: "POST" })));
    }
    if (job.status === "failed") actions.push(action("Retry failed", "button secondary", () => jobAction(`/api/knowledge/jobs/${job.id}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })));
    if (job.status === "completed") actions.push(action("Ask this Wiki  →", "button primary", () => createConversation()));

    const log = el("div", { class: "event-log", id: "job-event-log" });
    appendJobEvent(log, "job.status", { status: job.status });
    shell.replaceChildren(pageHeader("INGESTION JOB", job.name, `${job.id} · created ${fmtDate(job.createdAt, true)}`, actions),
      jobPipeline(job),
      el("section", { class: "stat-grid" },
        stat("STATUS", job.status), stat("FILES", job.fileCount || job.files.length, `${job.progress?.filesDone || 0} done`),
        stat("CANDIDATES", job.candidateCount || 0, `${approved} approved`), stat("TOTAL SIZE", fmtBytes(job.totalBytes))),
      el("div", { class: "split-grid" },
        el("section", {}, el("div", { class: "section-heading" }, el("h2", {}, "Files")), jobFileTable(job.files)),
        el("section", {}, el("div", { class: "section-heading" }, el("h2", {}, "Public event log")), log)));
    openContext({
      eyebrow: "INGESTION JOB", title: job.status,
      content: [section("Progress", el("p", {}, `${job.progress?.filesDone || 0} / ${job.progress?.filesTotal || job.fileCount || 0} files`),
        el("div", { class: "progress-track" }, el("i", { style: `width:${Math.min(100, ((job.progress?.filesDone || 0) / Math.max(job.progress?.filesTotal || job.fileCount || 1, 1)) * 100)}%` }))),
        section("Extraction", contextList([`Mode: ${job.extractionMode}`, `Candidates: ${job.candidateCount}`, `Failed files: ${job.progress?.filesFailed || 0}`])),
        job.error ? section("Diagnostic", el("pre", { class: "context-code" }, JSON.stringify(job.error, null, 2))) : null],
    });
    if (!["awaiting_review", "completed", "failed", "cancelled"].includes(job.status)) {
      const source = new EventSource(`/api/knowledge/jobs/${encodeURIComponent(job.id)}/events`);
      state.streams.set(`job:${job.id}`, source);
      JOB_EVENTS.forEach((type) => source.addEventListener(type, (message) => {
        const payload = JSON.parse(message.data); appendJobEvent(log, type, payload);
        if (["job.awaiting_review", "job.failed", "job.cancelled", "publish.completed", "publish.failed"].includes(type)) {
          source.close(); state.streams.delete(`job:${job.id}`); setTimeout(() => renderRoute(), 80);
        }
      }));
    }
  } catch (error) {
    if (token === state.viewToken) shell.replaceChildren(errorState(error));
  }
}

async function batchReviewCandidates(candidates, decision) {
  const selected = candidates.filter((candidate) => state.selectedCandidates.has(candidate.id));
  if (!selected.length) { toast("请先选择候选"); return; }
  try {
    const result = await api("/api/knowledge/candidates/batch-review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: selected.map((item) => ({ id: item.id, revision: item.revision })), decision }),
    });
    const failed = (result.results || []).filter((item) => !item.ok);
    toast(failed.length ? `${failed.length} 条处理失败，请刷新后重试` : `已${decision === "approve" ? "批准" : "驳回"} ${selected.length} 条`);
    state.selectedCandidates.clear(); renderRoute();
  } catch (error) { toast(error.message); }
}

async function renderReviewQueue(query, token) {
  const shell = el("div", { class: "page-shell wide" }, loading());
  $("#workspace").replaceChildren(shell);
  const jobId = query.get("job") || "";
  try {
    const [jobsResult, candidatesResult] = await Promise.all([
      api("/api/knowledge/jobs?limit=100"),
      api(`/api/knowledge/candidates?limit=100${jobId ? `&jobId=${encodeURIComponent(jobId)}` : ""}`),
    ]);
    if (token !== state.viewToken) return;
    const jobs = jobsResult.jobs || []; let candidates = candidatesResult.candidates || [];
    state.selectedCandidates.clear();
    const toolbar = el("div", { class: "toolbar" },
      el("div", { class: "field" }, el("span", {}, "Search"), el("input", { id: "candidate-search", placeholder: "标题、key 或来源文件" })),
      el("div", { class: "field" }, el("span", {}, "Job"), el("select", { id: "candidate-job" },
        el("option", { value: "" }, "All jobs"), jobs.map((job) => el("option", { value: job.id, selected: job.id === jobId }, job.name)))),
      el("div", { class: "field" }, el("span", {}, "Type"), el("select", { id: "candidate-type" },
        el("option", { value: "" }, "All types"), Object.keys(state.ontology?.schema?.entityTypes || {}).map((type) => el("option", { value: type }, type)))),
      el("div", { class: "field" }, el("span", {}, "Status"), el("select", { id: "candidate-status" },
        el("option", { value: "" }, "All statuses"), ["extracted", "needs_review", "approved", "rejected", "merged", "published"].map((status) => el("option", { value: status }, status)))),
      el("label", { class: "field" }, el("span", {}, "Conflict"), el("select", { id: "candidate-conflict" }, el("option", { value: "" }, "Any"), el("option", { value: "yes" }, "Conflicts only"))));
    const tableHost = el("div");
    const batch = el("div", { class: "batch-bar" }, el("span", { id: "selection-label" }, "0 selected"),
      el("div", { class: "batch-actions" },
        action("Approve", "button primary", () => batchReviewCandidates(candidates, "approve")),
        action("Reject", "button danger", () => batchReviewCandidates(candidates, "reject")),
        action("Publish approved", "button amber", async () => {
          const currentJob = $("#candidate-job").value;
          if (!currentJob) { toast("发布前请先选择一个任务"); return; }
          await jobAction(`/api/knowledge/jobs/${encodeURIComponent(currentJob)}/publish`, { method: "POST" });
        })));

    const draw = () => {
      const search = $("#candidate-search").value.trim().toLowerCase();
      const type = $("#candidate-type").value; const status = $("#candidate-status").value;
      const conflictOnly = $("#candidate-conflict").value === "yes";
      const visible = candidates.filter((candidate) => (!search || `${candidate.title} ${candidate.entityKey} ${candidate.sourcePath}`.toLowerCase().includes(search))
        && (!type || candidate.entityType === type) && (!status || candidate.status === status) && (!conflictOnly || candidate.conflict));
      const table = el("div", { class: "table-panel" }, el("table", { class: "work-table" },
        el("thead", {}, el("tr", {}, ["", "Candidate", "Type", "Source", "Status", "Validation"].map((item) => el("th", {}, item)))),
        el("tbody", {}, visible.map((candidate) => {
          const checkbox = el("input", { type: "checkbox", checked: state.selectedCandidates.has(candidate.id), "aria-label": `选择 ${candidate.title}` });
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) state.selectedCandidates.add(candidate.id); else state.selectedCandidates.delete(candidate.id);
            $("#selection-label").textContent = `${state.selectedCandidates.size} selected`;
          });
          return el("tr", {}, el("td", {}, checkbox),
            el("td", {}, el("button", { class: "row-link", type: "button", onClick: () => navigate(`/knowledge/review/${encodeURIComponent(candidate.id)}`) },
              el("strong", {}, candidate.title || "Untitled"), el("small", {}, candidate.entityKey || "key pending")),
              candidate.conflict ? el("span", { class: "conflict-tag" }, candidate.conflict.type) : null),
            el("td", {}, candidate.entityType), el("td", {}, candidate.sourcePath || "—"),
            el("td", {}, statusPill(candidate.status)),
            el("td", {}, candidate.validation?.valid && !candidate.relationErrors?.length ? "Pass" :
              el("ul", { class: "issue-list" }, [...(candidate.validation?.errors || []), ...(candidate.relationErrors || [])].slice(0, 3).map((issue) => el("li", {}, typeof issue === "string" ? issue : issue.message || JSON.stringify(issue))))));
        }))));
      tableHost.replaceChildren(visible.length ? table : emptyState("No candidates match", "调整筛选条件，或先在 Wiki Builder 创建一个导入任务。", "✓"));
    };
    toolbar.addEventListener("input", draw);
    $("#candidate-job", toolbar).addEventListener("change", (event) => {
      navigate(`/knowledge/review${event.target.value ? `?job=${encodeURIComponent(event.target.value)}` : ""}`);
    });
    shell.replaceChildren(pageHeader("HUMAN-IN-THE-LOOP", "Review Queue", "每个候选都保留来源、抽取方式、校验问题与冲突信息。"),
      toolbar, batch, tableHost);
    draw();
    openContext({
      eyebrow: "REVIEW GATE", title: "Why review?",
      content: [section("Publish policy", el("p", {}, "只有 approved 候选可以进入发布流程。发布后会写入 Wiki 文件、版本记录并热更新 FTS 与图谱索引。")),
        section("Current queue", contextList([`${candidates.length} candidates`, `${candidates.filter((item) => item.conflict).length} conflicts`, `${candidates.filter((item) => item.status === "approved").length} approved`]))],
    });
  } catch (error) {
    if (token === state.viewToken) shell.replaceChildren(errorState(error));
  }
}

async function renderCandidate(candidateId, token) {
  const shell = el("div", { class: "page-shell wide" }, loading());
  $("#workspace").replaceChildren(shell);
  try {
    const result = await api(`/api/knowledge/candidates/${encodeURIComponent(candidateId)}`);
    if (token !== state.viewToken) return;
    let candidate = result.candidate;
    const source = el("pre", { class: "source-preview" }, candidate.sourcePreview || "没有可显示的文本预览。");
    const editor = el("form", { class: "editor-panel form-grid" },
      el("div", { class: "field" }, el("label", { for: "edit-type" }, "Entity type"), el("select", { id: "edit-type" },
        Object.keys(state.ontology?.schema?.entityTypes || {}).map((type) => el("option", { value: type, selected: type === candidate.entityType }, type)))),
      el("div", { class: "field" }, el("label", { for: "edit-key" }, "Entity key"), el("input", { id: "edit-key", value: candidate.entityKey || "" })),
      el("div", { class: "field full" }, el("label", { for: "edit-title" }, "Title"), el("input", { id: "edit-title", value: candidate.title || "" })),
      el("div", { class: "field full" }, el("label", { for: "edit-definition" }, "Definition"), el("textarea", { id: "edit-definition" }, candidate.definition || "")),
      el("div", { class: "field full" }, el("label", { for: "edit-aliases" }, "Aliases"), el("input", { id: "edit-aliases", value: (candidate.aliases || []).join(", "), placeholder: "用逗号分隔" })),
      el("div", { class: "field full" }, el("label", { for: "edit-relations" }, "Relations (JSON)"), el("textarea", { id: "edit-relations" }, JSON.stringify(candidate.relations || {}, null, 2))),
      candidate.conflict ? el("div", { class: "field full" }, el("span", {}, "Merge target"), el("input", { id: "merge-target", value: candidate.conflict.existing?.key || "", placeholder: "existing entity key" })) : null,
      el("div", { class: "editor-actions field full" },
        action("Save draft", "button secondary", async () => {
          try {
            const relations = JSON.parse($("#edit-relations", editor).value || "{}");
            const updated = await api(`/api/knowledge/candidates/${candidate.id}`, {
              method: "PATCH", headers: { "content-type": "application/json" },
              body: JSON.stringify({ revision: candidate.revision, patch: {
                entity_key: $("#edit-key", editor).value.trim(), entity_type: $("#edit-type", editor).value,
                title: $("#edit-title", editor).value.trim(), definition: $("#edit-definition", editor).value.trim(),
                aliases: $("#edit-aliases", editor).value.split(",").map((item) => item.trim()).filter(Boolean), relations,
              } }),
            });
            candidate = updated.candidate; toast("草稿已保存"); renderRoute();
          } catch (error) { toast(error.message); }
        }),
        action("Approve", "button primary", () => reviewOne(candidate, "approve")),
        candidate.conflict ? action("Merge", "button amber", () => reviewOne(candidate, "merge", $("#merge-target", editor).value.trim())) : null,
        action("Reject", "button danger", () => reviewOne(candidate, "reject"))));
    editor.addEventListener("submit", (event) => event.preventDefault());
    shell.replaceChildren(pageHeader("CANDIDATE REVIEW", candidate.title || "Untitled candidate", `${candidate.sourcePath || "Unknown source"} · revision ${candidate.revision}`,
      [action("Back to queue", "button secondary", () => navigate(`/knowledge/review?job=${encodeURIComponent(candidate.jobId)}`))]),
      el("div", { class: "split-grid" },
        el("section", {}, el("div", { class: "section-heading" }, el("h2", {}, "Source preview"), el("small", {}, candidate.sourcePath || "")), source),
        el("section", {}, el("div", { class: "section-heading" }, el("h2", {}, "Candidate editor"), statusPill(candidate.status)), editor)));
    openContext({
      eyebrow: "VALIDATION", title: candidate.validation?.valid ? "Schema passed" : "Needs attention",
      content: [
        section("Extraction", contextList([`Method: ${candidate.extraction?.method || "rules"}`, `Revision: ${candidate.revision}`, `Source: ${candidate.sourcePath || "—"}`])),
        candidate.conflict ? section("Conflict", el("p", {}, `${candidate.conflict.type} · ${candidate.conflict.existing?.title || candidate.conflict.existing?.key}`)) : section("Conflict", el("p", {}, "No duplicate or protected-page conflict detected.")),
        section("Validation messages", contextList([...(candidate.validation?.errors || []), ...(candidate.relationErrors || [])].map((item) => typeof item === "string" ? item : item.message || JSON.stringify(item)).length
          ? [...(candidate.validation?.errors || []), ...(candidate.relationErrors || [])].map((item) => typeof item === "string" ? item : item.message || JSON.stringify(item))
          : ["All current checks passed"])),
      ],
    });
  } catch (error) {
    if (token === state.viewToken) shell.replaceChildren(errorState(error));
  }
}

async function reviewOne(candidate, decision, mergeTargetKey) {
  try {
    await api(`/api/knowledge/candidates/${candidate.id}/review`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: candidate.revision, decision, mergeTargetKey: mergeTargetKey || undefined }),
    });
    toast(`候选已${decision === "approve" ? "批准" : decision === "reject" ? "驳回" : "标记合并"}`);
    navigate(`/knowledge/review?job=${encodeURIComponent(candidate.jobId)}`);
  } catch (error) { toast(error.message); }
}

function wikiDirectory(pages, activeKey = null) {
  const search = el("input", { placeholder: "Search Wiki…", "aria-label": "搜索 Wiki" });
  const type = el("select", { "aria-label": "按类型筛选" },
    el("option", { value: "" }, "All entity types"),
    [...new Set(pages.map((page) => page.type))].sort().map((item) => el("option", { value: item }, item)));
  const list = el("div", { class: "wiki-page-list" });
  const draw = () => {
    const query = search.value.trim().toLowerCase(); const wantedType = type.value;
    const visible = pages.filter((page) => (!query || `${page.title} ${page.key} ${page.snippet}`.toLowerCase().includes(query)) && (!wantedType || page.type === wantedType));
    list.replaceChildren(...visible.map((page) => el("button", {
      class: `wiki-page-link ${page.key === activeKey ? "active" : ""}`, type: "button",
      onClick: () => navigate(`/knowledge/wiki/${encodeURIComponent(page.key)}`),
    }, el("strong", {}, page.title), el("small", {}, `${page.type} · ${page.status}`))));
  };
  search.addEventListener("input", draw); type.addEventListener("change", draw); draw();
  return el("aside", { class: "wiki-directory" }, search, type, list);
}

async function openPageSource(page, index = 0) {
  openContext({ eyebrow: "SOURCE", title: "Loading source…", content: loading() });
  try {
    const result = await api(`/api/wiki/pages/${encodeURIComponent(page.key)}/source?index=${index}`);
    const source = result.source;
    openContext({
      eyebrow: "SOURCE LOCATOR", title: page.title,
      content: [section("Path", el("p", {}, source.path), statusPill(source.available ? "verified" : "needs_review")),
        section("Content", el("pre", { class: "context-code" }, source.content || "路径已保留；当前来源文件不可读取。"))],
    });
  } catch (error) { openContext({ eyebrow: "SOURCE", title: "Failed", content: errorState(error) }); }
}

function showPageContext(page) {
  const outgoing = (page.outgoing || []).map((item) => `${item.relation} → ${item.entity.title}`);
  const incoming = (page.incoming || []).map((item) => `${item.entity.title} → ${item.relation}`);
  openContext({
    eyebrow: "WIKI PAGE", title: page.type,
    content: [
      section("Status & version", statusPill(page.status), el("p", {}, page.versions?.length ? `Latest v${page.versions[0].version} · ${fmtDate(page.versions[0].publishedAt)}` : "Repository page · no publication record")),
      section("Sources", contextList((page.sources || []).length ? page.sources : [page.path])),
      section("Outgoing", contextList(outgoing.length ? outgoing : ["No outgoing relations"])),
      section("Incoming", contextList(incoming.length ? incoming : ["No incoming references"])),
    ],
  });
}

async function renderWikiExplorer(activeKey, token) {
  const shell = el("div", { class: "page-shell wide" }, loading());
  $("#workspace").replaceChildren(shell);
  try {
    const pagesResult = await api("/api/wiki/pages?limit=100");
    const pages = pagesResult.pages || [];
    let page = null;
    if (activeKey) page = (await api(`/api/wiki/pages/${encodeURIComponent(activeKey)}`)).page;
    if (token !== state.viewToken) return;
    const documentView = page ? el("article", { class: "wiki-document" },
      el("small", { class: "eyebrow" }, `${page.type} · ${page.status}`), el("h1", {}, page.title),
      el("span", { class: "doc-path" }, page.path),
      el("div", { class: "message-tools" }, (page.sources || []).map((sourcePath, index) =>
        action(`▣ ${sourcePath}`, "evidence-button", () => openPageSource(page, index)))),
      renderMarkdown(page.content, "wiki-body"),
      el("div", { class: "relation-row" }, [
        ...(page.outgoing || []).map((item) => action(`${item.relation} → ${item.entity.title}`, "relation-chip", () => navigate(`/knowledge/wiki/${encodeURIComponent(item.entity.key)}`))),
        ...(page.incoming || []).map((item) => action(`${item.entity.title} → ${item.relation}`, "relation-chip", () => navigate(`/knowledge/wiki/${encodeURIComponent(item.entity.key)}`))),
      ])) : emptyState("Explore published knowledge", "选择左侧页面，查看正文、来源、版本和双向本体关系。", "▤");
    shell.replaceChildren(pageHeader("PUBLISHED KNOWLEDGE", "Wiki Explorer", `${pagesResult.total} pages indexed locally`,
      [action("Build Wiki", "button secondary", () => navigate("/knowledge/builder")),
        action("Open graph", "button primary", () => navigate(`/knowledge/ontology${page?.entityKey ? `?focus=${encodeURIComponent(page.entityKey)}` : ""}`))]),
      el("div", { class: "wiki-layout" }, wikiDirectory(pages, page?.key), documentView));
    if (page) showPageContext(page); else defaultContext("Wiki Explorer");
  } catch (error) {
    if (token === state.viewToken) shell.replaceChildren(errorState(error));
  }
}

function layoutGraph(nodes) {
  const groups = new Map();
  nodes.forEach((node) => {
    const bucket = groups.get(node.type) || [];
    bucket.push(node); groups.set(node.type, bucket);
  });
  const positions = new Map();
  [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([type, items], groupIndex) => {
    const blockX = 110 + (groupIndex % 3) * 420;
    const blockY = 95 + Math.floor(groupIndex / 3) * 245;
    items.sort((a, b) => a.title.localeCompare(b.title)).forEach((node, index) => {
      positions.set(node.key, { x: blockX + (index % 2) * 175, y: blockY + Math.floor(index / 2) * 62, type });
    });
  });
  return positions;
}

function drawOntologySvg(svg, graph, filterType = "", focusKey = "") {
  const nodes = graph.nodes.filter((node) => !filterType || node.type === filterType);
  const nodeKeys = new Set(nodes.map((node) => node.key));
  const edges = graph.edges.filter((edge) => nodeKeys.has(edge.source) && nodeKeys.has(edge.target));
  const positions = layoutGraph(nodes);
  svg.replaceChildren();
  const defs = svgEl("defs");
  const marker = svgEl("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse" });
  marker.append(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#59635a" })); defs.append(marker); svg.append(defs);
  const edgeLayer = svgEl("g");
  edges.forEach((edge) => {
    const from = positions.get(edge.source); const to = positions.get(edge.target);
    const line = svgEl("line", { class: "graph-edge", x1: from.x, y1: from.y, x2: to.x, y2: to.y, "marker-end": "url(#arrow)" });
    line.append(svgEl("title", {}, edge.relation)); edgeLayer.append(line);
  });
  const nodeLayer = svgEl("g");
  nodes.forEach((node) => {
    const point = positions.get(node.key);
    const group = svgEl("g", { class: `graph-node ${node.key === focusKey ? "focus" : ""}`, transform: `translate(${point.x} ${point.y})`, tabindex: 0, role: "button", "aria-label": `${node.type} ${node.title}` });
    group.append(svgEl("rect", { x: -70, y: -21, width: 140, height: 42, rx: 1, style: `stroke:${node.key === focusKey ? "#b9f227" : TYPE_COLORS[node.type] || "#7d897e"}` }),
      svgEl("text", { x: -59, y: -2 }, node.title.length > 12 ? `${node.title.slice(0, 12)}…` : node.title),
      svgEl("text", { class: "type", x: -59, y: 12 }, node.type));
    const open = () => showGraphNode(node);
    group.addEventListener("click", open);
    group.addEventListener("dblclick", () => navigate(`/knowledge/wiki/${encodeURIComponent(node.key)}`));
    group.addEventListener("keydown", (event) => { if (event.key === "Enter") open(); });
    nodeLayer.append(group);
  });
  svg.append(edgeLayer, nodeLayer);
  return { nodeCount: nodes.length, edgeCount: edges.length };
}

function enableGraphPanZoom(svg) {
  const view = { x: 0, y: 0, width: 1300, height: 820 };
  const apply = () => svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.width} ${view.height}`);
  let drag = null;
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 1.12 : .88;
    const rect = svg.getBoundingClientRect();
    const mx = view.x + (event.clientX - rect.left) / rect.width * view.width;
    const my = view.y + (event.clientY - rect.top) / rect.height * view.height;
    view.width = Math.min(2200, Math.max(380, view.width * factor));
    view.height = view.width * (820 / 1300);
    view.x = mx - (event.clientX - rect.left) / rect.width * view.width;
    view.y = my - (event.clientY - rect.top) / rect.height * view.height;
    apply();
  }, { passive: false });
  svg.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
    svg.setPointerCapture(event.pointerId); svg.classList.add("dragging");
  });
  svg.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const rect = svg.getBoundingClientRect();
    view.x = drag.vx - (event.clientX - drag.x) / rect.width * view.width;
    view.y = drag.vy - (event.clientY - drag.y) / rect.height * view.height;
    apply();
  });
  const end = () => { drag = null; svg.classList.remove("dragging"); };
  svg.addEventListener("pointerup", end); svg.addEventListener("pointercancel", end);
  apply();
  return () => { Object.assign(view, { x: 0, y: 0, width: 1300, height: 820 }); apply(); };
}

async function showGraphNode(node) {
  openContext({ eyebrow: "ONTOLOGY NODE", title: node.title, content: loading() });
  try {
    const page = (await api(`/api/wiki/pages/${encodeURIComponent(node.key)}`)).page;
    const relations = [
      ...(page.outgoing || []).map((item) => `${item.relation} → ${item.entity.title}`),
      ...(page.incoming || []).map((item) => `${item.entity.title} → ${item.relation}`),
    ];
    openContext({
      eyebrow: "ONTOLOGY NODE", title: page.title,
      content: [section("Type", statusPill(page.status), el("p", {}, page.type)),
        section("Definition", el("p", {}, page.content.slice(0, 500))),
        section("Relations", contextList(relations.length ? relations : ["No connected nodes"])),
        section("Actions", action("Open Wiki page", "button primary", () => navigate(`/knowledge/wiki/${encodeURIComponent(page.key)}`)))],
    });
  } catch (error) { openContext({ eyebrow: "ONTOLOGY NODE", title: "Failed", content: errorState(error) }); }
}

async function renderOntologyGraph(query, token) {
  const shell = el("div", { class: "page-shell wide" }, loading());
  $("#workspace").replaceChildren(shell);
  const focus = query.get("focus") || ""; const depth = query.get("depth") || "2";
  try {
    const [fullResult, graphResult] = await Promise.all([
      api("/api/wiki/graph"),
      focus ? api(`/api/wiki/graph?focus=${encodeURIComponent(focus)}&depth=${encodeURIComponent(depth)}`) : api("/api/wiki/graph"),
    ]);
    if (token !== state.viewToken) return;
    const full = fullResult.graph; const graph = graphResult.graph;
    const svg = svgEl("svg", { role: "img", "aria-label": "MetricLore ontology graph" });
    const resetView = enableGraphPanZoom(svg);
    const typeSelect = el("select", { "aria-label": "实体类型" }, el("option", { value: "" }, "All entity types"),
      [...new Set(graph.nodes.map((node) => node.type))].sort().map((type) => el("option", { value: type }, type)));
    const search = el("select", { "aria-label": "聚焦实体" }, el("option", { value: "" }, "Focus a node…"),
      full.nodes.slice().sort((a, b) => a.title.localeCompare(b.title)).map((node) => el("option", { value: node.key, selected: node.key === focus }, `${node.title} · ${node.type}`)));
    const depthSelect = el("select", { "aria-label": "关系深度" }, [1, 2, 3].map((item) => el("option", { value: item, selected: String(item) === String(depth) }, `Depth ${item}`)));
    const count = el("span");
    const draw = () => {
      const summary = drawOntologySvg(svg, graph, typeSelect.value, focus);
      count.textContent = `${summary.nodeCount} nodes · ${summary.edgeCount} edges`;
    };
    typeSelect.addEventListener("change", draw);
    search.addEventListener("change", () => navigate(`/knowledge/ontology${search.value ? `?focus=${encodeURIComponent(search.value)}&depth=${depthSelect.value}` : ""}`));
    depthSelect.addEventListener("change", () => navigate(`/knowledge/ontology${focus ? `?focus=${encodeURIComponent(focus)}&depth=${depthSelect.value}` : ""}`));
    const graphShell = el("div", { class: "graph-shell" }, el("div", { class: "graph-toolbar" },
      search, typeSelect, depthSelect, action("Fit", "", resetView),
      focus ? action("Clear focus", "", () => navigate("/knowledge/ontology")) : null), svg,
      el("div", { class: "graph-legend" }, Object.entries(TYPE_COLORS).map(([type, color]) => el("span", {}, el("i", { style: `background:${color}` }), type))));
    draw();
    shell.replaceChildren(pageHeader("KNOWLEDGE GRAPH", "Ontology", "筛选实体类型、聚焦一至三跳子图；单击检查节点，双击打开 Wiki 页面。",
      [count, action("Wiki Explorer", "button secondary", () => navigate("/knowledge/wiki"))]), graphShell);
    if (focus) {
      const node = full.nodes.find((item) => item.key === focus);
      if (node) showGraphNode(node);
    } else defaultContext("Ontology", "选择节点查看定义、来源和双向关系。滚轮缩放，拖拽画布，双击打开 Wiki。");
  } catch (error) {
    if (token === state.viewToken) shell.replaceChildren(errorState(error));
  }
}

async function showMetricContext(key, metric) {
  openContext({ eyebrow: "METRIC", title: metric.label, content: loading() });
  let page = null;
  try { page = (await api(`/api/wiki/pages/${encodeURIComponent(`metric-${key.replaceAll("_", "-")}`)}`)).page; } catch { /* 目录信息仍可展示 */ }
  const formula = metric.type === "atomic" ? `${metric.aggregation}(${metric.column})` : `${metric.numerator} / ${metric.denominator}${metric.scale ? ` × ${metric.scale}` : ""}`;
  openContext({
    eyebrow: "GOVERNED METRIC", title: metric.label,
    content: [section("Definition", el("p", {}, metric.description)),
      section("Semantic mapping", contextList([`Key: ${key}`, `Type: ${metric.type}`, `Formula: ${formula}`, `Format: ${metric.format}`])),
      page ? section("Ontology links", contextList(Object.entries(page.relations || {}).flatMap(([relation, targets]) => targets.map((target) => `${relation} → ${target}`)))) : null,
      section("Try it", action("Ask about this metric", "button primary", () => createConversation(`近 14 天${metric.label}趋势怎么样？`)))],
  });
}

async function renderMetrics(token) {
  const shell = el("div", { class: "page-shell" });
  $("#workspace").replaceChildren(shell);
  if (token !== state.viewToken) return;
  const metrics = Object.entries(state.catalog?.metrics || {});
  const search = el("input", { placeholder: "搜索指标、别名或物理字段", "aria-label": "搜索指标" });
  const list = el("div", { class: "metric-list" });
  const draw = () => {
    const query = search.value.trim().toLowerCase();
    const visible = metrics.filter(([key, metric]) => `${key} ${metric.label} ${metric.description} ${(metric.aliases || []).join(" ")} ${metric.column || ""}`.toLowerCase().includes(query));
    list.replaceChildren(...visible.map(([key, metric]) => {
      const formula = metric.type === "atomic" ? `${metric.aggregation}(${metric.column})` : `${metric.numerator} / ${metric.denominator}`;
      return el("button", { class: "metric-row", type: "button", onClick: () => showMetricContext(key, metric) },
        el("span", {}, el("strong", {}, metric.label), el("small", {}, key)),
        el("span", {}, metric.description), el("code", {}, formula), statusPill("verified"));
    }));
  };
  search.addEventListener("input", draw); draw();
  shell.append(pageHeader("SEMANTIC CATALOG", "Metrics", "注册指标是 Agent 查询数据的唯一入口；每个指标都有稳定 key、定义、公式和格式。"),
    el("div", { class: "toolbar", style: "grid-template-columns:1fr auto" },
      el("div", { class: "field" }, el("span", {}, "Search"), search),
      action("Ask data", "button primary", () => createConversation())),
    list);
  defaultContext("Metrics", "选择指标查看公式、物理映射、本体关系和示例问题。");
}

function mappingCard(kind, key, item) {
  const values = kind === "Metric"
    ? { key, type: item.type, mapping: item.type === "atomic" ? `${item.aggregation}(${item.column})` : `${item.numerator} / ${item.denominator}`, format: item.format }
    : { key, type: item.type, column: item.column, aliases: (item.aliases || []).join("、") || "—" };
  return el("article", { class: "mapping-card" }, el("small", { class: "eyebrow" }, kind), el("h3", {}, item.label),
    el("dl", {}, Object.entries(values).flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value || "—")])));
}

async function renderSemantic(token) {
  const shell = el("div", { class: "page-shell" });
  $("#workspace").replaceChildren(shell);
  if (token !== state.viewToken) return;
  const model = state.catalog;
  shell.append(pageHeader("GOVERNED MAPPING", "Semantic Model", "把业务指标和维度映射到受控物理字段；运行时只接受白名单对象与参数化筛选。"),
    el("section", { class: "stat-grid" }, stat("MODEL", model.model), stat("FACT TABLE", model.table), stat("TIME COLUMN", model.timeColumn), stat("GRAINS", model.timeGrains.join(" · "))),
    el("div", { class: "section-heading" }, el("h2", {}, "Registered metrics"), el("small", {}, Object.keys(model.metrics).length)),
    el("div", { class: "mapping-grid" }, Object.entries(model.metrics).map(([key, item]) => mappingCard("Metric", key, item))),
    el("div", { class: "section-heading" }, el("h2", {}, "Registered dimensions"), el("small", {}, Object.keys(model.dimensions).length)),
    el("div", { class: "mapping-grid" }, Object.entries(model.dimensions).map(([key, item]) => mappingCard("Dimension", key, item))));
  openContext({
    eyebrow: "QUERY BOUNDARY", title: "Controlled by code",
    content: [section("Accepted input", contextList(["Registered metric keys", "Registered dimensions", "Date range and grain", "Bound filter values"])),
      section("Runtime guarantee", el("p", {}, "语义层负责聚合表达式、标识符白名单、参数绑定、分组和结果上限。Agent 工具接收业务对象，不接收任意 SQL。"))],
  });
}

async function renderEvaluation(token) {
  const shell = el("div", { class: "page-shell" }, loading());
  $("#workspace").replaceChildren(shell);
  try {
    const { report, command } = await api("/api/evaluation");
    if (token !== state.viewToken) return;
    if (!report) {
      shell.replaceChildren(pageHeader("REGRESSION QUALITY", "Evaluate", "评测报告只读取本地最新一次运行结果。"),
        emptyState("No report yet", `运行 ${command} 生成首份回归报告。`, "◇"));
      return;
    }
    const groups = Object.entries(report.groups || {});
    shell.replaceChildren(pageHeader("REGRESSION QUALITY", "Evaluate", `Latest run · ${fmtDate(report.generatedAt, true)}`,
      [action("Run via CLI: npm run eval", "button secondary", () => toast("请在项目终端运行 npm run eval"))]),
      el("section", { class: "stat-grid" },
        stat("CASES", report.caseCount, `× ${report.repeatedRuns} runs`),
        stat("PASSED", report.passed, `${Math.round(report.passRate * 100)}% pass rate`),
        stat("FAILED", report.failed), stat("CONSISTENCY", `${Math.round(report.consistencyRate * 100)}%`, "public result agreement")),
      el("div", { class: "section-heading" }, el("h2", {}, "Capability coverage"), el("small", {}, "routing · tools · status · forbidden claims")),
      el("div", { class: "mapping-grid" }, groups.map(([group, value]) =>
        el("article", { class: "mapping-card" }, el("small", { class: "eyebrow" }, group), el("h3", {}, `${value.passed} / ${value.total}`),
          el("div", { class: "progress-track" }, el("i", { style: `width:${value.total ? value.passed / value.total * 100 : 0}%` }))))));
    openContext({
      eyebrow: "EVALUATION", title: "What is scored?",
      content: [section("Checks", contextList(["Skill routing", "Required tool coverage", "Run status", "Forbidden wording", "Repeat consistency"])),
        section("Data boundary", el("p", {}, "公开评测问题与内置数据均为合成内容；数值准确性另由语义层集成测试覆盖。"))],
    });
  } catch (error) {
    if (token === state.viewToken) shell.replaceChildren(errorState(error));
  }
}

async function renderSettings(token) {
  const shell = el("div", { class: "page-shell" });
  $("#workspace").replaceChildren(shell);
  if (token !== state.viewToken) return;
  const mode = state.health?.llmConfigured ? "OpenAI-compatible LLM" : "Deterministic local runtime";
  shell.append(pageHeader("LOCAL WORKSPACE", "Settings", "查看当前运行模式、数据源、知识索引与本地存储边界。"),
    el("div", { class: "mapping-grid" },
      el("article", { class: "mapping-card" }, el("small", { class: "eyebrow" }, "AGENT"), el("h3", {}, mode),
        el("dl", {}, el("dt", {}, "LLM"), el("dd", {}, state.health?.llmConfigured ? "Configured" : "Optional · not configured"),
          el("dt", {}, "Skills"), el("dd", {}, (state.health?.skills || []).join(", ")), el("dt", {}, "Fallback"), el("dd", {}, "Deterministic governed path"))),
      el("article", { class: "mapping-card" }, el("small", { class: "eyebrow" }, "DATA"), el("h3", {}, state.catalog?.label),
        el("dl", {}, el("dt", {}, "Database"), el("dd", {}, "SQLite"), el("dt", {}, "Model"), el("dd", {}, state.catalog?.model),
          el("dt", {}, "Fact table"), el("dd", {}, state.catalog?.table), el("dt", {}, "Dataset"), el("dd", {}, "Synthetic sample data"))),
      el("article", { class: "mapping-card" }, el("small", { class: "eyebrow" }, "KNOWLEDGE"), el("h3", {}, "Local LLM Wiki"),
        el("dl", {}, el("dt", {}, "Pages"), el("dd", {}, state.health?.wikiDocuments), el("dt", {}, "Entities"), el("dd", {}, state.health?.wikiEntities),
          el("dt", {}, "Search"), el("dd", {}, "SQLite FTS5"), el("dt", {}, "Graph"), el("dd", {}, "Ontology relations"))),
      el("article", { class: "mapping-card" }, el("small", { class: "eyebrow" }, "UPLOAD LIMITS"), el("h3", {}, "Wiki Builder"),
        el("dl", {}, el("dt", {}, "Files"), el("dd", {}, "50 per job"), el("dt", {}, "Job size"), el("dd", {}, "100 MB"),
          el("dt", {}, "File size"), el("dd", {}, "25 MB"), el("dt", {}, "ZIP expanded"), el("dd", {}, "250 MB")))));
  openContext({
    eyebrow: "PRIVACY", title: "Local by default",
    content: [section("Storage", el("p", {}, "会话、运行、候选、审核记录和版本保存在本地 SQLite；上传文件保存在本地任务目录。")),
      section("Model traffic", el("p", {}, state.health?.llmConfigured ? "LLM 模式已配置。模型调用使用环境变量中的兼容端点。" : "当前没有配置模型密钥，问答与规则抽取使用本地确定性路径。"))],
  });
}

async function renderRoute() {
  const { path, query } = parseRoute();
  const token = ++state.viewToken;
  closeStreams(); closePanels(); markActive(path);
  $("#workspace").replaceChildren(loading());
  $("#workspace").scrollTop = 0;
  try {
    let match;
    if (path === "/ask") await renderAskHome(token);
    else if ((match = path.match(/^\/ask\/([^/]+)$/))) await renderConversationRoute(decodeURIComponent(match[1]), token);
    else if (path === "/knowledge/builder") await renderBuilder(token);
    else if ((match = path.match(/^\/knowledge\/jobs\/([^/]+)$/))) await renderJob(decodeURIComponent(match[1]), token);
    else if (path === "/knowledge/review") await renderReviewQueue(query, token);
    else if ((match = path.match(/^\/knowledge\/review\/([^/]+)$/))) await renderCandidate(decodeURIComponent(match[1]), token);
    else if (path === "/knowledge/wiki") await renderWikiExplorer(null, token);
    else if ((match = path.match(/^\/knowledge\/wiki\/([^/]+)$/))) await renderWikiExplorer(decodeURIComponent(match[1]), token);
    else if (path === "/knowledge/ontology") await renderOntologyGraph(query, token);
    else if (path === "/data/metrics") await renderMetrics(token);
    else if (path === "/data/semantic") await renderSemantic(token);
    else if (path === "/evaluate") await renderEvaluation(token);
    else if (path === "/settings") await renderSettings(token);
    else navigate("/ask");
  } catch (error) {
    if (token === state.viewToken) $("#workspace").replaceChildren(el("div", { class: "page-shell" }, errorState(error)));
  }
  $("#workspace").focus({ preventScroll: true });
}

async function updateReviewBadge() {
  try {
    const result = await api("/api/knowledge/candidates?limit=100");
    const count = (result.candidates || []).filter((item) => ["extracted", "needs_review"].includes(item.status)).length;
    const badge = $("#review-count"); badge.textContent = count; badge.hidden = count === 0;
  } catch { $("#review-count").hidden = true; }
}

async function bootstrap() {
  try {
    const [health, catalog, ontology, skills] = await Promise.all([
      api("/api/health"), api("/api/catalog"), api("/api/ontology"), api("/api/skills"),
    ]);
    Object.assign(state, { health, catalog, ontology, skills });
    $("#health-label").textContent = `${health.llmConfigured ? "LLM" : "Local"} · ${health.wikiDocuments} pages`;
    $(".service-state").classList.remove("offline");
  } catch (error) {
    $(".service-state").classList.add("offline");
    $("#health-label").textContent = "Service unavailable";
    toast(error.message);
  }
  await Promise.all([loadRecentChats(), updateReviewBadge()]);
  renderRoute();
}

$("#new-chat").addEventListener("click", () => createConversation());
$("#refresh-chats").addEventListener("click", loadRecentChats);
$("#open-nav").addEventListener("click", () => document.body.classList.add("nav-open"));
$("#open-context").addEventListener("click", () => document.body.classList.add("context-open"));
$("#close-context").addEventListener("click", () => document.body.classList.remove("context-open"));
$("#screen-overlay").addEventListener("click", closePanels);
$("#nav-rail").addEventListener("click", (event) => { if (event.target.closest("a")) document.body.classList.remove("nav-open"); });
window.addEventListener("hashchange", renderRoute);
window.addEventListener("beforeunload", closeStreams);

bootstrap();
