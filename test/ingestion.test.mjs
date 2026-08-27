import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { closeDatabase, openDatabase } from "../lib/database.mjs";
import { chunkSegments } from "../lib/ingest/chunk.mjs";
import { extractRules } from "../lib/ingest/extract.mjs";
import { parseMultipart } from "../lib/http/multipart.mjs";
import { IngestionService } from "../lib/ingest/service.mjs";
import { defaultParsers } from "../lib/ingest/parsers/index.mjs";
import { runMigrations } from "../lib/migrations.mjs";
import { Ontology } from "../lib/ontology.mjs";
import { csvDict, htmlDoc, makeDocx, makePdf, makeXlsx, makeZip, mdEntity, sqlDdl, txtDoc } from "./helpers/fixtures.mjs";

function createService() {
  const db = openDatabase(resolve(mkdtempSync(resolve(tmpdir(), "ml-ingest-")), "test.db"));
  runMigrations(db);
  const service = new IngestionService({ db, ontology: new Ontology() });
  return { db, service, close: () => closeDatabase() };
}

test("migrations create ingestion tables and are idempotent", () => {
  const db = openDatabase(resolve(mkdtempSync(resolve(tmpdir(), "ml-mig-")), "test.db"));
  const first = runMigrations(db);
  assert.ok(first.some((migration) => migration.name === "ingestion"));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ingestion_jobs','ingestion_job_events','ingestion_files','document_chunks','knowledge_candidates')").all();
  assert.equal(tables.length, 5);
  runMigrations(db); // 第二次应无异常
  closeDatabase();
});

test("parser registry parses markdown frontmatter entities", async () => {
  const registry = defaultParsers();
  const result = await registry.parse({ buffer: Buffer.from(mdEntity()), extension: "md", relativePath: "dict.md" });
  assert.equal(result.hints[0].kind, "entity");
  assert.equal(result.hints[0].entity.key, "metric-gmv");
  assert.equal(result.hints[0].entity.type, "Metric");
  assert.ok(result.text.includes("SUM(revenue)"));
});

test("parser registry parses csv, sql, html, txt, pdf, docx and xlsx", async () => {
  const registry = defaultParsers();
  assert.equal((await registry.parse({ buffer: Buffer.from(csvDict()), extension: "csv" })).hints[0].kind, "tabular");
  assert.equal((await registry.parse({ buffer: Buffer.from(sqlDdl()), extension: "sql" })).hints[0].table, "daily_metrics");
  const html = await registry.parse({ buffer: Buffer.from(htmlDoc()), extension: "html" });
  assert.ok(!html.text.includes("alert(1)"));
  assert.ok(html.text.includes("支付成功订单"));
  const pdf = await registry.parse({ buffer: await makePdf(), extension: "pdf" });
  assert.equal(pdf.segments[0].locator.page, 1);
  assert.ok(pdf.text.includes("Metrics"));
  const docx = await registry.parse({ buffer: await makeDocx(), extension: "docx" });
  assert.equal(docx.segments[0].locator.section, "收入口径");
  const xlsx = await registry.parse({ buffer: await makeXlsx(), extension: "xlsx" });
  assert.equal(xlsx.hints[0].sheet, "Sheet1");
  assert.equal(xlsx.hints[0].rows[0].name, "客单价");
  const txt = await registry.parse({ buffer: Buffer.from(txtDoc()), extension: "txt" });
  assert.ok(txt.text.includes("第一行"));
});

test("chunker splits long segments and preserves locators", () => {
  const longText = Array.from({ length: 200 }, (_, i) => `第 ${i} 段内容`).join("\n");
  const chunks = chunkSegments([{ text: longText, locator: { page: 3 } }], { maxTokens: 500 });
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].locator.page, 3);
  assert.ok(chunks.every((chunk) => chunk.text.length > 0));
});

test("rule extractor builds candidates from frontmatter, tabular and sql hints", async () => {
  const registry = defaultParsers();
  const fromMd = extractRules(await registry.parse({ buffer: Buffer.from(mdEntity()), extension: "md", relativePath: "dict.md" }), { fileId: "file_1", relativePath: "dict.md" });
  assert.equal(fromMd[0].entityKey, "metric-gmv");

  const fromCsv = extractRules(await registry.parse({ buffer: Buffer.from(csvDict()), extension: "csv", relativePath: "d.csv" }), { fileId: "file_2", relativePath: "d.csv" });
  assert.equal(fromCsv.length, 2);
  assert.equal(fromCsv[0].entityType, "Metric");

  const fromSql = extractRules(await registry.parse({ buffer: Buffer.from(sqlDdl()), extension: "sql", relativePath: "d.sql" }), { fileId: "file_3", relativePath: "d.sql" });
  assert.ok(fromSql.some((draft) => draft.entityType === "DataAsset"));
  assert.ok(fromSql.some((draft) => draft.entityType === "DataField" && draft.title === "revenue"));
});

