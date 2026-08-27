import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

import singleTurnCases from "../evals/cases.mjs";
import { multiTurnCases } from "../evals/multi-turn-cases.mjs";
import { ROOT } from "./config.mjs";
import { randomUUID } from "node:crypto";

import { newId } from "./ingest/util.mjs";

const execFileAsync = promisify(execFile);

function hash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function parse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function mean(values) {
  const valid = values.map(Number).filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

const BUILTIN_DATASETS = [
  { key: "agent-single", name: "单轮 Agent 回归集", suite: "single_turn", paths: ["evals/cases.mjs"], caseCount: () => singleTurnCases.length },
  { key: "agent-multi", name: "多轮上下文回归集", suite: "multi_turn", paths: ["evals/multi-turn-cases.mjs"], caseCount: () => multiTurnCases.length },
  { key: "wiki-builder", name: "Wiki Builder 闭环集", suite: "wiki_builder", paths: ["examples/wiki-builder", "scripts/run-wiki-evals.mjs"], caseCount: () => 15 },
  { key: "data-accuracy", name: "语义查询数值集", suite: "data_accuracy", paths: ["scripts/run-data-evals.mjs", "config/semantic-model.json"], caseCount: ({ semantic }) => Object.keys(semantic.model.metrics || {}).length * 4 },
  { key: "knowledge-judge", name: "知识问答质量集", suite: "llm_judge", paths: ["evals/knowledge-judge.json"], caseCount: ({ judge }) => judge.cases.length, content: ({ judge }) => judge },
];

function fileDigest(paths) {
  const chunks = [];
  const visit = (relativePath) => {
    const path = resolve(ROOT, relativePath);
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      const entries = readdirSync(path, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) visit(`${relativePath}/${entry.name}`);
    } else chunks.push(`${relativePath}\0${readFileSync(path)}`);
  };
  for (const path of paths) visit(path);
  return hash(chunks.join("\n"));
}

export class EvaluationService {
  constructor({ db, semantic, wiki, runScript } = {}) {
    this.db = db;
    this.semantic = semantic;
    this.wiki = wiki;
    this.runScript = runScript || this.executeScript.bind(this);
    this.activeRun = null;
    this.refreshDatasets();
  }

  judgeSeed() {
    return JSON.parse(readFileSync(resolve(ROOT, "evals/knowledge-judge.json"), "utf8"));
  }

  refreshDatasets() {
    const judge = this.judgeSeed();
    for (const definition of BUILTIN_DATASETS) {
      const current = this.db.prepare("SELECT * FROM evaluation_dataset_versions WHERE dataset_key = ? AND is_current = 1").get(definition.key);
      if (definition.key === "knowledge-judge" && current?.origin === "user") continue;
      const digest = fileDigest(definition.paths);
      if (current?.content_hash === digest) continue;
      const content = definition.content?.({ judge, semantic: this.semantic }) || null;
      this.insertDatasetVersion({
        key: definition.key,
        name: definition.name,
        suite: definition.suite,
        contentHash: digest,
        caseCount: definition.caseCount({ judge, semantic: this.semantic }),
        sourcePaths: definition.paths,
        content,
        origin: "builtin",
      });
    }
    return this.listDatasets();
  }

