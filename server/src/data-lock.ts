import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

/** SQLite 的操作系统文件锁随进程结束释放，不依赖 PID、退出回调或删锁文件。 */
export function acquireDataLock(dataDir: string) {
  const lock = new DatabaseSync(join(dataDir, '.coteach-writer.sqlite'));
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  } catch (err) {
    lock.close();
    if ((err as Error).message.includes('locked')) throw new Error('这个数据目录已有运行中的服务或迁移程序，请先停止对应进程');
    throw err;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lock.exec('ROLLBACK');
    lock.close();
    process.removeListener('exit', release);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  };
  const stop = () => {
    release();
    process.exit(0);
  };
  process.once('exit', release);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return release;
}
