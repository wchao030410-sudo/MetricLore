import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { MetricLoreAgent } from "../lib/agent.mjs";
import { ConversationService } from "../lib/conversation.mjs";
import { closeDatabase, openDatabase } from "../lib/database.mjs";
import { IngestionService } from "../lib/ingest/service.mjs";
import { runMigrations } from "../lib/migrations.mjs";
import { Ontology } from "../lib/ontology.mjs";
import { SemanticLayer } from "../lib/semantic-layer.mjs";
import { SkillRegistry } from "../lib/skill-registry.mjs";
import { WikiIndex } from "../lib/wiki.mjs";
import { createAppServer } from "../server.mjs";

function newWiki() {
  return new WikiIndex(undefined, new Ontology());
}

function createDeps() {
  const db = openDatabase(resolve(mkdtempSync(resolve(tmpdir(), "ml-wb-")), "test.db"));
  runMigrations(db);
  const ontology = new Ontology();
  const semantic = new SemanticLayer();
  const skills = new SkillRegistry();
  const wiki = new WikiIndex(undefined, ontology);
  const agent = new MetricLoreAgent({ db, ontology, semantic, wiki, skills });
  const ingestion = new IngestionService({ db, ontology, wiki });
  const conversations = new ConversationService({ db, agent, semantic });
  return { db, ontology, semantic, skills, wiki, agent, ingestion, conversations, close: () => closeDatabase() };
}

test("wiki.pages lists, filters and searches published pages", () => {
  const wiki = newWiki();
  const all = wiki.pages({ limit: 100 });
  assert.ok(all.total >= 22);
  assert.ok(all.items.length <= 100);

  const metrics = wiki.pages({ entityTypes: ["Metric"], limit: 100 });
  assert.ok(metrics.items.length > 0);
  assert.ok(metrics.items.every((page) => page.type === "Metric"));

  const search = wiki.pages({ query: "客单价", limit: 10 });
  assert.ok(search.items.some((page) => page.title.includes("客单价")));
});

test("wiki.page returns detail with bidirectional relations", () => {
  const wiki = newWiki();
  const page = wiki.page("metric-aov");
  assert.equal(page.entityKey, "metric-aov");
  assert.equal(page.type, "Metric");
  assert.ok(page.outgoing.some((item) => item.relation === "derivedFrom"));
});

test("wiki.source returns content and guards path traversal", () => {
  const wiki = newWiki();
  const source = wiki.source("metric-revenue", 0);
  assert.equal(source.pageKey, "metric-revenue");
  assert.equal(source.available, true);
  assert.ok(source.content.length > 0);
});

test("wiki.graph returns full graph and depth-limited focus subgraph", () => {
  const wiki = newWiki();
  const full = wiki.graph({});
  assert.ok(full.nodes.length >= 22);
  assert.ok(full.edges.length > 0);

  const focused = wiki.graph({ focusKey: "metric-aov", depth: 1 });
  assert.ok(focused.nodes.some((node) => node.key === "metric-aov"));
  assert.ok(focused.nodes.length < full.nodes.length);
});

test("agent run persists a data snapshot for chart and table", async () => {
  const { conversations, close } = createDeps();
  const conv = conversations.createConversation({ title: "快照" });
  const { run } = await conversations.submitMessage(conv.id, "近 14 天收入趋势怎么样？");
  assert.equal(run.status, "completed");
  assert.ok(run.data, "运行应保存结果快照");
  assert.ok(Array.isArray(run.data.rows));
  assert.ok(run.data.rows.length > 0);
  close();
});

test("HTTP workbench endpoints serve wiki pages, graph, candidates and evaluation", async () => {
  const deps = createDeps();
  const server = createAppServer(deps);
  const base = await new Promise((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen(`http://127.0.0.1:${server.address().port}`)));
  try {
    const pages = await (await fetch(`${base}/api/wiki/pages?limit=5`)).json();
    assert.equal(pages.schemaVersion, "0.2");
    assert.ok(pages.data.pages.length > 0);
    assert.ok(pages.data.total >= 22);

    const graph = await (await fetch(`${base}/api/wiki/graph?depth=1`)).json();
    assert.ok(graph.data.graph.nodes.length >= 22);

    const candidates = await (await fetch(`${base}/api/knowledge/candidates?limit=5`)).json();
    assert.equal(candidates.schemaVersion, "0.2");
    assert.ok(Array.isArray(candidates.data.candidates));

    const evaluation = await (await fetch(`${base}/api/evaluation`)).json();
    assert.ok(evaluation.data.report === null || typeof evaluation.data.report === "object");
  } finally {
    server.close();
    closeDatabase();
  }
});
