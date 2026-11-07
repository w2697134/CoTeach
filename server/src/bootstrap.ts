import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { db, getSetting, now, setSetting } from './db/index.js';
import { ensureTeacherKb } from './kb/repo.js';
import { migrateOwnership, recoverRepositoryRefs } from './kb/migrate.js';
import { encrypt, hashPassword, randomToken } from './lib/crypto.js';

/** 启动时补齐超级管理员、演示老师、演示课程和模型服务 */
export async function bootstrap() {
  ensureRoot();
  ensureProviderFromEnv();
  await ensureDemo();
  await migrateOwnership();
  for (const u of db.all<{ id: number; name: string }>("SELECT id,name FROM users WHERE role='teacher'")) await ensureTeacherKb(u.id, u.name);
  recoverRepositoryRefs();
}

function ensureRoot() {
  if (db.get('SELECT id FROM users WHERE is_super = 1')) return;
  const password = process.env.CT_ROOT_PASSWORD || randomToken(9);
  db.insert('users', {
    username: 'root',
    name: '系统管理员',
    role: 'admin',
    password_hash: hashPassword(password),
    is_super: 1,
    created_at: now(),
  });
  const file = join(config.dataDir, 'root-password.txt');
  writeFileSync(file, `超级管理员账号：root\n初始密码：${password}\n`, {
    mode: 0o600,
  });
  console.log(`[bootstrap] 已创建超级管理员，初始密码见 ${file}`);
}

/** 第一次启动时按环境变量接入 DeepSeek，所有智能体都用 V4.1 Flash */
function ensureProviderFromEnv() {
  if (getSetting('providers_bootstrapped', false)) return;
  const key = process.env.CT_BOOT_DEEPSEEK_KEY;
  if (!key) return;
  const t = now();
  const pid = db.insert('providers', {
    name: 'DeepSeek 官方',
    kind: 'deepseek',
    protocol: 'openai',
    base_url: 'https://api.deepseek.com',
    api_key_enc: encrypt(key),
    headers: {},
    enabled: 1,
    sort: 1,
    created_at: t,
    updated_at: t,
  });
  const mid = db.insert('models', {
    provider_id: pid,
    model: 'deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
    caps: { chat: true, tools: true, vision: true, reasoning: false },
    context_window: 1_000_000,
    enabled: 1,
    sort: 1,
    created_at: t,
  });
  setSetting('default_model_id', mid);
  setSetting('providers_bootstrapped', true);
  console.log('[bootstrap] 已接入 DeepSeek V4.1 Flash');
}

async function ensureDemo() {
  if (!config.demoMode || db.get("SELECT id FROM users WHERE username = 'teacher'")) return;
  const tid = db.insert('users', {
    username: 'teacher',
    name: '王建国',
    role: 'teacher',
    title: '副教授',
    password_hash: hashPassword(randomToken(12)),
    is_demo: 1,
    created_at: now(),
  });
  const kbId = await ensureTeacherKb(tid, '王建国');
  db.insert('courses', {
    name: 'Python 程序设计',
    teacher_id: tid,
    kb_id: kbId,
    created_at: now(),
  });
  console.log('[bootstrap] 已创建演示老师和演示课程');
}
