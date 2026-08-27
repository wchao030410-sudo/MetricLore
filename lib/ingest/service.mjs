import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import JSZip from "jszip";

import { ROOT } from "../config.mjs";
import { chunkSegments } from "./chunk.mjs";
import { extractRules } from "./extract.mjs";
import { createLlmExtractor } from "./llm-extractor.mjs";
import { defaultParsers } from "./parsers/index.mjs";
import { atomicWriteFile, candidateToMarkdown, entityDirectory } from "./publish.mjs";
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

const CANCELABLE_JOB = new Set(["queued", "uploading", "parsing", "extracting", "validating", "awaiting_review"]);
const REVIEW_DECISIONS = new Set(["approve", "reject", "merge", "request_changes"]);
const REVIEW_STATUS = { approve: "approved", reject: "rejected", merge: "merged", request_changes: "needs_review" };
const PATCH_FIELDS = new Set(["entity_key", "entity_type", "title", "definition", "aliases", "relations"]);

function sanitizePath(path) {
  let cleaned = String(path || "").replace(/\\/g, "/");
  cleaned = cleaned.replace(/^\.\.?(\/|$)/, "");
  const segments = cleaned.split("/").filter((segment) => segment && segment !== "." && segment !== "..");
  return segments.join("/");
}

export class IngestionService {
  constructor({ db, ontology, parsers = defaultParsers(), storage = new UploadStore(), llmExtractor = createLlmExtractor(), limits = {}, wiki = null, wikiDir = resolve(ROOT, "wiki") }) {
    this.db = db;
    this.ontology = ontology;
    this.parsers = parsers;
    this.storage = storage;
    this.llmExtractor = llmExtractor;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.wiki = wiki;                 // WikiIndex，用于冲突检测与索引热更新
    this.wikiDir = wiki?.dir || wikiDir;
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
  }

