const $ = (selector) => document.querySelector(selector);
const el = (tag, attrs = {}, text = "") => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text) node.textContent = text;
  return node;
};

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

let catalog;
let lastRun;

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
  ["语义名称", "业务名称", "物理字段", "类型"].forEach((x) => header.append(el("th", {}, x)));
  table.append(header);
  for (const [key, dimension] of Object.entries(model.dimensions)) {
    const row = el("tr");
    [key, dimension.label, dimension.column, dimension.type].forEach((x) => row.append(el("td", {}, x)));
    table.append(row);
  }
  tablePanel.append(el("h3", {}, "维度"), table);
  content.append(tablePanel);
}

function renderTrace(run) {
  const target = $("#trace-content");
  target.replaceChildren();
  if (!run) { target.append(el("p", {}, "发起一次问答后，这里会显示其执行轨迹。")); return; }
  target.append(el("h3", {}, `${run.skill} · ${run.status}`));
  const list = el("ol", { class: "trace-list" });
  (run.publicTrace || []).forEach((event) => {
    const item = el("li");
    item.append(el("strong", {}, event.state));
    const detail = [event.skill && `Skill: ${event.skill}`, event.tool && `Tool: ${event.tool}`, event.capability && `能力: ${event.capability}`, event.elapsedMs !== undefined && `${event.elapsedMs}ms`].filter(Boolean).join(" · ");
    if (detail) item.append(el("span", {}, detail));
    list.append(item);
  });
  target.append(list);
  const calls = el("p", { class: "meta" }, `工具调用：${(run.toolCalls || []).map((call) => call.name).join(" → ") || "无"}`);
  target.append(calls);
}

function renderOntology(data) {
  const entities = data.entities || [];
  const summary = $("#ontology-summary"); summary.replaceChildren();
  summary.append(el("h3", {}, `${entities.length} 个规范实体 · ${Object.keys(data.schema.relationTypes || {}).length} 类关系`));
  summary.append(el("p", {}, "每张实体卡片都包含类型、状态与出边关系；通过 Agent Trace 可查看问答期间实际使用的知识证据。"));
  const grid = $("#ontology-grid"); grid.replaceChildren();
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
  const grid = $("#skill-grid"); grid.replaceChildren();
  (data.skills || []).forEach((skill) => {
    const card = el("article", { class: "card" });
    card.append(el("span", { class: "tag" }, `max ${skill.maxSteps} steps`));
    card.append(el("h3", {}, skill.name));
    card.append(el("p", {}, skill.description));
    card.append(el("p", { class: "meta" }, `Tools: ${skill.allowedTools.join(", ")}`));
    grid.append(card);
  });
}

function addMessage(role, text, payload) {
  const article = el("article", { class: role });
  if (role === "assistant") article.append(el("div", { class: "avatar" }, "DA"));
  const box = el("div");
  if (role === "assistant") box.append(el("strong", {}, "Data Agent"));
  box.append(el("p", {}, text));
  if (payload?.data?.rows?.length) {
    const table = el("table");
    const keys = Object.keys(payload.data.rows[0]);
    const head = el("tr");
    keys.forEach((key) => head.append(el("th", {}, catalog.metrics[key]?.label || catalog.dimensions[key]?.label || (key === "period" ? "日期" : key))));
    table.append(head);
    payload.data.rows.slice(0, 20).forEach((row) => {
      const tr = el("tr"); keys.forEach((key) => tr.append(el("td", {}, String(row[key] ?? "—")))); table.append(tr);
    });
    box.append(table);
  }
  if (payload?.sources?.length) box.append(el("p", { class: "meta" }, `来源：${payload.sources.map((x) => x.path).join(" · ")}`));
  article.append(box);
  $("#conversation").append(article);
  $("#conversation").scrollTop = $("#conversation").scrollHeight;
}

async function ask(message) {
  if (!message.trim()) return;
  addMessage("user", message);
  $("#message").value = "";
  const pending = el("article", { class: "assistant" });
  pending.append(el("div", { class: "avatar" }, "DA"), el("p", {}, "正在检索口径与数据…"));
  $("#conversation").append(pending);
  try {
    const result = await api("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) });
    pending.remove();
    addMessage("assistant", result.answer, result);
    lastRun = result; renderTrace(lastRun);
  } catch (error) {
    pending.remove(); addMessage("assistant", `请求失败：${error.message}`);
  }
}

document.querySelectorAll("nav button").forEach((button) => button.addEventListener("click", () => showPage(button.dataset.page)));
document.querySelectorAll(".suggestions button").forEach((button) => button.addEventListener("click", () => ask(button.textContent)));
$("#chat-form").addEventListener("submit", (event) => { event.preventDefault(); ask($("#message").value); });
$("#message").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); ask(event.target.value); } });
$("#wiki-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = $("#wiki-results"); target.replaceChildren(el("p", {}, "正在检索…"));
  try {
    const data = await api(`/api/wiki/search?q=${encodeURIComponent($("#wiki-query").value)}`);
    target.replaceChildren();
    if (!data.results.length) target.append(el("p", {}, "没有找到相关页面。"));
    data.results.forEach((item) => {
      const card = el("article", { class: "result" });
      card.append(el("h3", {}, item.title), el("small", {}, item.path), el("p", {}, item.snippet)); target.append(card);
    });
  } catch (error) { target.replaceChildren(el("p", {}, error.message)); }
});

Promise.all([api("/api/health"), api("/api/catalog"), api("/api/ontology"), api("/api/skills")]).then(([health, model, ontology, skills]) => {
  $("#health").textContent = `本地服务正常 · ${health.wikiDocuments} 篇知识`;
  catalog = model; renderCatalog(model); renderOntology(ontology); renderSkills(skills);
}).catch((error) => { $("#health").textContent = error.message; });
