// 开发用：在一个副本里另开一套后端和页面，数据是开发库复制出来的一份，改服务器代码不会打断主目录那套。
//   node tools/dev-copy.mjs data <数据目录>            从主目录的开发库复制一份（数据库用 VACUUM INTO 读，开发服务器开着也行）
//   node tools/dev-copy.mjs api <数据目录> <后端端口>   用这份数据开后端（tsx watch；模型的设置读主目录的 server/.env，不打印）
//   node tools/dev-copy.mjs web <页面端口> <后端端口>   开页面，/api 转到这个后端
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const MAIN = resolve(process.env.CT_MAIN || 'E:/Codex/zhongzhuan/projects/coteach');
const [cmd, a, b] = process.argv.slice(2);

if (cmd === 'data') {
  const out = resolve(a);
  const dev = join(MAIN, 'server', 'data');
  if (existsSync(join(out, 'coteach.db'))) {
    console.log('已经有了，不再复制：', out);
    process.exit(0);
  }
  mkdirSync(out, { recursive: true });
  new DatabaseSync(join(dev, 'coteach.db'), { readOnly: true }).exec(`VACUUM INTO '${join(out, 'coteach.db').replace(/'/g, "''")}'`);
  copyFileSync(join(dev, '.secret'), join(out, '.secret'));
  for (const d of ['knowledge', 'kb', 'sources', 'homework', 'archives', 'uploads', 'files']) if (existsSync(join(dev, d))) cpSync(join(dev, d), join(out, d), { recursive: true });
  console.log('复制好了：', out);
} else if (cmd === 'api') {
  const env = { ...process.env, CT_DATA_DIR: resolve(a), CT_PORT: String(b), CT_ENV_FILE: join(MAIN, 'server', '.env'), CT_DEMO_MODE: '0' };
  spawn('pnpm', ['--dir', ROOT, '--filter', 'server', 'dev'], { env, stdio: 'inherit', shell: true });
} else if (cmd === 'web') {
  const env = { ...process.env, CT_WEB_PORT: String(a), CT_API_PORT: String(b) };
  spawn('pnpm', ['--dir', ROOT, '--filter', 'web', 'dev'], { env, stdio: 'inherit', shell: true });
} else {
  console.log('用法见文件开头');
  process.exit(1);
}
