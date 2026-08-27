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
const STATUS_LABELS = {
  completed: "已完成", verified: "已验证", approved: "已批准", published: "已发布",
  running: "运行中", planning: "规划中", queued: "排队中", validating: "校验中",
  parsing: "解析中", extracting: "抽取中", publishing: "发布中",
  needs_review: "待审核", awaiting_review: "待审核", needs_clarification: "待澄清",
  failed: "失败", cancelled: "已取消", rejected: "已驳回",
  extracted: "已抽取", merged: "已合并", accepted: "已接收", parsed: "已解析",
  streaming: "生成中", pending: "待处理", active: "进行中", archived: "已归档", unknown: "未知",
};
function statusText(status = "unknown") {
  return STATUS_LABELS[status] || String(status).replaceAll("_", " ");
}

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
  return el("span", { class: "status-pill", "data-status": status }, statusText(status));
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

function openContext({ eyebrow = "上下文", title = "详情", content = [] }) {
  $("#context-eyebrow").textContent = eyebrow;
  $("#context-title").textContent = title;
  $("#context-body").replaceChildren(...(Array.isArray(content) ? content : [content]));
  // 上下文面板只属于 Ask。其它路由可以预填详情，但不能在小屏幕触发一个不可见的遮罩层。
  if ($("#stage")?.classList.contains("has-context") && matchMedia("(max-width: 1180px)").matches) {
    document.body.classList.add("context-open");
  }
}

function defaultContext(title = "工作区", copy = "选择执行轨迹、证据、实体或文件，查看与当前任务相关的细节。") {
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
    el("small", { class: "eyebrow" }, "基于本体与语义层的数据智能体"),
    el("h1", {}, "问数据，看清每一步"),
    el("p", {}, "从业务问题出发，沿语义层、Skill、工具与知识证据完成问数和分析。每次运行都留下可复核的公开轨迹。"),
    el("div", { class: "hero-actions" },
      action("开始分析 →", "button primary", () => createConversation()),
      action("构建知识库", "button secondary", () => navigate("/knowledge/builder"))));
  const side = el("div", { class: "hero-side" },
    el("button", { class: "path-card", type: "button", onClick: () => createConversation("近 14 天收入趋势怎么样？") },
      el("span", {}, "01"), el("h2", {}, "体验示例数据"), el("p", {}, "使用内置合成数据体验多轮问数、分析与证据追踪。")),
    el("button", { class: "path-card amber", type: "button", onClick: () => navigate("/knowledge/builder") },
      el("span", {}, "02"), el("h2", {}, "构建知识库"), el("p", {}, "导入文件，审核候选实体，发布为 Agent 可检索的本体知识。")));
  hero.append(lead, side);

  const mode = state.health?.llmConfigured ? "LLM" : "确定性模式";
  shell.append(hero, el("section", { class: "stat-grid" },
    stat("运行模式", mode, state.health?.llmConfigured ? "已连接模型" : "本地受治理路径"),
    stat("知识页面", state.health?.wikiDocuments ?? "—", "本地索引"),
    stat("实体", state.health?.wikiEntities ?? "—", "本体节点"),
    stat("最近任务", jobs.length, jobs[0] ? `最近 · ${statusText(jobs[0].status)}` : "可开始导入")));

  const samples = [
    ["数据", "近 14 天收入趋势怎么样？"], ["分析", "那按地区拆一下。"],
    ["口径", "客单价的口径是什么？"], ["知识", "语义层为什么限制任意 SQL？"],
  ];
  shell.append(el("div", { class: "section-heading" }, el("h2", {}, "从一个真实任务开始"), el("small", {}, "点击一次即可创建持久会话")),
    el("div", { class: "sample-grid" }, samples.map(([kind, question]) =>
      el("button", { class: "sample-card", type: "button", onClick: () => createConversation(question) },
        el("small", {}, kind), el("p", {}, question)))));

  defaultContext("问答", "首页展示两条完整路径：直接体验问数，或先构建自己的知识库。");
}

function scopeBar(context = {}) {
  const bar = el("div", { class: "scope-bar" }, el("strong", {}, "当前范围"));
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
    eyebrow: "会话范围", title: "当前上下文",
    content: [
      section("指标", contextList(metrics.map((key) => state.catalog?.metrics?.[key]?.label || key).length ? metrics.map((key) => state.catalog?.metrics?.[key]?.label || key) : ["尚未选择"])),
      section("维度与筛选", contextList([
        ...dimensions.map((key) => state.catalog?.dimensions?.[key]?.label || key),
        ...Object.entries(filters).map(([key, value]) => `${key}: ${[].concat(value).join("、")}`),
      ].length ? [...dimensions.map((key) => state.catalog?.dimensions?.[key]?.label || key), ...Object.entries(filters).map(([key, value]) => `${key}: ${[].concat(value).join("、")}`)] : ["尚未选择"])),
      section("时间范围", el("p", {}, context.timeRange ? `${context.timeRange.startDate} 至 ${context.timeRange.endDate}` : "由问题或默认范围确定")),
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
    el("div", { class: "data-view-header" }, el("strong", {}, `数据视图 · ${rows.length} 行`), el("small", {}, numeric || "结果"),
      action("导出 CSV", "message-action", () => download("metriclore-data.csv", rowsToCsv(data), "text/csv"))));
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
        const changeSort = () => { if (sort.column === column) sort.direction *= -1; else { sort.column = column; sort.direction = 1; } renderTable(); };
        head.addEventListener("click", changeSort);
        head.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); changeSort(); }
        });
        return head;
      }))),
      el("tbody", {}, sorted.slice(0, 50).map((row) => el("tr", {}, columns.map((column) => el("td", {}, row[column] ?? "—")))))));
  };
  renderTable();
  view.append(el("details", {}, el("summary", { class: "text-button" }, "查看数据表"), tableHost));
  return view;
}

function showRunContext(run) {
  const tools = (run.toolCalls || []).map((call) => `${call.sequence}. ${call.skillName || "skill"} → ${call.toolName} · ${statusText(call.status)}`);
  const evidence = (run.evidence || []).map((item) => item.sourceKey || item.sourcePath || item.sourceType);
  openContext({
    eyebrow: "Agent 运行", title: run.plan?.skill || run.capability || "运行",
    content: [
      section("目标", el("p", {}, run.plan?.goal || "等待计划生成")),
      section("状态", statusPill(run.status)),
      section("已用范围", el("pre", { class: "context-code" }, JSON.stringify(run.contextAfter || run.contextBefore || {}, null, 2))),
      section("工具调用", contextList(tools.length ? tools : ["尚未调用工具"])),
      section("证据", contextList(evidence.length ? evidence : ["尚未绑定来源"])),
      section("校验", el("p", {}, run.validation ? (run.validation.valid ? `通过 · ${run.validation.evidenceCount ?? evidence.length} 条证据` : (run.validation.findings || []).join("、")) : "等待校验")),
    ],
  });
}

