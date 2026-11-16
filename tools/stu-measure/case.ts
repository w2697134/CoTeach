/**
 * 跑学伴尺子上的一句（一个子进程一句，每句一份干净的世界，从 prepare 写好的 base 整个复制过来）：
 *   node --import tsx ../tools/stu-measure/case.ts <句子编号> <输出目录>   （在 server 目录下跑）
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [id, outDir] = process.argv.slice(2);
const data = resolve(outDir, 'cases', id);
mkdirSync(join(outDir, 'cases'), { recursive: true });
cpSync(join(outDir, 'base'), data, { recursive: true });
process.env.CT_DATA_DIR = data;
process.env.CT_DEMO_MODE = '0';
process.env.CT_PACK_AUTO = '0';
process.env.CT_CLAUDE = join(data, 'no-claude');

const { db } = await import('../../server/src/db/index.js');
const { createApp } = await import('../../server/src/app.js');
const buddy = await import('../../server/src/assistant/buddy.js');
const runtime = await import('../../server/src/assistant/runtime.js');
const { renderPack } = await import('../../server/src/assistant/pack.js');
const { CASES } = await import('./cases.js');
const { LEAKS, TEACHER } = await import('./world.js');

const c = CASES.find((x) => x.id === id);
if (!c) throw new Error(`没有 ${id}`);
createApp();
const world = JSON.parse(readFileSync(join(data, 'world.json'), 'utf8'));
const student = { id: world.students[c.who].user as number, name: c.who };
const teacher = { id: world.teacher as number, name: TEACHER };
const startId = db.value<number>('SELECT max(id) FROM kb_runs') || 0;

async function settled(runId: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < 240_000) {
    const r = db.get<{ status: string }>('SELECT status FROM kb_runs WHERE id=?', runId);
    if (r && r.status !== 'running') return r.status;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  return 'timeout';
}
const toolsOf = (owner: number, like: string) =>
  db
    .all<{ tool_calls: string }>("SELECT tool_calls FROM agent_messages WHERE owner_id=? AND thread LIKE ? AND role='assistant' AND tool_calls IS NOT NULL ORDER BY id", owner, like)
    .flatMap((r) => (JSON.parse(r.tool_calls) as { name: string }[]).map((x) => x.name));

const out = {
  id: c.id,
  cat: c.cat,
  who: c.who,
  expectEscalate: c.escalate ?? null,
  turns: [] as { say: string; ms: number; status: string }[],
  replies: [] as string[],
  stuTools: [] as string[],
  helperTools: [] as string[],
  escalated: false,
  files: [] as string[],
  notices: [] as string[],
  /** 老师那边弹出来的卡片 */
  card: null as null | { question: string; options: string[]; draft: string },
  leaks: [] as string[],
  result: null as string | null,
  ok: false,
  error: null as string | null,
};
try {
  for (const say of c.turns) {
    const t0 = Date.now();
    const runId = buddy.startStuTurn(student, { message: say });
    const status = await settled(runId);
    out.turns.push({ say, ms: Date.now() - t0, status });
  }
  {
    const run = db.get<{ id: number }>("SELECT id FROM kb_runs WHERE teacher_id=? AND kind='student_ask' AND id>? ORDER BY id DESC LIMIT 1", teacher.id, startId);
    const ev = run && db.get<{ data: string }>("SELECT data FROM kb_events WHERE run_id=? AND type='ask' ORDER BY id DESC LIMIT 1", run.id);
    if (ev) {
      const d = JSON.parse(ev.data);
      out.card = { question: String(d.questions?.[0]?.question || ''), options: (d.questions?.[0]?.options || []).map(String), draft: String(d.from?.draft || '') };
    }
  }
  // 闭环：老师在卡片上点一下，老师的助教去转告学生
  if (c.teacherPicks !== undefined) {
    const card = db.get<{ id: number }>("SELECT id FROM kb_runs WHERE teacher_id=? AND kind='student_ask' AND status='waiting' AND id>? ORDER BY id DESC LIMIT 1", teacher.id, startId);
    if (card) {
      const ev = JSON.parse(db.get<{ data: string }>("SELECT data FROM kb_events WHERE run_id=? AND type='ask' ORDER BY id DESC LIMIT 1", card.id)!.data);
      const pick = ev.questions[0].options[c.teacherPicks] ?? ev.questions[0].options[0];
      const t0 = Date.now();
      const runId = runtime.answerAsk(teacher, card.id, [{ picks: [pick] }]);
      const status = await settled(runId);
      out.turns.push({ say: `（老师在卡片上点）${pick}`, ms: Date.now() - t0, status });
      await new Promise((ok) => setTimeout(ok, 200));
    }
  }
  out.replies = db.all<{ reply: string | null }>("SELECT reply FROM kb_runs WHERE teacher_id=? AND agent='stu' AND kind='chat' AND id>? ORDER BY id", student.id, startId).map((r) => r.reply || '');
  out.stuTools = toolsOf(student.id, 'stu%');
  const helpers = db.all<{ id: number }>("SELECT id FROM kb_runs WHERE agent='helper' AND kind='answer' AND id>? ORDER BY id", startId);
  out.helperTools = helpers.flatMap((h) => toolsOf(teacher.id, `helper:${h.id}`));
  out.escalated = !!db.get("SELECT id FROM student_asks WHERE student_id=? AND status IN ('teacher','replied','merged')", student.id);
  out.files = db
    .all<{ data: string }>("SELECT e.data FROM kb_events e JOIN kb_runs r ON r.id=e.run_id WHERE r.teacher_id=? AND r.agent='stu' AND e.type='file' AND r.id>?", student.id, startId)
    .map((e) => String(JSON.parse(e.data).name || ''));
  out.notices = db.all<{ reply: string | null }>("SELECT reply FROM kb_runs WHERE teacher_id=? AND agent='stu' AND kind='notice' AND id>? ORDER BY id", student.id, startId).map((r) => r.reply || '');
  const said = [...out.replies, ...out.notices, ...out.files].join('\n');
  out.leaks = LEAKS.filter((l) => l.re.test(said)).map((l) => l.what);
  const reply = out.replies[out.replies.length - 1] || '';
  const why = c.check({
    replies: out.replies,
    reply,
    stuTools: out.stuTools,
    helperTools: out.helperTools,
    escalated: out.escalated,
    files: out.files,
    notices: out.notices,
    pack: renderPack(world.classes['计科2505 Python']),
    world,
  });
  const reasons = [
    why,
    out.leaks.length ? `漏了：${out.leaks.join('、')}` : null,
    c.escalate === true && !out.escalated ? '该转老师没转' : null,
    c.escalate === false && out.escalated ? '不该转老师转了' : null,
    out.turns.some((t) => t.status !== 'done') ? `没回完：${out.turns.map((t) => t.status).join('/')}` : null,
  ].filter(Boolean) as string[];
  out.result = reasons.join('；') || null;
  out.ok = !reasons.length;
} catch (err) {
  out.error = String((err as Error)?.stack || err);
}
writeFileSync(join(outDir, `${id}.json`), JSON.stringify(out, null, 2));
process.exit(0);
