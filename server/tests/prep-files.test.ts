import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// 备课带文件：类型和大小、读成文字（交资料那一套读法）、材料进了教案课件题目、只有这节课的老师能传能看、交进知识库。模型回答是写好的。
const dir = mkdtempSync(join(tmpdir(), 'ct-prep-files-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
process.env.CT_GRADE_AUTO = '0';
process.env.CT_PACK_AUTO = '0';
const { db } = await import('../src/db/index.js');
const { config } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');
const model = await import('../src/assistant/model.js');
const F = await import('../src/prep/files.js');
const service = await import('../src/kb/intake/service.js');
const repo = await import('../src/kb/repo.js');
const app = createApp();
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

test.after(async () => {
  await service.closeReaders();
  // 交进知识库以后的整理（没有模型，很快停下）先等它收尾，再关库删目录
  for (let i = 0; i < 50 && db.get("SELECT id FROM kb_runs WHERE status='running' UNION ALL SELECT id FROM kb_inbox WHERE status='running'"); i++) await sleep(100);
  await new Promise<void>((resolve) => setImmediate(resolve));
  db.raw.close();
  (await import('../src/config.js')).releaseDataLock();
  rmSync(dir, { recursive: true, force: true });
});

test('备课带文件：PDF、PPT、Word、图片、文字、代码能带；视频、压缩包、程序、空文件、太大的、太多的不行', () => {
  F.checkFiles(['第五章讲义.pdf', '第五章/课件.pptx', '教案.docx', '板书.png', '要点.md', '例题.py', '实验.ipynb'].map((name) => ({ name, size: 10 })));
  for (const name of ['录屏.mp4', '资料.zip', '安装包.exe', '成绩.xlsx']) assert.throws(() => F.checkFiles([{ name, size: 10 }]), new RegExp(`「${name.replace('.', '\\.')}」备课用不上`));
  assert.throws(() => F.checkFiles([{ name: '讲义.pdf', size: 0 }]), /「讲义\.pdf」是空文件/);
  assert.throws(() => F.checkFiles([{ name: '讲义.pdf', size: config.intake.maxDocBytes + 1 }]), /太大了/);
  assert.throws(() => F.checkFiles([1, 2, 3].map((i) => ({ name: `${i}.pdf`, size: config.intake.maxDocBytes }))), /一次带的文件太大/);
  assert.throws(() => F.checkFiles(Array.from({ length: F.MAX_FILES + 1 }, (_, i) => ({ name: `${i}.txt`, size: 1 }))), /一次最多带 20 份/);
});

test('备课带文件：材料里短的整份给，长的几份平分剩下的字，截掉的写明后面还有多少字', () => {
  const docs = [
    { name: '第五章/短.txt', text: '短'.repeat(100) },
    { name: '长一.pdf', text: '甲'.repeat(5000) },
    { name: '长二.pdf', text: '乙'.repeat(5000) },
  ];
  assert.equal(
    F.materialBlock('老师这次给的材料：', docs, 2100),
    `老师这次给的材料：\n\n《短.txt》\n${'短'.repeat(100)}\n\n《长一.pdf》\n${'甲'.repeat(1000)}\n……（后面还有 4000 字）\n\n《长二.pdf》\n${'乙'.repeat(1000)}\n……（后面还有 4000 字）`,
  );
  assert.equal(F.materialBlock('老师这次给的材料：', []), '');
});

/* ---------------- 整个走一遍 ---------------- */

const user = (name: string) => db.insert('users', { username: randomUUID(), name, role: 'teacher', password_hash: 'not-a-login-password', created_at: Date.now() });
const teacher = user('王建国');
const other = user('李老师');
function cookie(uid: number) {
  const token = randomUUID();
  db.insert('sessions', { id: createHash('sha256').update(token).digest('hex'), user_id: uid, created_at: Date.now(), expires_at: Date.now() + 3600000 });
  return `ct_sid=${token}`;
}
const cookies: Record<string, string> = { teacher: cookie(teacher), other: cookie(other) };
async function req(path: string, body?: unknown, who = 'teacher') {
  const res = await app.request('/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: cookies[who], 'x-tv2': '1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, json: type.includes('json') ? ((await res.json()) as any) : null, raw: type.includes('json') ? null : Buffer.from(await res.arrayBuffer()) };
}
/** 传文件的原样字节：分块上传的一块、助教栏的附件 */
const send = (path: string, bytes: Uint8Array, who = 'teacher', method = 'PUT') =>
  app.request('/api' + path, { method, headers: { cookie: cookies[who], 'x-tv2': '1', 'Content-Type': 'application/octet-stream' }, body: bytes });
async function until(fn: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error(`一直没等到：${what}`);
}

/** 每一手收到的第一句（备课那几手）和老师说着改时最后那句 */
const first: Record<string, string> = {};
let askSaid = '';
model.setModelStep(async (o) => {
  const purpose = o.purpose || '';
  const users = o.messages.filter((m) => m.role === 'user').map((m) => String(m.content));
  first[purpose] = users[0];
  const afterTool = o.messages[o.messages.length - 1].role === 'tool';
  const call = (name: string, args: any) => ({ text: '', toolCalls: [{ id: `c_${randomUUID().slice(0, 6)}`, name, args, raw: '' }] });
  if (afterTool) return { text: '好了', toolCalls: [] };
  switch (purpose) {
    case 'prep:plan':
      return call('save_plan', { title: '字符串处理', goals: ['会拆学号'], steps: [{ name: '讲授', minutes: 40, content: '学号拆分' }] });
    case 'prep:deck':
      return call('save_deck', { slides: [{ layout: 'cover', title: '字符串处理' }, { layout: 'points', title: '学号拆分', points: ['split'] }] });
    case 'prep:questions':
      return call('save_questions', { practice: [{ type: 'judge', stem: '字符串能改', answer: '错' }], homework: [{ type: 'code', stem: '给手机号打码', answer: 'mask_phone', points: 100 }] });
    case 'prep:design': {
      const pages = [...String(users[0]).matchAll(/第(\d+)页：/g)].map((m) => Number(m[1]));
      return call('save_pages', { pages: pages.map((page) => ({ page, html: `<div class="slide"><h1 class="title">第${page}页</h1></div>` })) });
    }
    case 'prep:check':
      return { text: '核对过了，都对。', toolCalls: [] };
    case 'prep:ask':
      askSaid = users[users.length - 1];
      return { text: '照你给的改好了。', toolCalls: [] };
    default:
      throw new Error(`没想到会调：${purpose}`);
  }
});

const docx = async (lines: string[]) => {
  const { Document, Packer, Paragraph, TextRun } = await import('docx');
  return new Uint8Array(await Packer.toBuffer(new Document({ sections: [{ children: lines.map((t) => new Paragraph({ children: [new TextRun(t)] })) }] })));
};
const lessonStatus = (id: number) => db.value<string>('SELECT status FROM lessons WHERE id=?', id);

let ready = 0;
test('备课带文件：照交资料的路子登记进知识库、分块传上来，读出来的文字给教案课件题目当材料；页面上看得到、打得开；别的老师传不了也看不了', async () => {
  const k = (await req('/classes', { name: '计科2501' })).json.id as number;
  const md = new TextEncoder().encode('# 第五章 字符串处理\n\n## 5.1 学号拆分\n\nstu_code = "2505-07-陈思远"\n');
  const word = await docx(['第五章 课后练习', '写 mask_phone 给手机号打码']);
  // 认不出来的二进制（是字的话会被当成文字导出的「伪」文件照读）
  const broken = Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 256);

  // 拿别人的班备课带文件：不行，也不会白白登记进谁的知识库；带了用不上的文件：不行，什么都不留
  assert.equal((await req('/prep', { classId: k, files: [{ name: 'a.md', size: 3 }] }, 'other')).status, 400);
  const wrong = await req('/prep', { classId: k, request: '第五章', files: [{ name: '录屏.mp4', size: 30 }] });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /「录屏\.mp4」备课用不上/);
  assert.equal(db.value('SELECT count(*) FROM kb_intakes'), 0);
  assert.equal(db.value('SELECT count(*) FROM lessons'), 0);

  const files = [
    { name: '第五章讲义.md', size: md.length },
    { name: '课后练习.docx', size: word.length },
    { name: '坏了.pptx', size: broken.length },
  ];
  const start = await req('/prep', { classId: k, request: '第五章 字符串处理', minutes: 90, files });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const { id, intake, uploads } = start.json as { id: number; intake: { id: number; kbId: number }; uploads: { itemId: number; index: number }[] };
  // 交进的是这位老师的知识库，最外层交的（整理助手看内容放到合适的地方）
  assert.equal(db.value('SELECT teacher_id FROM knowledge_bases WHERE id=?', intake.kbId), teacher);
  assert.equal(db.value('SELECT route FROM kb_intakes WHERE id=?', intake.id), 1);
  assert.equal(uploads.length, 3);

  // 还没传：先等文件，教案不动笔
  await sleep(300);
  let l = (await req(`/prep/${id}`)).json.lesson;
  assert.equal(l.lanes.read.status, 'doing');
  assert.equal(l.lanes.plan.status, 'wait');
  assert.deepEqual(
    l.files.map((f: any) => [f.name, f.status]),
    [
      ['第五章讲义.md', 'uploading'],
      ['课后练习.docx', 'uploading'],
      ['坏了.pptx', 'uploading'],
    ],
  );
  assert.equal(first['prep:plan'], undefined);

  // 别的老师往这次交的资料里传：不行
  const item = (i: number) => `/knowledge/${intake.kbId}/intakes/${intake.id}/items/${uploads[i].itemId}?offset=0`;
  assert.notEqual((await send(item(0), md, 'other')).status, 200);
  assert.equal(db.value('SELECT received FROM kb_intake_items WHERE id=?', uploads[0].itemId), 0);

  const bytes = [md, word, broken];
  for (const [i, u] of uploads.entries()) assert.equal((await send(item(i), bytes[u.index])).status, 200);
  await until(() => lessonStatus(id) !== 'making', '备完');
  l = (await req(`/prep/${id}`)).json.lesson;
  assert.equal(l.status, 'ready', l.error);
  assert.equal(l.lanes.read.status, 'done');
  assert.match(l.lanes.read.note, /^看了《第五章讲义》《课后练习》；《坏了》.+/);
  assert.deepEqual(
    l.files.map((f: any) => [f.name, f.status]),
    [
      ['第五章讲义.md', 'read'],
      ['课后练习.docx', 'read'],
      ['坏了.pptx', 'unread'],
    ],
  );
  assert.ok(l.files[2].reason);

  // 读出来的文字（Word 也转成了字）给了教案、课件、题目那几手；核对不带
  for (const p of ['prep:plan', 'prep:deck', 'prep:questions']) {
    assert.match(first[p], /老师这次给的材料：\n\n《第五章讲义\.md》\n# 第五章 字符串处理/, p);
    assert.match(first[p], /《课后练习\.docx》\n[\s\S]*写 mask_phone 给手机号打码/, p);
    assert.doesNotMatch(first[p], /《坏了\.pptx》/, p);
  }
  assert.match(first['prep:plan'], /老师说这节课：第五章 字符串处理/);
  assert.doesNotMatch(first['prep:check'], /老师这次给的材料/);

  // 原件打得开；别的老师打不开
  const raw = await req(`/prep/${id}/files/${l.files[0].id}`);
  assert.equal(raw.status, 200);
  assert.deepEqual(new Uint8Array(raw.raw!), md);
  assert.equal((await req(`/prep/${id}/files/${l.files[0].id}`, undefined, 'other')).status, 404);

  // 交进知识库那一步：读好的放进了知识库，排上了整理（备课不等它）
  await until(() => !['uploading', 'reading'].includes(db.value<string>('SELECT status FROM kb_intakes WHERE id=?', intake.id)!), '放进知识库');
  assert.ok(repo.manifest(intake.kbId).some((e) => e.sourceId && e.path.includes('第五章讲义')));
  assert.ok(db.get("SELECT id FROM kb_inbox WHERE kb_id=? AND sender='intake' AND source_id LIKE ?", intake.kbId, `${intake.id}:%`));
  ready = id;
});

test('备课带文件：只带文件没说话的，教案那一手不再说「照授课计划备下一节」；没带文件没说话的照旧', async () => {
  const k = (await req('/classes', { name: '计科2502' })).json.id as number;
  const md = new TextEncoder().encode('第六章 函数：def 和 return');
  const a = await req('/prep', { classId: k, files: [{ name: '第六章.txt', size: md.length }] });
  assert.equal((await send(`/knowledge/${a.json.intake.kbId}/intakes/${a.json.intake.id}/items/${a.json.uploads[0].itemId}?offset=0`, md)).status, 200);
  await until(() => lessonStatus(a.json.id) !== 'making', '备完');
  assert.match(first['prep:plan'], /《第六章\.txt》\n第六章 函数：def 和 return/);
  assert.doesNotMatch(first['prep:plan'], /老师没说这节讲什么/);

  const b = await req('/prep', { classId: k });
  await until(() => lessonStatus(b.json.id) !== 'making', '备完');
  assert.match(first['prep:plan'], /老师没说这节讲什么/);
  assert.doesNotMatch(first['prep:plan'], /老师这次给的材料/);
  assert.equal((await req(`/prep/${b.json.id}`)).json.lesson.lanes.read, undefined);
});

test('助教栏带文件：先传上来拿编号，读成材料跟着那句话给助教；只能用自己传的；别的老师改不了这节课', async () => {
  assert.ok(ready, '要先有一节备好的课');
  const up = async (name: string, text: string, who = 'teacher') => (await (await send(`/homework/files?name=${encodeURIComponent(name)}`, new TextEncoder().encode(text), who, 'POST')).json()) as { id: number };
  const mine = await up('第3页照这个.txt', '标题改成「学号拆分」，代码用 split 拆成三段');
  const theirs = await up('别人的.txt', '别人的东西', 'other');
  assert.equal((await req(`/prep/${ready}/ask`, { message: '照这个改第 3 页', fileIds: [theirs.id] })).status, 400);
  assert.equal((await req(`/prep/${ready}/ask`, { message: '照这个改第 3 页', fileIds: [mine.id] }, 'other')).status, 404);
  const ask = await req(`/prep/${ready}/ask`, { message: '照这个改第 3 页', focus: { part: 'deck', page: 2 }, fileIds: [mine.id] });
  assert.equal(ask.status, 200, JSON.stringify(ask.json));
  await until(() => db.value<string>('SELECT status FROM lesson_asks WHERE id=?', ask.json.askId) !== 'running', '改完');
  assert.equal(askSaid, '（老师正看着：课件第 2 页）\n照这个改第 3 页\n\n老师这次给的材料：\n\n《第3页照这个.txt》\n标题改成「学号拆分」，代码用 split 拆成三段');
  const asks = (await req(`/prep/${ready}`)).json.lesson.asks;
  assert.deepEqual(
    asks.map((a: any) => [a.status, a.files.map((f: any) => f.name)]),
    [['done', ['第3页照这个.txt']]],
  );
});
