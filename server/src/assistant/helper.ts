/**
 * 替老师回学伴、给班级写资料包的助教（2026-11-16）。
 * 老师那边看到的还是同一个 CoT 助教；这一手只能翻资料、看和写资料包、给文件、问老师：
 * 改不了班级、作业、成绩，也看不到成绩册和名单（程序上就不给这些工具）；学生交的作业，程序也不让它拿给别的学生。
 * 每次从头来，开头是说明和这个班的资料包：同一个班每次开头一样，缓存命中。
 */
import { db, now } from '../db/index.js';
import { bad } from '../lib/http.js';
import type { ToolCall, ToolSpec } from '../llm/types.js';
import { listKbs } from '../kb/bases.js';
import { isTextEntry, manifest, readEntry } from '../kb/repo.js';
import { modelStep } from './model.js';
import { dropPack, grantFile, kbOriginal, putPack, renderPack, teacherTitle } from './pack.js';
import { nowLine } from './time.js';
import { append, requestMessages } from './thread.js';

/** 一次最多来回几步 */
const MAX_STEPS = 10;

export const helperPrompt = (teacherName: string) => `你是${teacherTitle(teacherName)}的 CoT 助教。老师的每个班有一份资料包，学生的 CoT 学伴照着它回答学生，拿不准的来问你。
你要做两件事：学伴来问时替老师回答；老师建班、布置作业时给资料包写说明。资料从老师的知识库里找。

能给学生的：讲义、课件、教材、题目、老师写的说明。
不给学生的：答案和解析（资料包的规矩里老师说了可以才给）、试卷、别的同学交的作业、分数、名单。
要老师拍板的事（晚交、改分、请假、规矩里没有的例外）用 ask_teacher 问老师，带上你拟的回复，不要替老师答应。
大家都可能问、跟个人无关的回答，用 update_pack 写进资料包。
最后直接写出要说的话。`;

