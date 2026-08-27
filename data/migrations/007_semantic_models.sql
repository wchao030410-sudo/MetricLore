-- Multi-model semantic registry. The config model remains the built-in model;
-- user-created models and every custom metric are persisted in SQLite.

ALTER TABLE semantic_metrics RENAME TO semantic_metrics_v006;
DROP INDEX IF EXISTS idx_semantic_metrics_updated;

CREATE TABLE semantic_models (
  id                TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  table_name        TEXT NOT NULL,
  time_column       TEXT NOT NULL,
  default_metric    TEXT,
  time_grains_json  TEXT NOT NULL DEFAULT '["day","week","month"]',
  source            TEXT NOT NULL DEFAULT 'custom' CHECK (source IN ('base','custom')),
  is_active         INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_semantic_models_one_active ON semantic_models(is_active) WHERE is_active = 1;

INSERT INTO semantic_models (
  id, label, description, table_name, time_column, default_metric,
  time_grains_json, source, is_active, created_at, updated_at
) VALUES (
  'commerce_daily', '电商经营日报', '内置示例语义模型', 'daily_metrics', 'date', 'revenue',
  '["day","week","month"]', 'base', 1, datetime('now'), datetime('now')
);

CREATE TABLE semantic_metrics (
  model_id        TEXT NOT NULL REFERENCES semantic_models(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (model_id, key)
);

INSERT INTO semantic_metrics (model_id, key, definition_json, created_at, updated_at)
SELECT 'commerce_daily', key, definition_json, created_at, updated_at
FROM semantic_metrics_v006;

DROP TABLE semantic_metrics_v006;

CREATE INDEX idx_semantic_metrics_updated ON semantic_metrics(model_id, updated_at DESC);

CREATE TABLE semantic_dimensions (
  model_id        TEXT NOT NULL REFERENCES semantic_models(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (model_id, key)
);