test("ingestion service persists jobs, files, chunks and candidates with sources", async () => {
  const { service, close } = createService();
  const job = service.createJob({ name: "导入指标", extractionMode: "rules" });
  const result = await service.runJob(job.id, [{ relativePath: "dict.md", buffer: Buffer.from(mdEntity()), mediaType: "text/markdown" }]);
  assert.equal(result.status, "awaiting_review");
  assert.equal(result.files[0].status, "parsed");
  assert.equal(result.summary.candidates, 1);

  const candidates = service.listCandidates({ jobId: job.id });
  assert.equal(candidates.items.length, 1);
  const candidate = candidates.items[0];
  assert.equal(candidate.entityKey, "metric-gmv");
  assert.equal(candidate.validation.valid, true);
  assert.equal(candidate.sources[0].path, "dict.md");
  assert.ok(candidate.sources[0].locator.section);

  const chunks = service.db.prepare("SELECT * FROM document_chunks WHERE file_id = ?").all(result.files[0].id);
  assert.ok(chunks.length >= 1);
  close();
});

test("file failures are isolated and job reaches awaiting_review", async () => {
  const { service, close } = createService();
  const job = service.createJob({ name: "混合", extractionMode: "rules" });
  // 一个正常 markdown + 一个不支持的扩展名文件（在 validateLimits 前会被整体拒绝，这里用损坏的 pdf 触发单文件解析失败）
  const result = await service.runJob(job.id, [
    { relativePath: "a.md", buffer: Buffer.from(mdEntity()) },
    { relativePath: "bad.pdf", buffer: Buffer.from("not a real pdf") },
  ]);
  assert.equal(result.status, "awaiting_review");
  const statuses = Object.fromEntries(result.files.map((file) => [file.relative_path, file.status]));
  assert.equal(statuses["a.md"], "parsed");
  assert.equal(statuses["bad.pdf"], "failed");
  assert.ok(result.files.find((file) => file.relative_path === "bad.pdf").error_json);
  close();
});

test("unsupported file type fails the whole job at upload validation", async () => {
  const { service, close } = createService();
  const job = service.createJob({ name: "不支持", extractionMode: "rules" });
  const result = await service.runJob(job.id, [{ relativePath: "x.exe", buffer: Buffer.from("bin") }]);
  assert.equal(result.status, "failed");
  assert.ok(result.error.message.includes("不支持的文件类型"));
  close();
});

test("zip import expands entries and preserves relative paths", async () => {
  const { service, close } = createService();
  const job = service.createJob({ name: "ZIP 导入", extractionMode: "rules" });
  const zip = await makeZip({ "docs/dict.md": mdEntity(), "docs/table.csv": csvDict() });
  const result = await service.runJob(job.id, [{ relativePath: "bundle.zip", buffer: zip }]);
  assert.equal(result.status, "awaiting_review");
  assert.deepEqual(result.files.map((file) => file.relative_path).sort(), ["docs/dict.md", "docs/table.csv"]);
  assert.ok(result.summary.candidates >= 3);
  close();
});

test("job events are persisted with increasing sequence", async () => {
  const { service, close } = createService();
  const job = service.createJob({ name: "事件", extractionMode: "rules" });
  await service.runJob(job.id, [{ relativePath: "a.md", buffer: Buffer.from(mdEntity()) }]);
  const events = service.eventsAfter(job.id, 0);
  assert.ok(events.length >= 3);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1).slice(0, events.length));
  assert.ok(events.some((event) => event.event_type === "job.started"));
  assert.ok(events.some((event) => event.event_type === "job.awaiting_review"));
  close();
});

test("cancel marks a queued job cancelled", async () => {
  const { service, close } = createService();
  const job = service.createJob({ name: "取消" });
  const cancelled = service.cancelJob(job.id);
  assert.equal(cancelled.status, "cancelled");
  close();
});

test("multipart parser extracts fields and files", () => {
  const boundary = "Xb0undary";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n我的导入\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="a.md"\r\nContent-Type: text/markdown\r\n\r\n`),
    Buffer.from(mdEntity()),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const { fields, files } = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(fields.name, "我的导入");
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, "a.md");
  assert.ok(files[0].buffer.toString("utf8").includes("metric-gmv"));
});

test("llm extraction adapter returns drafts only when configured", async () => {
  const { createLlmExtractor } = await import("../lib/ingest/llm-extractor.mjs");
  const disabled = createLlmExtractor({ apiKey: "", model: "" });
  assert.equal(disabled.enabled, false);
  assert.deepEqual(await disabled.extract({ parseResult: { text: "x" }, fileId: "f", relativePath: "a.md" }), []);

  const calls = [];
  const fetchFn = async () => {
    calls.push(1);
    return new Response(JSON.stringify({ choices: [{ message: { content: '[{"key":"metric-x","type":"Metric","title":"指标X","definition":"定义","aliases":[],"relations":{}}]' } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const enabled = createLlmExtractor({ fetchFn, apiKey: "k", model: "m", baseUrl: "http://x/v1" });
  assert.equal(enabled.enabled, true);
  const drafts = await enabled.extract({ parseResult: { text: "指标X的定义" }, fileId: "f", relativePath: "a.md" });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].entityType, "Metric");
  assert.equal(calls.length, 1);
});
