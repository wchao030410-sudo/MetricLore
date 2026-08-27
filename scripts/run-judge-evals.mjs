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

loadEnv();
const db = openDatabase();
runMigrations(db);
const stored = db.prepare("SELECT content_json, version FROM evaluation_dataset_versions WHERE dataset_key = 'knowledge-judge' AND is_current = 1").get();
const dataset = stored?.content_json ? JSON.parse(stored.content_json) : JSON.parse(readFileSync(resolve(ROOT, "evals/knowledge-judge.json"), "utf8"));
const configured = Boolean(process.env.LLM_API_KEY && process.env.LLM_MODEL);
const outputPath = resolve(ROOT, "outputs/evals/judge-latest.json");
mkdirSync(resolve(ROOT, "outputs/evals"), { recursive: true });

if (!configured) {
  const report = {
    generatedAt: new Date().toISOString(), status: "not_configured", configured: false,
    datasetVersion: stored?.version || 1, caseCount: dataset.cases.length, scoredCases: 0,
    score: null, dimensions: null, averageAgentLatencyMs: null, averageJudgeLatencyMs: null,
    message: "配置 LLM_API_KEY 和 LLM_MODEL 后运行 LLM-as-a-Judge。",
    results: [],
  };
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  closeDatabase();
  console.log(JSON.stringify({ status: report.status, caseCount: report.caseCount, score: null, output: "outputs/evals/judge-latest.json" }, null, 2));
} else {
  const ontology = new Ontology();
  const semantic = new SemanticLayer(undefined, db);
  const wiki = new WikiIndex(undefined, ontology);
  const agent = new MetricLoreAgent({ semantic, wiki, db, ontology, skills: new SkillRegistry() });
  const base = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const judgeModel = process.env.LLM_JUDGE_MODEL || process.env.LLM_MODEL;
  const results = [];
  for (const item of dataset.cases) {
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
      results.push({
        id: item.id, question: item.question, status: "scored", dimensions,
        score: Object.values(dimensions).reduce((sum, value) => sum + value, 0) / 20,
        reason: String(score.reason || "").slice(0, 500),
        agentLatencyMs, judgeLatencyMs: performance.now() - judgeStarted,
        answer: answer.answer, sources: answer.sources,
      });
    } catch (error) {
      results.push({ id: item.id, question: item.question, status: "failed", error: error.message });
    }
  }
  const scored = results.filter((item) => item.status === "scored");
  const dimensionNames = ["correctness", "groundedness", "completeness", "citationQuality"];
  const dimensions = Object.fromEntries(dimensionNames.map((name) => [name, scored.length ? scored.reduce((sum, item) => sum + item.dimensions[name], 0) / scored.length / 5 : null]));
  const report = {
    generatedAt: new Date().toISOString(),
    status: scored.length === dataset.cases.length ? "completed" : scored.length ? "partial" : "failed",
    configured: true,
    judgeModel,
    datasetVersion: stored?.version || 1,
    caseCount: dataset.cases.length,
    scoredCases: scored.length,
    failedCases: dataset.cases.length - scored.length,
    score: scored.length ? scored.reduce((sum, item) => sum + item.score, 0) / scored.length : null,
    dimensions,
    averageAgentLatencyMs: scored.length ? scored.reduce((sum, item) => sum + item.agentLatencyMs, 0) / scored.length : null,
    averageJudgeLatencyMs: scored.length ? scored.reduce((sum, item) => sum + item.judgeLatencyMs, 0) / scored.length : null,
    results,
  };
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  closeDatabase();
  console.log(JSON.stringify({ status: report.status, caseCount: report.caseCount, scoredCases: report.scoredCases, score: report.score, averageAgentLatencyMs: report.averageAgentLatencyMs, output: "outputs/evals/judge-latest.json" }, null, 2));
}

