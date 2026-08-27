-- v0.3 M4: multi-model auto routing
-- 会话上下文记录所属语义模型，支持跨模型自动路由与追问继承。

ALTER TABLE conversation_context ADD COLUMN model_id TEXT;
