import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ROOT } from "./config.mjs";

export class SkillRegistry {
  constructor(root = resolve(ROOT, "skills")) {
    this.root = root;
    this.refresh();
  }

  refresh() {
    this.skills = new Map();
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = resolve(this.root, entry.name);
      const config = JSON.parse(readFileSync(resolve(dir, "skill.json"), "utf8"));
      const instructions = readFileSync(resolve(dir, "SKILL.md"), "utf8");
      this.skills.set(config.name, Object.freeze({ ...config, instructions, directory: dir }));
    }
  }

  get(name) {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`未注册的 Skill: ${name}`);
    return skill;
  }

  list() {
    return [...this.skills.values()].map(({ instructions, directory, ...skill }) => skill);
  }

  eligible(capability) {
    return this.list().filter((skill) => skill.triggers.includes(capability));
  }
}
