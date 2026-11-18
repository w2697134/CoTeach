import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDataLock } from './data-lock.js';

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
export const releaseDataLock = acquireDataLock(dataDir);

/** 第一次启动时生成应用密钥并保存，用来加密 API Key */
function loadSecret(): string {
  if (env.CT_SECRET && env.CT_SECRET.length >= 32) return env.CT_SECRET;
  const file = resolve(dataDir, '.secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(48).toString('base64url');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function dashscopeKey(): string {
  if (env.CT_DASHSCOPE_KEY?.trim()) return env.CT_DASHSCOPE_KEY.trim();
  const file = env.CT_DASHSCOPE_KEY_FILE;
  if (!file || !existsSync(file)) return '';
  return readFileSync(file, 'utf8').match(/sk-[A-Za-z0-9_-]+/)?.[0] || '';
}

export const config = {
  env: env.NODE_ENV === 'production' ? 'production' : 'development',
  host: env.CT_HOST || '127.0.0.1',
  port: Number(env.CT_PORT || 18660),
  dataDir,
  dbFile: resolve(dataDir, env.CT_DB_FILE || 'coteach.db'),
  /** 旧课程仓库的迁移来源；新库与历史档案见 knowledge/、archives/ */
  kbDir: resolve(dataDir, 'kb'),
  webDir: resolve(env.CT_WEB_DIR || resolve(serverRoot, 'dist', 'web')),
  secret: loadSecret(),
  gitBin: env.CT_GIT || 'git',
  /** 登录页是否显示演示账号 */
  demoMode: env.CT_DEMO_MODE !== '0',
  /** 每个用户每天调用模型的次数上限，0 为不限 */
  dailyCallLimit: Number(env.CT_DAILY_CALL_LIMIT || 400),
  /** 整理助手每个老师每天最多跑几轮（一轮里会调好多次模型），0 为不限；管理员不限 */
  keeperDailyTurns: Number(env.CT_KEEPER_DAILY_TURNS || 200),
  sessionDays: Number(env.CT_SESSION_DAYS || 14),
  /**
   * 只让这几个账号登录（用户名，逗号分开；管理员总能登）。设了就不开放注册、演示入口，已经登着的不在名单里也算退出。
   * 比赛期间线上只开放给评委。不设就照旧。
   */
  loginOnly: (env.CT_LOGIN_ONLY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /**
   * 账号密码登录开不开（默认开）。设成 off：只能用登录密钥进（管理员除外），注册和演示入口关掉，登录页上「账号密码」显示暂未开放；
   * 没有密钥的号已经登着的也算退出。
   */
  passwordLogin: env.CT_PASSWORD_LOGIN !== 'off',
  /** 语音输入用的阿里云百炼 key：CT_DASHSCOPE_KEY，或者 CT_DASHSCOPE_KEY_FILE 指的文件（里面那串 sk-… 就行）。没有就不开语音输入，见 voice.ts */
  dashscopeKey: dashscopeKey(),
  /** 当面等回话的智能体先用备用模型（快），主模型当备用；逗号分开，设成空就都照默认顺序。见 assistant/model.ts 的 orderFor */
  fastAgents: (env.CT_FAST_AGENTS ?? 'ta,stu')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** 交资料：单个文件、一次交的总量、单份资料、压缩包里的文件数和解开后的总量 */
  intake: {
    maxFileBytes: Number(env.CT_INTAKE_MAX_FILE_MB || 500) * 1024 * 1024,
    maxBatchBytes: Number(env.CT_INTAKE_MAX_BATCH_MB || 500) * 1024 * 1024,
    maxDocBytes: Number(env.CT_INTAKE_MAX_DOC_MB || 200) * 1024 * 1024,
    maxEntries: Number(env.CT_INTAKE_MAX_ENTRIES || 3000),
    maxExpandBytes: Number(env.CT_INTAKE_MAX_EXPAND_MB || 4096) * 1024 * 1024,
    /** 留给服务器其他服务的磁盘空间（服务器是共用的） */
    reserveBytes: Number(env.CT_INTAKE_RESERVE_MB || 10240) * 1024 * 1024,
    workers: Math.max(1, Number(env.CT_INTAKE_WORKERS || 2)),
    workerMemoryMb: Number(env.CT_INTAKE_WORKER_MB || 1024),
    readTimeoutMs: Number(env.CT_INTAKE_READ_TIMEOUT_S || 600) * 1000,
    visionConcurrency: Math.max(1, Number(env.CT_INTAKE_VISION_CONCURRENCY || 3)),
  },
};

if (!existsSync(config.kbDir)) mkdirSync(config.kbDir, { recursive: true });

export const isProd = config.env === 'production';
