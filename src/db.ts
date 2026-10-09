import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  niches_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS creators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  niches_json TEXT NOT NULL,
  raw_payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  platform TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  views INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  raw_payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS social_accounts_by_creator ON social_accounts (creator_id);
CREATE INDEX IF NOT EXISTS metrics_latest_by_account ON metrics (account_id, captured_at, id);
CREATE INDEX IF NOT EXISTS deliveries_by_creator_date ON deliveries (creator_id, delivered_at);
`;

type SqlValue = string | number | bigint | null;

let queryCount = 0;

export function resetQueryCount(): void {
  queryCount = 0;
}

export function getQueryCount(): number {
  return queryCount;
}

export function openDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export async function all<T>(db: DatabaseSync, sql: string, ...params: SqlValue[]): Promise<T[]> {
  queryCount += 1;
  return db.prepare(sql).all(...params) as T[];
}

export async function get<T>(db: DatabaseSync, sql: string, ...params: SqlValue[]): Promise<T | undefined> {
  queryCount += 1;
  const row = db.prepare(sql).get(...params);
  if (row === undefined || row === null) return undefined;
  return row as T;
}