async function showEvidence(evidence) {
  if (evidence.sourceType === "query" || String(evidence.sourceKey).startsWith("query:")) {
    openContext({
      eyebrow: "查询证据", title: evidence.sourceKey || "受治理查询",
      content: [section("定位", el("pre", { class: "context-code" }, JSON.stringify(evidence.locator || {}, null, 2))),
        section("查询边界", el("p", {}, "结果由注册指标、维度、日期范围和参数化筛选生成。这里展示公开查询范围，不展示内部 SQL。"))],
    });
    return;
  }
  const key = evidence.sourceKey;
  if (!key || key.startsWith("wiki:")) {
    openContext({ eyebrow: "知识证据", title: evidence.sourcePath || "知识库", content: section("定位", el("p", {}, evidence.sourcePath || "wiki/")) });
    return;
  }
  openContext({ eyebrow: "来源", title: "正在读取…", content: loading() });
  try {
    const [pageResult, sourceResult] = await Promise.all([
      api(`/api/wiki/pages/${encodeURIComponent(key)}`),
      api(`/api/wiki/pages/${encodeURIComponent(key)}/source`),
    ]);
    const page = pageResult.page; const source = sourceResult.source;
    openContext({
      eyebrow: "来源定位", title: page.title,
      content: [
        section("已发布页面", el("p", {}, page.path), action("打开知识页", "button secondary", () => navigate(`/knowledge/wiki/${encodeURIComponent(page.key)}`))),
        section("原始来源", el("p", {}, source.path), el("pre", { class: "context-code" }, source.content || "来源文件当前不可读取；页面保留了路径定位。")),
      ],
    });
  } catch (error) {
    openContext({ eyebrow: "来源", title: "来源读取失败", content: errorState(error) });
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
        action("查看运行 ↗", "message-action", () => showRunContext(run))),
      content,
      clarificationBox(run),
      dataView(run.data),
      details,
      followUpSuggestions(run),
      el("div", { class: "message-tools" },
        (run.evidence || []).map((evidence) => action(`▣ ${evidence.sourcePath || evidence.sourceKey || "证据"}`, "evidence-button", () => showEvidence(evidence))),
        action("导出 Markdown", "message-action", () => download(`run-${run.id.slice(0, 8)}.md`, message.content || "", "text/markdown")),
        ACTIVE_RUN.has(run.status) ? action("停止", "message-action", () => cancelRun(run.id)) : null,
        ["completed", "failed", "cancelled"].includes(run.status) ? action("重试", "message-action", () => retryRun(run.userMessageId)) : null)));
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
    const header = pageHeader("持久对话", conversation.title, "消息、上下文、运行、工具与证据均保存在本地 SQLite。",
      [action("新建分析", "button secondary", () => createConversation())]);
    const messages = el("div", { class: "message-list", id: "message-list" });
    const runs = new Map(conversation.runs.map((run) => [run.id, run]));
    if (!conversation.messages.length) {
      messages.append(el("div", { class: "empty-conversation" }, el("span", { class: "signal-glyph" }, "⌁"),
        el("h2", {}, "想探究什么？"),
        el("p", {}, "可以查询指标数值、继续追问维度拆分，也可以检查口径、血缘和知识库证据。")));
    } else {
      for (const message of conversation.messages) {
        if (message.role === "user") {
          messages.append(el("article", { class: "message user" }, el("div", { class: "message-content" }, message.content), el("div", { class: "message-avatar" }, "你")));
        } else if (message.role === "assistant" && runs.has(message.runId)) {
          messages.append(assistantMessage(message, runs.get(message.runId)));
        }
      }
    }
    const form = el("form", { class: "composer", id: "ask-form" },
      el("textarea", { id: "ask-input", maxlength: "4000", placeholder: "追问数据、口径或分析，例如：那按地区拆一下…" }),
      el("button", { id: "ask-submit", class: "button primary", type: "submit" }, "运行 ↗"));
    form.addEventListener("submit", (event) => { event.preventDefault(); submitQuestion(conversation.id, $("#ask-input").value); });
    const input = $("#ask-input", form);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
    });
    shell.replaceChildren(header, scopeBar(conversation.context), messages,
      el("div", { class: "composer-wrap" }, form, el("small", { class: "composer-hint" }, "Enter 运行 · Shift + Enter 换行 · 公开轨迹不包含模型私有思维链")));
    $$(".message.assistant", messages).forEach((card) => attachRunStream(card, conversation.id));
    messages.scrollTop = messages.scrollHeight;
    const latestRun = conversation.runs[0];
    if (latestRun) showRunContext(latestRun); else defaultContext("会话");
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
  button.disabled = true; button.textContent = "上传中…";
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
    toast(error.message); button.disabled = false; button.textContent = "开始构建 →";
  }
}

function jobTable(jobs) {
  if (!jobs.length) return emptyState("还没有导入记录", "添加文档后，任务状态与候选数量会显示在这里。", "⇧");
  return el("div", { class: "table-panel" }, el("table", { class: "work-table" },
    el("thead", {}, el("tr", {}, ["任务", "状态", "文件", "候选", "创建时间"].map((item) => el("th", {}, item)))),
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
    el("span", { class: "upload-glyph" }, "⇧"), el("h2", {}, "拖入你的知识文档"),
    el("p", {}, "Markdown · TXT · CSV · SQL · HTML · PDF · DOCX · XLSX · ZIP"),
    el("p", {}, "最多 50 个文件，单文件 25 MB，单任务 100 MB"),
    el("div", { class: "upload-actions" },
      action("选择文件", "button primary", () => filePicker.click()),
      action("选择文件夹", "button secondary", () => folderPicker.click())),
    filePicker, folderPicker);
  const handleFiles = (files) => { addSelectedFiles(files); selectedFileStack(stack); };
  filePicker.addEventListener("change", () => handleFiles(filePicker.files));
  folderPicker.addEventListener("change", () => handleFiles(folderPicker.files));
  ["dragenter", "dragover"].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.remove("dragging"); }));
  zone.addEventListener("drop", (event) => handleFiles(event.dataTransfer.files));
  zone.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") filePicker.click(); });

  const settings = el("div", { class: "panel panel-pad" },
    el("div", { class: "field" }, el("label", { for: "job-name" }, "导入名称"),
      el("input", { id: "job-name", placeholder: "例如：电商指标词典 2026Q3" })),
    el("div", { class: "section-heading" }, el("h2", {}, "抽取模式")),
    el("div", { class: "mode-grid" },
      el("label", { class: "mode-option" }, el("input", { type: "radio", name: "extraction-mode", value: "rules", checked: true }),
        el("strong", {}, "本地规则"), el("p", {}, "完全本地解析，适合结构化词典、Markdown frontmatter 与 SQL DDL。")),
      el("label", { class: "mode-option" }, el("input", { type: "radio", name: "extraction-mode", value: "llm_assisted" }),
        el("strong", {}, "LLM 辅助"), el("p", {}, "先按本地规则处理，再调用已配置的兼容模型补充候选。"))),
    el("div", { id: "privacy-note", class: "privacy-note", hidden: true }, "LLM 辅助会把已解析的文本片段发送到设置页配置的模型地址。请确认文档允许发送到该服务。"),
    el("div", { class: "section-heading" }, el("h2", {}, "已选文件"), el("small", { id: "selected-total" }, "")),
    stack,
    action("开始构建 →", "button primary", null, { id: "start-ingestion", style: "margin-top:14px;width:100%" }));
  form.append(el("div", {}, zone), settings);
  form.addEventListener("submit", (event) => event.preventDefault());
  $$('input[name="extraction-mode"]', settings).forEach((input) => input.addEventListener("change", () => {
    $("#privacy-note", settings).hidden = $('input[name="extraction-mode"]:checked', settings).value !== "llm_assisted";
  }));
  $("#start-ingestion", settings).addEventListener("click", () => startIngestion(form, $("#start-ingestion", settings)));
  selectedFileStack(stack);

  shell.replaceChildren(pageHeader("知识摄入", "知识构建", "把一批文档转成可审核、可发布、可追溯的 LLM 知识库。"),
    form,
    el("div", { class: "section-heading" }, el("h2", {}, "最近导入"), el("small", {}, `${jobs.length} 个任务`)),
    jobTable(jobs));
  defaultContext("知识构建", "上传后会依次完成解析、切分、实体抽取、本体校验和人工审核准备。");
}

