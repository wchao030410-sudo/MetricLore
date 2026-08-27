import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ROOT } from "./config.mjs";

const NAME = /^(\d+)_([a-z0-9_]+)\.sql$/;

function checksum(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

/**
 * 按递增编号执行 data/migrations/*.sql，并在 schema_migrations 中记录版本、名称、时间和内容校验和。
 * 已应用的迁移再次启动时校验 checksum，不一致则抛错；迁移本身在事务内执行且幂等。
 */
export function runMigrations(db, dir = resolve(ROOT, "data/migrations")) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)");
  const applied = new Map(db.prepare("SELECT version, checksum FROM schema_migrations").all().map((row) => [row.version, row.checksum]));

  const files = readdirSync(dir)
    .filter((file) => NAME.test(file))
    .map((file) => {
      const match = file.match(NAME);
      return { version: Number(match[1]), name: match[2], file, sql: readFileSync(resolve(dir, file), "utf8") };
    })
    .sort((a, b) => a.version - b.version);

  for (const migration of files) {
    const recorded = applied.get(migration.version);
    const digest = checksum(migration.sql);
    if (recorded !== undefined) {
      if (recorded !== digest) throw new Error(`迁移 ${migration.version}_${migration.name} 的 checksum 与已记录不一致`);
      continue;
    }
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)").run(migration.version, migration.name, new Date().toISOString(), digest);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`迁移 ${migration.version}_${migration.name} 失败: ${error.message}`);
    }
  }
  return files.map(({ version, name }) => ({ version, name }));
}
