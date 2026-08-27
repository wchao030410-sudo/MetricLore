import { parseFrontmatter } from "../../markdown-frontmatter.mjs";

function splitByHeadings(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = null;
  const heading = (line) => line.match(/^(#{1,6})\s+(.+)$/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = heading(lines[index]);
    if (match) {
      if (current) sections.push(current);
      current = { title: match[2].trim(), startLine: index + 1, lines: [] };
    } else if (current) {
      current.lines.push(lines[index]);
    } else if (lines[index].trim()) {
      current = { title: null, startLine: index + 1, lines: [lines[index]] };
    }
  }
  if (current) sections.push(current);
  return sections.map((section) => ({
    text: section.lines.join("\n").trim(),
    locator: { section: section.title || undefined, startLine: section.startLine, endLine: section.startLine + section.lines.length - 1 },
  })).filter((segment) => segment.text.length > 0);
}

function mdParser() {
  return {
    id: "markdown",
    extensions: ["md", "markdown"],
    mediaTypes: ["text/markdown"],
    parse(input) {
      const content = input.buffer.toString("utf8");
      const { attributes, body } = parseFrontmatter(content);
      const hints = [];
      if (attributes.key && attributes.type && attributes.title) {
        const relations = {};
        for (const item of Array.isArray(attributes.relations) ? attributes.relations : []) {
          const [relation, target] = String(item).split(":");
          if (relation && target) (relations[relation] ||= []).push(target);
        }
        hints.push({
          kind: "entity",
          entity: {
            key: attributes.key,
            type: attributes.type,
            title: attributes.title,
            definition: body.trim().slice(0, 1000) || null,
            aliases: attributes.aliases || [],
            relations,
            status: attributes.status || "candidate",
            sources: attributes.sources || [],
          },
          locator: { section: attributes.title, startLine: 1 },
        });
      }
      return { text: body, segments: splitByHeadings(body), hints, locatorCapabilities: ["section", "line"], metadata: { title: attributes.title || null } };
    },
  };
}

function txtParser() {
  return {
    id: "text",
    extensions: ["txt", "text", "log"],
    mediaTypes: ["text/plain"],
    parse(input) {
      const text = input.buffer.toString("utf8");
      const lines = text.split(/\r?\n/);
      return { text, segments: text.trim() ? [{ text: text.trim(), locator: { startLine: 1, endLine: lines.length } }] : [], hints: [], locatorCapabilities: ["line"] };
    },
  };
}

function sqlParser() {
  const CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?["'`]?([\w.]+)["'`]?\s*\(([\s\S]*?)\)/gi;
  return {
    id: "sql",
    extensions: ["sql"],
    mediaTypes: ["application/sql", "text/x-sql", "application/x-sql"],
    parse(input) {
      const text = input.buffer.toString("utf8");
      const hints = [];
      for (const match of text.matchAll(CREATE_TABLE)) {
        const table = match[1];
        const body = match[2];
        const columns = body
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part && !/^\s*(primary\s+key|unique|constraint|foreign\s+key|check)/i.test(part))
          .map((part) => {
            const tokens = part.split(/\s+/);
            return { name: (tokens[0] || "").replace(/["'`]/g, ""), type: tokens.slice(1).join(" ") };
          })
          .filter((column) => column.name);
        const before = text.slice(0, match.index);
        const startLine = before.split("\n").length;
        hints.push({ kind: "sql_table", table, columns, locator: { startLine, section: table } });
      }
      const statements = text.split(";").map((statement) => statement.trim()).filter(Boolean);
      const segments = statements.map((statement, index) => ({ text: statement, locator: { statement: index + 1 } }));
      return { text, segments, hints, locatorCapabilities: ["line"] };
    },
  };
}

export function registerTextParsers(registry) {
  registry.register(mdParser());
  registry.register(txtParser());
  registry.register(sqlParser());
  return registry;
}
