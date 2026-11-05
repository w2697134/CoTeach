import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 读取 .env 文件，已有的环境变量不覆盖 */
function loadEnvFile(file: string) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
loadEnvFile(resolve(serverRoot, '.env'));
if (process.env.CT_ENV_FILE) loadEnvFile(process.env.CT_ENV_FILE);

const env = process.env;
const dataDir = resolve(env.CT_DATA_DIR || resolve(serverRoot, 'data'));
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

/** 第一次启动时生成应用密钥并保存，用来加密 API Key */
function loadSecret(): string {
  if (env.CT_SECRET && env.CT_SECRET.length >= 32) return env.CT_SECRET;
  const file = resolve(dataDir, '.secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(48).toString('base64url');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  env: env.NODE_ENV === 'production' ? 'production' : 'development',
  host: env.CT_HOST || '127.0.0.1',
  port: Number(env.CT_PORT || 18660),
  dataDir,
  dbFile: resolve(dataDir, env.CT_DB_FILE || 'coteach.db'),
  /** 每门课的知识库是一个 git 仓库，放在这里 */
  kbDir: resolve(dataDir, 'kb'),
  webDir: resolve(env.CT_WEB_DIR || resolve(serverRoot, 'dist', 'web')),
  secret: loadSecret(),
  gitBin: env.CT_GIT || 'git',
  /** 登录页是否显示演示账号 */
  demoMode: env.CT_DEMO_MODE !== '0',
  /** 每个用户每天调用模型的次数上限，0 为不限 */
  dailyCallLimit: Number(env.CT_DAILY_CALL_LIMIT || 400),
  sessionDays: Number(env.CT_SESSION_DAYS || 14),
};

if (!existsSync(config.kbDir)) mkdirSync(config.kbDir, { recursive: true });

export const isProd = config.env === 'production';
