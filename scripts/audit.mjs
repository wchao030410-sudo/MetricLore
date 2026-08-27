import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const allowed = new Set([".mjs", ".js", ".json", ".md", ".html", ".css", ".sql", ".yaml", ".yml", ".example", ".txt", ""]);
const checks = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["internal domain", /(?:joyspace|taishan|\.jd\.com)/i],
  ["internal Java package", /com\.jd\./],
];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", "node_modules", "metriclore.db"].includes(entry.name)) return [];
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const findings = [];
for (const path of walk(root)) {
  if (relative(root, path) === "scripts/audit.mjs") continue;
  if (!allowed.has(extname(path))) continue;
  const text = readFileSync(path, "utf8");
  for (const [name, pattern] of checks) if (pattern.test(text)) findings.push(`${name}: ${relative(root, path)}`);
}
if (findings.length) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Audit passed: no configured secret or internal-identifier patterns found.");
}
