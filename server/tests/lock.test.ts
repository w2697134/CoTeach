import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireDataLock } from '../src/data-lock.js';

test('运行锁排斥第二个写进程，并在正常释放、SIGTERM 和异常退出后可重取', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coteach-lock-test-'));
  try {
    // 旧 PID 被复用也不参与新锁判定。
    writeFileSync(join(dir, '.coteach-writer.lock'), JSON.stringify({ pid: process.pid, nonce: 'legacy', startedAt: 1 }));
    const release = acquireDataLock(dir);
    assert.throws(() => acquireDataLock(dir), /已有运行/);
    release();
    release();
    acquireDataLock(dir)();
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `import {acquireDataLock} from ${JSON.stringify('file:///' + resolve('src/data-lock.ts').replace(/\\/g, '/'))}; acquireDataLock(process.argv[1]); console.log('ready'); setInterval(()=>{},1000);`,
          dir,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      await once(child.stdout!, 'data');
      assert.throws(() => acquireDataLock(dir), /已有运行/);
      const exited = once(child, 'exit');
      child.kill(signal);
      await exited;
      acquireDataLock(dir)();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
