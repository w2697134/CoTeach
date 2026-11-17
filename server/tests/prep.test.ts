import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

process.env.CT_DATA_DIR = mkdtempSync(join(tmpdir(), 'ct-prep-'));
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
process.env.CT_GRADE_AUTO = '0';
process.env.CT_PACK_AUTO = '0';
const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const model = await import('../src/assistant/model.js');
const L = await import('../src/prep/lessons.js');
// 课件样式定好了才做成幻灯片：测试里当它定好了
(await import('../src/prep/kit.js')).setSlideKitGuide('课件样式（测试）');
const app = createApp();

test('备课：教案要有课题和教学过程；分钟数不像样的不要，空的环节去掉', () => {
  assert.throws(() => L.cleanPlan({ title: '', steps: [{ name: '导入', content: '讲' }] }), /课题和教学过程/);
  assert.throws(() => L.cleanPlan({ title: '递归', steps: [] }), /课题和教学过程/);
  const p = L.cleanPlan({
    title: '递归',
    goals: ['会写递归', ''],
    steps: [
      { name: '导入', minutes: 5, content: '排队报数' },
      { name: '讲授', minutes: 999, content: '两要素' },
      { name: '空的', minutes: 3, content: '' },
    ],
  });
  assert.deepEqual(p.goals, ['会写递归']);
  assert.deepEqual(
    p.steps.map((s) => [s.name, s.minutes]),
    [
      ['导入', 5],
      ['讲授', null],
    ],
  );
});

test('备课：课件版式不认识的当要点页；选择题答案字母换成序号；空页不要', () => {
  const d = L.cleanDeck({
    slides: [
      { layout: 'cover', title: '字典' },
      { layout: 'weird', title: '要点', points: ['a', '', 'b'] },
      { layout: 'quiz', title: '问一问', quiz: { question: '哪个对', options: ['x', 'y', 'z'], answer: 'C' } },
    ],
  });
  assert.equal(d.slides[1].layout, 'points');
  assert.deepEqual(d.slides[1].points, ['a', 'b']);
  assert.deepEqual(d.slides[2].quiz?.answer, [2]);
  assert.ok(d.slides.every((s) => s.id));
  assert.throws(() => L.cleanSlide({ layout: 'points' }), /空的/);
  assert.deepEqual(L.answerIndexes('AC', 3), [0, 2]);
  assert.deepEqual(L.answerIndexes([1, '1', 9], 3), [1]);
  assert.deepEqual(L.cleanQuestion({ type: 'single', stem: '选', options: ['A. [1, 2]', '(B) "2501"', 'C、{1}', '-1'], answer: 'B' }, false).options, ['[1, 2]', '"2501"', '{1}', '-1']);
});

test('备课：幻灯片太满程序量得出来（字、条目、代码行、表格、卡片），封面章节页不量', async () => {
  const { tooFull } = await import('../src/prep/kit.js');
  assert.deepEqual(tooFull(`<div class="slide"><h1 class="title">短</h1><ul class="list"><li>一</li><li>二</li></ul></div>`), []);
  assert.deepEqual(tooFull(`<div class="slide"><ul class="list">${'<li>x</li>'.repeat(8)}</ul></div>`), ['条目太多']);
  assert.ok(tooFull(`<div class="slide"><pre class="code"><code>${'print(1)\n'.repeat(14)}</code></pre></div>`).includes('代码太长'));
  assert.ok(tooFull(`<div class="slide"><p>${'字'.repeat(200)}</p></div>`).includes('字太多'));
  assert.deepEqual(tooFull(`<div class="slide section"><p>${'字'.repeat(200)}</p></div>`), []);
});

test('备课：代码行在它那一栏放不下算太满（两栏比整页窄，中文注释算宽），代码里转义的字照原样量', async () => {
  const { codeBlocks, codeTooWide, tooFull } = await import('../src/prep/kit.js');
  const line = 'score = input("请输入成绩：")  # 多余提示且未转 int';
  const pre = (s: string, cls = 'code') => `<pre class="${cls}" data-lang="python"><code>${s}</code></pre>`;
  // 整页宽放得下，两栏放不下
  assert.equal(codeTooWide(`<div class="slide">${pre(line)}</div>`), false);
  const two = `<div class="slide"><div class="grid-2"><div>${pre(line)}</div><div>${pre('x = 1')}</div></div></div>`;
  assert.equal(codeTooWide(two), true);
  assert.ok(tooFull(two).includes('代码行太长，这一栏放不下'));
  // 注释挪走、行短了就放得下
  assert.equal(codeTooWide(`<div class="slide"><div class="grid-2"><div>${pre('score = input("请输入成绩：")')}</div></div></div>`), false);
  // 栏数按外面套的块算；闭合的块不算；转义还原再量
  const b = codeBlocks(`<div class="slide"><div class="split"><p>说明<br></p></div>${pre('if a &lt; b:\n    print(a &amp; b)', 'code sm')}<div class="grid-3"><div>${pre('y')}</div></div></div>`);
  assert.deepEqual(b.map((x) => [x.parts, x.small, x.lines]), [
    [1, true, ['if a < b:', '    print(a & b)']],
    [3, false, ['y']],
  ]);
});

