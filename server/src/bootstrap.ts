import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { db, getSetting, now, setSetting } from './db/index.js';
import { ensureTeacherKb, startingKb } from './kb/repo.js';
import { migrateOwnership, recoverRepositoryRefs } from './kb/migrate.js';
import { encrypt, hashPassword, randomToken } from './lib/crypto.js';

/** 启动时补齐超级管理员、演示老师、演示课程和模型服务 */
export async function bootstrap() {
  ensureRoot();
  ensureProviderFromEnv();
  ensureAgyFromEnv();
  await ensureDemo();
  ensureDemoStudent();
  await migrateOwnership();
  for (const u of db.all<{ id: number }>("SELECT id FROM users WHERE role='teacher'")) await startingKb(u.id);
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

/**
 * 有服务器本机的 Gemini 接口（环境变量 CT_AGY_URL，比如 http://127.0.0.1:8467/v1）就接上 Gemini 4 Hydrogen（CT_AGY_MODEL 可换），
 * 第一次接上时设成默认模型，原来的默认（DeepSeek）当备用：它出错或一直没动静就换 DeepSeek。
 */
function ensureAgyFromEnv() {
  const url = process.env.CT_AGY_URL?.trim();
  if (!url) return;
  const model = process.env.CT_AGY_MODEL?.trim() || 'gemini-4-hydrogen';
  const t = now();
  let pid = db.value<number>("SELECT id FROM providers WHERE kind='agy' ORDER BY id LIMIT 1");
  if (!pid)
    pid = db.insert('providers', {
      name: 'Gemini 接口（服务器本机）',
      kind: 'agy',
      protocol: 'openai',
      base_url: url,
      api_key_enc: encrypt(''),
      headers: {},
      enabled: 1,
      sort: 0,
      created_at: t,
      updated_at: t,
    });
  else db.update('providers', pid, { base_url: url, updated_at: t });
  let mid = db.value<number>('SELECT id FROM models WHERE provider_id=? AND model=?', pid, model);
  if (!mid)
    mid = db.insert('models', {
      provider_id: pid,
      model,
      label: 'Gemini 4 Hydrogen',
      caps: { chat: true, tools: true, vision: true, reasoning: true },
      context_window: 1_000_000,
      enabled: 1,
      sort: 0,
      created_at: t,
    });
  if (getSetting('agy_default_set', false)) return;
  const old = getSetting<number | null>('default_model_id', null);
  if (old && old !== mid) setSetting('fallback_model_id', old);
  setSetting('default_model_id', mid);
  setSetting('agy_default_set', true);
  console.log(`[bootstrap] 默认模型换成 ${model}（Gemini 接口），原来的默认模型当备用`);
}

async function ensureDemo() {
  // 演示老师被设成正式账号以后不再补一个新的
  if (!config.demoMode || getSetting('demo_teacher_claimed', false) || db.get("SELECT id FROM users WHERE username = 'teacher'")) return;
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

/** 演示学生；演示老师设成正式账号以后，演示学生也不再补（tools/test-accounts 会把它改成 s0） */
function ensureDemoStudent() {
  if (!config.demoMode || getSetting('demo_teacher_claimed', false) || db.get("SELECT id FROM users WHERE username = 'student'")) return;
  db.insert('users', {
    username: 'student',
    name: '李明',
    role: 'student',
    password_hash: hashPassword(randomToken(12)),
    is_demo: 1,
    created_at: now(),
  });
  console.log('[bootstrap] 已创建演示学生');
}