  insertDatasetVersion({ key, name, suite, contentHash, caseCount, sourcePaths = [], content = null, origin = "builtin" }) {
    const existing = this.db.prepare("SELECT * FROM evaluation_dataset_versions WHERE dataset_key = ? AND content_hash = ?").get(key, contentHash);
    if (existing) return this.publicDataset(existing);
    const version = this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM evaluation_dataset_versions WHERE dataset_key = ?").get(key).version;
    const now = new Date().toISOString();
    const id = newId("dataset_");
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE evaluation_dataset_versions SET is_current = 0 WHERE dataset_key = ? AND is_current = 1").run(key);
      this.db.prepare(`INSERT INTO evaluation_dataset_versions
        (id, dataset_key, name, suite, version, content_hash, case_count, source_paths_json, content_json, origin, is_current, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .run(id, key, name, suite, version, contentHash, caseCount, JSON.stringify(sourcePaths), content ? JSON.stringify(content) : null, origin, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.publicDataset(this.db.prepare("SELECT * FROM evaluation_dataset_versions WHERE id = ?").get(id));
  }

  createJudgeDatasetVersion(input = {}) {
    const name = String(input.name || "知识问答质量集").trim();
    const cases = Array.isArray(input.cases) ? input.cases : [];
    if (!name || name.length > 100) throw new Error("评测集名称不能为空且不能超过 100 个字符");
    if (!cases.length || cases.length > 100) throw new Error("Judge 评测集需要 1 到 100 条用例");
    // 传入已有 key 表示对该评测集新建版本；否则创建新的 Judge 评测集。
    const key = String(input.key || "").trim() || `judge_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const normalized = cases.map((item, index) => {
      const question = String(item.question || "").trim();
      const referenceAnswer = String(item.referenceAnswer || "").trim();
      if (!question || !referenceAnswer) throw new Error(`第 ${index + 1} 条用例缺少 question 或 referenceAnswer`);
      return {
        id: String(item.id || `judge-${String(index + 1).padStart(3, "0")}`),
        question,
        referenceAnswer,
        requiredSources: Array.isArray(item.requiredSources) ? item.requiredSources.map(String).filter(Boolean) : [],
      };
    });
    const content = { name, description: String(input.description || "").trim(), cases: normalized };
    return this.insertDatasetVersion({
      key, name, suite: "llm_judge", contentHash: hash(content), caseCount: normalized.length,
      sourcePaths: ["ui"], content, origin: "user",
    });
  }

  listJudgeDatasets() {
    return this.db.prepare("SELECT * FROM evaluation_dataset_versions WHERE suite = 'llm_judge' ORDER BY dataset_key, version DESC").all()
      .map((row) => this.publicDataset(row));
  }

  currentJudgeDatasetContent(key) {
    const row = this.db.prepare("SELECT * FROM evaluation_dataset_versions WHERE dataset_key = ? AND is_current = 1").get(key);
    return row ? { ...this.publicDataset(row), content: parse(row.content_json, null) } : null;
  }

  publicDataset(row) {
    return {
      id: row.id, key: row.dataset_key, name: row.name, suite: row.suite, version: row.version,
      contentHash: row.content_hash, caseCount: row.case_count, sourcePaths: parse(row.source_paths_json, []),
      origin: row.origin, current: Boolean(row.is_current), createdAt: row.created_at,
    };
  }

  listDatasets() {
    const rows = this.db.prepare("SELECT * FROM evaluation_dataset_versions ORDER BY dataset_key, version DESC").all();
    return rows.map((row) => this.publicDataset(row));
  }

  currentDatasetContent(key) {
    const row = this.db.prepare("SELECT content_json FROM evaluation_dataset_versions WHERE dataset_key = ? AND is_current = 1").get(key);
    return parse(row?.content_json, null);
  }

  datasetSnapshot() {
    return this.db.prepare("SELECT * FROM evaluation_dataset_versions WHERE is_current = 1 ORDER BY dataset_key").all()
      .map((row) => this.publicDataset(row));
  }

  knowledgeSnapshot() {
    const publication = this.db.prepare("SELECT id, version, status, completed_at FROM wiki_publications WHERE status = 'completed' ORDER BY version DESC LIMIT 1").get();
    const versionCount = this.db.prepare("SELECT COUNT(*) AS count FROM wiki_versions").get().count;
    const documents = (this.wiki?.documents || []).map((item) => ({ path: item.path, content: item.content, status: item.status })).sort((a, b) => a.path.localeCompare(b.path));
    const digest = hash(documents);
    return {
      label: publication ? `Wiki v${publication.version}` : `仓库快照 ${digest.slice(0, 8)}`,
      publicationId: publication?.id || null,
      publicationVersion: publication?.version || 0,
      pageVersionCount: versionCount,
      documentCount: documents.length,
      entityCount: this.wiki?.entities?.size || 0,
      contentHash: digest,
      capturedAt: new Date().toISOString(),
    };
  }

  modelSnapshot() {
    const catalog = this.semantic.catalog();
    const schema = { model: catalog.model, table: catalog.table, timeColumn: catalog.timeColumn, metrics: catalog.metrics, dimensions: catalog.dimensions };
    return { id: catalog.model, label: catalog.label, metricCount: Object.keys(catalog.metrics).length, dimensionCount: Object.keys(catalog.dimensions).length, schemaHash: hash(schema) };
  }

  createRun() {
    const running = this.db.prepare("SELECT id FROM evaluation_runs WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get();
    if (running) {
      const error = new Error("已有评测正在运行"); error.code = "EVALUATION_ALREADY_RUNNING"; error.status = 409; throw error;
    }
    this.refreshDatasets();
    const id = newId("eval_");
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO evaluation_runs
      (id, status, progress_json, dataset_snapshot_json, knowledge_snapshot_json, model_snapshot_json, created_at)
      VALUES (?, 'queued', ?, ?, ?, ?, ?)`)
      .run(id, JSON.stringify({ completed: 0, total: 5, current: "等待开始" }), JSON.stringify(this.datasetSnapshot()), JSON.stringify(this.knowledgeSnapshot()), JSON.stringify(this.modelSnapshot()), now);
    queueMicrotask(() => this.executeRun(id));
    return this.getRun(id);
  }

  async executeScript(script, { judge = false } = {}) {
    const env = { ...process.env };
    if (!judge) env.FORCE_DETERMINISTIC = "1";
    const result = await execFileAsync(process.execPath, [resolve(ROOT, script)], { cwd: ROOT, env, timeout: judge ? 10 * 60_000 : 120_000, maxBuffer: 2_000_000 });
    return result.stdout;
  }

  updateProgress(id, completed, current) {
    this.db.prepare("UPDATE evaluation_runs SET progress_json = ? WHERE id = ?").run(JSON.stringify({ completed, total: 5, current }), id);
  }

  readReport(file) {
    const path = resolve(ROOT, `outputs/evals/${file}`);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  }

  aggregateReports() {
    const single = this.readReport("latest.json");
    const multi = this.readReport("multi-turn-latest.json");
    const wiki = this.readReport("wiki-latest.json");
    const data = this.readReport("data-latest.json");
    const judge = this.readReport("judge-latest.json");
    return {
      singleTurn: single,
      multiTurn: multi,
      wiki,
      data,
      judge,
      averageLatencyMs: mean([single?.averageLatencyMs, multi?.averageLatencyMs].filter(Number.isFinite)),
    };
  }

  async executeRun(id) {
    this.activeRun = id;
    this.db.prepare("UPDATE evaluation_runs SET status = 'running', started_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    const suites = [
      ["scripts/run-evals.mjs", "单轮 Agent", false],
      ["scripts/run-multi-turn-evals.mjs", "多轮 Agent", false],
      ["scripts/run-wiki-evals.mjs", "Wiki Builder", false],
      ["scripts/run-data-evals.mjs", "数据准确率", false],
      ["scripts/run-judge-evals.mjs", "LLM Judge", true],
    ];
    try {
      for (const [index, [script, label, judge]] of suites.entries()) {
        this.updateProgress(id, index, `正在运行：${label}`);
        await this.runScript(script, { judge });
      }
      const metrics = this.aggregateReports();
      this.db.prepare("UPDATE evaluation_runs SET status = 'completed', progress_json = ?, metrics_json = ?, completed_at = ? WHERE id = ?")
        .run(JSON.stringify({ completed: 5, total: 5, current: "已完成" }), JSON.stringify(metrics), new Date().toISOString(), id);
    } catch (error) {
      this.db.prepare("UPDATE evaluation_runs SET status = 'failed', error_json = ?, completed_at = ? WHERE id = ?")
        .run(JSON.stringify({ message: error.message, stdout: error.stdout?.slice(-2000), stderr: error.stderr?.slice(-2000) }), new Date().toISOString(), id);
    } finally {
      this.activeRun = null;
    }
  }

  publicRun(row) {
    if (!row) return null;
    return {
      id: row.id, status: row.status, progress: parse(row.progress_json, {}),
      datasets: parse(row.dataset_snapshot_json, []), knowledge: parse(row.knowledge_snapshot_json, {}), model: parse(row.model_snapshot_json, {}),
      metrics: parse(row.metrics_json, null), error: parse(row.error_json, null),
      startedAt: row.started_at, completedAt: row.completed_at, createdAt: row.created_at,
    };
  }

  getRun(id) {
    return this.publicRun(this.db.prepare("SELECT * FROM evaluation_runs WHERE id = ?").get(id));
  }

  listRuns(limit = 20) {
    return this.db.prepare("SELECT * FROM evaluation_runs ORDER BY created_at DESC LIMIT ?").all(Math.min(Math.max(Number(limit) || 20, 1), 100)).map((row) => this.publicRun(row));
  }

  latestRun() {
    return this.publicRun(this.db.prepare("SELECT * FROM evaluation_runs ORDER BY created_at DESC LIMIT 1").get());
  }
}
