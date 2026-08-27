import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ROOT } from "./config.mjs";

let singleton;

export function openDatabase(path = process.env.DATABASE_PATH || resolve(ROOT, "data/metriclore.db")) {
  if (singleton && path === singleton.path) return singleton.db;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_metrics'").get();
  if (!row) db.exec(readFileSync(resolve(ROOT, "data/seed.sql"), "utf8"));
  singleton = { path, db };
  return db;
}

export function closeDatabase() {
  if (!singleton) return;
  singleton.db.close();
  singleton = undefined;
}
