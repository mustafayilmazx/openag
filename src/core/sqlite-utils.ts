import * as os from "node:os";
import * as path from "node:path";

export const BRAIN_DIR = path.join(os.homedir(), ".gemini", "antigravity-ide", "brain");
export const CONV_DIR = path.join(os.homedir(), ".gemini", "antigravity-ide", "conversations");

export type SqliteParam = string | number | bigint | null | undefined;
export type SqliteValue = string | number | bigint | Uint8Array | Buffer | null | undefined;

export interface SqliteStatement {
  all: <T = Record<string, SqliteValue>>(param?: SqliteParam) => T[];
  get: <T = Record<string, SqliteValue>>(param?: SqliteParam) => T | undefined;
}

export interface SqliteDb {
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}

export interface SqliteModule {
  DatabaseSync: new (p: string, opts?: { readOnly?: boolean; open?: boolean }) => SqliteDb;
}

let cachedSqlite: SqliteModule | null | undefined;

export function loadSqlite(): SqliteModule | null {
  if (cachedSqlite !== undefined) return cachedSqlite;
  try {
    // SAFETY: node:sqlite built-in DatabaseSync matches SqliteModule contract
    cachedSqlite = require("node:sqlite") as SqliteModule;
  } catch {
    cachedSqlite = null;
  }
  return cachedSqlite;
}

export function withSqliteDb<T>(dbPath: string, fn: (db: SqliteDb) => T): T | null {
  const sqlite = loadSqlite();
  if (!sqlite) return null;

  let db: SqliteDb | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true, open: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Suppress closing error if already closed or invalid
      }
    }
  }
}

