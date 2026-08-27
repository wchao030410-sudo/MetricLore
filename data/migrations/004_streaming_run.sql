-- v0.2 M4: Streaming Run
-- 保存创建型消息请求的幂等结果，避免网络重试重复创建消息和 Agent Run。

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope         TEXT NOT NULL,
  key           TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys(created_at);
