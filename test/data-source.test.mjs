import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { closeDatabase, openDatabase } from "../lib/database.mjs";
import { DataSourceService } from "../lib/data-source.mjs";
import { runMigrations } from "../lib/migrations.mjs";
import { Ontology } from "../lib/ontology.mjs";
import { SemanticLayer } from "../lib/semantic-layer.mjs";
import { WikiIndex } from "../lib/wiki.mjs";
import { createAppServer } from "../server.mjs";
import { makeXlsx } from "./helpers/fixtures.mjs";

const SAMPLE_CSV = [
  "date,region,channel,revenue,orders",
  "2026-06-01,华东,自然流量,8620.4,104",
  "2026-06-02,华北,广告,11240.6,152",
  "2026-06-03,华南,会员,7980.5,91",
].join("\n");

function createDeps() {
  const db = openDatabase(resolve(mkdtempSync(resolve(tmpdir(), "ml-ds-")), "test.db"));
  runMigrations(db);
  const ontology = new Ontology();
  const semantic = new SemanticLayer(undefined, db);
  const wiki = new WikiIndex(undefined, ontology);
  const dataSources = new DataSourceService({ db });
  return { db, ontology, semantic, wiki, dataSources, close: () => closeDatabase() };
}

test("migration creates data_sources and seeds the builtin source", () => {
  const { db, close } = createDeps();
  const rows = db.prepare("SELECT * FROM data_sources").all();
  assert.ok(rows.some((row) => row.kind === "builtin" && row.table_name === "daily_metrics"));
  close();
});

test("data_sources is not exposed as a semantic model candidate table", () => {
  const { semantic, close } = createDeps();
  const tables = semantic.databaseTables().map((item) => item.name);
  assert.ok(!tables.includes("data_sources"));
  assert.ok(tables.includes("daily_metrics"));
  close();
});

test("preview infers column types, time field and dimensions from CSV", async () => {
  const { dataSources, close } = createDeps();
  const preview = await dataSources.preview({ buffer: Buffer.from(SAMPLE_CSV), filename: "sample-sales.csv" });
  assert.equal(preview.totalRows, 3);
  const byName = Object.fromEntries(preview.columns.map((column) => [column.name, column]));
  assert.equal(byName.date.role, "time");
  assert.equal(byName.region.role, "dimension");
  assert.equal(byName.revenue.type, "REAL");
  assert.equal(byName.revenue.role, "measure");
  assert.equal(byName.orders.type, "INTEGER");
  close();
});

test("preview supports XLSX uploads", async () => {
  const { dataSources, close } = createDeps();
  const buffer = await makeXlsx([["date", "region", "revenue"], ["2026-06-01", "华东", 8620.4], ["2026-06-02", "华北", 11240.6]]);
  const preview = await dataSources.preview({ buffer, filename: "sample.xlsx" });
  assert.equal(preview.totalRows, 2);
  assert.ok(preview.columns.some((column) => column.name === "date" && column.role === "time"));
  close();
});

test("create builds a sanitized table, inserts rows and registers the source", async () => {
  const { db, dataSources, close } = createDeps();
  const source = await dataSources.create({ name: "示例销售", buffer: Buffer.from(SAMPLE_CSV), filename: "sample-sales.csv" });
  assert.equal(source.kind, "uploaded");
  assert.match(source.table, /^user_/);
  assert.equal(source.rowCount, 3);
  assert.equal(source.modelCount, 0);
  const rows = db.prepare(`SELECT COUNT(*) AS count FROM "${source.table}"`).get();
  assert.equal(rows.count, 3);
  close();
});

test("list and get return sources with preview; delete removes uploaded source", async () => {
  const { db, dataSources, close } = createDeps();
  const source = await dataSources.create({ name: "待删除", buffer: Buffer.from(SAMPLE_CSV), filename: "a.csv" });
  const listed = dataSources.list();
  assert.ok(listed.some((item) => item.id === source.id));
  const detail = dataSources.get(source.id);
  assert.ok(detail.preview.length >= 3);
  assert.equal(detail.preview[0].length, 5);

  assert.equal(dataSources.remove(source.id), true);
  assert.equal(dataSources.get(source.id), null);
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(source.table);
  assert.equal(tableExists, undefined);
  close();
});

test("builtin source and model-referenced source are protected from deletion", async () => {
  const { dataSources, semantic, close } = createDeps();
  const builtin = dataSources.list().find((item) => item.kind === "builtin");
  assert.throws(() => dataSources.remove(builtin.id), (error) => error.code === "BUILTIN_SOURCE_PROTECTED");

  const source = await dataSources.create({ name: "被引用", buffer: Buffer.from(SAMPLE_CSV), filename: "b.csv" });
  semantic.registerModel({ id: "ref_model", label: "引用模型", table: source.table, timeColumn: "date" });
  assert.throws(() => dataSources.remove(source.id), (error) => error.code === "SOURCE_REFERENCED_BY_MODEL");
  close();
});

test("HTTP data source endpoints serve preview, create, list, detail and delete", async () => {
  const deps = createDeps();
  const server = createAppServer(deps);
  const base = await new Promise((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen(`http://127.0.0.1:${server.address().port}`)));
  try {
    const form = new FormData();
    form.append("file", new Blob([SAMPLE_CSV], { type: "text/csv" }), "http.csv");
    const created = await fetch(`${base}/api/data/sources`, { method: "POST", body: form });
    assert.equal(created.status, 201);
    const sourceId = (await created.json()).data.source.id;

    const list = await (await fetch(`${base}/api/data/sources`)).json();
    assert.ok(list.data.sources.some((item) => item.id === sourceId));

    const detail = await (await fetch(`${base}/api/data/sources/${sourceId}`)).json();
    assert.equal(detail.data.source.rowCount, 3);

    const deleted = await fetch(`${base}/api/data/sources/${sourceId}`, { method: "DELETE" });
    assert.equal(deleted.status, 204);
  } finally {
    server.close();
    closeDatabase();
  }
});
