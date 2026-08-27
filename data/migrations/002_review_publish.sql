-- v0.2 M2: Review and Publish
-- 依据 docs/v0.2/DATA_MODEL.md，创建审核决定、发布批次与 Wiki 版本表。

CREATE TABLE IF NOT EXISTS review_decisions (
  id                TEXT PRIMARY KEY,
  candidate_id      TEXT NOT NULL REFERENCES knowledge_candidates(id) ON DELETE CASCADE,
  decision          TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  patch_json        TEXT,
  note              TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_decisions_candidate ON review_decisions(candidate_id);

CREATE TABLE IF NOT EXISTS wiki_publications (
  id                 TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  version            INTEGER NOT NULL,
  status             TEXT NOT NULL,
  summary_json       TEXT,
  health_json        TEXT,
  index_refreshed_at TEXT,
  created_at         TEXT NOT NULL,
  completed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_wiki_publications_job ON wiki_publications(job_id);

CREATE TABLE IF NOT EXISTS wiki_versions (
  id                 TEXT PRIMARY KEY,
  entity_key         TEXT NOT NULL,
  version            INTEGER NOT NULL,
  action             TEXT NOT NULL,
  path               TEXT NOT NULL,
  content_sha256     TEXT NOT NULL,
  source_candidate_id TEXT,
  publication_id     TEXT NOT NULL REFERENCES wiki_publications(id) ON DELETE CASCADE,
  published_at       TEXT NOT NULL,
  UNIQUE(entity_key, version)
);
CREATE INDEX IF NOT EXISTS idx_wiki_versions_key ON wiki_versions(entity_key);
