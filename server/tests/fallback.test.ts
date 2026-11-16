import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'coteach-fallback-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
const { db, setSetting } = await import('../src/db/index.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { chat } = await import('../src/llm/index.js');

/** 一个假的模型服务：收到请求就按 lines 一行一行回 SSE */
function fake(lines: string[]): Promise<{ server: Server; url: string; hits: () => number }> {
  let n = 0;
  const server = createServer((req, res) => {
    n++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const l of lines) res.write(`data: ${l}\n\n`);
      res.end();
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${(server.address() as any).port}/v1`, hits: () => n })));
}
function model(kind: string, url: string, name: string, label: string) {
  const t = Date.now();
  const pid = db.insert('providers', { name: label, kind, protocol: 'openai', base_url: url, api_key_enc: encrypt('k'), headers: {}, enabled: 1, sort: 0, created_at: t, updated_at: t });
  return db.insert('models', { provider_id: pid, model: name, label, caps: { chat: true, tools: true }, enabled: 1, sort: 0, created_at: t });
}

test('助教这种带工具的调用：Gemini 接口出错（头已经到了，只报过一段空的）就换备用模型从头来，不把错当回答', async () => {
  const agy = await fake([JSON.stringify({ choices: [{ delta: { content: 'Please provide a response that complies with content policies' }, finish_reason: 'error' }] })]);
  const ds = await fake([JSON.stringify({ choices: [{ delta: { content: '备用的回答' } }] }), JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }), '[DONE]']);
  try {
    const main = model('agy', agy.url, 'gemini-4-hydrogen', 'Gemini 4 Hydrogen');
    const back = model('deepseek', ds.url, 'deepseek-chat', 'DeepSeek');
    setSetting('default_model_id', main);
    setSetting('fallback_model_id', back);
    const uid = db.insert('users', { username: 'u1', name: '王老师', role: 'teacher', password_hash: 'x', created_at: Date.now() });
    const tools = [{ name: 'list_classes', description: '列出班级', parameters: { type: 'object', properties: {} } }];
    const r = await chat({ messages: [{ role: 'user', content: '你好' }], tools, userId: uid, countQuota: false, agentKey: 'ta', purpose: 'test' });
    assert.equal(r.text, '备用的回答');
    assert.equal(r.modelLabel, 'DeepSeek');
    assert.equal(agy.hits(), 1, 'Gemini 接口报的错不重试，直接换');
    assert.equal(ds.hits(), 1);
  } finally {
    agy.server.close();
    ds.server.close();
  }
});
