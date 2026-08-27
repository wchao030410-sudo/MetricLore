import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

import { MetricLoreAgent } from "./lib/agent.mjs";
import { loadEnv, ROOT } from "./lib/config.mjs";
import { ConversationService } from "./lib/conversation.mjs";
import { openDatabase } from "./lib/database.mjs";
import { parseMultipart } from "./lib/http/multipart.mjs";
import { IngestionService } from "./lib/ingest/service.mjs";
import { newId } from "./lib/ingest/util.mjs";
import { runMigrations } from "./lib/migrations.mjs";
import { Ontology } from "./lib/ontology.mjs";
import { SemanticLayer } from "./lib/semantic-layer.mjs";
import { SkillRegistry } from "./lib/skill-registry.mjs";
import { WikiIndex } from "./lib/wiki.mjs";

const publicDir = resolve(ROOT, "public");
const UPLOAD_MAX_BYTES = 101 * 1024 * 1024;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

// v0.2 新接口统一信封，见 docs/v0.2/API_AND_EVENTS.md
function ok(res, status, data) {
  return json(res, status, { schemaVersion: "0.2", data, meta: { requestId: newId("req_") } });
}

function err(res, status, code, message, extra = {}) {
  return json(res, status, { schemaVersion: "0.2", error: { code, message, retryable: extra.retryable ?? false, userAction: extra.userAction ?? null, details: extra.details ?? {}, requestId: newId("req_") } });
}

async function body(req, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new Error("请求体必须是 JSON"); }
}

