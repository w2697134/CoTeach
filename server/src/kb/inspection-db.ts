import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 原库不打开 SQLite 连接：只复制 db/WAL，SQLite 的辅助文件只会写在临时目录。 */
export function withInspectionDb<T>(dataDir: string, fn: (raw: DatabaseSync) => T, dbName = 'coteach.db'): T {
  const dir = mkdtempSync(join(tmpdir(), 'coteach-inspect-'));
  let raw: DatabaseSync | undefined;
  const read = (suffix: string): Buffer | null => {
    try {
      return readFileSync(join(dataDir, dbName + suffix));
    } catch (err) {
      if (suffix && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };
  try {
    const database = read('')!,
      wal = read('-wal');
    writeFileSync(join(dir, 'inspect.db'), database);
    if (wal) writeFileSync(join(dir, 'inspect.db-wal'), wal);
    const walAfter = read('-wal');
    if (!database.equals(read('')!) || (wal === null ? walAfter !== null : !walAfter || !wal.equals(walAfter)))
      throw new Error('数据正在变化，请停止写入后再核验');
    raw = new DatabaseSync(join(dir, 'inspect.db'), { readOnly: true });
    raw.exec('PRAGMA query_only=ON');
    if (raw.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('数据库完整性检查未通过');
    return fn(raw);
  } finally {
    raw?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
