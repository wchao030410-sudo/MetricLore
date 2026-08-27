-- v0.2 M5: Agent Workbench
-- 保存受治理工具返回的公开数据快照，用于消息内图表和表格恢复。

ALTER TABLE agent_runs ADD COLUMN result_json TEXT;
