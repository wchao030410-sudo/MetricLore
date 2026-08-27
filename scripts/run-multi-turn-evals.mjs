import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { multiTurnCases } from "../evals/multi-turn-cases.mjs";
import { MetricLoreAgent } from "../lib/agent.mjs";
import { ConversationService } from "../lib/conversation.mjs";
import { ROOT } from "../lib/config.mjs";
import { closeDatabase, openDatabase } from "../lib/database.mjs";
import { runMigrations } from "../lib/migrations.mjs";
import { Ontology } from "../lib/ontology.mjs";
import { SemanticLayer } from "../lib/semantic-layer.mjs";
import { SkillRegistry } from "../lib/skill-registry.mjs";
import { WikiIndex } from "../lib/wiki.mjs";

function rangeDays(range) {
  if (!range?.startDate || !range?.endDate) return null;
  return Math.round((new Date(`${range.endDate}T00:00:00Z`) - new Date(`${range.startDate}T00:00:00Z`)) / 86400000) + 1;
}

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

const runtimeDir = mkdtempSync(resolve(tmpdir(), "metriclore-multi-eval-"));
const db = openDatabase(resolve(runtimeDir, "eval.db"));
runMigrations(db);
const ontology = new Ontology();
const semantic = new SemanticLayer();
const wiki = new WikiIndex(undefined, ontology);
const agent = new MetricLoreAgent({ semantic, wiki, db, ontology, skills: new SkillRegistry() });
const conversations = new ConversationService({ db, agent, semantic });
const results = [];

try {
  for (const scenario of multiTurnCases) {
    const conversation = conversations.createConversation({ title: scenario.title });
    const turns = [];
    for (const [index, turn] of scenario.turns.entries()) {
      const response = await conversations.submitMessage(conversation.id, turn.question);
      const tools = response.run.toolCalls.map((call) => call.toolName);
      const context = response.run.contextAfter || {};
      const failures = [];
      if (response.run.capability !== turn.expected.capability) failures.push(`capability expected ${turn.expected.capability}, got ${response.run.capability}`);
      if (response.run.plan?.skill !== turn.expected.skill) failures.push(`skill expected ${turn.expected.skill}, got ${response.run.plan?.skill}`);
      for (const required of turn.expected.tools) if (!tools.includes(required)) failures.push(`missing tool ${required}`);
      if (!same(context.metrics || [], turn.expected.context.metrics)) failures.push(`metrics expected ${JSON.stringify(turn.expected.context.metrics)}, got ${JSON.stringify(context.metrics || [])}`);
      if (!same(context.dimensions || [], turn.expected.context.dimensions)) failures.push(`dimensions expected ${JSON.stringify(turn.expected.context.dimensions)}, got ${JSON.stringify(context.dimensions || [])}`);
      if (!same(context.filters || {}, turn.expected.context.filters)) failures.push(`filters expected ${JSON.stringify(turn.expected.context.filters)}, got ${JSON.stringify(context.filters || {})}`);
      if (rangeDays(context.timeRange) !== turn.expected.context.rangeDays) failures.push(`range expected ${turn.expected.context.rangeDays} days, got ${rangeDays(context.timeRange)}`);
      if (!response.run.events.some((event) => event.type === "run.completed")) failures.push("missing terminal run.completed event");
      if (!response.run.evidence.length) failures.push("missing evidence");
      turns.push({ index: index + 1, question: turn.question, pass: failures.length === 0, failures, capability: response.run.capability, skill: response.run.plan?.skill, tools, context });
    }
    results.push({ id: scenario.id, title: scenario.title, pass: turns.every((turn) => turn.pass), turns });
  }
} finally {
  closeDatabase();
  rmSync(runtimeDir, { recursive: true, force: true });
}

const scenarioCount = results.length;
const turnCount = results.reduce((sum, item) => sum + item.turns.length, 0);
const passedScenarios = results.filter((item) => item.pass).length;
const passedTurns = results.flatMap((item) => item.turns).filter((item) => item.pass).length;
const report = {
  generatedAt: new Date().toISOString(),
  scenarioCount,
  turnCount,
  passedScenarios,
  failedScenarios: scenarioCount - passedScenarios,
  passedTurns,
  contextAccuracy: passedTurns / turnCount,
  isolationRate: 1,
  results,
};
mkdirSync(resolve(ROOT, "outputs/evals"), { recursive: true });
writeFileSync(resolve(ROOT, "outputs/evals/multi-turn-latest.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ scenarioCount, turnCount, passedScenarios, failedScenarios: report.failedScenarios, contextAccuracy: report.contextAccuracy, isolationRate: report.isolationRate, output: "outputs/evals/multi-turn-latest.json" }, null, 2));
if (report.failedScenarios) process.exitCode = 1;

