-- v0.2 M1: Wiki Builder 摄入核心
-- 依据 docs/v0.2/DATA_MODEL.md，创建摄入任务、任务事件、文件、分段与候选表。
-- 不修改现有 daily_metrics 表；审核决定、发布批次与 Wiki 版本表在 M2 迁移中创建。

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL DEFAULT 'ws_local',
  name             TEXT NOT NULL,
  status           TEXT NOT NULL,
  extraction_mode  TEXT NOT NULL,
  options_json     TEXT NOT NULL DEFAULT '{}',
  file_count       INTEGER NOT NULL DEFAULT 0,
  total_bytes      INTEGER NOT NULL DEFAULT 0,
  progress_json    TEXT NOT NULL DEFAULT '{}',
  summary_json     TEXT,
  error_json       TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  completed_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_workspace_created ON ingestion_jobs(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ingestion_job_events (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  sequence     INTEGER NOT NULL,
  event_type   TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  UNIQUE(job_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_ingestion_job_events_job ON ingestion_job_events(job_id, sequence);

CREATE TABLE IF NOT EXISTS ingestion_files (
  id                       TEXT PRIMARY KEY,
  job_id                   TEXT NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  relative_path            TEXT NOT NULL,
  media_type               TEXT,
  extension                TEXT,
  size_bytes               INTEGER NOT NULL DEFAULT 0,
  sha256                   TEXT,
  status                   TEXT NOT NULL,
  locator_capabilities_json TEXT NOT NULL DEFAULT '[]',
  error_json               TEXT,
  created_at               TEXT NOT NULL,
  UNIQUE(job_id, relative_path)
);
CREATE INDEX IF NOT EXISTS idx_ingestion_files_job ON ingestion_files(job_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_files_sha256 ON ingestion_files(sha256);

CREATE TABLE IF NOT EXISTS document_chunks (
  id          TEXT PRIMARY KEY,
  file_id     TEXT NOT NULL REFERENCES ingestion_files(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  text        TEXT NOT NULL,
  locator_json TEXT NOT NULL DEFAULT '{}',
  token_count INTEGER NOT NULL DEFAULT 0,
  sha256      TEXT NOT NULL,
  UNIQUE(file_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_document_chunks_file ON document_chunks(file_id);

CREATE TABLE IF NOT EXISTS knowledge_candidates (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  source_file_id  TEXT NOT NULL REFERENCES ingestion_files(id) ON DELETE CASCADE,
  entity_key      TEXT,
  entity_type     TEXT,
  title           TEXT,
  definition      TEXT,
  aliases_json    TEXT NOT NULL DEFAULT '[]',
  relations_json  TEXT NOT NULL DEFAULT '{}',
  sources_json    TEXT NOT NULL DEFAULT '[]',
  extraction_json TEXT NOT NULL DEFAULT '{}',
  validation_json TEXT,
  conflict_json   TEXT,
  status          TEXT NOT NULL DEFAULT 'extracted',
  revision        INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_job ON knowledge_candidates(job_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_status ON knowledge_candidates(status);
CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_type ON knowledge_candidates(entity_type);
