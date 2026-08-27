import { EventEmitter } from "node:events";
import JSZip from "jszip";

import { chunkSegments } from "./chunk.mjs";
import { extractRules } from "./extract.mjs";
import { createLlmExtractor } from "./llm-extractor.mjs";
import { defaultParsers } from "./parsers/index.mjs";
import { UploadStore } from "./storage.mjs";
import { estimateTokens, extensionOf, json, newId, nowIso, sha256 } from "./util.mjs";

const DEFAULT_LIMITS = {
  maxFiles: 50,
  maxTotalBytes: 100 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  maxZipExpandedBytes: 250 * 1024 * 1024,
  maxZipRatio: 100,
  maxPathDepth: 20,
};

const TERMINAL_JOB = new Set(["failed", "cancelled"]);
const CANCELABLE_JOB = new Set(["queued", "uploading", "parsing", "extracting", "validating", "awaiting_review"]);

function sanitizePath(path) {
  let cleaned = String(path || "").replace(/\\/g, "/");
  cleaned = cleaned.replace(/^\.\.?(\/|$)/, "");
  const segments = cleaned.split("/").filter((segment) => segment && segment !== "." && segment !== "..");
  return segments.join("/");
}

export class IngestionService {
  constructor({ db, ontology, parsers = defaultParsers(), storage = new UploadStore(), llmExtractor = createLlmExtractor(), limits = {} }) {
    this.db = db;
    this.ontology = ontology;
    this.parsers = parsers;
    this.storage = storage;
    this.llmExtractor = llmExtractor;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
  }

  emit(type, payload) {
    if (payload?.jobId) this.persistEvent(payload.jobId, type, payload);
    this.events.emit(type, payload);
    this.events.emit("*", { type, ...payload });
  }

  persistEvent(jobId, type, payload) {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS seq FROM ingestion_job_events WHERE job_id = ?").get(jobId);
    const sequence = row.seq + 1;
    this.db.prepare("INSERT INTO ingestion_job_events (id, job_id, sequence, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newId("jevt_"), jobId, sequence, type, json({ ...payload, sequence }), nowIso());
  }

  eventsAfter(jobId, afterSequence = 0) {
    return this.db.prepare("SELECT * FROM ingestion_job_events WHERE job_id = ? AND sequence > ? ORDER BY sequence ASC").all(jobId, afterSequence);
  }

  // ---------- Job 生命周期 ----------

  createJob({ name, extractionMode = "rules", options = {} }) {
    const id = newId("job_");
    this.db.prepare("INSERT INTO ingestion_jobs (id, workspace_id, name, status, extraction_mode, options_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, "ws_local", String(name || "未命名导入").slice(0, 200), "queued", extractionMode === "llm_assisted" ? "llm_assisted" : "rules", json(options), nowIso());
    return this.getJob(id);
  }

  updateJob(id, patch) {
    const sets = Object.keys(patch).map((key) => `${key} = ?`).join(", ");
    this.db.prepare(`UPDATE ingestion_jobs SET ${sets} WHERE id = ?`).run(...Object.values(patch), id);
  }

  async runJob(jobId, files) {
    const job = this.getJob(jobId);
    if (!job) throw new Error(`任务不存在: ${jobId}`);
    this.updateJob(jobId, { status: "uploading", started_at: nowIso() });
    this.emit("job.started", { jobId });

    let normalized;
    try {
      normalized = await this.normalizeUpload(files);
      this.validateLimits(normalized);
    } catch (error) {
      this.updateJob(jobId, { status: "failed", completed_at: nowIso(), error_json: json({ message: error.message, stage: "uploading" }) });
      this.emit("job.failed", { jobId, error: error.message });
      return this.getJob(jobId);
    }

    const fileRows = this.insertFiles(jobId, normalized);
    this.updateJob(jobId, { status: "parsing", file_count: fileRows.length, total_bytes: fileRows.reduce((sum, row) => sum + row.size_bytes, 0) });
    for (const fileRow of fileRows) await this.processFile(jobId, fileRow, job.extractionMode);

    this.updateJob(jobId, { status: "validating" });
    const summary = this.summarize(jobId);
    const progress = this.progress(jobId);
    this.updateJob(jobId, { status: "awaiting_review", completed_at: nowIso(), summary_json: json(summary), progress_json: json(progress) });
    this.emit("job.awaiting_review", { jobId });
    return this.getJob(jobId);
  }

  async normalizeUpload(files) {
    const out = [];
    for (const file of files) {
      const name = file.relativePath || file.filename || "unnamed";
      if (extensionOf(name) === "zip") {
        out.push(...(await this.expandZip(file.buffer, name)));
      } else {
        out.push({ relativePath: sanitizePath(name), buffer: Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer), mediaType: file.mediaType || null });
      }
    }
    return out;
  }

  async expandZip(buffer, name) {
    const zip = await JSZip.loadAsync(buffer);
    const compressed = buffer.length;
    let expanded = 0;
    const entries = [];
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const relativePath = sanitizePath(path);
      if (!relativePath) continue;
      if (relativePath.split("/").length > this.limits.maxPathDepth) throw new Error(`ZIP 路径过深: ${path}`);
      const content = await entry.async("nodebuffer");
      expanded += content.length;
      if (expanded > this.limits.maxZipExpandedBytes) throw new Error("ZIP 解压后超过大小限制");
      if (expanded > compressed * this.limits.maxZipRatio) throw new Error("ZIP 压缩比异常，可能存在 zip bomb");
      entries.push({ relativePath, buffer: content, mediaType: null });
    }
    return entries;
  }

