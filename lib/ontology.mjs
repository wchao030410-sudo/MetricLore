import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { ROOT, readJson } from "./config.mjs";
import { parseFrontmatter } from "./markdown-frontmatter.mjs";

const KEY = /^[a-z][a-z0-9-]*$/;

export class Ontology {
  constructor(schemaPath = resolve(ROOT, "ontology/schema.json")) {
    this.schema = readJson(schemaPath);
  }

  validateEntity(entity) {
    const errors = [];
    for (const field of this.schema.requiredFields) {
      if (entity[field] === undefined || entity[field] === null || entity[field] === "") errors.push(`缺少必填字段: ${field}`);
    }
    if (entity.key && !KEY.test(entity.key)) errors.push("key 必须是小写 kebab-case");
    if (entity.type && !this.schema.entityTypes[entity.type]) errors.push(`未知实体类型: ${entity.type}`);
    if (entity.status && !this.schema.statuses.includes(entity.status)) errors.push(`未知状态: ${entity.status}`);
    if (entity.sources && !Array.isArray(entity.sources)) errors.push("sources 必须是数组");
    if (entity.relations && typeof entity.relations !== "object") errors.push("relations 必须是对象");
    return errors;
  }

  validateRelations(entity, byKey) {
    const errors = [];
    for (const [relation, rawTargets] of Object.entries(entity.relations || {})) {
      const definition = this.schema.relationTypes[relation];
      if (!definition) { errors.push(`未知关系: ${relation}`); continue; }
      if (!definition.from.includes(entity.type)) errors.push(`${entity.type} 不能使用关系 ${relation}`);
      for (const targetKey of Array.isArray(rawTargets) ? rawTargets : [rawTargets]) {
        const target = byKey.get(targetKey);
        if (!target) { errors.push(`关系目标不存在: ${relation} → ${targetKey}`); continue; }
        if (!definition.to.includes(target.type)) errors.push(`${relation} 不能指向 ${target.type}`);
      }
    }
    return errors;
  }

  loadEntity(path) {
    const content = readFileSync(path, "utf8");
    const { attributes, body } = parseFrontmatter(content);
    const relations = {};
    if (Array.isArray(attributes.relations)) {
      for (const item of attributes.relations) {
        const [relation, target] = String(item).split(":");
        if (!relation || !target) continue;
        (relations[relation] ||= []).push(target);
      }
    }
    return { ...attributes, relations, content: body, path: relative(ROOT, path) };
  }

  resolveSource(entity, source) {
    const path = resolve(ROOT, source);
    if (!path.startsWith(resolve(ROOT) + "/") || !existsSync(path)) return false;
    return true;
  }
}