const JOB_STAGES = [
  ["uploading", "上传"], ["parsing", "解析"], ["extracting", "抽取"], ["validating", "校验"], ["awaiting_review", "审核"],
];

function jobPipeline(job) {
  const statusIndex = Math.max(0, JOB_STAGES.findIndex(([status]) => status === job.status));
  const terminal = ["completed", "publishing"].includes(job.status) ? JOB_STAGES.length : statusIndex;
  return el("div", { class: "job-pipeline" }, JOB_STAGES.map(([status, label], index) =>
    el("div", { class: `job-stage ${index < terminal ? "done" : ""} ${index === statusIndex && !["completed", "cancelled", "failed"].includes(job.status) ? "active" : ""}` },
      el("strong", {}, label), el("small", {}, status === "awaiting_review" ? "人工关口" : status))));
}

function jobFileTable(files = []) {
  return el("div", { class: "table-panel" }, el("table", { class: "work-table" },
    el("thead", {}, el("tr", {}, ["文件", "类型", "大小", "状态", "诊断"].map((item) => el("th", {}, item)))),
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
    if (job.candidateCount) actions.push(action("审核候选", "button amber", () => navigate(`/knowledge/review?job=${encodeURIComponent(job.id)}`)));
    if (approved) actions.push(action(`发布已批准 (${approved})`, "button primary", () => jobAction(`/api/knowledge/jobs/${job.id}/publish`, { method: "POST" })));
    if (["queued", "uploading", "parsing", "extracting", "validating"].includes(job.status)) {
      actions.push(action("取消", "button secondary", () => jobAction(`/api/knowledge/jobs/${job.id}/cancel`, { method: "POST" })));
    }
    if (job.status === "failed") actions.push(action("重试失败文件", "button secondary", () => jobAction(`/api/knowledge/jobs/${job.id}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })));
    if (job.status === "completed") actions.push(action("提问此知识库 →", "button primary", () => createConversation()));

    const log = el("div", { class: "event-log", id: "job-event-log" });
    appendJobEvent(log, "job.status", { status: job.status });
    shell.replaceChildren(pageHeader("摄入任务", job.name, `${job.id} · 创建于 ${fmtDate(job.createdAt, true)}`, actions),
      jobPipeline(job),
      el("section", { class: "stat-grid" },
        stat("状态", statusText(job.status)), stat("文件", job.fileCount || job.files.length, `${job.progress?.filesDone || 0} 已完成`),
        stat("候选", job.candidateCount || 0, `${approved} 已批准`), stat("总大小", fmtBytes(job.totalBytes))),
      el("div", { class: "split-grid" },
        el("section", {}, el("div", { class: "section-heading" }, el("h2", {}, "文件")), jobFileTable(job.files)),
        el("section", {}, el("div", { class: "section-heading" }, el("h2", {}, "公开事件日志")), log)));
    openContext({
      eyebrow: "摄入任务", title: statusText(job.status),
      content: [section("进度", el("p", {}, `${job.progress?.filesDone || 0} / ${job.progress?.filesTotal || job.fileCount || 0} 个文件`),
        el("div", { class: "progress-track" }, el("i", { style: `width:${Math.min(100, ((job.progress?.filesDone || 0) / Math.max(job.progress?.filesTotal || job.fileCount || 1, 1)) * 100)}%` }))),
        section("抽取", contextList([`模式：${job.extractionMode}`, `候选：${job.candidateCount}`, `失败文件：${job.progress?.filesFailed || 0}`])),
        job.error ? section("诊断", el("pre", { class: "context-code" }, JSON.stringify(job.error, null, 2))) : null],
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
      el("div", { class: "field" }, el("span", {}, "搜索"), el("input", { id: "candidate-search", placeholder: "标题、key 或来源文件" })),
      el("div", { class: "field" }, el("span", {}, "任务"), el("select", { id: "candidate-job" },
        el("option", { value: "" }, "全部任务"), jobs.map((job) => el("option", { value: job.id, selected: job.id === jobId }, job.name)))),
      el("div", { class: "field" }, el("span", {}, "类型"), el("select", { id: "candidate-type" },
        el("option", { value: "" }, "全部类型"), Object.keys(state.ontology?.schema?.entityTypes || {}).map((type) => el("option", { value: type }, type)))),
      el("div", { class: "field" }, el("span", {}, "状态"), el("select", { id: "candidate-status" },
        el("option", { value: "" }, "全部状态"), ["extracted", "needs_review", "approved", "rejected", "merged", "published"].map((status) => el("option", { value: status }, statusText(status))))),
      el("label", { class: "field" }, el("span", {}, "冲突"), el("select", { id: "candidate-conflict" }, el("option", { value: "" }, "不限"), el("option", { value: "yes" }, "仅冲突"))));
    const tableHost = el("div");
    const approveSelected = action("批准所选", "button primary", () => batchReviewCandidates(candidates, "approve"), { disabled: true });
    const rejectSelected = action("驳回所选", "button danger", () => batchReviewCandidates(candidates, "reject"), { disabled: true });
    const batch = el("div", { class: "batch-bar" }, el("span", { id: "selection-label" }, "已选 0 条可审核候选"),
      el("div", { class: "batch-actions" },
        approveSelected,
        rejectSelected,
        action("发布已批准", "button amber", async () => {
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
      const actionable = visible.filter((candidate) => ["extracted", "needs_review"].includes(candidate.status));
      const selectedActionable = actionable.filter((candidate) => state.selectedCandidates.has(candidate.id));
      const selectAll = el("input", {
        type: "checkbox", checked: actionable.length > 0 && selectedActionable.length === actionable.length,
        disabled: !actionable.length, "aria-label": "选择当前结果中的全部待审核候选",
      });
      selectAll.indeterminate = selectedActionable.length > 0 && selectedActionable.length < actionable.length;
      selectAll.addEventListener("change", () => {
        actionable.forEach((candidate) => selectAll.checked
          ? state.selectedCandidates.add(candidate.id)
          : state.selectedCandidates.delete(candidate.id));
        draw();
      });
      const table = el("div", { class: "table-panel" }, el("table", { class: "work-table" },
        el("thead", {}, el("tr", {}, el("th", {}, selectAll), ["候选", "类型", "来源", "状态", "校验", "操作"].map((item) => el("th", {}, item)))),
        el("tbody", {}, visible.map((candidate) => {
          const canReview = ["extracted", "needs_review"].includes(candidate.status);
          const checkbox = el("input", {
            type: "checkbox", checked: state.selectedCandidates.has(candidate.id), disabled: !canReview,
            "aria-label": canReview ? `选择 ${candidate.title}` : `${candidate.title} 当前不可批量审核`,
          });
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) state.selectedCandidates.add(candidate.id); else state.selectedCandidates.delete(candidate.id);
            draw();
          });
          return el("tr", {}, el("td", {}, checkbox),
            el("td", {}, el("button", { class: "row-link", type: "button", onClick: () => navigate(`/knowledge/review/${encodeURIComponent(candidate.id)}`) },
              el("strong", {}, candidate.title || "未命名"), el("small", {}, candidate.entityKey || "key 待补充")),
              candidate.conflict ? el("span", { class: "conflict-tag" }, candidate.conflict.type) : null),
            el("td", {}, candidate.entityType), el("td", {}, candidate.sourcePath || "—"),
            el("td", {}, statusPill(candidate.status)),
            el("td", {}, candidate.validation?.valid && !candidate.relationErrors?.length ? "通过" :
              el("ul", { class: "issue-list" }, [...(candidate.validation?.errors || []), ...(candidate.relationErrors || [])].slice(0, 3).map((issue) => el("li", {}, typeof issue === "string" ? issue : issue.message || JSON.stringify(issue))))),
            el("td", {}, action(canReview ? "审核" : "查看", canReview ? "button primary row-action" : "button secondary row-action",
              () => navigate(`/knowledge/review/${encodeURIComponent(candidate.id)}`), { "aria-label": `${canReview ? "审核" : "查看"}候选 ${candidate.title || "未命名"}` })));
        }))));
      const selectedCount = state.selectedCandidates.size;
      $("#selection-label").textContent = `已选 ${selectedCount} 条可审核候选`;
      approveSelected.disabled = selectedCount === 0;
      rejectSelected.disabled = selectedCount === 0;
      tableHost.replaceChildren(visible.length ? table : emptyState("没有匹配的候选", "调整筛选条件，或先在知识构建创建一个导入任务。", "✓"));
    };
    toolbar.addEventListener("input", () => { state.selectedCandidates.clear(); draw(); });
    $("#candidate-job", toolbar).addEventListener("change", (event) => {
      navigate(`/knowledge/review${event.target.value ? `?job=${encodeURIComponent(event.target.value)}` : ""}`);
    });
    const pendingCount = candidates.filter((item) => ["extracted", "needs_review"].includes(item.status)).length;
    const conflictCount = candidates.filter((item) => item.conflict).length;
    const approvedCount = candidates.filter((item) => item.status === "approved").length;
    const guide = el("section", { class: "review-guide" },
      el("div", {}, el("small", { class: "eyebrow" }, "审核流程"), el("h2", {}, "先核对原文，再决定是否发布"),
        el("p", {}, "点击每行的“审核”查看来源、抽取结果和校验问题；确定无误的候选也可以勾选后批量批准。已批准内容需要按任务发布，才会进入 Wiki 和问答索引。")),
      el("div", { class: "review-counts", "aria-label": "审核队列概览" },
        el("span", {}, el("strong", {}, pendingCount), "待审核"),
        el("span", {}, el("strong", {}, conflictCount), "有冲突"),
        el("span", {}, el("strong", {}, approvedCount), "已批准")));
    shell.replaceChildren(pageHeader("人工审核", "审核队列", "每个候选都保留来源、抽取方式、校验问题与冲突信息。"),
      guide, toolbar, batch, tableHost);
    draw();
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
      el("div", { class: "field" }, el("label", { for: "edit-type" }, "实体类型"), el("select", { id: "edit-type" },
        Object.keys(state.ontology?.schema?.entityTypes || {}).map((type) => el("option", { value: type, selected: type === candidate.entityType }, type)))),
      el("div", { class: "field" }, el("label", { for: "edit-key" }, "实体键"), el("input", { id: "edit-key", value: candidate.entityKey || "" })),
      el("div", { class: "field full" }, el("label", { for: "edit-title" }, "标题"), el("input", { id: "edit-title", value: candidate.title || "" })),
      el("div", { class: "field full" }, el("label", { for: "edit-definition" }, "定义"), el("textarea", { id: "edit-definition" }, candidate.definition || "")),
      el("div", { class: "field full" }, el("label", { for: "edit-aliases" }, "别名"), el("input", { id: "edit-aliases", value: (candidate.aliases || []).join(", "), placeholder: "用逗号分隔" })),
      el("div", { class: "field full" }, el("label", { for: "edit-relations" }, "关系 (JSON)"), el("textarea", { id: "edit-relations" }, JSON.stringify(candidate.relations || {}, null, 2))),
      candidate.conflict ? el("div", { class: "field full" }, el("span", {}, "合并目标"), el("input", { id: "merge-target", value: candidate.conflict.existing?.key || "", placeholder: "现有实体 key" })) : null,
      el("div", { class: "editor-actions field full" },
        action("保存草稿", "button secondary", async () => {
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
        action("批准", "button primary", () => reviewOne(candidate, "approve")),
        candidate.conflict ? action("合并", "button amber", () => reviewOne(candidate, "merge", $("#merge-target", editor).value.trim())) : null,
        action("驳回", "button danger", () => reviewOne(candidate, "reject"))));
    editor.addEventListener("submit", (event) => event.preventDefault());
    const validationItems = [...(candidate.validation?.errors || []), ...(candidate.relationErrors || [])]
      .map((item) => typeof item === "string" ? item : item.message || JSON.stringify(item));
    const reviewSummary = el("section", { class: "review-summary" },
      el("article", {}, el("small", {}, "当前状态"), statusPill(candidate.status)),
      el("article", {}, el("small", {}, "自动校验"), el("strong", {}, validationItems.length ? `${validationItems.length} 项待确认` : "全部通过")),
      el("article", {}, el("small", {}, "冲突检测"), el("strong", {}, candidate.conflict ? `${candidate.conflict.type} · 需要处理` : "未发现冲突")),
      el("article", {}, el("small", {}, "抽取方式"), el("strong", {}, candidate.extraction?.method || "rules")),
      validationItems.length ? el("div", { class: "review-issues" }, el("strong", {}, "需要关注"),
        el("ul", { class: "issue-list" }, validationItems.map((item) => el("li", {}, item)))) : null);
    shell.replaceChildren(pageHeader("候选审核", candidate.title || "未命名候选", `${candidate.sourcePath || "未知来源"} · revision ${candidate.revision}`,
      [action("返回队列", "button secondary", () => navigate(`/knowledge/review?job=${encodeURIComponent(candidate.jobId)}`))]),
      reviewSummary,
      el("div", { class: "split-grid" },
        el("section", {}, el("div", { class: "section-heading" }, el("h2", {}, "来源预览"), el("small", {}, candidate.sourcePath || "")), source),
        el("section", {}, el("div", { class: "section-heading" }, el("h2", {}, "候选编辑器"), statusPill(candidate.status)), editor)));
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
  const search = el("input", { placeholder: "搜索知识库…", "aria-label": "搜索知识库" });
  const type = el("select", { "aria-label": "按类型筛选" },
    el("option", { value: "" }, "全部实体类型"),
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
  openContext({ eyebrow: "来源", title: "正在加载来源…", content: loading() });
  try {
    const result = await api(`/api/wiki/pages/${encodeURIComponent(page.key)}/source?index=${index}`);
    const source = result.source;
    openContext({
      eyebrow: "来源定位", title: page.title,
      content: [section("路径", el("p", {}, source.path), statusPill(source.available ? "verified" : "needs_review")),
        section("内容", el("pre", { class: "context-code" }, source.content || "路径已保留；当前来源文件不可读取。"))],
    });
  } catch (error) { openContext({ eyebrow: "来源", title: "失败", content: errorState(error) }); }
}

function showPageContext(page) {
  const outgoing = (page.outgoing || []).map((item) => `${item.relation} → ${item.entity.title}`);
  const incoming = (page.incoming || []).map((item) => `${item.entity.title} → ${item.relation}`);
  openContext({
    eyebrow: "知识页面", title: page.type,
    content: [
      section("状态与版本", statusPill(page.status), el("p", {}, page.versions?.length ? `最近 v${page.versions[0].version} · ${fmtDate(page.versions[0].publishedAt)}` : "仓库页面 · 无发布记录")),
      section("来源", contextList((page.sources || []).length ? page.sources : [page.path])),
      section("出边", contextList(outgoing.length ? outgoing : ["暂无出边关系"])),
      section("入边", contextList(incoming.length ? incoming : ["暂无入边引用"])),
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
      ])) : emptyState("浏览已发布知识", "选择左侧页面，查看正文、来源、版本和双向本体关系。", "▤");
    shell.replaceChildren(pageHeader("已发布知识", "知识库", `${pagesResult.total} 页本地索引`,
      [action("构建知识库", "button secondary", () => navigate("/knowledge/builder")),
        action("打开图谱", "button primary", () => navigate(`/knowledge/ontology${page?.entityKey ? `?focus=${encodeURIComponent(page.entityKey)}` : ""}`))]),
      el("div", { class: "wiki-layout" }, wikiDirectory(pages, page?.key), documentView));
    if (page) showPageContext(page); else defaultContext("知识库");
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
      eyebrow: "本体节点", title: page.title,
      content: [section("类型", statusPill(page.status), el("p", {}, page.type)),
        section("定义", el("p", {}, page.content.slice(0, 500))),
        section("关系", contextList(relations.length ? relations : ["无连接节点"])),
        section("操作", action("打开知识库页面", "button primary", () => navigate(`/knowledge/wiki/${encodeURIComponent(page.key)}`)))],
    });
  } catch (error) { openContext({ eyebrow: "本体节点", title: "失败", content: errorState(error) }); }
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
    const typeSelect = el("select", { "aria-label": "实体类型" }, el("option", { value: "" }, "全部实体类型"),
      [...new Set(graph.nodes.map((node) => node.type))].sort().map((type) => el("option", { value: type }, type)));
    const search = el("select", { "aria-label": "聚焦实体" }, el("option", { value: "" }, "聚焦节点…"),
      full.nodes.slice().sort((a, b) => a.title.localeCompare(b.title)).map((node) => el("option", { value: node.key, selected: node.key === focus }, `${node.title} · ${node.type}`)));
    const depthSelect = el("select", { "aria-label": "关系深度" }, [1, 2, 3].map((item) => el("option", { value: item, selected: String(item) === String(depth) }, `深度 ${item}`)));
    const count = el("span");
    const draw = () => {
      const summary = drawOntologySvg(svg, graph, typeSelect.value, focus);
      count.textContent = `${summary.nodeCount} 节点 · ${summary.edgeCount} 边`;
    };
    typeSelect.addEventListener("change", draw);
    search.addEventListener("change", () => navigate(`/knowledge/ontology${search.value ? `?focus=${encodeURIComponent(search.value)}&depth=${depthSelect.value}` : ""}`));
    depthSelect.addEventListener("change", () => navigate(`/knowledge/ontology${focus ? `?focus=${encodeURIComponent(focus)}&depth=${depthSelect.value}` : ""}`));
    const graphShell = el("div", { class: "graph-shell" }, el("div", { class: "graph-toolbar" },
      search, typeSelect, depthSelect, action("适配", "", resetView),
      focus ? action("清除聚焦", "", () => navigate("/knowledge/ontology")) : null), svg,
      el("div", { class: "graph-legend" }, Object.entries(TYPE_COLORS).map(([type, color]) => el("span", {}, el("i", { style: `background:${color}` }), type))));
    draw();
    shell.replaceChildren(pageHeader("知识图谱", "本体", "筛选实体类型、聚焦一至三跳子图；单击检查节点，双击打开知识库页面。",
      [count, action("知识库", "button secondary", () => navigate("/knowledge/wiki"))]), graphShell);
    if (focus) {
      const node = full.nodes.find((item) => item.key === focus);
      if (node) showGraphNode(node);
    } else defaultContext("本体", "选择节点查看定义、来源和双向关系。滚轮缩放，拖拽画布，双击打开知识库。");
  } catch (error) {
    if (token === state.viewToken) shell.replaceChildren(errorState(error));
  }
}

async function showMetricContext(key, metric) {
  openContext({ eyebrow: "指标", title: metric.label, content: loading() });
  let page = null;
  try { page = (await api(`/api/wiki/pages/${encodeURIComponent(`metric-${key.replaceAll("_", "-")}`)}`)).page; } catch { /* 目录信息仍可展示 */ }
  const formula = metric.type === "atomic" ? `${metric.aggregation}(${metric.column})` : `${metric.numerator} / ${metric.denominator}${metric.scale ? ` × ${metric.scale}` : ""}`;
  openContext({
    eyebrow: "受治理指标", title: metric.label,
    content: [section("定义", el("p", {}, metric.description)),
      section("语义映射", contextList([`键：${key}`, `类型：${metric.type}`, `公式：${formula}`, `格式：${metric.format}`])),
      page ? section("本体关联", contextList(Object.entries(page.relations || {}).flatMap(([relation, targets]) => targets.map((target) => `${relation} → ${target}`)))) : null,
      section("试一试", action("问问这个指标", "button primary", () => createConversation(`近 14 天${metric.label}趋势怎么样？`)))],
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
  shell.append(pageHeader("语义目录", "指标", "注册指标是 Agent 查询数据的唯一入口；每个指标都有稳定 key、定义、公式和格式。"),
    el("div", { class: "toolbar", style: "grid-template-columns:1fr auto" },
      el("div", { class: "field" }, el("span", {}, "搜索"), search),
      action("问数据", "button primary", () => createConversation())),
    list);
  defaultContext("指标", "选择指标查看公式、物理映射、本体关系和示例问题。");
}

function mappingCard(kind, key, item) {
  const values = kind === "Metric"
    ? { key, type: item.type, mapping: item.type === "atomic" ? `${item.aggregation}(${item.column})` : `${item.numerator} / ${item.denominator}${item.scale && item.scale !== 1 ? ` × ${item.scale}` : ""}`, format: item.format, source: item.source === "custom" ? "界面注册" : "基础配置" }
    : { key, type: item.type, column: item.column, aliases: (item.aliases || []).join("、") || "—" };
  return el("article", { class: "mapping-card" }, el("small", { class: "eyebrow" }, kind), el("h3", {}, item.label),
    el("dl", {}, Object.entries(values).flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value || "—")])));
}

function openMetricRegistry() {
  const model = state.catalog;
  const registry = model.registry || {};
  const numericColumns = (registry.physicalColumns || []).filter((column) => column.numeric);
  const atomicMetrics = Object.entries(model.metrics).filter(([, metric]) => metric.type === "atomic");
  const dialog = el("dialog", { class: "metric-dialog", "aria-labelledby": "metric-dialog-title" });
  const errorBox = el("div", { class: "form-error", hidden: true });
  const typeSelect = el("select", { name: "type" },
    el("option", { value: "atomic" }, "原子指标 · 聚合一个事实字段"),
    el("option", { value: "derived" }, "派生指标 · 两个原子指标相除"));
  const formatSelect = el("select", { name: "format" },
    el("option", { value: "number" }, "普通数值"), el("option", { value: "integer" }, "整数"),
    el("option", { value: "currency" }, "货币"), el("option", { value: "percent" }, "百分比"));
  const formulaFields = el("div", { class: "metric-formula full" });
  const field = (label, control, hint = "", full = false) => el("label", { class: `field${full ? " full" : ""}` }, el("span", {}, label), control, hint ? el("small", {}, hint) : null);
  const option = ([key, metric]) => el("option", { value: key }, `${metric.label} · ${key}`);

  const drawFormulaFields = () => {
    if (typeSelect.value === "derived") {
      formulaFields.replaceChildren(el("div", { class: "form-grid" },
        field("分子指标", el("select", { name: "numerator", required: true }, atomicMetrics.map(option)), "选择一个已注册原子指标"),
        field("分母指标", el("select", { name: "denominator", required: true }, atomicMetrics.map(option)), "分母为 0 时返回空值"),
        field("缩放系数", el("input", { name: "scale", type: "number", min: "0.0001", max: "10000", step: "any", value: "1", required: true }), "比例填 1，百分比通常填 100"),
        el("div", { class: "formula-preview" }, el("small", {}, "计算模板"), el("code", {}, "分子聚合值 ÷ 分母聚合值 × 缩放系数"))));
    } else {
      formulaFields.replaceChildren(el("div", { class: "form-grid" },
        field("物理字段", el("select", { name: "column", required: true }, numericColumns.map((column) => el("option", { value: column.name }, `${column.name} · ${column.type}`))), `来自事实表 ${model.table}`),
        field("聚合方式", el("select", { name: "aggregation", required: true }, ["SUM", "AVG", "MIN", "MAX", "COUNT"].map((value) => el("option", { value }, value))), "运行时生成受治理聚合表达式")));
    }
  };
  typeSelect.addEventListener("change", drawFormulaFields);

  const form = el("form", { class: "metric-dialog-form" },
    el("header", { class: "dialog-header" },
      el("div", {}, el("small", { class: "eyebrow" }, "语义模型"), el("h2", { id: "metric-dialog-title" }, "注册指标"),
        el("p", {}, `把业务口径映射到 ${model.model} / ${model.table}，保存后 Agent 可立即识别并查询。`)),
      action("×", "icon-button", () => dialog.close(), { "aria-label": "关闭注册指标窗口" })),
    el("div", { class: "form-grid dialog-body" },
      field("指标名称", el("input", { name: "label", required: true, maxlength: "80", placeholder: "例如：收入访客价值" })),
      field("指标 key", el("input", { name: "key", required: true, pattern: "[a-z][a-z0-9_]*", placeholder: "revenue_per_visitor" }), "使用小写字母、数字和下划线"),
      field("指标定义", el("textarea", { name: "description", required: true, maxlength: "1000", placeholder: "说明统计对象、时间口径和业务边界" }), "这段定义会用于语义目录和口径问答", true),
      field("指标类型", typeSelect), field("展示格式", formatSelect),
      field("别名", el("input", { name: "aliases", placeholder: "RPV, 单访价值" }), "多个别名用逗号分隔", true),
      formulaFields,
      errorBox),
    el("footer", { class: "dialog-actions" },
      action("取消", "button secondary", () => dialog.close()),
      el("button", { class: "button primary", type: "submit" }, "注册并启用")));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    const submit = $("button[type=submit]", form); submit.disabled = true; submit.textContent = "正在校验…";
    const values = Object.fromEntries(new FormData(form));
    values.aliases = String(values.aliases || "").split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    if (values.type === "derived") values.scale = Number(values.scale || 1);
    try {
      const result = await api("/api/semantic/metrics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
      state.catalog = result.catalog;
      dialog.close();
      toast(`指标“${result.metric.label}”已注册并启用`);
      renderRoute();
    } catch (error) {
      errorBox.textContent = error.message; errorBox.hidden = false;
      submit.disabled = false; submit.textContent = "注册并启用";
    }
  });
  dialog.addEventListener("close", () => dialog.remove());
  dialog.append(form); document.body.append(dialog); drawFormulaFields();
  if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
}

function physicalFieldCard(column) {
  const role = { time: "时间字段", dimension: "维度字段", measure: "可聚合数值", attribute: "普通属性" }[column.role] || column.role;
  return el("article", { class: "physical-field" }, el("code", {}, column.name), el("span", {}, column.type), el("small", {}, role));
}

async function renderSemantic(token) {
  const shell = el("div", { class: "page-shell" });
  $("#workspace").replaceChildren(shell);
  if (token !== state.viewToken) return;
  const model = state.catalog;
  const registry = model.registry || { physicalColumns: [], customMetricKeys: [] };
  shell.append(pageHeader("业务口径到数据字段", "语义模型", "当前工作区使用一个语义模型连接一张事实表。这个页面展示 Agent 能识别哪些指标、如何计算，以及它们映射到哪些数据字段。",
    [action("＋ 注册指标", "button primary", openMetricRegistry, { disabled: !registry.writable })]),
    el("section", { class: "semantic-flow", "aria-label": "语义模型映射链路" },
      el("article", {}, el("small", {}, "语义模型"), el("strong", {}, model.label), el("code", {}, model.model)),
      el("span", {}, "→"),
      el("article", {}, el("small", {}, "事实表"), el("strong", {}, model.table), el("code", {}, `时间字段 ${model.timeColumn}`)),
      el("span", {}, "→"),
      el("article", {}, el("small", {}, "Agent 查询入口"), el("strong", {}, `${Object.keys(model.metrics).length} 指标 · ${Object.keys(model.dimensions).length} 维度`), el("code", {}, model.timeGrains.join(" / ")))),
    el("div", { class: "visible-note" }, el("strong", {}, "如何理解这个页面"),
      el("p", {}, "事实表保存每天、地区、渠道等明细；语义模型把业务名称绑定到聚合公式。Agent 只能选择这里登记的指标和维度，再由运行时生成参数化查询。")),
    el("section", { class: "stat-grid" }, stat("当前模型", model.model), stat("事实表", model.table), stat("注册指标", Object.keys(model.metrics).length, `${registry.customMetricKeys?.length || 0} 个界面注册`), stat("注册维度", Object.keys(model.dimensions).length)),
    el("div", { class: "section-heading" }, el("h2", {}, "已注册指标"), el("small", {}, Object.keys(model.metrics).length)),
    el("div", { class: "mapping-grid" }, Object.entries(model.metrics).map(([key, item]) => mappingCard("Metric", key, item))),
    el("div", { class: "section-heading" }, el("h2", {}, "已注册维度"), el("small", {}, Object.keys(model.dimensions).length)),
    el("div", { class: "mapping-grid" }, Object.entries(model.dimensions).map(([key, item]) => mappingCard("Dimension", key, item))),
    el("div", { class: "section-heading" }, el("h2", {}, `事实表字段 · ${model.table}`), el("small", {}, registry.physicalColumns?.length || 0)),
    el("div", { class: "physical-grid" }, (registry.physicalColumns || []).map(physicalFieldCard)),
    el("div", { class: "visible-note governance" }, el("strong", {}, "运行时保证"),
      el("p", {}, "字段标识、聚合方式、指标依赖和别名在注册时完成校验；查询使用参数绑定、白名单维度和 500 行结果上限。界面注册内容保存在本地 SQLite。")));
}

function percent(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(Number(value) === 1 ? 0 : 1)}%` : "—";
}

function evaluationDefinition(title, formula, copy) {
  return el("article", { class: "eval-definition" }, el("h3", {}, title), el("code", {}, formula), el("p", {}, copy));
}

function suiteCard(name, label, value, copy, detail) {
  return el("article", { class: "suite-card" }, el("small", { class: "eyebrow" }, name), el("h2", {}, label), el("strong", {}, value), el("p", {}, copy), el("footer", {}, detail));
}

async function renderEvaluation(token) {
  const shell = el("div", { class: "page-shell" }, loading());
  $("#workspace").replaceChildren(shell);
  try {
    const { report, command } = await api("/api/evaluation");
    if (token !== state.viewToken) return;
    if (!report) {
      shell.replaceChildren(pageHeader("回归质量", "评测", "评测报告只读取本地最新一次运行结果。"),
        emptyState("暂无报告", `运行 ${command} 生成首份回归报告。`, "◇"));
      return;
    }
    const single = report.singleTurn;
    const multi = report.multiTurn;
    const wikiEval = report.wiki;
    const groups = Object.entries(single?.groups || {});
    const groupCopy = {
      definition: ["指标口径", "是否进入 wiki-answer，并调用口径与血缘工具"],
      data: ["自然语言问数", "是否进入 metric-query，并执行受治理指标查询"],
      analysis: ["对比分析", "是否调用趋势、周期对比和维度拆分工具"],
      knowledge: ["知识问答", "是否找到 Wiki 或语义目录证据"],
      safety: ["安全边界", "是否拒绝任意 SQL、密钥和提示词请求"],
    };
    shell.replaceChildren(pageHeader("回归质量", "评测", `最近运行 · ${fmtDate(report.generatedAt, true)}`,
      [action("完整重跑：npm run verify", "button secondary", () => toast("请在项目终端运行 npm run verify"))]),
      el("section", { class: "stat-grid" },
        stat("单轮通过率", percent(single?.passRate), `${single?.passed ?? "—"} / ${single?.caseCount ?? "—"} 条`),
        stat("重复一致性", percent(single?.consistencyRate), single ? `${single.caseCount} 条各运行 ${single.repeatedRuns} 次` : "未运行"),
        stat("多轮上下文准确率", percent(multi?.contextAccuracy), multi ? `${multi.turnCount} 轮对话` : "未运行"),
        stat("Wiki 专项", wikiEval ? `${wikiEval.passed}/${wikiEval.checkCount}` : "—", wikiEval ? `${percent(wikiEval.passRate)} 通过` : "未运行")),
      el("div", { class: "section-heading" }, el("h2", {}, "评测体系"), el("small", {}, "三层互补")),
      el("section", { class: "suite-grid" },
        suiteCard("01 · 单轮 Agent", "路由与工具是否正确", single ? `${single.caseCount} 条 × ${single.repeatedRuns} 次` : "未生成", "覆盖口径、问数、分析、知识和安全请求。每条用例检查 Skill、必要工具、最终状态和禁用表述。", single ? `${single.passed} 通过 · ${single.failed} 失败` : "运行 npm run eval"),
        suiteCard("02 · 多轮 Agent", "上下文能否连续继承", multi ? `${multi.scenarioCount} 组 · ${multi.turnCount} 轮` : "未生成", "连续执行查数、维度拆分、分析和口径追问，逐项检查指标、维度、筛选和时间范围。", multi ? `会话隔离 ${percent(multi.isolationRate)} · 整轮通过 ${percent(multi.turnPassRate)}` : "运行 npm run eval:multi-turn"),
        suiteCard("03 · Wiki Builder", "知识闭环能否跑通", wikiEval ? `${wikiEval.checkCount} 项检查` : "未生成", "使用两套示例验证摄入、来源、校验、审核、发布、冲突保护、索引、本体图和 Agent 引用。", wikiEval ? `${wikiEval.passed} 通过 · ${wikiEval.failed} 失败` : "运行 npm run eval:wiki")),
      el("div", { class: "section-heading" }, el("h2", {}, "这些指标怎么算"), el("small", {}, "统一口径")),
      el("section", { class: "eval-definition-grid" },
        evaluationDefinition("单轮通过率", "通过用例数 ÷ 单轮用例总数", "一条用例需要同时满足预期 Skill、必要工具、运行状态、禁用表述和三次公开结果一致，才记为通过。"),
        evaluationDefinition("重复一致性", "三次结果签名完全相同的用例数 ÷ 用例总数", "结果签名包含 Skill、状态、工具序列和最终答案，用来发现同一个问题重复运行时的漂移。"),
        evaluationDefinition("多轮上下文准确率", "正确上下文项 ÷ 全部上下文检查项", `每轮分别检查指标、维度、筛选和时间范围。当前 ${multi?.scenarioCount ?? "—"} 组、${multi?.turnCount ?? "—"} 轮，共 ${multi?.contextCheckCount ?? "—"} 个上下文检查点。`),
        evaluationDefinition("会话隔离率", "初始上下文为空的场景数 ÷ 场景总数", "每组对话都创建独立会话，第一轮不得继承其他场景的指标、维度、时间或筛选。"),
        evaluationDefinition("Wiki 专项通过率", "通过检查项 ÷ Wiki 检查项总数", "检查对象是构建链路，不是问答数量；当前包括两套示例和 15 个发布治理检查。"),
        evaluationDefinition("数值准确性", "自动化测试中的实际查询结果 = 预期结果", "语义层测试直接检查参数化 SQL、派生指标和查询结果；它属于测试门禁，不混入 Agent 单轮通过率。")),
      el("div", { class: "section-heading" }, el("h2", {}, "单轮能力覆盖"), el("small", {}, "每类 24 条")),
      el("div", { class: "mapping-grid" }, groups.map(([group, value]) =>
        el("article", { class: "mapping-card" }, el("small", { class: "eyebrow" }, groupCopy[group]?.[0] || group), el("h3", {}, `${value.passed} / ${value.total}`),
          el("p", { class: "card-copy" }, groupCopy[group]?.[1] || "能力回归"),
          el("div", { class: "progress-track" }, el("i", { style: `width:${value.total ? value.passed / value.total * 100 : 0}%` }))))),
      el("div", { class: "visible-note governance" }, el("strong", {}, "评测边界"),
        el("p", {}, "当前评测使用公开合成问题和合成数据，适合做版本回归与演示验收。它衡量仓库内已定义任务的稳定性；接入真实业务后，应补充企业口径、真实问法、权限边界和人工标注答案集。")));
  } catch (error) {
    if (token === state.viewToken) shell.replaceChildren(errorState(error));
  }
}

async function renderSettings(token) {
  const shell = el("div", { class: "page-shell" });
  $("#workspace").replaceChildren(shell);
  if (token !== state.viewToken) return;
  const mode = state.health?.llmConfigured ? "OpenAI 兼容模型" : "确定性本地运行";
  shell.append(pageHeader("本地工作区", "设置", "查看当前运行模式、数据源、知识索引与本地存储边界。"),
    el("div", { class: "mapping-grid" },
      el("article", { class: "mapping-card" }, el("small", { class: "eyebrow" }, "智能体"), el("h3", {}, mode),
        el("dl", {}, el("dt", {}, "LLM"), el("dd", {}, state.health?.llmConfigured ? "已配置" : "可选 · 未配置"),
          el("dt", {}, "Skills"), el("dd", {}, (state.health?.skills || []).join(", ")), el("dt", {}, "降级路径"), el("dd", {}, "确定性受治理路径"))),
      el("article", { class: "mapping-card" }, el("small", { class: "eyebrow" }, "数据"), el("h3", {}, state.catalog?.label),
        el("dl", {}, el("dt", {}, "数据库"), el("dd", {}, "SQLite"), el("dt", {}, "模型"), el("dd", {}, state.catalog?.model),
          el("dt", {}, "事实表"), el("dd", {}, state.catalog?.table), el("dt", {}, "数据集"), el("dd", {}, "合成示例数据"))),
      el("article", { class: "mapping-card" }, el("small", { class: "eyebrow" }, "知识"), el("h3", {}, "本地知识库"),
        el("dl", {}, el("dt", {}, "页面"), el("dd", {}, state.health?.wikiDocuments), el("dt", {}, "实体"), el("dd", {}, state.health?.wikiEntities),
          el("dt", {}, "检索"), el("dd", {}, "SQLite FTS5"), el("dt", {}, "图谱"), el("dd", {}, "本体关系"))),
      el("article", { class: "mapping-card" }, el("small", { class: "eyebrow" }, "上传限制"), el("h3", {}, "知识构建"),
        el("dl", {}, el("dt", {}, "文件数"), el("dd", {}, "每任务 50"), el("dt", {}, "任务体积"), el("dd", {}, "100 MB"),
          el("dt", {}, "单文件"), el("dd", {}, "25 MB"), el("dt", {}, "ZIP 解压"), el("dd", {}, "250 MB")))));
  openContext({
    eyebrow: "隐私", title: "默认本地",
    content: [section("存储", el("p", {}, "会话、运行、候选、审核记录和版本保存在本地 SQLite；上传文件保存在本地任务目录。")),
      section("模型流量", el("p", {}, state.health?.llmConfigured ? "LLM 模式已配置。模型调用使用环境变量中的兼容端点。" : "当前没有配置模型密钥，问答与规则抽取使用本地确定性路径。"))],
  });
}

async function renderRoute() {
  const { path, query } = parseRoute();
  const token = ++state.viewToken;
  closeStreams(); closePanels(); markActive(path);
  $("#workspace").replaceChildren(loading());
  $("#workspace").scrollTop = 0;
  // 右侧上下文面板只在 Ask（会话）页面出现，按会话独立展示
  const isAsk = path === "/ask" || path.startsWith("/ask/");
  $("#stage")?.classList.toggle("has-context", isAsk);
  $("#open-context").hidden = !isAsk;
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
    $("#health-label").textContent = `${health.llmConfigured ? "LLM" : "本地"} · ${health.wikiDocuments} 页面`;
    $(".service-state").classList.remove("offline");
  } catch (error) {
    $(".service-state").classList.add("offline");
    $("#health-label").textContent = "服务不可用";
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
