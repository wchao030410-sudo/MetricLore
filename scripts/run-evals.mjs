import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import cases from "../evals/cases.mjs";
import { MetricLoreAgent } from "../lib/agent.mjs";
import { ROOT } from "../lib/config.mjs";
import { openDatabase, closeDatabase } from "../lib/database.mjs";
import { Ontology } from "../lib/ontology.mjs";
import { SemanticLayer } from "../lib/semantic-layer.mjs";
import { SkillRegistry } from "../lib/skill-registry.mjs";
import { WikiIndex } from "../lib/wiki.mjs";

const db = openDatabase(resolve(ROOT, "data/eval.db"));
const ontology = new Ontology();
const semantic = new SemanticLayer();
const wiki = new WikiIndex(undefined, ontology);
const agent = new MetricLoreAgent({ semantic, wiki, db, ontology, skills: new SkillRegistry() });
const results = [];
for (const item of cases) {
  const runs = [];
  for (let repeat = 0; repeat < 3; repeat += 1) runs.push(await agent.answer(item.question));
  const result = runs[0];
  const tools = result.toolCalls.map((call) => call.name);
  const failures = [];
  if (result.skill !== item.expected.skill) failures.push(`skill expected ${item.expected.skill}, got ${result.skill}`);
  if (result.status !== item.expected.status) failures.push(`status expected ${item.expected.status}, got ${result.status}`);
  for (const tool of item.expected.tools || []) if (!tools.includes(tool)) failures.push(`missing tool ${tool}`);
  for (const forbidden of item.expected.forbidden || []) if (result.answer.includes(forbidden)) failures.push(`forbidden text ${forbidden}`);
  const signatures = runs.map((run) => JSON.stringify({ skill: run.skill, status: run.status, tools: run.toolCalls.map((call) => call.name), answer: run.answer }));
  const consistent = new Set(signatures).size === 1;
  if (!consistent) failures.push("three repeated runs produced different public results");
  results.push({ id: item.id, group: item.group, question: item.question, pass: failures.length === 0, failures, skill: result.skill, status: result.status, tools, consistent });
}
closeDatabase();
const passed = results.filter((item) => item.pass).length;
const consistencyRate = results.filter((item) => item.consistent).length / results.length;
const report = { generatedAt: new Date().toISOString(), caseCount: results.length, repeatedRuns: 3, passed, failed: results.length - passed, passRate: passed / results.length, consistencyRate, results };
const output = resolve(ROOT, "outputs/evals/latest.json");
mkdirSync(resolve(ROOT, "outputs/evals"), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2));
const escape = (value) => String(value).replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
const html = `<!doctype html><meta charset="utf-8"><title>MetricLore Eval Report</title><style>body{font-family:system-ui;margin:40px;color:#17221d}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #dfe7e1;padding:8px;text-align:left}.pass{color:#0d7a50}.fail{color:#b42318}</style><h1>MetricLore Evaluation</h1><p>Generated: ${escape(report.generatedAt)}</p><h2>${passed}/${results.length} passed (${(report.passRate * 100).toFixed(1)}%)</h2><p>Three-run public-result consistency: ${(report.consistencyRate * 100).toFixed(1)}%</p><table><tr><th>ID</th><th>Group</th><th>Question</th><th>Skill</th><th>Tools</th><th>Result</th></tr>${results.map((item) => `<tr><td>${escape(item.id)}</td><td>${escape(item.group)}</td><td>${escape(item.question)}</td><td>${escape(item.skill)}</td><td>${escape(item.tools.join(", "))}</td><td class="${item.pass ? "pass" : "fail"}">${item.pass ? "PASS" : escape(item.failures.join("; "))}</td></tr>`).join("")}</table>`;
writeFileSync(resolve(ROOT, "outputs/evals/latest.html"), html);
console.log(JSON.stringify({ caseCount: report.caseCount, repeatedRuns: report.repeatedRuns, passed, failed: report.failed, passRate: report.passRate, consistencyRate: report.consistencyRate, output: "outputs/evals/latest.json", html: "outputs/evals/latest.html" }, null, 2));
if (report.failed) process.exitCode = 1;