test('备课：题目选择题要两个以上选项，判断题答案只认对错，作业每题有分', () => {
  const [q1, q2, q3] = L.cleanQuestions(
    [
      { type: 'single', stem: '选一个', options: ['a', 'b'], answer: 'B' },
      { type: 'judge', stem: '对不对', answer: '错误' },
      { type: 'code', stem: '写个函数', answer: 'def f(): pass', points: 7.3, rubric: '能跑给分' },
    ],
    true,
  );
  assert.equal(q1.answer, 'B');
  assert.deepEqual(q1.choice, [1]);
  assert.equal(q2.answer, '错');
  assert.equal(q3.points, 7.5);
  assert.throws(() => L.cleanQuestion({ type: 'single', stem: '只有一个', options: ['a'] }, false), /选项不够/);
  const body = L.homeworkBody([q1, q3]);
  assert.match(body, /\*\*第 1 题\*\*（10 分）选一个/);
  assert.match(body, /A\. a\nB\. b/);
  assert.doesNotMatch(body, /def f/);
  assert.deepEqual(
    L.homeworkRubric([q1, q3]).map((r) => [r.title, r.points]),
    [
      ['第1题', 10],
      ['第2题', 7.5],
    ],
  );
});

/* ---------------- 整个走一遍：备、改、撤回、跟助教说着改、发作业 ---------------- */

const user = (name: string, role = 'teacher') =>
  db.insert('users', { username: randomUUID(), name, role, password_hash: 'not-a-login-password', created_at: Date.now() });