  validateLimits(files) {
    if (!files.length) throw new Error("没有可处理的文件");
    if (files.length > this.limits.maxFiles) throw new Error(`文件数量超过上限 ${this.limits.maxFiles}`);
    const total = files.reduce((sum, file) => sum + file.buffer.length, 0);
    if (total > this.limits.maxTotalBytes) throw new Error("上传总量超过限制");
    for (const file of files) {
      if (file.buffer.length > this.limits.maxFileBytes) throw new Error(`单个文件超过大小限制: ${file.relativePath}`);
      if (!this.parsers.supports({ extension: extensionOf(file.relativePath), mediaType: file.mediaType })) throw new Error(`不支持的文件类型: ${file.relativePath}`);
    }
  }

  insertFiles(jobId, files) {
    const insert = this.db.prepare("INSERT INTO ingestion_files (id, job_id, relative_path, media_type, extension, size_bytes, sha256, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const rows = [];
    for (const file of files) {
      const id = newId("file_");
      const extension = extensionOf(file.relativePath);
      const digest = sha256(file.buffer);
      this.storage.write(jobId, id, file.buffer);
      insert.run(id, jobId, file.relativePath, file.mediaType, extension, file.buffer.length, digest, "accepted", nowIso());
      this.emit("file.accepted", { jobId, fileId: id, relativePath: file.relativePath });
      rows.push({ id, relative_path: file.relativePath, media_type: file.mediaType, extension, size_bytes: file.buffer.length, sha256: digest });
    }
    return rows;
  }

  async processFile(jobId, fileRow, extractionMode = "rules") {
    this.updateFile(fileRow.id, { status: "parsing" });
    this.emit("file.parsing", { jobId, fileId: fileRow.id });
    try {
      const buffer = this.storage.read(jobId, fileRow.id);
      const parseResult = await this.parsers.parse({ buffer, extension: fileRow.extension, mediaType: fileRow.media_type, relativePath: fileRow.relative_path });
      this.updateFile(fileRow.id, { status: "parsed", locator_capabilities_json: json(parseResult.locatorCapabilities || []) });
      this.emit("file.parsed", { jobId, fileId: fileRow.id, locatorCapabilities: parseResult.locatorCapabilities || [] });

      const chunks = chunkSegments(parseResult.segments);
      this.insertChunks(fileRow.id, chunks);

      const drafts = extractRules(parseResult, { fileId: fileRow.id, relativePath: fileRow.relative_path });
      if (extractionMode === "llm_assisted") {
        drafts.push(...(await this.llmExtractor.extract({ parseResult, fileId: fileRow.id, relativePath: fileRow.relative_path })));
      }
      this.emit("extraction.started", { jobId, fileId: fileRow.id });
      for (const draft of drafts) {
        const candidateId = this.insertCandidate(jobId, fileRow.id, draft);
        this.emit("candidate.extracted", { jobId, fileId: fileRow.id, candidateId, entityType: draft.entityType });
      }
    } catch (error) {
      this.updateFile(fileRow.id, { status: "failed", error_json: json({ message: error.message, stage: "parsing" }) });
      this.emit("file.failed", { jobId, fileId: fileRow.id, error: error.message });
    }
  }

  updateFile(id, patch) {
    const sets = Object.keys(patch).map((key) => `${key} = ?`).join(", ");
    this.db.prepare(`UPDATE ingestion_files SET ${sets} WHERE id = ?`).run(...Object.values(patch), id);
  }

  insertChunks(fileId, chunks) {
    const insert = this.db.prepare("INSERT INTO document_chunks (id, file_id, ordinal, text, locator_json, token_count, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)");
    chunks.forEach((chunk, index) => {
      insert.run(newId("chunk_"), fileId, index + 1, chunk.text, json(chunk.locator || {}), chunk.tokenCount || estimateTokens(chunk.text), sha256(chunk.text));
    });
  }

  candidateEntity(draft) {
    return {
      key: draft.entityKey,
      type: draft.entityType,
      title: draft.title,
      status: "candidate",
      sources: (draft.sources || []).map((source) => source.path),
      relations: draft.relations || {},
      aliases: draft.aliases || [],
    };
  }

  insertCandidate(jobId, fileId, draft) {
    const entity = this.candidateEntity(draft);
    const errors = this.ontology.validateEntity(entity);
    const id = newId("cand_");
    const now = nowIso();
    this.db.prepare("INSERT INTO knowledge_candidates (id, job_id, source_file_id, entity_key, entity_type, title, definition, aliases_json, relations_json, sources_json, extraction_json, validation_json, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracted', 1, ?, ?)")
      .run(id, jobId, fileId, draft.entityKey, draft.entityType, draft.title, draft.definition, json(draft.aliases || []), json(draft.relations || {}), json(draft.sources || []), json(draft.extraction || {}), json({ valid: errors.length === 0, errors }), now, now);
    return id;
  }

  summarize(jobId) {
    const files = this.db.prepare("SELECT status, COUNT(*) AS count FROM ingestion_files WHERE job_id = ? GROUP BY status").all(jobId);
    const candidates = this.db.prepare("SELECT entity_type, COUNT(*) AS count FROM knowledge_candidates WHERE job_id = ? GROUP BY entity_type").all(jobId);
    const total = this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_candidates WHERE job_id = ?").get(jobId).count;
    return {
      files: Object.fromEntries(files.map((row) => [row.status, row.count])),
      candidates: total,
      entityTypes: Object.fromEntries(candidates.filter((row) => row.entity_type).map((row) => [row.entity_type, row.count])),
    };
  }

  progress(jobId) {
    const files = this.db.prepare("SELECT status, COUNT(*) AS count FROM ingestion_files WHERE job_id = ? GROUP BY status").all(jobId);
    const filesTotal = files.reduce((sum, row) => sum + row.count, 0);
    const filesFailed = files.find((row) => row.status === "failed")?.count || 0;
    const candidates = this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_candidates WHERE job_id = ?").get(jobId).count;
    return { stage: "awaiting_review", filesTotal, filesDone: filesTotal - filesFailed, filesFailed, candidates };
  }

  // ---------- 查询 ----------

  getJob(id) {
    const job = this.db.prepare("SELECT * FROM ingestion_jobs WHERE id = ?").get(id);
    if (!job) return null;
    return this.decorateJob(job);
  }

  decorateJob(job) {
    const files = this.db.prepare("SELECT id, relative_path, media_type, extension, size_bytes, sha256, status, error_json FROM ingestion_files WHERE job_id = ? ORDER BY created_at").all(job.id);
    const candidateCount = this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_candidates WHERE job_id = ?").get(job.id).count;
    return {
      id: job.id,
      workspaceId: job.workspace_id,
      name: job.name,
      status: job.status,
      extractionMode: job.extraction_mode,
      options: JSON.parse(job.options_json || "{}"),
      fileCount: job.file_count,
      totalBytes: job.total_bytes,
      progress: JSON.parse(job.progress_json || "{}"),
      summary: job.summary_json ? JSON.parse(job.summary_json) : null,
      error: job.error_json ? JSON.parse(job.error_json) : null,
      candidateCount,
      files,
      createdAt: job.created_at,
      startedAt: job.started_at,
      completedAt: job.completed_at,
    };
  }

  listJobs({ status, limit = 20, cursor } = {}) {
    const params = [];
    const where = [];
    if (status) { where.push("status = ?"); params.push(status); }
    if (cursor) { where.push("created_at < ?"); params.push(cursor); }
    const limitN = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const rows = this.db.prepare(`SELECT * FROM ingestion_jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`).all(...params, limitN + 1);
    const hasMore = rows.length > limitN;
    const items = rows.slice(0, limitN).map((row) => this.decorateJob(row));
    return { items, nextCursor: hasMore ? items.at(-1).createdAt : null };
  }

  listCandidates({ jobId, status, type, hasConflict, hasValidationErrors, limit = 20, cursor } = {}) {
    const where = [];
    const params = [];
    if (jobId) { where.push("job_id = ?"); params.push(jobId); }
    if (status) { where.push("status = ?"); params.push(status); }
    if (type) { where.push("entity_type = ?"); params.push(type); }
    if (hasConflict) where.push("conflict_json IS NOT NULL");
    if (hasValidationErrors) where.push("json_extract(validation_json, '$.valid') = 0");
    if (cursor) { where.push("created_at < ?"); params.push(cursor); }
    const limitN = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const rows = this.db.prepare(`SELECT * FROM knowledge_candidates ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`).all(...params, limitN + 1);
    const hasMore = rows.length > limitN;
    const items = rows.slice(0, limitN).map((row) => this.decorateCandidate(row));
    return { items, nextCursor: hasMore ? items.at(-1).createdAt : null };
  }

  getCandidate(id) {
    const row = this.db.prepare("SELECT * FROM knowledge_candidates WHERE id = ?").get(id);
    if (!row) return null;
    return this.decorateCandidate(row);
  }

  decorateCandidate(row) {
    const source = this.db.prepare("SELECT id, relative_path FROM ingestion_files WHERE id = ?").get(row.source_file_id);
    const preview = this.db.prepare("SELECT text FROM document_chunks WHERE file_id = ? ORDER BY ordinal LIMIT 1").get(row.source_file_id);
    return {
      id: row.id,
      jobId: row.job_id,
      sourceFileId: row.source_file_id,
      sourcePath: source?.relative_path || null,
      sourcePreview: preview?.text?.slice(0, 1000) || null,
      entityKey: row.entity_key,
      entityType: row.entity_type,
      title: row.title,
      definition: row.definition,
      aliases: JSON.parse(row.aliases_json || "[]"),
      relations: JSON.parse(row.relations_json || "{}"),
      sources: JSON.parse(row.sources_json || "[]"),
      extraction: JSON.parse(row.extraction_json || "{}"),
      validation: JSON.parse(row.validation_json || "{}"),
      conflict: row.conflict_json ? JSON.parse(row.conflict_json) : null,
      status: row.status,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---------- 运维 ----------

  async retryJob(jobId, { fileIds } = {}) {
    const job = this.getJob(jobId);
    if (!job) throw new Error(`任务不存在: ${jobId}`);
    const rows = this.db.prepare("SELECT * FROM ingestion_files WHERE job_id = ? AND status = 'failed'").all(jobId)
      .filter((row) => !fileIds?.length || fileIds.includes(row.id));
    for (const row of rows) await this.processFile(jobId, row, job.extractionMode);
    return this.getJob(jobId);
  }

  cancelJob(jobId) {
    const job = this.getJob(jobId);
    if (!job) throw new Error(`任务不存在: ${jobId}`);
    if (CANCELABLE_JOB.has(job.status)) {
      this.updateJob(jobId, { status: "cancelled", completed_at: nowIso() });
      this.emit("job.cancelled", { jobId });
    }
    return this.getJob(jobId);
  }
}
