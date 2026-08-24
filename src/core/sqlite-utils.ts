import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const NON_IDE_ROOT = path.join(os.homedir(), ".gemini", "antigravity");
export const IDE_ROOT = path.join(os.homedir(), ".gemini", "antigravity-ide");

export const NON_IDE_BRAIN_DIR = path.join(NON_IDE_ROOT, "brain");
export const NON_IDE_CONV_DIR = path.join(NON_IDE_ROOT, "conversations");

export const IDE_BRAIN_DIR = path.join(IDE_ROOT, "brain");
export const IDE_CONV_DIR = path.join(IDE_ROOT, "conversations");

export const BRAIN_DIR = fs.existsSync(IDE_BRAIN_DIR) ? IDE_BRAIN_DIR : NON_IDE_BRAIN_DIR;
export const CONV_DIR = fs.existsSync(IDE_CONV_DIR) ? IDE_CONV_DIR : NON_IDE_CONV_DIR;

export function getBrainDirs(): string[] {
  const dirs: string[] = [];
  if (fs.existsSync(IDE_BRAIN_DIR)) dirs.push(IDE_BRAIN_DIR);
  if (fs.existsSync(NON_IDE_BRAIN_DIR)) dirs.push(NON_IDE_BRAIN_DIR);
  return dirs.length > 0 ? dirs : [IDE_BRAIN_DIR, NON_IDE_BRAIN_DIR];
}

export function getConvDirs(): string[] {
  const dirs: string[] = [];
  if (fs.existsSync(IDE_CONV_DIR)) dirs.push(IDE_CONV_DIR);
  if (fs.existsSync(NON_IDE_CONV_DIR)) dirs.push(NON_IDE_CONV_DIR);
  return dirs.length > 0 ? dirs : [IDE_CONV_DIR, NON_IDE_CONV_DIR];
}

export function resolveConversationDb(convId: string): string | null {
  const cleanId = convId.endsWith(".db") ? convId.slice(0, -3) : convId;
  const ideDb = path.join(IDE_CONV_DIR, `${cleanId}.db`);
  if (fs.existsSync(ideDb)) return ideDb;
  const nonIdeDb = path.join(NON_IDE_CONV_DIR, `${cleanId}.db`);
  if (fs.existsSync(nonIdeDb)) return nonIdeDb;
  return null;
}

export function resolveTranscriptPath(convId: string): string | null {
  const ideTranscript = path.join(IDE_BRAIN_DIR, convId, ".system_generated", "logs", "transcript.jsonl");
  if (fs.existsSync(ideTranscript)) return ideTranscript;
  const nonIdeTranscript = path.join(NON_IDE_BRAIN_DIR, convId, ".system_generated", "logs", "transcript.jsonl");
  if (fs.existsSync(nonIdeTranscript)) return nonIdeTranscript;
  return null;
}

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

