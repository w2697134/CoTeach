/**
 * 跑尺子上的一个世界一遍（一个子进程一遍，每遍一份干净的数据库）：
 *   node --import tsx ../tools/suggest-measure/case.ts <世界> <第几遍> <输出目录>   （在 server 目录下跑）
 * 输出目录里事先放好 base/coteach.db 和 base/.secret（ruler.ts 准备，带着接好的模型）。
 * 看一眼以后，该提的世界弹了卡片：第 1 遍在卡片上点「分出来」，第 2 遍在对话里打字「那个分了吧」，看助教分没分对（SUGGEST_E2E=0 不走这一步）。
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [id, rep, outDir] = process.argv.slice(2);
const data = resolve(outDir, 'cases', `${id}-${rep}`);
mkdirSync(data, { recursive: true });
copyFileSync(join(outDir, 'base', 'coteach.db'), join(data, 'coteach.db'));
copyFileSync(join(outDir, 'base', '.secret'), join(data, '.secret'));
process.env.CT_DATA_DIR = data;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SUGGEST_AUTO = '0';
process.env.CT_GRADE_AUTO = '0';
process.env.CT_PACK_AUTO = '0';

const { db } = await import('../../server/src/db/index.js');
const { createApp } = await import('../../server/src/app.js');
const suggest = await import('../../server/src/assistant/suggest.js');
const runtime = await import('../../server/src/assistant/runtime.js');
const { WORLDS, base, TEACHER } = await import('./worlds.js');

const w = WORLDS.find((x) => x.id === id);
if (!w) throw new Error(`没有 ${id}`);
const app = createApp();
const c = await base(app);
await w.setup(c);
const user = { id: c.teacher, name: TEACHER };

async function settled(runId: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < 240_000) {
    const r = db.get<{ status: string }>('SELECT status FROM kb_runs WHERE id=?', runId);
    if (r && r.status !== 'running') return r.status;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  return 'timeout';
}
/** 这一遍里调的模型（开发库副本里原有的调用记录不算） */
const calls = (purpose: string, since: number) =>
  db
    .all<{ model: string; status: string; latency_ms: number }>('SELECT model, status, latency_ms FROM llm_calls WHERE purpose=? AND created_at>=? ORDER BY id', purpose, since)
    .map((r) => `${r.model}${r.status === 'ok' ? '' : `(${r.status})`} ${(r.latency_ms / 1000).toFixed(1)}s`);
/** 问老师的话是不是一句：去掉句末的标点，中间没有句号、问号、叹号 */
const oneSentence = (q: string) => !/[。？！?!]/.test(q.trim().replace(/[。？！?!]+$/, ''));

const out: Record<string, any> = { id, rep, should: w.should, suggested: false, ok: false, wrong: null, error: null };
try {
  const t0 = Date.now();
  const p = await suggest.checkSuggestions(c.teacher);
  out.ms = Date.now() - t0;
  const row = db.get<any>('SELECT * FROM specialist_suggestions WHERE teacher_id=? ORDER BY id DESC LIMIT 1', c.teacher);
  Object.assign(out, { status: row?.status ?? null, due: row?.due ?? null, subjects: row?.subjects ?? null, reply: row?.reply ?? null, digest: row?.digest ?? null });
  out.models = calls('ta:suggest', t0);
  out.suggested = !!p;
  if (p) {
    const hw = p.homework_id ? db.get<{ title: string; cls: string }>('SELECT a.title, c.name AS cls FROM assignments a JOIN classes c ON c.id=a.class_id WHERE a.id=?', p.homework_id) : null;
    out.proposal = { question: p.question, name: p.name, duty: p.duty, guide: p.guide, homework: hw ? `${hw.cls}「${hw.title}」` : null };
    out.oneSentence = oneSentence(p.question || '');
    out.chars = (p.question || '').length;
    out.wrong = w.check?.(p, c) ?? null;
  }
  out.ok = out.suggested === w.should && !out.wrong;

  // 该提的提了：老师答应，看助教分没分对（SUGGEST_E2E=0 时不走这一步：只改了看一眼的话时用不着）
  if (p && w.should && process.env.SUGGEST_E2E !== '0') {
    const t1 = Date.now();
    const runId = rep === '1' ? runtime.answerAsk(user, p.card_run_id!, [{ picks: [suggest.YES] }]) : runtime.startTaTurn(user, { message: '那个分了吧', kbId: null });
    const status = await settled(runId);
    const after = db.get<any>('SELECT * FROM specialist_suggestions WHERE id=?', p.id);
    const made = db.all<any>('SELECT * FROM specialists WHERE teacher_id=? AND retired_at IS NULL ORDER BY id', c.teacher).filter((s) => s.created_at >= t1);
    const bound = p.homework_id ? db.value<number>('SELECT specialist_id FROM assignments WHERE id=?', p.homework_id) : null;
    const card = db.value<string>('SELECT status FROM kb_runs WHERE id=?', p.card_run_id);
    const tools = db
      .all<{ tool_calls: string }>("SELECT tool_calls FROM agent_messages WHERE owner_id=? AND role='assistant' AND tool_calls IS NOT NULL ORDER BY id", c.teacher)
      .flatMap((r) => (JSON.parse(r.tool_calls) as { name: string }[]).map((x) => x.name));
    // 分对没有只看分出来的结果；这一轮最后回老师那一步没回成（模型超时、换 DeepSeek 被拒）单独记
    const why = [
      made.length !== 1 ? `分了 ${made.length} 个` : '',
      made[0] && made[0].name !== p.name ? `名字换成了「${made[0].name}」` : '',
      p.homework_id && (!made[0] || bound !== made[0].id) ? '作业没交给它批' : '',
      card !== 'done' ? '卡片没收起来' : '',
      after?.status !== 'accepted' || !after?.specialist_id ? `账上是 ${after?.status}，specialist_id=${after?.specialist_id}` : '',
    ].filter(Boolean);
    const run = db.get<{ reply: string | null; error: string | null }>('SELECT reply, error FROM kb_runs WHERE id=?', runId);
    out.e2e = {
      how: rep === '1' ? '点「分出来」' : '打字「那个分了吧」',
      ms: Date.now() - t1,
      status,
      tools,
      made: made.map((s) => ({ name: s.name, duty: s.duty, guide: s.guide })),
      reply: run?.reply ?? null,
      turnError: status === 'done' ? null : `这一轮停在 ${status}${run?.error ? `：${run.error.slice(0, 120)}` : ''}`,
      models: calls('ta:chat', t1),
      ok: !why.length,
      why: why.join('；') || null,
    };
  }
} catch (err) {
  out.error = String((err as Error)?.stack || err);
}
writeFileSync(join(outDir, `${id}-${rep}.json`), JSON.stringify(out, null, 2));
process.exit(0);
