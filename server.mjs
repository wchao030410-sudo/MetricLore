import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

import { DataAgent } from "./lib/agent.mjs";
import { loadEnv, ROOT } from "./lib/config.mjs";
import { openDatabase } from "./lib/database.mjs";
import { Ontology } from "./lib/ontology.mjs";
import { SemanticLayer } from "./lib/semantic-layer.mjs";
import { SkillRegistry } from "./lib/skill-registry.mjs";
import { WikiIndex } from "./lib/wiki.mjs";

loadEnv();
const db = openDatabase();
const semantic = new SemanticLayer();
const ontology = new Ontology();
const skills = new SkillRegistry();
const wiki = new WikiIndex(undefined, ontology);
const agent = new DataAgent({ semantic, wiki, db, ontology, skills });
const publicDir = resolve(ROOT, "public");

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("请求体不能超过 1 MB");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new Error("请求体必须是 JSON"); }
}

function staticFile(pathname, res) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const path = resolve(publicDir, relative);
  if (path !== publicDir && !path.startsWith(publicDir + sep)) return false;
  if (!existsSync(path) || !statSync(path).isFile()) return false;
  res.writeHead(200, {
    "content-type": mime[extname(path)] || "application/octet-stream",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  createReadStream(path).pipe(res);
  return true;
}

export function createAppServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, 200, { status: "ok", database: "sqlite", wikiDocuments: wiki.documents.length, wikiEntities: wiki.entities.size, skills: skills.list().map((item) => item.name), llmConfigured: Boolean(process.env.LLM_API_KEY) });
      }
      if (req.method === "GET" && url.pathname === "/api/catalog") return json(res, 200, semantic.catalog());
      if (req.method === "GET" && url.pathname === "/api/skills") return json(res, 200, { skills: skills.list() });
      if (req.method === "GET" && url.pathname === "/api/ontology") return json(res, 200, { schema: ontology.schema, entities: [...wiki.entities.values()].map((entity) => wiki.publicEntity(entity)) });
      if (req.method === "GET" && url.pathname.startsWith("/api/wiki/entity/")) return json(res, 200, { entity: wiki.entity(decodeURIComponent(url.pathname.slice("/api/wiki/entity/".length))) });
      if (req.method === "GET" && url.pathname.startsWith("/api/wiki/trace/")) return json(res, 200, { paths: wiki.trace(decodeURIComponent(url.pathname.slice("/api/wiki/trace/".length)), [], Number(url.searchParams.get("depth") || 2)) });
      if (req.method === "GET" && url.pathname === "/api/wiki/search") {
        return json(res, 200, { results: wiki.search(url.searchParams.get("q") || "", url.searchParams.get("limit") || 5) });
      }
      if (req.method === "POST" && url.pathname === "/api/query") {
        const result = semantic.execute(db, await body(req));
        return json(res, 200, { rows: result.rows, metrics: result.metrics, dimensions: result.dimensions, timeGrain: result.timeGrain });
      }
      if (req.method === "POST" && url.pathname === "/api/chat") return json(res, 200, await agent.answer((await body(req)).message));
      if (req.method === "GET" && staticFile(url.pathname, res)) return;
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      return json(res, 400, { error: error.message || "Bad request" });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3000);
  createAppServer().listen(port, host, () => console.log(`Data Agent: http://${host}:${port}`));
}
