/**
 * 跑尺子上的一句（一个子进程一句，每句一份干净的世界）：
 *   node --import tsx ../tools/ta-measure/case.ts <句子编号> <输出目录>   （在 server 目录下跑）
 * 输出目录里事先放好 base/coteach.db 和 base/.secret（ruler.ts 准备，带着接好的 DeepSeek）。
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
// 后台整理助手在这里不跑（助教要是把活交给它，这件活马上失败，结果里看得到它交了）
process.env.CT_CLAUDE = join(data, 'no-claude');

const { db } = await import('../../server/src/db/index.js');
const { createApp } = await import('../../server/src/app.js');
const runtime = await import('../../server/src/assistant/runtime.js');
const { CASES } = await import('./cases.js');
const { seed, snapshot, diff, TEACHER } = await import('./world.js');

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
  asks: [] as { question: string; options: string[] }[][],
  autoAnswered: false,
  textAsks: 0,
  turns: [] as { say: string; ms: number; status: string }[],
  replies: [] as string[],
  tools: [] as string[],
  actions: [] as string[],
  changes: [] as string[],
  wrong: [] as string[],
  result: null as string | null,
  ok: false,
  error: null as string | null,
};
try {
  const turns = [...c.turns];
  while (turns.length) {
    const t = turns.shift()!;
    if (!('say' in t)) continue;
    let t0 = Date.now();
    let runId = runtime.startTaTurn(user, { message: t.say, kbId: null });
    let status = await settled(runId);
    out.turns.push({ say: t.say, ms: Date.now() - t0, status });
    // 没弹卡片、直接用一句话问的（开放的问题没有选项，比如「新班叫什么」）：也算问了，照写好的回答打字回它
    for (let guard = 0; status === 'done' && turns[0] && 'answer' in turns[0] && guard < 2; guard++) {
      const said = db.get<{ reply: string | null }>('SELECT reply FROM kb_runs WHERE id=?', runId)?.reply || '';
      const acted = db.value<number>('SELECT count(*) FROM ta_actions WHERE run_id=?', runId) || 0;
      if (acted || !/[？?]|请问|请(老师)?(告诉|说|给)|叫什么|是什么|哪(个|份|一|些)/.test(said.trim())) break;
      out.asked = true;
      out.textAsks++;
      const text = (turns.shift() as { answer: string[] }).answer.join('；');
      t0 = Date.now();
      runId = runtime.startTaTurn(user, { message: text, kbId: null });
      status = await settled(runId);
      out.turns.push({ say: `（打字回答）${text}`, ms: Date.now() - t0, status });
    }
    // 问了：照写好的回答选；没写回答（不该问的问了）就选它排第一的
    for (let guard = 0; status === 'waiting' && guard < 3; guard++) {
      out.asked = true;
      const ev = db.get<{ data: string }>("SELECT data FROM kb_events WHERE run_id=? AND type='ask' ORDER BY id DESC LIMIT 1", runId)!;
      const ask = JSON.parse(ev.data) as { questions: { question: string; options: string[] }[] };
      out.asks.push(ask.questions);
      const scripted = turns[0] && 'answer' in turns[0] ? (turns.shift() as { answer: string[] }).answer : null;
      if (!scripted) out.autoAnswered = true;
      // 写好的回答只管第几个问题；多出来的问题像忙着的老师那样回「你定」（2026-11-16 改：原来选它排第一的，
      // a05 里它把「不设截止」排第一，老师前面说了下周一交也被这个选项盖掉，不像真老师）。选项里挑意思最贴的：一样的最好，再是多出来的字最少的
      const answers = ask.questions.map((q, i) => {
        // 「算了」是整件事都不办了，每个问题都这么答
        const want = scripted?.[i] ?? (scripted?.[0]?.startsWith('算了') ? scripted[0] : undefined);
        if (!want) return { text: '你定' };
        const w = norm(want);
        const hits = q.options
          .filter((o) => norm(o) === w || norm(o).includes(w) || (norm(o).length >= 2 && w.includes(norm(o))))
          .sort((a, b) => Math.abs(norm(a).length - w.length) - Math.abs(norm(b).length - w.length));
        return hits.length ? { picks: [hits[0]] } : { text: want };
      });
      t0 = Date.now();
      runId = runtime.answerAsk(user, runId, answers);
      status = await settled(runId);
      out.turns.push({ say: `（回答）${JSON.stringify(answers)}`, ms: Date.now() - t0, status });
    }
  }
  // 该问的没问：写好的回答没用上，也照样算
  const after = snapshot(world);
  out.replies = db.all<{ reply: string | null }>("SELECT reply FROM kb_runs WHERE teacher_id=? AND agent='ta' ORDER BY id", world.teacher).map((r) => r.reply || '');
  out.tools = db
    .all<{ tool_calls: string }>("SELECT tool_calls FROM agent_messages WHERE owner_id=? AND role='assistant' AND tool_calls IS NOT NULL ORDER BY id", world.teacher)
    .flatMap((r) => (JSON.parse(r.tool_calls) as { name: string }[]).map((x) => x.name));
  out.actions = db.all<{ kind: string }>("SELECT kind FROM ta_actions WHERE teacher_id=? AND status='done' ORDER BY id", world.teacher).map((r) => r.kind);
  out.changes = diff(before, after);
  out.wrong = out.changes.filter((line) => !c.allow.some((re) => re.test(line)));
  out.result = c.check({ before, after, world, replies: out.replies, tools: out.tools, actions: out.actions });
  out.ok = out.result === null && out.wrong.length === 0 && (c.ask !== true || out.asked);
} catch (err) {
  out.error = String((err as Error)?.stack || err);
}
writeFileSync(join(outDir, `${id}.json`), JSON.stringify(out, null, 2));
process.exit(0);
