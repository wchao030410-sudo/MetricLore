import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { MetricLoreAgent } from "../lib/agent.mjs";
import { loadEnv, ROOT } from "../lib/config.mjs";
import { closeDatabase, openDatabase } from "../lib/database.mjs";
import { runMigrations } from "../lib/migrations.mjs";
import { Ontology } from "../lib/ontology.mjs";
import { SemanticLayer } from "../lib/semantic-layer.mjs";
import { SkillRegistry } from "../lib/skill-registry.mjs";
import { WikiIndex } from "../lib/wiki.mjs";

function parseJson(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(cleaned); } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Judge 未返回 JSON");
    return JSON.parse(match[0]);
  }
}

function bounded(value) {
  return Math.max(0, Math.min(5, Number(value) || 0));
}

function mean(values) {
  const valid = values.map(Number).filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

loadEnv();
const db = openDatabase();
runMigrations(db);
const storedDatasets = db.prepare("SELECT * FROM evaluation_dataset_versions WHERE suite = 'llm_judge' AND is_current = 1 ORDER BY dataset_key").all()
  .map((row) => ({ key: row.dataset_key, name: row.name, version: row.version, content: JSON.parse(row.content_json) }))
  .filter((item) => item.content?.cases?.length);
if (!storedDatasets.length) {
  const builtin = JSON.parse(readFileSync(resolve(ROOT, "evals/knowledge-judge.json"), "utf8"));
  storedDatasets.push({ key: "knowledge-judge", name: "知识问答质量集", version: 1, content: builtin });
}
const configured = Boolean(process.env.LLM_API_KEY && process.env.LLM_MODEL);
const outputPath = resolve(ROOT, "outputs/evals/judge-latest.json");
mkdirSync(resolve(ROOT, "outputs/evals"), { recursive: true });

if (!configured) {
  const report = {
    generatedAt: new Date().toISOString(), status: "not_configured", configured: false,
    datasetCount: storedDatasets.length, datasets: storedDatasets.map((item) => ({ key: item.key, name: item.name, version: item.version, caseCount: item.content.cases.length, scoredCases: 0, score: null, dimensions: null })),
    score: null, message: "配置 LLM_API_KEY 和 LLM_MODEL 后运行 LLM-as-a-Judge。", results: [],
  };
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  closeDatabase();
  console.log(JSON.stringify({ status: report.status, datasetCount: report.datasetCount, score: null, output: "outputs/evals/judge-latest.json" }, null, 2));
} else {
  const ontology = new Ontology();
  const semantic = new SemanticLayer(undefined, db);
  const wiki = new WikiIndex(undefined, ontology);
  const agent = new MetricLoreAgent({ semantic, wiki, db, ontology, skills: new SkillRegistry() });
  const base = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const judgeModel = process.env.LLM_JUDGE_MODEL || process.env.LLM_MODEL;

  const judgeCase = async (item) => {
    try {
      const agentStarted = performance.now();
      const answer = await agent.answer(item.question);
      const agentLatencyMs = performance.now() - agentStarted;
      const judgeStarted = performance.now();
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.LLM_API_KEY}` },
        body: JSON.stringify({
          model: judgeModel,
          temperature: 0,
          messages: [
            { role: "system", content: "你是严格的数据知识问答评审。分别按 0-5 分评估 correctness、groundedness、completeness、citationQuality。只返回 JSON：{\"correctness\":0,\"groundedness\":0,\"completeness\":0,\"citationQuality\":0,\"reason\":\"\"}。correctness 看是否符合参考答案；groundedness 看声明是否由来源支持；completeness 看关键限制是否覆盖；citationQuality 看来源是否可追溯。" },
            { role: "user", content: JSON.stringify({ question: item.question, referenceAnswer: item.referenceAnswer, requiredSources: item.requiredSources, candidateAnswer: answer.answer, candidateSources: answer.sources }) },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Judge 请求失败 (${response.status})`);
      const payload = await response.json();
      const score = parseJson(payload.choices?.[0]?.message?.content);
      const dimensions = {
        correctness: bounded(score.correctness), groundedness: bounded(score.groundedness),
        completeness: bounded(score.completeness), citationQuality: bounded(score.citationQuality),
      };
      return {
        id: item.id, question: item.question, status: "scored", dimensions,
        score: Object.values(dimensions).reduce((sum, value) => sum + value, 0) / 20,
        reason: String(score.reason || "").slice(0, 500),
        agentLatencyMs, judgeLatencyMs: performance.now() - judgeStarted,
        answer: answer.answer, sources: answer.sources,
      };
    } catch (error) {
      return { id: item.id, question: item.question, status: "failed", error: error.message };
    }
  };

  const dimensionNames = ["correctness", "groundedness", "completeness", "citationQuality"];
  const results = [];
  const datasetScores = [];
  for (const dataset of storedDatasets) {
    const perCase = [];
    for (const item of dataset.content.cases) {
      const result = await judgeCase(item);
      perCase.push(result);
      results.push({ datasetKey: dataset.key, ...result });
    }
    const scored = perCase.filter((item) => item.status === "scored");
    const dimensions = Object.fromEntries(dimensionNames.map((name) => [name, scored.length ? scored.reduce((sum, item) => sum + item.dimensions[name], 0) / scored.length / 5 : null]));
    datasetScores.push({
      key: dataset.key,
      name: dataset.name,
      version: dataset.version,
      caseCount: dataset.content.cases.length,
      scoredCases: scored.length,
      failedCases: dataset.content.cases.length - scored.length,
      score: scored.length ? scored.reduce((sum, item) => sum + item.score, 0) / scored.length : null,
      dimensions,
      averageAgentLatencyMs: mean(scored.map((item) => item.agentLatencyMs)),
      averageJudgeLatencyMs: mean(scored.map((item) => item.judgeLatencyMs)),
    });
  }
  const scores = datasetScores.map((item) => item.score).filter(Number.isFinite);
  const report = {
    generatedAt: new Date().toISOString(),
    status: scores.length === datasetScores.length ? "completed" : scores.length ? "partial" : "failed",
    configured: true,
    judgeModel,
    datasetCount: storedDatasets.length,
    datasets: datasetScores,
    score: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null,
    averageAgentLatencyMs: mean(datasetScores.map((item) => item.averageAgentLatencyMs)),
    averageJudgeLatencyMs: mean(datasetScores.map((item) => item.averageJudgeLatencyMs)),
    results,
  };
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  closeDatabase();
  console.log(JSON.stringify({ status: report.status, datasetCount: report.datasetCount, score: report.score, datasets: datasetScores.map((item) => ({ key: item.key, score: item.score })), averageAgentLatencyMs: report.averageAgentLatencyMs, output: "outputs/evals/judge-latest.json" }, null, 2));
}
