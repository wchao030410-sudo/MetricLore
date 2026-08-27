import { AgentRuntime } from "./agent-runtime.mjs";
import { Ontology } from "./ontology.mjs";
import { SkillRegistry } from "./skill-registry.mjs";
import { ToolRegistry } from "./tool-registry.mjs";

export class MetricLoreAgent {
  constructor({ semantic, wiki, db, ontology = new Ontology(), skills = new SkillRegistry(), fetchFn }) {
    this.semantic = semantic;
    this.wiki = wiki;
    this.db = db;
    this.ontology = ontology;
    this.skills = skills;
    this.tools = new ToolRegistry({ semantic, wiki, ontology, db });
    this.runtime = new AgentRuntime({ skills, tools: this.tools, semantic, wiki, fetchFn });
  }

  async answer(message, history = [], context = {}, options = {}) {
    return this.runtime.run(message, history, context, options);
  }
}
