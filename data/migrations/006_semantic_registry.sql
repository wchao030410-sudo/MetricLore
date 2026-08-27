-- v0.2 post-release: user-managed metric registry
-- 自定义指标保存在 SQLite，启动时与 config/semantic-model.json 的基础指标合并。

CREATE TABLE IF NOT EXISTS semantic_metrics (
  key             TEXT PRIMARY KEY,
  definition_json TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_semantic_metrics_updated ON semantic_metrics(updated_at DESC);

