-- Versioned evaluation datasets and reproducible evaluation runs.

CREATE TABLE evaluation_dataset_versions (
  id                TEXT PRIMARY KEY,
  dataset_key       TEXT NOT NULL,
  name              TEXT NOT NULL,
  suite             TEXT NOT NULL,
  version           INTEGER NOT NULL,
  content_hash      TEXT NOT NULL,
  case_count        INTEGER NOT NULL DEFAULT 0,
  source_paths_json TEXT NOT NULL DEFAULT '[]',
  content_json      TEXT,
  origin            TEXT NOT NULL DEFAULT 'builtin' CHECK (origin IN ('builtin','user')),
  is_current        INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1)),
  created_at        TEXT NOT NULL,
  UNIQUE (dataset_key, version),
  UNIQUE (dataset_key, content_hash)
);

CREATE UNIQUE INDEX idx_evaluation_dataset_current
ON evaluation_dataset_versions(dataset_key, is_current) WHERE is_current = 1;

CREATE TABLE evaluation_runs (
  id                      TEXT PRIMARY KEY,
  status                  TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  progress_json           TEXT NOT NULL DEFAULT '{}',
  dataset_snapshot_json   TEXT NOT NULL,
  knowledge_snapshot_json TEXT NOT NULL,
  model_snapshot_json     TEXT NOT NULL,
  metrics_json            TEXT,
  error_json              TEXT,
  started_at              TEXT,
  completed_at            TEXT,
  created_at              TEXT NOT NULL
);

CREATE INDEX idx_evaluation_runs_created ON evaluation_runs(created_at DESC);
