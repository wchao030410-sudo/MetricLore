-- v0.3 M1: Data workspace
-- 用户上传的数据表注册为数据源；内置事实表作为内置数据源预置。

CREATE TABLE IF NOT EXISTS data_sources (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('builtin','uploaded')),
  table_name   TEXT NOT NULL UNIQUE,
  source_file  TEXT,
  row_count    INTEGER NOT NULL DEFAULT 0,
  columns_json TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_data_sources_created ON data_sources(created_at DESC);

INSERT OR IGNORE INTO data_sources (id, name, kind, table_name, source_file, row_count, columns_json, created_at, updated_at)
SELECT 'src_builtin_daily', '电商经营日报', 'builtin', 'daily_metrics', NULL,
  (SELECT COUNT(*) FROM daily_metrics),
  json_array(
    json_object('name','date','type','TEXT','role','time'),
    json_object('name','region','type','TEXT','role','dimension'),
    json_object('name','channel','type','TEXT','role','dimension'),
    json_object('name','revenue','type','REAL','role','measure'),
    json_object('name','orders','type','INTEGER','role','measure'),
    json_object('name','visitors','type','INTEGER','role','measure')
  ),
  datetime('now'), datetime('now');
