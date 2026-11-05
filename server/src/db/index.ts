import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { config } from '../config.js';
import { migrations } from './schema.js';

type Param = string | number | bigint | null | Uint8Array | boolean | undefined;
export type Row = Record<string, any>;

/**
 * 对 node:sqlite 的简单封装：
 * 语句缓存、参数转换、事务和 JSON 字段读写。
 */
class Database {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA temp_store = MEMORY');
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private norm(params: Param[]): any[] {
    return params.map(p => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...this.norm(params)) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...this.norm(params)) as T[];
  }

  run(sql: string, ...params: Param[]) {
    const r = this.stmt(sql).run(...this.norm(params));
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  }

  /** 取单个标量值 */
  value<T = any>(sql: string, ...params: Param[]): T | undefined {
    const row = this.get<Row>(sql, ...params);
    if (!row) return undefined;
    const k = Object.keys(row)[0];
    return row[k] as T;
  }

  exec(sql: string) {
    this.raw.exec(sql);
  }

  /** 插入一行并返回 id，对象和数组字段存成 JSON */
  insert(table: string, data: Record<string, any>): number {
    const keys = Object.keys(data).filter(k => data[k] !== undefined);
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    return this.run(sql, ...keys.map(k => toDb(data[k]))).id;
  }

  /** 按 id 更新部分字段 */
  update(table: string, id: number | string, data: Record<string, any>, idCol = 'id') {
    const keys = Object.keys(data).filter(k => data[k] !== undefined);
    if (!keys.length) return 0;
    const sql = `UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`;
    return this.run(sql, ...keys.map(k => toDb(data[k])), id).changes;
  }

  /** 事务（支持嵌套，内层使用 SAVEPOINT） */
  tx<T>(fn: () => T): T {
    const sp = `sp_${this.depth}`;
    if (this.depth === 0) this.raw.exec('BEGIN IMMEDIATE');
    else this.raw.exec(`SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      if (this.depth === 0) this.raw.exec('COMMIT');
      else this.raw.exec(`RELEASE ${sp}`);
      return result;
    } catch (err) {
      this.depth--;
      if (this.depth === 0) this.raw.exec('ROLLBACK');
      else this.raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  migrate() {
    this.raw.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const done = new Set(this.all<{ version: number }>('SELECT version FROM _migrations').map(r => r.version));
    migrations.forEach((sql, i) => {
      const version = i + 1;
      if (done.has(version)) return;
      this.tx(() => {
        this.raw.exec(sql);
        this.run('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)', version, Date.now());
      });
      console.log(`[db] migration ${version} applied`);
    });
  }
}

function toDb(v: any): Param {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

/** 解析 JSON 字段，出错时返回默认值 */
export function j<T = any>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** 解析一行里的多个 JSON 字段 */
export function parseRow<T extends Row>(row: T | undefined, jsonFields: string[], fallbacks: Record<string, any> = {}): T | undefined {
  if (!row) return row;
  const out: Row = { ...row };
  for (const f of jsonFields) {
    if (f in out) out[f] = j(out[f], fallbacks[f] ?? null);
  }
  return out as T;
}

export function parseRows<T extends Row>(rows: T[], jsonFields: string[], fallbacks: Record<string, any> = {}): T[] {
  return rows.map(r => parseRow(r, jsonFields, fallbacks)!);
}

export const db = new Database(config.dbFile);
db.migrate();

export const now = () => Date.now();

/** 读取 / 写入系统设置 */
export function getSetting<T = any>(key: string, fallback: T): T {
  const v = db.value<string>('SELECT value FROM settings WHERE key = ?', key);
  return v === undefined ? fallback : j<T>(v, fallback);
}

export function setSetting(key: string, value: any) {
  db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}
