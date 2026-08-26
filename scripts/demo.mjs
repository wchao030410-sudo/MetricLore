import { DataAgent } from "../lib/agent.mjs";
import { openDatabase, closeDatabase } from "../lib/database.mjs";
import { Ontology } from "../lib/ontology.mjs";
import { SemanticLayer } from "../lib/semantic-layer.mjs";
import { SkillRegistry } from "../lib/skill-registry.mjs";
import { WikiIndex } from "../lib/wiki.mjs";

const ontology = new Ontology();
const semantic = new SemanticLayer();
const db = openDatabase();
const agent = new DataAgent({ db, semantic, ontology, wiki: new WikiIndex(undefined, ontology), skills: new SkillRegistry() });
for (const question of ["客单价的口径是什么？", "近14天收入为什么下降？", "执行 SQL: SELECT * FROM daily_metrics"]) {
  const result = await agent.answer(question);
  console.log(`\nQ: ${question}\nSkill: ${result.skill}\nTools: ${result.toolCalls.map((call) => call.name).join(" → ")}\nA: ${result.answer}`);
}
closeDatabase();