  revisionConflict() {
    const error = new Error("候选内容已被更新，请刷新后重试");
    error.code = "CANDIDATE_REVISION_CONFLICT";
    error.status = 409;
    return error;
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
      publications: this.listPublications(job.id),
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
    if (hasValidationErrors) where.push("json_extract(validation_json, '$.valid') = 0");
    if (cursor) { where.push("created_at < ?"); params.push(cursor); }
    const limitN = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // conflict 为动态计算，无法用 SQL 过滤；设置 hasConflict 时全量装饰后过滤（小数据集足够）。
    if (hasConflict) {
      const rows = this.db.prepare(`SELECT * FROM knowledge_candidates ${clause} ORDER BY created_at DESC`).all(...params);
      const items = rows.map((row) => this.decorateCandidate(row)).filter((candidate) => candidate.conflict).slice(0, limitN);
      return { items, nextCursor: items.length === limitN ? items.at(-1).createdAt : null };
    }

    const rows = this.db.prepare(`SELECT * FROM knowledge_candidates ${clause} ORDER BY created_at DESC LIMIT ?`).all(...params, limitN + 1);
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
    const candidate = {
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
      status: row.status,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    candidate.conflict = this.computeConflict(candidate);
    candidate.relationErrors = this.relationErrors(candidate);
    return candidate;
  }

  computeConflict(candidate) {
    if (!this.wiki || !candidate.entityKey) return null;
    const existing = this.wiki.entities.get(candidate.entityKey);
    if (existing) {
      return { type: existing.status === "verified" ? "verified_conflict" : "update_available", existing: { key: existing.key, title: existing.title, status: existing.status || "untyped" } };
    }
    for (const entity of this.wiki.entities.values()) {
      if (entity.key === candidate.entityKey) continue;
      if (entity.title && candidate.title && entity.title === candidate.title) {
        return { type: "duplicate_title", existing: { key: entity.key, title: entity.title, status: entity.status || "untyped" } };
      }
      const aliasSet = new Set((entity.aliases || []).map((alias) => String(alias).toLowerCase()));
      const overlap = (candidate.aliases || []).find((alias) => aliasSet.has(String(alias).toLowerCase()));
      if (overlap) return { type: "alias_overlap", existing: { key: entity.key, title: entity.title, status: entity.status || "untyped" } };
    }
    return null;
  }

  relationErrors(candidate) {
    if (!this.wiki || !Object.keys(candidate.relations || {}).length) return [];
    const byKey = new Map();
    for (const entity of this.wiki.entities.values()) byKey.set(entity.key, { type: entity.type });
    const siblings = this.db.prepare("SELECT entity_key, entity_type FROM knowledge_candidates WHERE job_id = ? AND entity_key IS NOT NULL").all(candidate.jobId);
    for (const sibling of siblings) byKey.set(sibling.entity_key, { type: sibling.entity_type });
    return this.ontology.validateRelations({ type: candidate.entityType, relations: candidate.relations }, byKey);
  }

  // ---------- 审核与发布 ----------

  updateCandidate(id, { revision, patch = {} }) {
    const row = this.db.prepare("SELECT * FROM knowledge_candidates WHERE id = ?").get(id);
    if (!row) return null;
    if (revision !== undefined && revision !== row.revision) throw this.revisionConflict();
    const current = {
      entity_key: row.entity_key,
      entity_type: row.entity_type,
      title: row.title,
      definition: row.definition,
      aliases: JSON.parse(row.aliases_json || "[]"),
      relations: JSON.parse(row.relations_json || "{}"),
    };
    for (const key of Object.keys(patch)) {
      if (!PATCH_FIELDS.has(key)) throw new Error(`不允许修改字段: ${key}`);
      if (key === "aliases") current.aliases = Array.isArray(patch.aliases) ? patch.aliases : [];
      else if (key === "relations") current.relations = patch.relations && typeof patch.relations === "object" ? patch.relations : {};
      else current[key] = patch[key];
    }
    const entity = {
      key: current.entity_key, type: current.entity_type, title: current.title, status: "candidate",
      sources: JSON.parse(row.sources_json || "[]").map((source) => source.path),
      relations: current.relations, aliases: current.aliases,
    };
    const errors = this.ontology.validateEntity(entity);
    this.db.prepare("UPDATE knowledge_candidates SET entity_key = ?, entity_type = ?, title = ?, definition = ?, aliases_json = ?, relations_json = ?, validation_json = ?, revision = ?, updated_at = ? WHERE id = ?")
      .run(current.entity_key, current.entity_type, current.title, current.definition, json(current.aliases), json(current.relations), json({ valid: errors.length === 0, errors }), row.revision + 1, nowIso(), id);
    return this.getCandidate(id);
  }

  reviewCandidate(id, { revision, decision, note, mergeTargetKey } = {}) {
    const row = this.db.prepare("SELECT * FROM knowledge_candidates WHERE id = ?").get(id);
    if (!row) return null;
    if (!REVIEW_DECISIONS.has(decision)) throw new Error(`未知审核决定: ${decision}`);
    if (revision !== undefined && revision !== row.revision) throw this.revisionConflict();
    const patch = mergeTargetKey ? { mergeTargetKey } : null;
    this.db.prepare("INSERT INTO review_decisions (id, candidate_id, decision, expected_revision, patch_json, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(newId("review_"), id, decision, row.revision, patch ? json(patch) : null, note || null, nowIso());
    this.db.prepare("UPDATE knowledge_candidates SET status = ?, revision = ?, updated_at = ? WHERE id = ?")
      .run(REVIEW_STATUS[decision], row.revision + 1, nowIso(), id);
    return this.getCandidate(id);
  }

  batchReview({ items = [], decision, note } = {}) {
    const results = [];
    for (const item of items) {
      try {
        const candidate = this.reviewCandidate(item.id, { revision: item.revision, decision, note, mergeTargetKey: item.mergeTargetKey });
        results.push({ id: item.id, ok: true, status: candidate?.status });
      } catch (error) {
        results.push({ id: item.id, ok: false, code: error.code || "REVIEW_FAILED", message: error.message });
      }
    }
    return results;
  }

  nextPublicationVersion() {
    return this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM wiki_publications").get().version;
  }

  nextEntityVersion(entityKey) {
    return this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM wiki_versions WHERE entity_key = ?").get(entityKey).version;
  }

  async publishJob(jobId) {
    const job = this.getJob(jobId);
    if (!job) throw new Error(`任务不存在: ${jobId}`);
    const rows = this.db.prepare("SELECT * FROM knowledge_candidates WHERE job_id = ? AND status = 'approved'").all(jobId);

    const pubId = newId("pub_");
    const pubVersion = this.nextPublicationVersion();
    this.db.prepare("INSERT INTO wiki_publications (id, job_id, version, status, created_at) VALUES (?, ?, ?, 'publishing', ?)").run(pubId, jobId, pubVersion, nowIso());
    this.updateJob(jobId, { status: "publishing" });
    this.emit("publish.started", { jobId, publicationId: pubId });

    const summary = { created: 0, updated: 0, skipped: 0, failed: 0 };
    const skippedDetails = [];
    const failedDetails = [];
    for (const row of rows) {
      const candidate = this.decorateCandidate(row);
      try {
        if (candidate.conflict?.type === "verified_conflict") {
          summary.skipped += 1; skippedDetails.push({ key: candidate.entityKey, reason: "verified_conflict" });
          continue;
        }
        if (!candidate.entityKey || !candidate.entityType || !candidate.title) {
          summary.skipped += 1; skippedDetails.push({ key: candidate.entityKey, reason: "incomplete" });
          continue;
        }
        const directory = entityDirectory(candidate.entityType, this.ontology);
        const path = resolve(this.wikiDir, directory, `${candidate.entityKey}.md`);
        const action = this.wiki?.entities?.has(candidate.entityKey) ? "update" : "create";
        const status = candidate.extraction?.entityStatus || "verified";
        const content = candidateToMarkdown(candidate, { status });
        atomicWriteFile(path, content);
        const version = this.nextEntityVersion(candidate.entityKey);
        this.db.prepare("INSERT INTO wiki_versions (id, entity_key, version, action, path, content_sha256, source_candidate_id, publication_id, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(newId("wver_"), candidate.entityKey, version, action, `${directory}/${candidate.entityKey}.md`, sha256(content), candidate.id, pubId, nowIso());
        this.db.prepare("UPDATE knowledge_candidates SET status = 'published', updated_at = ? WHERE id = ?").run(nowIso(), candidate.id);
        summary[action === "create" ? "created" : "updated"] += 1;
        this.emit("candidate.published", { jobId, candidateId: candidate.id, entityKey: candidate.entityKey });
      } catch (error) {
        summary.failed += 1; failedDetails.push({ key: candidate.entityKey, message: error.message });
      }
    }

    let indexRefreshedAt = null;
    let health = null;
    try {
      this.wiki?.refresh();
      indexRefreshedAt = nowIso();
      this.emit("index.refreshed", { jobId, at: indexRefreshedAt });
    } catch (error) {
      health = { error: error.message };
    }

    const completedAt = nowIso();
    const publicationStatus = summary.created + summary.updated > 0 ? "completed" : "failed";
    this.db.prepare("UPDATE wiki_publications SET status = ?, summary_json = ?, health_json = ?, index_refreshed_at = ?, completed_at = ? WHERE id = ?")
      .run(publicationStatus, json({ ...summary, skippedDetails, failedDetails }), json(health), indexRefreshedAt, completedAt, pubId);
    this.updateJob(jobId, { status: "completed", completed_at: completedAt, summary_json: json(this.summarize(jobId)) });
    this.emit("job.completed", { jobId, publicationId: pubId });
    return { publicationId: pubId, version: pubVersion, status: publicationStatus, summary: { ...summary, skippedDetails, failedDetails }, health, indexRefreshedAt };
  }

  listPublications(jobId) {
    return this.db.prepare("SELECT * FROM wiki_publications WHERE job_id = ? ORDER BY version DESC").all(jobId)
      .map((row) => ({
        id: row.id, jobId: row.job_id, version: row.version, status: row.status,
        summary: row.summary_json ? JSON.parse(row.summary_json) : null,
        health: row.health_json ? JSON.parse(row.health_json) : null,
        indexRefreshedAt: row.index_refreshed_at, createdAt: row.created_at, completedAt: row.completed_at,
      }));
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
