/**
 * 跑消息尺子上的一句（一个子进程一句，每句一份干净的世界）：
 *   node --import tsx ../tools/msg-measure/case.ts <句子编号> <输出目录>   （在 server 目录下跑）
 * 输出目录里事先放好 base/coteach.db 和 base/.secret（ruler.ts 准备，带着接好的模型）。
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [id, outDir] = process.argv.slice(2);
const data = resolve(outDir, 'cases', id);
mkdirSync(data, { recursive: true });
copyFileSync(join(outDir, 'base', 'coteach.db'), join(data, 'coteach.db'));
copyFileSync(join(outDir, 'base', '.secret'), join(data, '.secret'));
process.env.CT_DATA_DIR = data;
process.env.CT_DEMO_MODE = '0';
process.env.CT_CLAUDE = join(data, 'no-claude');

const { db } = await import('../../server/src/db/index.js');
const { createApp } = await import('../../server/src/app.js');
const runtime = await import('../../server/src/assistant/runtime.js');
const { CASES } = await import('./cases.js');
const { seed, snapshot, diff, TEACHER } = await import('../ta-measure/world.js');

const c = CASES.find((x) => x.id === id);
if (!c) throw new Error(`没有 ${id}`);
createApp();
const world = await seed();
c.setup?.(world);
const user = { id: world.teacher, name: TEACHER };
const before = snapshot(world);

const norm = (s: string) => s.replace(/[\s「」：:，,。]/g, '').toLowerCase();
async function settled(runId: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < 180_000) {
    const r = db.get<{ status: string }>('SELECT status FROM kb_runs WHERE id=?', runId);
    if (r && r.status !== 'running') return r.status;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  return 'timeout';
}

const out = {
  id: c.id,
  cat: c.cat,
  expectAsk: c.ask ?? null,
  asked: false,
  turns: [] as { say: string; ms: number; steps: number; status: string }[],
  replies: [] as string[],
  tools: [] as { name: string; args: Record<string, any> }[],
  wrong: [] as string[],
  result: null as string | null,
  ok: false,
  error: null as string | null,
};
/** 这一轮调了几次模型（量快慢用） */
const steps = (runId: number) => db.value<number>("SELECT count(*) FROM agent_messages WHERE run_id=? AND role='assistant'", runId) || 0;
try {
  const turns = [...c.turns];
  while (turns.length) {
    const t = turns.shift()!;
    if (!('say' in t)) continue;
    let t0 = Date.now();
    let runId = runtime.startTaTurn(user, { message: t.say, kbId: null });
    let status = await settled(runId);
    out.turns.push({ say: t.say, ms: Date.now() - t0, steps: steps(runId), status });
    // 没弹卡片、直接用一句话问的：也算问了，照写好的回答打字回它
    if (status === 'done' && turns[0] && 'answer' in turns[0]) {
      const said = db.get<{ reply: string | null }>('SELECT reply FROM kb_runs WHERE id=?', runId)?.reply || '';
      if (/[？?]|哪(个|门|一)/.test(said)) {
        out.asked = true;
        const text = (turns.shift() as { answer: string[] }).answer.join('；');
        t0 = Date.now();
        runId = runtime.startTaTurn(user, { message: text, kbId: null });
        status = await settled(runId);
        out.turns.push({ say: `（打字回答）${text}`, ms: Date.now() - t0, steps: steps(runId), status });
      }
    }
    // 弹了卡片：照写好的回答选（选项里挑意思最贴的），没写回答的回「你定」
    for (let guard = 0; status === 'waiting' && guard < 3; guard++) {
      out.asked = true;
      const ev = db.get<{ data: string }>("SELECT data FROM kb_events WHERE run_id=? AND type='ask' ORDER BY id DESC LIMIT 1", runId)!;
      const ask = JSON.parse(ev.data) as { questions: { question: string; options: string[] }[] };
      const scripted = turns[0] && 'answer' in turns[0] ? (turns.shift() as { answer: string[] }).answer : null;
      const answers = ask.questions.map((q, i) => {
        const want = scripted?.[i];
        if (!want) return { text: '你定' };
        const w = norm(want);
        const hits = q.options.filter((o) => norm(o) === w || norm(o).includes(w) || (norm(o).length >= 2 && w.includes(norm(o))));
        return hits.length ? { picks: [hits[0]] } : { text: want };
      });
      t0 = Date.now();
      runId = runtime.answerAsk(user, runId, answers);
      status = await settled(runId);
      out.turns.push({ say: `（回答）${JSON.stringify(answers)}`, ms: Date.now() - t0, steps: steps(runId), status });
    }
  }
  const after = snapshot(world);
  out.replies = db.all<{ reply: string | null }>("SELECT reply FROM kb_runs WHERE teacher_id=? AND agent='ta' AND kind='chat' ORDER BY id", world.teacher).map((r) => r.reply || '');
  out.tools = db
    .all<{ tool_calls: string }>("SELECT tool_calls FROM agent_messages WHERE owner_id=? AND role='assistant' AND tool_calls IS NOT NULL ORDER BY id", world.teacher)
    .flatMap((r) => JSON.parse(r.tool_calls) as { name: string; args: Record<string, any> }[]);
  out.wrong = diff(before, after);
  out.result = c.check({ world, tools: out.tools, replies: out.replies, asked: out.asked });
  out.ok = out.result === null && out.wrong.length === 0 && (c.ask !== true || out.asked) && (c.ask !== false || !out.asked);
} catch (err) {
  out.error = String((err as Error)?.stack || err);
}
writeFileSync(join(outDir, `${id}.json`), JSON.stringify(out, null, 2));
process.exit(0);