async function rawBody(req, maxBytes = UPLOAD_MAX_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("上传内容超过大小限制");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function staticFile(pathname, res) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const path = resolve(publicDir, relative);
  if (path !== publicDir && !path.startsWith(publicDir + sep)) return false;
  if (!existsSync(path) || !statSync(path).isFile()) return false;
  res.writeHead(200, {
    "content-type": mime[extname(path)] || "application/octet-stream",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  createReadStream(path).pipe(res);
  return true;
}

function defaultDeps() {
  loadEnv();
  const db = openDatabase();
  runMigrations(db);
  const semantic = new SemanticLayer();
  const ontology = new Ontology();
  const skills = new SkillRegistry();
  const wiki = new WikiIndex(undefined, ontology);
  const agent = new MetricLoreAgent({ semantic, wiki, db, ontology, skills });
  const ingestion = new IngestionService({ db, ontology, wiki });
  const conversations = new ConversationService({ db, agent, semantic });
  return { db, semantic, ontology, skills, wiki, agent, ingestion, conversations };
}

export function createAppServer(deps = defaultDeps()) {
  const { semantic, ontology, skills, wiki, agent, ingestion, conversations } = deps;

  const streamJobEvents = (req, res, jobId) => {
    const snapshot = ingestion.getJob(jobId);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "connection": "keep-alive", "x-content-type-options": "nosniff" });
    const send = (event, data, id) => {
      if (id) res.write(`id: ${id}\n`);
      res.write(`event: ${event}\ndata: ${JSON.stringify({ schemaVersion: "0.2", ...data })}\n\n`);
    };
    let lastSequence = 0;
    const lastId = String(req.headers["last-event-id"] || "");
    if (lastId) {
      const event = ingestion.db.prepare("SELECT sequence FROM ingestion_job_events WHERE id = ?").get(lastId);
      if (event) lastSequence = event.sequence;
    }
    send("job.status", { jobId, status: snapshot?.status ?? "unknown", sequence: 0 });
    for (const event of ingestion.eventsAfter(jobId, lastSequence)) {
      send(event.event_type, JSON.parse(event.payload_json || "{}"), event.id);
    }
    const listener = (payload) => { if (payload.jobId === jobId) send(payload.type, payload); };
    ingestion.events.on("*", listener);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    req.on("close", () => { clearInterval(heartbeat); ingestion.events.off("*", listener); });
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, 200, { status: "ok", database: "sqlite", wikiDocuments: wiki.documents.length, wikiEntities: wiki.entities.size, skills: skills.list().map((item) => item.name), llmConfigured: Boolean(process.env.LLM_API_KEY) });
      }
      if (req.method === "GET" && url.pathname === "/api/catalog") return json(res, 200, semantic.catalog());
      if (req.method === "GET" && url.pathname === "/api/skills") return json(res, 200, { skills: skills.list() });
      if (req.method === "GET" && url.pathname === "/api/ontology") return json(res, 200, { schema: ontology.schema, entities: [...wiki.entities.values()].map((entity) => wiki.publicEntity(entity)) });
      if (req.method === "GET" && url.pathname.startsWith("/api/wiki/entity/")) return json(res, 200, { entity: wiki.entity(decodeURIComponent(url.pathname.slice("/api/wiki/entity/".length))) });
      if (req.method === "GET" && url.pathname.startsWith("/api/wiki/trace/")) return json(res, 200, { paths: wiki.trace(decodeURIComponent(url.pathname.slice("/api/wiki/trace/".length)), [], Number(url.searchParams.get("depth") || 2)) });
      if (req.method === "GET" && url.pathname === "/api/wiki/search") {
        return json(res, 200, { results: wiki.search(url.searchParams.get("q") || "", url.searchParams.get("limit") || 5) });
      }
      if (req.method === "POST" && url.pathname === "/api/query") {
        const result = semantic.execute(db, await body(req));
        return json(res, 200, { rows: result.rows, metrics: result.metrics, dimensions: result.dimensions, timeGrain: result.timeGrain });
      }
      if (req.method === "POST" && url.pathname === "/api/chat") return json(res, 200, await agent.answer((await body(req)).message));

      // ---- v0.2 Conversation API ----
      const runEvents = url.pathname.match(/^\/api\/conversations\/([^/]+)\/runs\/([^/]+)\/events$/);
      const conversationMessages = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      const conversationDetail = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
      const runCancel = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      const runClarify = url.pathname.match(/^\/api\/runs\/([^/]+)\/clarifications$/);
      const messageRetry = url.pathname.match(/^\/api\/messages\/([^/]+)\/retry$/);

      if (req.method === "POST" && url.pathname === "/api/conversations") {
        const payload = await body(req);
        const conversation = conversations.createConversation({ title: payload.title });
        return ok(res, 201, { conversation });
      }
      if (req.method === "GET" && url.pathname === "/api/conversations") {
        const { items, nextCursor } = conversations.listConversations({ status: url.searchParams.get("status") || undefined, limit: url.searchParams.get("limit") || undefined, cursor: url.searchParams.get("cursor") || undefined });
        return ok(res, 200, { conversations: items, nextCursor });
      }
      if (req.method === "POST" && conversationMessages) {
        const payload = await body(req);
        const result = await conversations.submitMessage(decodeURIComponent(conversationMessages[1]), payload.content, { contextPatch: payload.contextPatch });
        return ok(res, 200, result);
      }
      if (req.method === "GET" && runEvents) {
        const run = conversations.getRun(decodeURIComponent(runEvents[2]));
        if (!run) return err(res, 404, "NOT_FOUND", "运行不存在");
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "connection": "keep-alive", "x-content-type-options": "nosniff" });
        for (const event of run.events) res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({ schemaVersion: "0.2", runId: run.id, sequence: event.sequence, ...event.payload })}\n\n`);
        res.end();
        return;
      }
      if (req.method === "POST" && runCancel) {
        const run = conversations.cancelRun(decodeURIComponent(runCancel[1]));
        if (!run) return err(res, 404, "NOT_FOUND", "运行不存在");
        return ok(res, 200, { run });
      }
      if (req.method === "POST" && runClarify) {
        const payload = await body(req);
        const result = await conversations.resolveClarification(decodeURIComponent(runClarify[1]), { optionId: payload.optionId });
        return ok(res, 200, result);
      }
      if (req.method === "POST" && messageRetry) {
        const result = await conversations.retryMessage(decodeURIComponent(messageRetry[1]));
        return ok(res, 200, result);
      }
      if (req.method === "GET" && conversationDetail) {
        const conversation = conversations.getConversation(decodeURIComponent(conversationDetail[1]));
        if (!conversation) return err(res, 404, "NOT_FOUND", "会话不存在");
        return ok(res, 200, { conversation });
      }
      if (req.method === "PATCH" && conversationDetail) {
        const payload = await body(req);
        const conversation = conversations.updateConversation(decodeURIComponent(conversationDetail[1]), { title: payload.title, status: payload.status });
        if (!conversation) return err(res, 404, "NOT_FOUND", "会话不存在");
        return ok(res, 200, { conversation });
      }
      if (req.method === "DELETE" && conversationDetail) {
        const deleted = conversations.deleteConversation(decodeURIComponent(conversationDetail[1]));
        if (!deleted) return err(res, 404, "NOT_FOUND", "会话不存在");
        res.writeHead(204, { "x-content-type-options": "nosniff" });
        return res.end();
      }

      // ---- v0.2 Wiki Builder API ----
      const jobEvents = url.pathname.match(/^\/api\/knowledge\/jobs\/([^/]+)\/events$/);
      const jobCandidates = url.pathname.match(/^\/api\/knowledge\/jobs\/([^/]+)\/candidates$/);
      const jobRetry = url.pathname.match(/^\/api\/knowledge\/jobs\/([^/]+)\/retry$/);
      const jobCancel = url.pathname.match(/^\/api\/knowledge\/jobs\/([^/]+)\/cancel$/);
      const jobPublish = url.pathname.match(/^\/api\/knowledge\/jobs\/([^/]+)\/publish$/);
      const jobDetail = url.pathname.match(/^\/api\/knowledge\/jobs\/([^/]+)$/);
      const batchReview = url.pathname.match(/^\/api\/knowledge\/candidates\/batch-review$/);
      const candidateReview = url.pathname.match(/^\/api\/knowledge\/candidates\/([^/]+)\/review$/);
      const candidateDetail = url.pathname.match(/^\/api\/knowledge\/candidates\/([^/]+)$/);

      if (req.method === "POST" && url.pathname === "/api/knowledge/jobs") {
        const contentType = req.headers["content-type"] || "";
        if (!contentType.includes("multipart/form-data")) return err(res, 415, "UNSUPPORTED_MEDIA_TYPE", "需要 multipart/form-data 上传文件");
        const raw = await rawBody(req);
        const { fields, files } = parseMultipart(raw, contentType);
        if (!files.length) return err(res, 400, "NO_FILES", "没有上传文件");
        let options = {};
        let paths = [];
        try { options = fields.options ? JSON.parse(fields.options) : {}; }
        catch { return err(res, 400, "INVALID_OPTIONS", "options 必须是 JSON"); }
        try { paths = fields.paths ? JSON.parse(fields.paths) : []; }
        catch { return err(res, 400, "INVALID_PATHS", "paths 必须是 JSON 数组"); }
        const uploadFiles = files.map((file, index) => ({ relativePath: paths[index] || file.filename, buffer: file.buffer, mediaType: file.mediaType }));
        const name = fields.name;
        const extractionMode = fields.extractionMode === "llm_assisted" ? "llm_assisted" : "rules";
        const job = ingestion.createJob({ name, extractionMode, options });
        ingestion.runJob(job.id, uploadFiles).catch(() => {});
        return ok(res, 202, { job: { id: job.id, name: job.name, status: job.status, extractionMode: job.extractionMode }, eventsUrl: `/api/knowledge/jobs/${job.id}/events` });
      }
      if (req.method === "GET" && url.pathname === "/api/knowledge/jobs") {
        const { items, nextCursor } = ingestion.listJobs({ status: url.searchParams.get("status") || undefined, limit: url.searchParams.get("limit") || undefined, cursor: url.searchParams.get("cursor") || undefined });
        return ok(res, 200, { jobs: items, nextCursor });
      }
      if (req.method === "GET" && jobEvents) {
        const jobId = decodeURIComponent(jobEvents[1]);
        if (!ingestion.getJob(jobId)) return err(res, 404, "NOT_FOUND", "任务不存在");
        return streamJobEvents(req, res, jobId);
      }
      if (req.method === "GET" && jobCandidates) {
        const jobId = decodeURIComponent(jobCandidates[1]);
        const { items, nextCursor } = ingestion.listCandidates({ jobId, status: url.searchParams.get("status") || undefined, type: url.searchParams.get("type") || undefined, hasConflict: url.searchParams.get("hasConflict") === "true" || undefined, hasValidationErrors: url.searchParams.get("hasValidationErrors") === "true" || undefined, limit: url.searchParams.get("limit") || undefined, cursor: url.searchParams.get("cursor") || undefined });
        return ok(res, 200, { candidates: items, nextCursor });
      }
      if (req.method === "GET" && candidateDetail) {
        const candidate = ingestion.getCandidate(decodeURIComponent(candidateDetail[1]));
        if (!candidate) return err(res, 404, "NOT_FOUND", "候选不存在");
        return ok(res, 200, { candidate });
      }
      if (req.method === "PATCH" && candidateDetail) {
        const payload = await body(req);
        const candidate = ingestion.updateCandidate(decodeURIComponent(candidateDetail[1]), { revision: payload.revision, patch: payload.patch || {} });
        return ok(res, 200, { candidate });
      }
      if (req.method === "POST" && batchReview) {
        const payload = await body(req);
        const results = ingestion.batchReview({ items: payload.items || [], decision: payload.decision, note: payload.note });
        return ok(res, 200, { results });
      }
      if (req.method === "POST" && candidateReview) {
        const payload = await body(req);
        const candidate = ingestion.reviewCandidate(decodeURIComponent(candidateReview[1]), { revision: payload.revision, decision: payload.decision, note: payload.note, mergeTargetKey: payload.mergeTargetKey });
        if (!candidate) return err(res, 404, "NOT_FOUND", "候选不存在");
        return ok(res, 200, { candidate });
      }
      if (req.method === "POST" && jobPublish) {
        const jobId = decodeURIComponent(jobPublish[1]);
        const result = await ingestion.publishJob(jobId);
        return ok(res, 200, { publication: result });
      }
      if (req.method === "POST" && jobRetry) {
        const jobId = decodeURIComponent(jobRetry[1]);
        const payload = await body(req);
        const job = await ingestion.retryJob(jobId, { fileIds: payload.fileIds });
        return ok(res, 200, { job });
      }
      if (req.method === "POST" && jobCancel) {
        const job = ingestion.cancelJob(decodeURIComponent(jobCancel[1]));
        return ok(res, 200, { job });
      }
      if (req.method === "GET" && jobDetail) {
        const job = ingestion.getJob(decodeURIComponent(jobDetail[1]));
        if (!job) return err(res, 404, "NOT_FOUND", "任务不存在");
        return ok(res, 200, { job });
      }

      if (req.method === "GET" && staticFile(url.pathname, res)) return;
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error.code && error.status) return err(res, error.status, error.code, error.message, { retryable: error.code === "CANDIDATE_REVISION_CONFLICT" });
      return json(res, 400, { error: error.message || "Bad request" });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3000);
  createAppServer().listen(port, host, () => console.log(`MetricLore: http://${host}:${port}`));
}
