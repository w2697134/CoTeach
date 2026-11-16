/**
 * 尺子：批改交分的格子名带标点时，模型第一次交的分程序认不认得出（2026-11-17）。
 * 起因：本地专门助手批「实验二」（评分标准项名像「第5项 用字典保存「姓名: 成绩」」），Gemini 交上来的格子
 * 名变成 No1…No8、__dummy__ 或者干脆是空的，三次都交不对就「没交批改结果」；线上项名短的那班 93 份一次都交对了。
 * 同一份作业、同一个模型，比：普通说明 / 专门助手的说明 × 项名原样 / 项名去掉标点，每种跑几次，只看第一次交的。
 *   在 server 目录：node --import tsx ../tools/grade-keys/ruler.ts <标签> [每种几次，默认 6]
 * 用开发数据的一份副本（.secret 原样复制，不打开），不写开发库。
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const [label = 'run', times = '6'] = process.argv.slice(2);
const N = Number(times);
const out = join(ROOT, 'output', 'grade-keys', label);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'data'), { recursive: true });
const dev = join(ROOT, 'server', 'data');
new DatabaseSync(join(dev, 'coteach.db'), { readOnly: true }).exec(`VACUUM INTO '${join(out, 'data', 'coteach.db').replace(/'/g, "''")}'`);
copyFileSync(join(dev, '.secret'), join(out, 'data', '.secret'));
process.env.CT_DATA_DIR = join(out, 'data');
process.env.CT_DEMO_MODE = '0';
process.env.CT_GRADE_AUTO = '0';
process.env.CT_PACK_AUTO = '0';

const { db } = await import('../../server/src/db/index.js');
const { assignmentRow, submissionRow, classRow, userName } = await import('../../server/src/grading/common.js');
const { rubricOf } = await import('../../server/src/grading/rubric.js');
const { gradePrompt, gradeInput, submitTool, cleanResult, workText } = await import('../../server/src/grading/grader.js');
const { specialistGradeSystem, specialistRow } = await import('../../server/src/assistant/specialists.js');
const { modelStep } = await import('../../server/src/assistant/model.js');

const HW = Number(process.env.GK_HW || 12),
  SUB = Number(process.env.GK_SUB || 77);
const a = assignmentRow(HW)!;
const s = submissionRow(SUB)!;
const k = classRow(a.class_id)!;
const rubric = rubricOf(HW)!.items;
const text = await workText(s);
const spec = specialistRow(1)!;
const plain = (t: string) => t.replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
// GK_ONLY=修后：只量现在代码里的样子（评分标准原文照旧带标点，交分的格子名是 itemKeys 去掉标点的）
const all = [
  { id: '修后·普通', system: gradePrompt(userName(a.teacher_id)), rubric },
  { id: '修后·专门', system: specialistGradeSystem(gradePrompt(userName(a.teacher_id)), spec), rubric },
  { id: '普通·原样', system: gradePrompt(userName(a.teacher_id)), rubric },
  { id: '专门·原样', system: specialistGradeSystem(gradePrompt(userName(a.teacher_id)), spec), rubric },
  { id: '普通·去标点', system: gradePrompt(userName(a.teacher_id)), rubric: rubric.map((r) => ({ ...r, title: plain(r.title) })) },
  { id: '专门·去标点', system: specialistGradeSystem(gradePrompt(userName(a.teacher_id)), spec), rubric: rubric.map((r) => ({ ...r, title: plain(r.title) })) },
];
const variants = process.env.GK_ONLY ? all.filter((v) => v.id.startsWith(process.env.GK_ONLY!)) : all.slice(2);
console.log('项名：', rubric.map((r) => r.title).join(' | '));

type Row = { variant: string; n: number; ok: boolean; why: string; keys: string[]; ms: number };
const rows: Row[] = [];
async function one(v: (typeof variants)[number], n: number) {
  const t0 = Date.now();
  let ok = false,
    why = '',
    keys: string[] = [];
  try {
    const r = await modelStep({
      agent: 'grader',
      purpose: 'gradekeys',
      messages: [
        { role: 'system', content: v.system },
        { role: 'user', content: gradeInput(a, k.name, '', v.rubric, text) },
      ],
      tools: [submitTool(v.rubric)],
      userId: a.teacher_id,
      signal: new AbortController().signal,
      onText: () => {},
    });
    const call = r.toolCalls.find((c) => c.name === 'submit_grade');
    if (!call) why = '没交';
    else {
      const items = (call.args as any)?.items;
      keys = items && typeof items === 'object' ? (Array.isArray(items) ? items.map((x: any) => String(x?.title ?? '?')) : Object.keys(items)) : [];
      try {
        cleanResult(call.args, v.rubric, text);
        ok = true;
      } catch (err) {
        why = (err as Error).message.slice(0, 80);
      }
    }
  } catch (err) {
    why = '出错：' + (err as Error).message.slice(0, 80);
  }
  rows.push({ variant: v.id, n, ok, why, keys, ms: Date.now() - t0 });
  console.log(v.id, n, ok ? '认得出' : '认不出', why, ok ? '' : JSON.stringify(keys).slice(0, 120));
}
// 每种几次，两个一起跑（Gemini 接口只有两个名额）
const jobs = variants.flatMap((v) => Array.from({ length: N }, (_, n) => () => one(v, n + 1)));
const lanes = Array.from({ length: 2 }, async () => {
  for (let j = jobs.shift(); j; j = jobs.shift()) await j();
});
await Promise.all(lanes);
const sum = variants.map((v) => {
  const r = rows.filter((x) => x.variant === v.id);
  return `| ${v.id} | ${r.filter((x) => x.ok).length}/${r.length} | ${Math.round(r.reduce((m, x) => m + x.ms, 0) / r.length / 1000)} 秒 |`;
});
const md = [`# 交分格子名 ${label}`, '', '| 说明·项名 | 第一次就认得出 | 平均每次 |', '|---|---|---|', ...sum, '', '```', JSON.stringify(rows, null, 1), '```'].join('\n');
writeFileSync(join(out, 'summary.md'), md);
console.log('\n' + sum.join('\n'));
db.close?.();
