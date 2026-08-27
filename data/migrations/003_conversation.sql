-- v0.2 M3: Multi-turn Orchestration
-- 依据 docs/v0.2/DATA_MODEL.md，创建会话、消息、上下文、Agent Run、事件、工具调用与证据表。

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL DEFAULT 'ws_local',
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_message_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversations_workspace_last ON conversations(workspace_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id          TEXT UNIQUE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  status          TEXT NOT NULL,
  edited_from_id  TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS conversation_context (
  conversation_id             TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  version                     INTEGER NOT NULL DEFAULT 1,
  metrics_json                TEXT NOT NULL DEFAULT '[]',
  dimensions_json             TEXT NOT NULL DEFAULT '[]',
  time_range_json             TEXT,
  filters_json                TEXT NOT NULL DEFAULT '{}',
  entities_json               TEXT NOT NULL DEFAULT '[]',
  pending_clarification_json  TEXT,
  updated_at                  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id                   TEXT PRIMARY KEY,
  conversation_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_message_id      TEXT NOT NULL,
  assistant_message_id TEXT,
  status               TEXT NOT NULL,
  capability           TEXT,
  provider             TEXT,
  context_before_json  TEXT,
  context_after_json   TEXT,
  plan_json            TEXT,
  budget_json          TEXT,
  validation_json      TEXT,
  error_json           TEXT,
  started_at           TEXT,
  completed_at         TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation ON agent_runs(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_run_events (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  sequence     INTEGER NOT NULL,
  event_type   TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  UNIQUE(run_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_events_run ON agent_run_events(run_id, sequence);

CREATE TABLE IF NOT EXISTS tool_calls (
  id                   TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  sequence             INTEGER NOT NULL,
  skill_name           TEXT,
  tool_name            TEXT NOT NULL,
  args_json            TEXT NOT NULL DEFAULT '{}',
  result_summary_json  TEXT,
  status               TEXT NOT NULL,
  started_at           TEXT,
  completed_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id, sequence);

CREATE TABLE IF NOT EXISTS evidence_records (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  claim_index  INTEGER NOT NULL DEFAULT 0,
  source_type  TEXT,
  source_key   TEXT,
  source_path  TEXT,
  locator_json TEXT,
  snippet      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_records_run ON evidence_records(run_id);
