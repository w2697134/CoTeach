import { randomInt } from 'node:crypto';
import { db, now } from './db/index.js';
import { sha256 } from './lib/crypto.js';

/**
 * 登录密钥：一个号一把，登录页贴上就进这个号，不用输账号密码。
 * 样子像 CT-7K3Q-9XWP-M2DH-4RTA：去掉了 0 O 1 I L 这些容易看错的字；贴的时候大小写、空格、横杠都不讲究。
 * 16 位、每位 31 种，猜不出来。库里只存 sha256，原文只在发的时候给一次。
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const LEN = 16;

export function newLoginKey(): string {
  let s = '';
  for (let i = 0; i < LEN; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return 'CT-' + s.match(/.{4}/g)!.join('-');
}

/** 贴进来的密钥去掉格式，只留 16 位；对不上的返回空 */
export function keyCore(raw: string): string {
  let s = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (s.length === LEN + 2 && s.startsWith('CT')) s = s.slice(2);
  return s.length === LEN && [...s].every((ch) => ALPHABET.includes(ch)) ? s : '';
}

const keyHash = (core: string) => sha256('ct-login-key:' + core);

/** 这个号手里有没有能用的密钥 */
export function hasLoginKey(userId: number): boolean {
  return !!db.get('SELECT 1 FROM login_keys WHERE user_id=? AND revoked_at IS NULL', userId);
}

/** 有没有哪个号拿着能用的密钥（有才在登录页上露出「用密钥登录」） */
export const anyLoginKey = () => !!db.get('SELECT 1 FROM login_keys WHERE revoked_at IS NULL LIMIT 1');

/** 给这个号发一把新的，原来那把停用；原文只在这里给一次 */
export function issueLoginKey(userId: number): string {
  const key = newLoginKey(),
    core = keyCore(key),
    t = now();
  db.tx(() => {
    db.run('UPDATE login_keys SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', t, userId);
    db.insert('login_keys', { user_id: userId, key_hash: keyHash(core), hint: core.slice(-4), created_at: t });
  });
  return key;
}

/** 停用这个号的密钥，这个号在别处登着的都退出；本来就没有返回 false */
export function revokeLoginKey(userId: number): boolean {
  return db.tx(() => {
    const r = db.run('UPDATE login_keys SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', now(), userId);
    if (r.changes) db.run('DELETE FROM sessions WHERE user_id=?', userId);
    return r.changes > 0;
  });
}

/** 按贴进来的密钥找是哪个号；对不上、停用了都返回空 */
export function findLoginKey(raw: string) {
  const core = keyCore(raw);
  if (!core) return null;
  return db.get<{ id: number; user_id: number }>('SELECT id, user_id FROM login_keys WHERE key_hash=? AND revoked_at IS NULL', keyHash(core)) || null;
}

export const touchLoginKey = (id: number) => db.run('UPDATE login_keys SET last_used_at=? WHERE id=?', now(), id);

/** 管理页上显示：末 4 位、哪天发的、最近一次用 */
export function loginKeyInfo(userId: number) {
  const k = db.get<{ hint: string; created_at: number; last_used_at: number | null }>(
    'SELECT hint, created_at, last_used_at FROM login_keys WHERE user_id=? AND revoked_at IS NULL',
    userId,
  );
  return k ? { hint: k.hint, createdAt: k.created_at, lastUsedAt: k.last_used_at } : null;
}