const str = (description: string) => ({ type: 'string', description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

const SEARCH: ToolSpec = {
  name: 'search_kb',
  description: '在老师的知识库里找资料：文件名和内容都查，返回在哪个库、哪个文件，带一小段原文。',
  parameters: obj({ query: str('要找的词，几个词用空格隔开') }, ['query']),
};
const READ: ToolSpec = {
  name: 'read_kb',
  description: '读知识库里的一份文件。',
  parameters: obj({ path: str('写成「知识库名/路径」，search_kb 返回的就是这个写法'), offset: { type: 'number', description: '从第几个字接着读，默认从头' } }, ['path']),
};
const UPDATE_PACK: ToolSpec = {
  name: 'update_pack',
  description: '往这个班的资料包里写一条（同一个标题再写就是改），或者去掉一条。',
  parameters: obj(
    {
      kind: { type: 'string', enum: ['rule', 'qa', 'notice'], description: 'rule 规矩，qa 答过的问题，notice 通知' },
      title: str('标题'),
      body: str('内容；去掉时不用写'),
      remove: { type: 'boolean', description: 'true 去掉这一条' },
    },
    ['title'],
  ),
};
const GIVE_FILES: ToolSpec = {
  name: 'give_files',
  description: '把知识库里的原件（课件、讲义这类）放进资料包，学伴就能发给这个班的学生。',
  parameters: obj(
    {
      files: {
        type: 'array',
        items: obj({ path: str('「知识库名/路径」'), note: str('一句话说是什么') }, ['path']),
      },
    },
    ['files'],
  ),
};
const ASK_TEACHER: ToolSpec = {
  name: 'ask_teacher',
  description: '要老师拍板时问老师：老师那边弹一张卡片，学伴会先告诉学生已经问了老师。问完这一次就结束。',
  parameters: obj(
    {
      question: str('问老师的话：谁、要什么、为什么'),
      options: { type: 'array', items: { type: 'string' }, description: '给老师选的几个答复，最可能的放第一个' },
      draft: str('你拟的给学生的回复'),
    },
    ['question', 'options'],
  ),
};
/** 写资料包那一条说明用：说明走这个工具存，它最后说的话不算说明（2026-11-16 试跑：最后那段话里夹着「您把原件交给我之后……」这种对老师说的） */
const SAVE_NOTE: ToolSpec = {
  name: 'save_note',
  description: '把写好的这一条说明存进资料包，再存一次就换成新的。学伴看的，不是给老师看的。',
  parameters: obj({ body: str('说明') }, ['body']),
};

export type HelperMode = 'answer' | 'pack';
export interface Escalation {
  question: string;
  options: string[];
  draft: string;
}
export interface HelperResult {
  runId: number;
  text: string;
  escalation?: Escalation;
  /** 写资料包时存下的那一条说明（save_note） */
  note?: string;
  /** 这一次往资料包里写了什么、给了哪些文件（给测量和工作记录用） */
  wrote: string[];
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** 学生交的作业（带 studentId 的）查不到也读不到：别的同学的作业不给，程序拦 */
const allowed = (e: { studentId?: number }) => e.studentId === undefined;

/** 一个知识库最多列这么多份，再多的用 search_kb 找 */
const CATALOG_MAX = 200;
/**
 * 老师知识库里有哪些文件（2026-11-16 试跑：它看不到有什么，只能拿关键词一遍遍猜，十步用完了还没写出说明）。
 * 原件标出来（能发给学生的只有原件）；学生交的作业不列。
 */
function catalog(teacherId: number) {
  const parts: string[] = [];
  for (const kb of listKbs(teacherId).filter((k) => k.status === 'active')) {
    let entries: ReturnType<typeof manifest> = [];
    try {
      entries = manifest(kb.id).filter(allowed);
    } catch {
      continue;
    }
    if (!entries.length) continue;
    // 原件（PDF、PPT 这类）旁边还有一份转出来的文字版：读用文字版，发给学生用原件；老师交的就是文字的，那一份本身就是原件
    const binary = new Set(entries.filter((e) => e.sourcePart === 'original').map((e) => e.sourceId));
    const mark = (e: (typeof entries)[number]) => (!e.sourceId ? '' : e.sourcePart === 'original' || !binary.has(e.sourceId) ? '（原件）' : '（原件的文字版）');
    const shown = entries.slice(0, CATALOG_MAX).map((e) => `${e.path}${mark(e)}`);
    parts.push(`「${kb.name}」：${shown.join('、')}${entries.length > CATALOG_MAX ? `，还有 ${entries.length - CATALOG_MAX} 份` : ''}`);
  }
  return parts.length ? `老师的知识库里有：\n${parts.join('\n')}` : '老师的知识库里还没有资料';
}

function search(teacherId: number, query: string) {
  const words = query
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  if (!words.length) throw bad('要找什么没说');
  const hits: { where: string; snippet: string; score: number }[] = [];
  for (const kb of listKbs(teacherId).filter((k) => k.status === 'active')) {
    for (const e of manifest(kb.id)) {
      if (!allowed(e) || !isTextEntry(e)) continue;
      let body = '';
      try {
        body = readEntry(kb.id, e).toString('utf8');
      } catch {
        continue;
      }
      const hay = (e.path + '\n' + body).toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      const at = body.toLowerCase().indexOf(words[0]);
      const snippet = at >= 0 ? body.slice(Math.max(0, at - 40), at + 80).replace(/\s+/g, ' ') : body.slice(0, 100).replace(/\s+/g, ' ');
      hits.push({ where: `${kb.name}/${e.path}`, snippet, score: words.filter((w) => e.path.toLowerCase().includes(w)).length });
    }
  }
  if (!hits.length) return `知识库里没找到「${query}」`;
  hits.sort((x, y) => y.score - x.score);
  return hits
    .slice(0, 12)
    .map((h) => `${h.where}：…${h.snippet}…`)
    .join('\n');
}

function read(teacherId: number, full: string, offset: number) {
  const s = String(full || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  const kbs = listKbs(teacherId).filter((k) => k.status === 'active');
  const kb = kbs.find((k) => s === k.name || s.startsWith(k.name + '/'));
  if (!kb) throw bad(`「${s}」不在知识库里。路径写成「知识库名/路径」，现在的知识库：${kbs.map((k) => `「${k.name}」`).join('、') || '没有'}`);
  const path = s.slice(kb.name.length + 1);
  const e = manifest(kb.id).find((x) => x.path === path);
  if (!e) throw bad(`「${kb.name}」里没有「${path}」，先用 search_kb 找`);
  if (!allowed(e)) throw bad(`「${path}」是学生交的作业，不能拿给别的学生`);
  const body = readEntry(kb.id, e).toString('utf8');
  const from = Math.max(0, offset);
  const piece = body.slice(from, from + 8000);
  const rest = body.length - from - piece.length;
  return piece + (rest > 0 ? `\n（还有 ${rest} 字，接着读 offset=${from + piece.length}）` : '');
}

async function runTool(o: { teacherId: number; classId: number; mode: HelperMode; wrote: string[]; note: { body?: string } }, call: ToolCall): Promise<string> {
  const a = call.args || {};
  try {
    switch (call.name) {
      case 'search_kb':
        return search(o.teacherId, String(a.query ?? ''));
      case 'read_kb':
        return read(o.teacherId, String(a.path ?? ''), num(a.offset) ?? 0);
      case 'update_pack': {
        const title = String(a.title ?? '').trim();
        if (!title) throw bad('标题没写');
        if (a.remove === true || a.remove === 'true') {
          const hit = dropPack(o.classId, title);
          if (hit) o.wrote.push(`去掉「${hit.title}」`);
          return hit ? `去掉了「${hit.title}」` : `资料包里没有「${title}」`;
        }
        const kind = ['rule', 'qa', 'notice'].includes(String(a.kind)) ? (String(a.kind) as 'rule' | 'qa' | 'notice') : 'qa';
        const body = String(a.body ?? '').trim();
        if (!body) throw bad('内容没写');
        const r = putPack(o.classId, kind, title, body);
        o.wrote.push(`${r.created ? '写' : '改'}「${title}」`);
        return `${r.created ? '写进' : '改好'}了「${title}」`;
      }
      case 'save_note': {
        const body = String(a.body ?? '').trim();
        if (!body) throw bad('说明是空的');
        o.note.body = body;
        return '存好了';
      }
      case 'give_files': {
        const list = Array.isArray(a.files) ? a.files : [];
        if (!list.length) throw bad('没说给哪份');
        const done: string[] = [];
        const failed: string[] = [];
        for (const f of list.slice(0, 20)) {
          try {
            const hit = kbOriginal(o.teacherId, String(f?.path ?? ''));
            grantFile(o.classId, hit.kb.id, hit.sourceId, hit.name, String(f?.note ?? ''));
            done.push(hit.name);
          } catch (err) {
            failed.push((err as Error).message);
          }
        }
        if (done.length) o.wrote.push(`给了 ${done.map((n) => `「${n}」`).join('、')}`);
        return [done.length ? `放进资料包了：${done.map((n) => `「${n}」`).join('、')}，学伴能发给学生` : '', ...failed].filter(Boolean).join('\n');
      }
      default:
        return `没有「${call.name}」这个工具`;
    }
  } catch (err) {
    return `没办成：${(err as Error).message || '没办成'}`;
  }
}

/**
 * 跑一次：answer 是学伴来问（task 写着谁问的、问什么），pack 是给资料包写一条说明（task 写着写什么，最后那段话就是说明）。
 * 记一轮在 kb_runs（agent='helper'，老师的），跟模型说的话记在 helper:轮次 那一段里。
 */
export async function runHelper(o: { teacherId: number; classId: number; mode: HelperMode; request: string; task: string; signal?: AbortSignal }): Promise<HelperResult> {
  const teacher = db.get<{ id: number; name: string }>('SELECT id, name FROM users WHERE id=?', o.teacherId);
  if (!teacher) throw bad('没有这位老师');
  const runId = db.insert('kb_runs', {
    teacher_id: o.teacherId,
    agent: 'helper',
    kind: o.mode,
    status: 'running',
    request: o.request.slice(0, 2000),
    class_ids: JSON.stringify([o.classId]),
    created_by: o.teacherId,
    created_at: now(),
  });
  const key = `helper:${runId}`;
  const signal = o.signal ?? new AbortController().signal;
  const wrote: string[] = [];
  const note: { body?: string } = {};
  const tools = o.mode === 'answer' ? [SEARCH, READ, UPDATE_PACK, GIVE_FILES, ASK_TEACHER] : [SEARCH, READ, GIVE_FILES, SAVE_NOTE];
  // 资料包在前、要做的事在后：同一个班的开头一样。
  // 写资料包时不给它看现有的资料包：截止、规矩、通知程序会现取，给它看了它就往说明里抄（v2 抄错了一个星期几）
  const pack = o.mode === 'answer' ? `这个班的资料包：\n${renderPack(o.classId, { teacherView: true })}\n\n` : '';
  append(o.teacherId, key, runId, { role: 'user', content: `${pack}${catalog(o.teacherId)}\n\n（现在是 ${nowLine()}）\n${o.task}` });
  const finish = (status: string, text: string, error?: string) =>
    db.update('kb_runs', runId, { status, reply: text || null, error: error ?? null, finished_at: now() });
  try {
    for (let n = 0; n < MAX_STEPS; n++) {
      signal.throwIfAborted();
      const r = await modelStep({
        agent: 'helper',
        purpose: `helper:${o.mode}`,
        messages: requestMessages(o.teacherId, key, helperPrompt(teacher.name)),
        tools,
        userId: o.teacherId,
        signal,
        onText: () => {},
      });
      append(o.teacherId, key, runId, {
        role: 'assistant',
        content: r.text,
        ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}),
        ...(r.reasoning ? { reasoning: r.reasoning } : {}),
      });
      if (!r.toolCalls.length) {
        finish('done', note.body ?? r.text.trim());
        return { runId, text: r.text.trim(), ...(note.body ? { note: note.body } : {}), wrote };
      }
      const asks = r.toolCalls.filter((c) => c.name === 'ask_teacher');
      for (const call of r.toolCalls.filter((c) => c.name !== 'ask_teacher')) {
        const out = await runTool({ teacherId: o.teacherId, classId: o.classId, mode: o.mode, wrote, note }, call);
        append(o.teacherId, key, runId, { role: 'tool', toolCallId: call.id, content: out });
      }
      if (asks.length && o.mode === 'answer') {
        const a = asks[0].args || {};
        const escalation: Escalation = {
          question: String(a.question ?? '').trim(),
          options: (Array.isArray(a.options) ? a.options : []).map((x: unknown) => String(x ?? '').trim()).filter(Boolean).slice(0, 5),
          draft: String(a.draft ?? '').trim(),
        };
        for (const c of asks) append(o.teacherId, key, runId, { role: 'tool', toolCallId: c.id, content: '已经问了老师，等老师回' });
        finish('done', `问了老师：${escalation.question}`);
        return { runId, text: '', escalation, wrote };
      }
    }
    finish('done', note.body ?? '');
    return { runId, text: '', ...(note.body ? { note: note.body } : {}), wrote };
  } catch (err) {
    finish(signal.aborted ? 'canceled' : 'error', '', (err as Error).message || '没回完');
    throw err;
  }
}

/** 批作业、拟评分标准的助教也用这几样翻资料 */
export { SEARCH as SEARCH_KB, READ as READ_KB, search as searchKb, read as readKb, catalog as kbCatalog };