const teacher = user('王建国');
const other = user('李老师');
function cookie(uid: number) {
  const token = randomUUID();
  db.insert('sessions', { id: createHash('sha256').update(token).digest('hex'), user_id: uid, created_at: Date.now(), expires_at: Date.now() + 3600000 });
  return `ct_sid=${token}`;
}
const cookies: Record<string, string> = { teacher: cookie(teacher), other: cookie(other) };
async function req(path: string, body?: unknown, who = 'teacher', method?: string) {
  const res = await app.request('/api' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { cookie: cookies[who], 'x-tv2': '1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, json: type.includes('json') ? ((await res.json()) as any) : null };
}

/** 模型回答按用途给（课件和题目两手一起做，先后不定） */
const seen: string[] = [];
let askReply: { calls?: { name: string; args: any }[]; text?: string }[] = [];
model.setModelStep(async (o) => {
  seen.push(o.purpose || '');
  const call = (name: string, args: any) => ({ text: '', toolCalls: [{ id: `c_${randomUUID().slice(0, 6)}`, name, args, raw: JSON.stringify(args) }] });
  const last = o.messages[o.messages.length - 1];
  const afterTool = last.role === 'tool';
  switch (o.purpose) {
    case 'prep:plan':
      return afterTool
        ? { text: '好了', toolCalls: [] }
        : call('save_plan', {
            title: '字典的常用操作',
            goals: ['会用 get 取值'],
            steps: [
              { name: '导入', minutes: 5, content: '词频统计' },
              { name: '讲授', minutes: 40, content: 'get 和 items' },
            ],
            board: 'dict → get / items',
          });
    case 'prep:deck':
      return afterTool
        ? { text: '好了', toolCalls: [] }
        : call('save_deck', {
            slides: [
              { layout: 'cover', title: '字典的常用操作', subtitle: '计科5班' },
              { layout: 'code', title: 'get 取值', code: { lang: 'python', text: "d.get('a', 0)" }, notes: '先演示' },
              { layout: 'quiz', title: '想一想', quiz: { question: '缺的键 get 返回什么', options: ['报错', 'None'], answer: 'B' } },
            ],
          });
    case 'prep:questions':
      return afterTool
        ? { text: '好了', toolCalls: [] }
        : call('save_questions', {
            practice: [{ type: 'single', stem: 'get 的默认值', options: ['None', '0'], answer: 'A' }],
            homework: [
              { type: 'code', stem: '统计词频', answer: 'for w in words: d[w] = d.get(w, 0) + 1', points: 60, rubric: '能跑对给满分' },
              { type: 'short', stem: '说说 get 和 [] 的区别', answer: '缺键时 get 不报错', points: 40 },
            ],
          });
    case 'prep:check':
      return { text: '核对过了，答案和代码都对。', toolCalls: [] };
    case 'prep:design': {
      if (afterTool) return { text: '好了', toolCalls: [] };
      // 这一批是哪几页：看给它的话里的「第N页：」
      const ask = String(last.content);
      const pages = [...ask.matchAll(/第(\d+)页：/g)].map((m) => Number(m[1]));
      // 第 2 页做得太满（十二条），精修那一手会收到它
      const full = `<div class="slide"><h1 class="title">第2页</h1><ul class="list">${'<li>一条很长很长的要点说明</li>'.repeat(12)}</ul></div>`;
      return call('save_pages', {
        pages: pages.map((n) => ({
          page: n,
          html: n === 2 ? full : `<h1 class="title">第${n}页</h1><script>alert(1)</script><p onclick="x()">内容</p><img src="https://evil.example/x.png">`,
        })),
      });
    }
    case 'prep:refine': {
      if (afterTool) return { text: '好了', toolCalls: [] };
      const ask = String(last.content);
      const pages = [...ask.matchAll(/第(\d+)页（/g)].map((m) => Number(m[1]));
      return call('save_pages', { pages: pages.map((n) => ({ page: n, html: `<div class="slide"><h1 class="title">第${n}页</h1><ul class="list"><li>要点</li></ul></div>`, notes: '精修后的讲稿' })) });
    }
    case 'prep:ask': {
      const s = askReply.shift();
      if (!s) return { text: '改好了', toolCalls: [] };
      return { text: s.text || '', toolCalls: (s.calls || []).map((c, i) => ({ id: `a_${i}_${randomUUID().slice(0, 6)}`, name: c.name, args: c.args, raw: '' })) };
    }
    default:
      throw new Error(`没想到会调：${o.purpose}`);
  }
});

async function until(fn: () => boolean, what: string) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error(`一直没等到：${what}`);
}

test('备课：一句话备一节，几手都做完；页面上改、撤回、跟助教说着改；课后作业发到班里带评分标准', async () => {
  const k = (await req('/classes', { name: '计科5班' })).json.id as number;
  const start = await req('/prep', { classId: k, request: '下节讲字典的常用操作', minutes: 90 });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const id = start.json.id as number;
  await until(() => db.value<string>('SELECT status FROM lessons WHERE id=?', id) !== 'making', '备完');
  const got = (await req(`/prep/${id}`)).json.lesson;
  assert.equal(got.status, 'ready', got.error);
  assert.equal(got.title, '字典的常用操作');
  assert.equal(got.minutes, 90);
  assert.deepEqual(
    Object.entries(got.lanes).map(([key, v]: any) => [key, v.status]),
    [
      ['brief', 'done'],
      ['plan', 'done'],
      ['deck', 'done'],
      ['questions', 'done'],
      ['check', 'done'],
    ].filter(([key]) => key in got.lanes),
  );
  assert.deepEqual(got.counts, { slides: 3, practice: 1, homework: 2 });
  assert.deepEqual(got.deck.slides[2].quiz.answer, [1]);
  // 做成了幻灯片：每页都有 html，脚本、事件、外部图片去掉了
  assert.ok(got.deck.slides.every((s: any) => s.html?.includes('class="title"')));
  // 太满的第 2 页精修过：只剩一条，讲稿换成精修后的
  assert.equal((got.deck.slides[1].html.match(/<li\b/g) || []).length, 1);
  assert.equal(got.deck.slides[1].notes, '精修后的讲稿');
  assert.ok(seen.includes('prep:refine'));
  assert.doesNotMatch(got.deck.slides[0].html, /script|onclick|evil\.example/);
  assert.equal(got.cover.slide.layout, 'cover');
  // 别的老师看不到
  assert.equal((await req(`/prep/${id}`, undefined, 'other')).status, 404);
  assert.equal((await req('/prep', undefined, 'other')).json.lessons.length, 0);

  // 页面上改课件：存一版；撤回回到助教做的那一版
  const slides = got.deck.slides.map((s: any, i: number) => (i === 1 ? { ...s, title: '用 get 取值' } : s));
  const put = await req(`/prep/${id}/deck`, { data: { ...got.deck, slides } }, 'teacher', 'PUT');
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal((await req(`/prep/${id}`)).json.lesson.deck.slides[1].title, '用 get 取值');
  assert.equal((await req(`/prep/${id}/undo`, { part: 'deck' })).status, 200);
  assert.equal((await req(`/prep/${id}`)).json.lesson.deck.slides[1].title, 'get 取值');
  assert.equal((await req(`/prep/${id}/undo`, { part: 'deck' })).status, 400);

  // 跟助教说着改：它改第 2 页，回一句
  askReply = [
    { calls: [{ name: 'update_slide', args: { page: 2, slide: { layout: 'code', title: 'get 带默认值', code: { lang: 'python', text: "d.get('a', 0)" } } } }] },
    { text: '把第 2 页标题改成了「get 带默认值」。' },
  ];
  const ask = await req(`/prep/${id}/ask`, { message: '第二页标题说清楚是带默认值', focus: { part: 'deck', page: 2 } });
  assert.equal(ask.status, 200, JSON.stringify(ask.json));
  await until(() => db.value<string>('SELECT status FROM lesson_asks WHERE id=?', ask.json.askId) !== 'running', '改完');
  const after = (await req(`/prep/${id}`)).json.lesson;
  assert.equal(after.deck.slides[1].title, 'get 带默认值');
  assert.equal(after.deck.slides[1].id, got.deck.slides[1].id);
  assert.match(after.deck.slides[1].html, /第2页/, '改了内容的那一页补做了样子');
  const deckVersions = after.versions.deck.count;
  assert.deepEqual(after.asks.map((a: any) => [a.status, a.reply, a.changed]), [['done', '把第 2 页标题改成了「get 带默认值」。', ['deck']]]);
  // 老师说的话带着正看的那一页
  const said = db.value<string>("SELECT content FROM agent_messages WHERE thread=? AND role='user' ORDER BY id LIMIT 1", `lesson:${id}`) || '';
  assert.match(said, /课件第 2 页/);

  // 发作业：作业要求是题目，满分是各题加起来，评分标准一题一项
  const pub = await req(`/prep/${id}/publish`, {});
  assert.equal(pub.status, 200, JSON.stringify(pub.json));
  const hw = db.get<any>('SELECT * FROM assignments WHERE id=?', pub.json.assignmentId);
  assert.equal(hw.class_id, k);
  assert.equal(hw.points, 100);
  assert.match(hw.body, /\*\*第 1 题\*\*（60 分）统计词频/);
  const rubric = JSON.parse(db.value<string>('SELECT items FROM hw_rubrics WHERE assignment_id=?', hw.id)!);
  assert.deepEqual(
    rubric.map((r: any) => [r.title, r.points]),
    [
      ['第1题', 60],
      ['第2题', 40],
    ],
  );
  assert.equal((await req(`/prep/${id}/publish`, {})).status, 409);

  // Word
  const doc = await app.request(`/api/prep/${id}/docx`, { headers: { cookie: cookies.teacher, 'x-tv2': '1' } });
  assert.equal(doc.status, 200);
  // 删掉
  assert.equal((await req(`/prep/${id}`, undefined, 'teacher', 'DELETE')).status, 200);
  assert.equal((await req(`/prep/${id}`)).status, 404);
});

test('备课：以前只有教案的那份能补做课件和题目', async () => {
  const k = (await req('/classes', { name: '计科6班' })).json.id as number;
  const plan = JSON.stringify({ title: '递归', goals: [], focus: '', hard: '', review: '', steps: [{ name: '讲授', minutes: 45, content: '两要素' }], sources: [] });
  const id = db.insert('lessons', { teacher_id: teacher, class_id: k, title: '递归', status: 'ready', plan, lanes: '{"plan":{"status":"done"}}', created_at: Date.now(), updated_at: Date.now() });
  db.insert('lesson_versions', { lesson_id: id, part: 'plan', data: plan, by: 'ta', created_at: Date.now() });
  const r = await req(`/prep/${id}/redo`, { lanes: ['deck', 'questions', 'check'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await until(() => db.value<string>('SELECT status FROM lessons WHERE id=?', id) !== 'making', '补完');
  const got = (await req(`/prep/${id}`)).json.lesson;
  assert.equal(got.status, 'ready');
  assert.equal(got.title, '递归');
  assert.deepEqual(got.counts, { slides: 3, practice: 1, homework: 2 });
});
