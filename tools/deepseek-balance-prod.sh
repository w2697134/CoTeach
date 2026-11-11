# 只读：查线上 teach-v2 用的 DeepSeek key 的指纹和余额，key 本身不输出
set -e
NODE=$(systemctl show teach-v2 -p ExecStart --value | grep -o 'path=[^ ;]*' | head -1 | cut -d= -f2)
[ -x "$NODE" ] || NODE=$(command -v node)
echo "node: $NODE"
systemctl show teach-v2 -p Environment -p EnvironmentFiles --value | sed -E 's/(SECRET|KEY|PASSWORD)=[^ ]*/\1=***/g'
cat > /tmp/ct_balance.mjs <<'JS'
import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
const envs = {};
const raw = execSync('systemctl show teach-v2 -p Environment --value').toString().trim();
for (const kv of raw.split(/\s+/)) { const i = kv.indexOf('='); if (i > 0) envs[kv.slice(0, i)] = kv.slice(i + 1); }
const files = execSync('systemctl show teach-v2 -p EnvironmentFiles --value').toString().trim().split('\n').map(l => l.split(' ')[0]).filter(Boolean);
for (const f of files) if (existsSync(f)) for (const line of readFileSync(f, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) envs[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); }
const dataDir = envs.TV2_DATA_DIR || '/var/lib/teach-v2';
let secret = envs.TV2_SECRET && envs.TV2_SECRET.length >= 32 ? envs.TV2_SECRET : '';
let from = 'env';
if (!secret) { secret = readFileSync(`${dataDir}/.secret`, 'utf8').trim(); from = `${dataDir}/.secret`; }
console.log('secret from:', from);
const db = new DatabaseSync(`${dataDir}/${envs.TV2_DB_FILE || 'teach.db'}`);
const rows = db.prepare('SELECT id, name, kind, enabled, api_key_enc FROM providers ORDER BY id').all();
const aes = createHash('sha256').update('tv2-aes:' + secret).digest();
for (const r of rows) {
  if (r.kind !== 'deepseek') { console.log('provider', r.id, r.name, r.kind, 'enabled', r.enabled); continue; }
  const [v, iv, tag, data] = String(r.api_key_enc).split('.');
  const d = createDecipheriv('aes-256-gcm', aes, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  const key = Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  console.log('provider', r.id, r.name, 'enabled', r.enabled, 'key 指纹', createHash('sha256').update(key).digest('hex').slice(0, 12));
  const res = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  console.log('balance', res.status, (await res.text()).slice(0, 300));
}
const since = Date.now() - 24 * 3600_000;
console.log('近24小时调用', JSON.stringify(db.prepare("SELECT status, COUNT(*) n, MAX(created_at) last FROM llm_calls WHERE created_at > ? GROUP BY status").all(since)));
console.log('近24小时余额报错', db.prepare("SELECT COUNT(*) n FROM llm_calls WHERE created_at > ? AND error LIKE '%Balance%'").get(since).n);
JS
"$NODE" /tmp/ct_balance.mjs
rm -f /tmp/ct_balance.mjs
