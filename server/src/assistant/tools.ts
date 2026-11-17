/**
 * CoT 助教手里的工具：班级、作业、批改、成绩走页面用的那套接口（callApi），知识库只读，整理交给后台的整理助手。
 * 办成一件事记一笔（卡片 + 撤回）；只是看看的记一行工作记录。返回给助教的话要短，只写它接着办事、回老师用得着的。
 */
import { readFileSync } from 'node:fs';
import { db } from '../db/index.js';
import { bad, notFound } from '../lib/http.js';
import type { ToolCall, ToolSpec } from '../llm/types.js';
import { record, type RunRef } from '../kb/agent/events.js';
import { listKbs } from '../kb/bases.js';
import { isTextEntry, manifest, readEntry, sourceBytes } from '../kb/repo.js';
import { blobPath, readBlobText } from '../kb/intake/store.js';
import { callApi } from './api.js';
import { recordAction, undoAction } from './actions.js';
import { notifyClass, replyStudent } from './bridge.js';
import { myClasses } from './buddy.js';
import { dropPack, grantFile, isPackKind, kbOriginal, putPack, renderPack, revokeFile } from './pack.js';
import { classesOf, findClass, findHomework, findStudent, type ClassRow, type HomeworkRow } from './resolve.js';
import { parseWhen, showTime, weekLater } from './time.js';
import { createSpecialist, findSpecialist, runSpecialist, updateSpecialist } from './specialists.js';

export interface TaContext {
  user: { id: number; name: string };
  ref: RunRef;
  /** 交给后台整理助手一件活，返回后台任务的编号 */
  startJob: (brief: string, kbName: string | null, attachmentIds: number[]) => number;
  /** 老师停下这一轮时中断（交给专门助手的活要跟着停） */
  signal?: AbortSignal;
}

const str = (description: string) => ({ type: 'string', description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const HOMEWORK = { homework: str('作业标题'), class: str('哪个班的；一份作业发给了几个班、只改其中一个班时才填') };

export const ASK_TOOL = 'ask';

export const TOOL_SPECS: ToolSpec[] = [
  { name: 'list_classes', description: '列出老师的班级：人数、加课码、能不能加入、有没有归档、几份待批。', parameters: obj({}) },
  {
    name: 'class_detail',
    description: '看一个班：学生名单（谁加入了）和这个班的作业（交了几份、几份待批）。',
    parameters: obj({ class: str('班名') }, ['class']),
  },
  { name: 'create_class', description: '新建一个班，建好就有加课码和二维码。', parameters: obj({ name: str('班名') }, ['name']) },
  {
    name: 'update_class',
    description: '改一个班。只传要改的。',
    parameters: obj(
      {
        class: str('现在的班名'),
        name: str('新班名'),
        archived: { type: 'boolean', description: 'true 归档，false 恢复' },
        join_open: { type: 'boolean', description: 'true 允许学生加入，false 停止加入' },
        new_code: { type: 'boolean', description: 'true 换一个加课码' },
      },
      ['class'],
    ),
  },
  { name: 'delete_class', description: '删掉一个班。', parameters: obj({ class: str('班名') }, ['class']) },
  {
    name: 'assign_homework',
    description: '布置作业，可以一次发给几个班。老师没说的项不要传，系统按常规填，返回里会写用了什么。',
    parameters: obj(
      {
        classes: { type: 'array', items: { type: 'string' }, description: '发给哪些班（班名）' },
        title: str('标题'),
        body: str('作业要求，学生看到的正文'),
        points: { type: 'number', description: '满分' },
        due: str('截止时间，照老师的说法写，系统换算成日期；老师说不设截止就写「不设」'),
        allow_late: { type: 'boolean', description: '截止后还能不能交' },
        publish_at: str('定时发布的时间，照老师的说法写；现在就发不要传'),
        attachments: { type: 'array', items: { type: 'number' }, description: '老师发来的文件编号，作为附件发给学生' },
        kb_files: { type: 'array', items: { type: 'string' }, description: '知识库里的原件，写成「知识库名/路径」，作为附件发给学生' },
      },
      ['classes', 'title'],
    ),
  },
  {
    name: 'update_homework',
    description: '改一份已经布置的作业。只传要改的。',
    parameters: obj(
      {
        ...HOMEWORK,
        title: str('新标题'),
        body: str('新的作业要求'),
        points: { type: 'number', description: '满分' },
        due: str('新的截止时间，照老师的说法写（往后推几天也照说），系统换算；不设截止写「不设」'),
        allow_late: { type: 'boolean', description: '截止后还能不能交' },
        publish_at: str('还没发布的作业改发布时间，照老师的说法写'),
      },
      ['homework'],
    ),
  },
  { name: 'delete_homework', description: '删掉一份作业。', parameters: obj(HOMEWORK, ['homework']) },
  {
    name: 'homework_detail',
    description: '看一份作业每个学生的情况：交了没有、迟交、批了几分、退回。',
    parameters: obj(HOMEWORK, ['homework']),
  },
  {
    name: 'view_submission',
    description: '看一个学生交的作业：文字、附件名、分数和评语。',
    parameters: obj({ ...HOMEWORK, student: str('学生姓名或学号') }, ['homework', 'student']),
  },
  {
    name: 'grade',
    description: '给一个学生交的作业打分、写评语，或者退回让他重交。只写评语时不传分数。',
    parameters: obj(
      {
        ...HOMEWORK,
        student: str('学生姓名或学号'),
        score: { type: 'number', description: '老师给的分数' },
        comment: str('评语'),
        return: { type: 'boolean', description: 'true 退回重交' },
      },
      ['homework', 'student'],
    ),
  },
  {
    name: 'grade_homework',
    description: '让助教批一份作业：学生交了还没批的都批（照评分标准在后台批，批完告诉老师）。redo 传 true 连助教批过的也重批；老师自己批过的不动。',
    parameters: obj({ ...HOMEWORK, redo: { type: 'boolean', description: 'true 重批' } }, ['homework']),
  },
  {
    name: 'homework_review',
    description: '一份作业的讲评：分数分布、错得多的几类问题、做得好的、下节课该讲的。还没写的现在写，要半分钟左右；share 传 true 把不带名字的那一版发给学生。',
    parameters: obj({ ...HOMEWORK, rewrite: { type: 'boolean', description: 'true 重写' }, share: { type: 'boolean', description: 'true 发给学生' } }, ['homework']),
  },
  {
    name: 'class_grades',
    description: '看一个班的成绩：每个学生每份作业的分数和平均分（百分制）。要导出 Excel 时 export 传 true，老师会看到下载按钮。',
    parameters: obj({ class: str('班名'), export: { type: 'boolean', description: '要不要给老师 Excel' } }, ['class']),
  },
  {
    name: 'search_kb',
    description: '在老师所有的知识库里找资料：文件名和内容都查，返回在哪个库、哪个文件，带一小段原文。',
    parameters: obj({ query: str('要找的词，几个词用空格隔开') }, ['query']),
  },
  {
    name: 'read_kb',
    description: '读知识库里的一份文件。',
    parameters: obj({ path: str('写成「知识库名/路径」，search_kb 返回的就是这个写法'), offset: { type: 'number', description: '从第几个字接着读，默认从头' } }, ['path']),
  },
  {
    name: 'read_attachment',
    description: '读老师发来的一份文件的文字。',
    parameters: obj({ id: { type: 'number', description: '文件编号' }, offset: { type: 'number', description: '从第几个字接着读，默认从头' } }, ['id']),
  },
  {
    name: 'hand_to_keeper',
    description:
      '把整理资料、改知识库里内容的活交给整理助手，它在后台做，做完会告诉你。brief 是写给它的交代：老师的原话、要做什么、依据哪些文件、要注意什么；它没听过你们的对话。',
    parameters: obj(
      {
        brief: str('交代'),
        kb: str('放进哪个知识库；不知道就不传，它自己看内容放'),
        attachments: { type: 'array', items: { type: 'number' }, description: '要交给它的老师发来的文件编号' },
      },
      ['brief'],
    ),
  },
  {
    name: ASK_TOOL,
    description:
      '问老师。老师的话对不上、能有不止一种理解、或者缺了办不了的关键信息时用。每个问题给几个选项，最可能的放第一个；几处不清楚就放在一次里问。问完这一轮就停下，等老师回答。',
    parameters: obj(
      {
        questions: {
          type: 'array',
          items: obj(
            {
              question: str('问题'),
              options: { type: 'array', items: { type: 'string' }, description: '选项' },
              multiple: { type: 'boolean', description: '能不能多选' },
            },
            ['question', 'options'],
          ),
        },
      },
      ['questions'],
    ),
  },
  {
    name: 'undo',
    description: '撤回你办过的一件事（改回办之前的样子）。',
    parameters: obj({ what: str('撤回哪一件，照你办的时候的说法写；不传就是最近办的那件') }),
  },
  {
    name: 'reset_password',
    description: '学生忘了密码时给他重置一个新密码，新密码只给老师看。',
    parameters: obj({ student: str('学生姓名或学号'), class: str('哪个班的；学生只在一个班里时不用填') }, ['student']),
  },
  {
    name: 'notify_students',
    description: '给学生发通知，送到学生的 CoT 学伴那里。只发给某份作业还没交的学生时传 homework。',
    parameters: obj(
      {
        classes: { type: 'array', items: { type: 'string' }, description: '发给哪些班（班名）' },
        message: str('通知的话，学生看到的就是这段'),
        homework: str('只发给这份作业还没交的学生时，填作业标题'),
      },
      ['classes', 'message'],
    ),
  },
  {
    name: 'reply_student',
    description: '回复学生来问、在等老师回的事：把老师的意思写成对学生说的话，送到学生那里。',
    parameters: obj({ student: str('学生姓名'), reply: str('对学生说的话'), question: str('他问的哪件事；同一个学生有几件在等时才填') }, ['student', 'reply']),
  },
  {
    name: 'update_pack',
    description: '改班级资料包（学生的学伴照着它回答学生）：写一条规矩、通知或答复，同一个标题再写就是改；或者去掉一条（标题写文件名就是不再给学生这份文件）。',
    parameters: obj(
      {
        classes: { type: 'array', items: { type: 'string' }, description: '哪些班（班名）' },
        kind: { type: 'string', enum: ['rule', 'notice', 'qa'], description: 'rule 规矩，notice 通知，qa 答复' },
        title: str('标题'),
        body: str('内容；去掉时不用写'),
        remove: { type: 'boolean', description: 'true 去掉这一条' },
      },
      ['classes', 'title'],
    ),
  },
  {
    name: 'give_files',
    description: '把知识库里的原件（课件、讲义这类）放进班级资料包，学生的学伴就能发给学生。',
    parameters: obj(
      {
        classes: { type: 'array', items: { type: 'string' }, description: '哪些班（班名）' },
        files: { type: 'array', items: obj({ path: str('「知识库名/路径」'), note: str('一句话说是什么') }, ['path']) },
      },
      ['classes', 'files'],
    ),
  },
  {
    name: 'view_pack',
    description: '看一个班的资料包：学生的学伴现在知道些什么、能发哪些文件。',
    parameters: obj({ class: str('班名') }, ['class']),
  },
  {
    name: 'student_questions',
    description: '看学生最近问了学伴什么（学情）：每句原话和谁问的，转来问老师的也在里面。',
    parameters: obj({ class: str('班名'), days: { type: 'number', description: '最近几天，默认 7' } }, ['class']),
  },
  {
    name: 'prep_lesson',
    description: '给一个班备一节课：在后台做出教案、课件、课堂练习和课后作业，做好放在「备课」里，老师在那里看、改、放映、发作业。',
    parameters: obj(
      {
        class: str('班名'),
        topic: str('这节讲什么、老师有什么要求；老师没说就不传，按进度备下一节'),
        minutes: { type: 'number', description: '这节课多少分钟；老师没说就不传' },
      },
      ['class'],
    ),
  },
  {
    name: 'new_specialist',
    description:
      '分出一个专门助手：同一类活反复出现、每次要照同一套做法办时用。它的对话一直留着，以后这类活交给它（ask_specialist），越办越熟。已经有管这类活的，就交给那一个，不再分新的。',
    parameters: obj(
      {
        name: str('名字，照它管的活起'),
        duty: str('它管哪一类活，一句话'),
        guide: str('它怎么办：照老师的哪些资料、哪些规矩，要注意什么'),
        homework: str('交给它批的作业标题：以后这份作业交上来的由它批；没有就不传'),
        class: str('作业在哪个班；同名作业在几个班时才填'),
      },
      ['name', 'duty', 'guide'],
    ),
  },
  {
    name: 'ask_specialist',
    description: '把一件活交给你分出来的专门助手，它接着自己以前的对话办，办完把结果交回给你。task 写清楚要它办什么、依据什么；它没听过你和老师的对话。',
    parameters: obj({ specialist: str('专门助手的名字'), task: str('交代') }, ['specialist', 'task']),
  },
  {
    name: 'edit_specialist',
    description: '改一个专门助手：名字、管的事、做法（整段换掉）；或者把某份作业交给它批、不再由它批；或者停用它。',
    parameters: obj(
      {
        specialist: str('专门助手的名字'),
        name: str('新名字'),
        duty: str('新的管什么'),
        guide: str('新的做法'),
        homework: str('作业标题'),
        class: str('作业在哪个班；同名作业在几个班时才填'),
        stop_homework: { type: 'boolean', description: 'true 这份作业不再由它批，改回你自己批' },
        retire: { type: 'boolean', description: 'true 停用它' },
      },
      ['specialist'],
    ),
  },
];

/* ---------------- 小工具 ---------------- */

/** 比较说法时不管空格、引号、书名号、标点 */
const norm = (s: string) => s.replace(/[\s「」『』《》"'“”‘’：:，,。]/g, '').toLowerCase();

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined);
const text = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? undefined : String(v));
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(/[,，、]/) : []);
const score = (n: number) => String(Math.round(n * 10) / 10);
/** 「不设」「无」「没有」「null」都算不设截止 */
const NONE = /^(不设|无|没有|null|none|不限)$/i;

/** 老师说的时间由程序换算（截止只说哪天算 23:59，发布只说哪天算早上 8 点；「往后推两天」从原来的算） */
function due(value: unknown, field: string, from?: number | null): number | null {
  const s = String(value ?? '').trim();
  if (NONE.test(s)) return null;
  const publish = field === '发布时间';
  const t = parseWhen(s, { hour: publish ? 8 : 23, minute: publish ? 0 : 59, from });
  if (t === null) throw bad(`${field}「${s}」看不懂，问老师具体是哪天几点`);
  return t;
}

function tool(ref: RunRef, name: string, label: string, extra: Record<string, unknown> = {}) {
  record(ref, 'tool', { name, label, ...extra });
}

const classLink = (k: { id: number }) => ({ label: '打开班级', to: `/classes/${k.id}` });
const homeworkLink = (h: HomeworkRow, k?: ClassRow, many = false) => ({
  label: many && k ? `看「${k.name}」的` : '看作业',
  to: `/classes/${h.class_id}/homework/${h.id}`,
});

/** 老师发来的一份文件（必须是这位老师的） */
function attachmentOf(teacherId: number, id: number) {
  const row = db.get<any>(
    `SELECT i.*, k.teacher_id FROM kb_intake_items i JOIN kb_intakes n ON n.id=i.intake_id JOIN knowledge_bases k ON k.id=n.kb_id WHERE i.id=?`,
    id,
  );
  if (!row || row.teacher_id !== teacherId) throw notFound(`没有编号 ${id} 的文件`);
  return row as { id: number; name: string; kind: string; size: number; hash: string | null; text_hash: string | null; status: string; reason: string | null };
}

/** 知识库里的一份：「知识库名/路径」 */
function kbEntry(teacherId: number, full: string) {
  const s = String(full || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  const kbs = listKbs(teacherId).filter((k) => k.status === 'active');
  const kb = kbs.find((k) => s === k.name || s.startsWith(k.name + '/'));
  if (!kb) throw notFound(`「${s}」不在知识库里。路径写成「知识库名/路径」，现在的知识库：${kbs.map((k) => `「${k.name}」`).join('、') || '没有'}`);
  const path = s.slice(kb.name.length + 1);
  const e = manifest(kb.id).find((x) => x.path === path);
  if (!e) throw notFound(`「${kb.name}」里没有「${path}」，先用 search_kb 找`);
  return { kb, e };
}

async function upload(userId: number, name: string, bytes: Uint8Array) {
  return callApi<{ id: number; name: string; size: number }>(userId, 'POST', `/homework/files?name=${encodeURIComponent(name)}`, bytes);
}

/** 一份作业在某个班里那个学生：一份作业发了几个班时，按学生在哪个班找 */
function locate(teacherId: number, args: Record<string, unknown>) {
  const { rows, classes } = findHomework(teacherId, String(args.homework ?? ''), text(args.class) || null);
  const who = String(args.student ?? '');
  const tried: string[] = [];
  for (const h of rows) {
    const k = classes.get(h.class_id)!;
    try {
      return { h, k, s: findStudent(h.class_id, k.name, who) };
    } catch (err) {
      tried.push((err as Error).message);
      if (rows.length === 1) throw err;
    }
  }
  throw bad(tried.join('\n'));
}

const SNAP = ['score', 'comment', 'graded_at', 'returned_at', 'submitted_at', 'graded_by', 'items', 'ai_grade_id'] as const;
const pickSnap = (row: Record<string, unknown> | undefined, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, row?.[k] ?? null]));

/* ---------------- 各个工具 ---------------- */

type Handler = (ctx: TaContext, a: Record<string, any>) => Promise<string>;

const handlers: Record<string, Handler> = {
  async list_classes(ctx) {
    tool(ctx.ref, 'ta_look', '查看', { text: '班级' });
    const r = await callApi<{ classes: any[] }>(ctx.user.id, 'GET', '/classes');
    if (!r.classes.length) return '还没有班';
    return r.classes
      .map(
        (k) =>
          `「${k.name}」${k.count} 人，加课码 ${k.code}${k.joinOpen ? '' : '（停止加入）'}${k.archived ? '（已归档）' : ''}${k.pending ? `，${k.pending} 份待批` : ''}`,
      )
      .join('\n');
  },

  async class_detail(ctx, a) {
    const k = findClass(ctx.user.id, String(a.class ?? ''));
    tool(ctx.ref, 'ta_look', '查看', { text: `「${k.name}」` });
    const d = await callApi<any>(ctx.user.id, 'GET', `/classes/${k.id}`);
    const hw = await callApi<{ homework: any[] }>(ctx.user.id, 'GET', `/homework/class/${k.id}`);
    const joined = d.students.filter((s: any) => s.joined),
      waiting = d.students.filter((s: any) => !s.joined);
    const lines = [
      `「${d.name}」加课码 ${d.code}${d.joinOpen ? '' : '（停止加入）'}${d.archived ? '（已归档）' : ''}`,
      `已加入 ${joined.length} 人：${joined.map((s: any) => `${s.name}（${s.studentNo}）`).join('、') || '还没有'}`,
    ];
    if (waiting.length) lines.push(`名单上还没加入 ${waiting.length} 人：${waiting.map((s: any) => `${s.name}（${s.studentNo}）`).join('、')}`);
    lines.push(
      hw.homework.length
        ? `作业：${hw.homework
            .map(
              (h) =>
                `「${h.title}」${h.publishAt > Date.now() ? `${showTime(h.publishAt)} 发布，` : ''}${h.dueAt ? `截止 ${showTime(h.dueAt)}` : '不设截止'}，已交 ${h.submitted}/${h.total}${h.submitted - h.graded > 0 ? `，${h.submitted - h.graded} 份待批` : ''}`,
            )
            .join('；')}`
        : '还没有作业',
    );
    return lines.join('\n');
  },

  async prep_lesson(ctx, a) {
    const k = findClass(ctx.user.id, String(a.class ?? ''));
    const topic = text(a.topic)?.trim() || null;
    const minutes = num(a.minutes);
    const { startLesson } = await import('../prep/make.js');
    const id = startLesson(ctx.user.id, k.id, topic, minutes && minutes >= 10 && minutes <= 300 ? Math.round(minutes) : null);
    recordAction(ctx.ref, 'prep.start', { title: `在给「${k.name}」备课`, lines: [topic || '按进度备下一节'], links: [{ label: '去看', to: `/prep/${id}` }] }, null);
    return `开始备了，在后台做，教案、课件、练习和作业做好都在「备课」里`;
  },

  async create_class(ctx, a) {
    const name = String(a.name ?? '').trim();
    const r = await callApi<{ id: number }>(ctx.user.id, 'POST', '/classes', { name });
    const d = await callApi<any>(ctx.user.id, 'GET', `/classes/${r.id}`);
    recordAction(
      ctx.ref,
      'class.create',
      { title: `建好了班级「${d.name}」`, links: [classLink(d)], code: d.code, classId: d.id, className: d.name },
      { kind: 'class.create', classId: d.id },
    );
    return `建好了「${d.name}」，加课码 ${d.code}`;
  },

  async update_class(ctx, a) {
    const k = findClass(ctx.user.id, String(a.class ?? ''));
    const name = text(a.name)?.trim(),
      archived = bool(a.archived),
      joinOpen = bool(a.join_open),
      newCode = bool(a.new_code) === true;
    const keys = ['name', 'archived_at', 'join_open', 'join_code'];
    const before = pickSnap(db.get<any>('SELECT * FROM classes WHERE id=?', k.id), keys);
    const patch: Record<string, unknown> = {};
    if (name && name !== k.name) patch.name = name;
    if (archived !== undefined && archived !== !!k.archived_at) patch.archived = archived;
    if (joinOpen !== undefined && joinOpen !== !!k.join_open) patch.joinOpen = joinOpen;
    // 归档和停止加入一起说时，先停止加入再归档（归档以后加入设置就动不了了）
    if (patch.joinOpen !== undefined) await callApi(ctx.user.id, 'PATCH', `/classes/${k.id}`, { joinOpen: patch.joinOpen });
    if (patch.name !== undefined || patch.archived !== undefined)
      await callApi(ctx.user.id, 'PATCH', `/classes/${k.id}`, { ...(patch.name !== undefined && { name: patch.name }), ...(patch.archived !== undefined && { archived: patch.archived }) });
    let code: string | undefined;
    if (newCode) code = (await callApi<{ code: string }>(ctx.user.id, 'POST', `/classes/${k.id}/code`)).code;
    const after = pickSnap(db.get<any>('SELECT * FROM classes WHERE id=?', k.id), keys);
    const changed = keys.filter((x) => (before[x] ?? null) !== (after[x] ?? null));
    if (!changed.length) return `「${k.name}」本来就是这样，没有改动`;
    const said = [
      patch.name !== undefined && `改名为「${patch.name}」`,
      patch.archived === true && '归档了',
      patch.archived === false && '恢复了',
      patch.joinOpen === false && '停止了学生加入',
      patch.joinOpen === true && '允许学生加入了',
      code && `换了加课码 ${code}`,
    ].filter(Boolean) as string[];
    recordAction(
      ctx.ref,
      'class.update',
      { title: `「${k.name}」${said.join('，')}`, links: [classLink(k)], ...(code && { code, classId: k.id }) },
      { kind: 'class.update', classId: k.id, before: pickSnap(before, changed), after: pickSnap(after, changed) },
    );
    return `「${k.name}」${said.join('，')}`;
  },

  async delete_class(ctx, a) {
    const k = findClass(ctx.user.id, String(a.class ?? ''));
    await callApi(ctx.user.id, 'DELETE', `/classes/${k.id}`);
    recordAction(ctx.ref, 'class.delete', { title: `删掉了班级「${k.name}」` }, { kind: 'class.delete', classId: k.id });
    return `删掉了「${k.name}」（可以撤回）`;
  },

  async assign_homework(ctx, a) {
    const uid = ctx.user.id;
    const names = [...new Set(list(a.classes).map((x) => String(x).trim()).filter(Boolean))];
    if (!names.length) throw bad('发给哪个班没说，问老师');
    const ks = names.map((n) => findClass(uid, n)).filter((k, i, all) => all.findIndex((x) => x.id === k.id) === i);
    const title = String(a.title ?? '').trim();
    const points = num(a.points) ?? 100;
    let dueAt: number | null;
    if (a.due === undefined || a.due === null || String(a.due).trim() === '') dueAt = weekLater();
    else dueAt = due(a.due, '截止时间');
    const allowLate = bool(a.allow_late) ?? true;
    const publishAt = a.publish_at ? due(a.publish_at, '发布时间') : null;
    if (publishAt !== null && publishAt <= Date.now()) throw bad('定时发布的时间已经过了');
    const fileIds: number[] = [];
    const fileNames: string[] = [];
    for (const raw of list(a.attachments)) {
      const f = attachmentOf(uid, Number(raw));
      if (!f.hash || !['done', 'same'].includes(f.status)) throw bad(`文件「${f.name}」没收全，用不了`);
      const up = await upload(uid, f.name.split('/').pop() || f.name, readFileSync(blobPath(f.hash)));
      fileIds.push(up.id);
      fileNames.push(up.name);
    }
    for (const raw of list(a.kb_files)) {
      const { e } = kbEntry(uid, String(raw));
      if (!e.sourceId) throw bad(`「${raw}」是整理出来的笔记，不能当附件；要把内容发给学生就写进作业要求`);
      const up = await upload(uid, e.path.split('/').pop() || e.path, sourceBytes(e.sourceId, 'original'));
      fileIds.push(up.id);
      fileNames.push(up.name);
    }
    const r = await callApi<{ ids: number[] }>(uid, 'POST', '/homework', {
      classIds: ks.map((k) => k.id),
      title,
      body: String(a.body ?? ''),
      points,
      dueAt,
      allowLate,
      publishAt,
      fileIds,
    });
    const rows = r.ids.map((hid) => db.get<HomeworkRow>('SELECT * FROM assignments WHERE id=?', hid)!);
    const facts = [
      `满分 ${score(points)}`,
      dueAt ? `截止 ${showTime(dueAt)}` : '不设截止',
      dueAt && !allowLate ? '截止后不收' : '',
      publishAt ? `${showTime(publishAt)} 发布` : '',
    ].filter(Boolean);
    recordAction(
      ctx.ref,
      'homework.create',
      {
        title: `${publishAt ? '定时布置' : '布置'}了「${title}」`,
        lines: [`发给 ${ks.map((k) => `「${k.name}」`).join('、')}`, facts.join(' · '), ...(fileNames.length ? [`附件：${fileNames.join('、')}`] : [])],
        links: rows.map((h) => homeworkLink(h, ks.find((k) => k.id === h.class_id), rows.length > 1)),
      },
      { kind: 'homework.create', ids: r.ids },
    );
    return `布置好了「${title}」，发给 ${ks.map((k) => `「${k.name}」`).join('、')}；${facts.join('，')}${fileNames.length ? `；附件 ${fileNames.join('、')}` : ''}。`;
  },

  async update_homework(ctx, a) {
    const uid = ctx.user.id;
    const { rows, classes } = findHomework(uid, String(a.homework ?? ''), text(a.class) || null);
    const body: Record<string, unknown> = {};
    if (text(a.title)?.trim()) body.title = text(a.title)!.trim();
    if (a.body !== undefined) body.body = String(a.body ?? '');
    if (num(a.points) !== undefined) body.points = num(a.points);
    if (a.due !== undefined && a.due !== null && String(a.due).trim() !== '') body.dueAt = due(a.due, '截止时间', rows[0].due_at);
    if (bool(a.allow_late) !== undefined) body.allowLate = bool(a.allow_late);
    if (a.publish_at) body.publishAt = due(a.publish_at, '发布时间', rows[0].publish_at);
    if (!Object.keys(body).length) return '没说要改什么';
    const keys = ['title', 'body', 'points', 'due_at', 'allow_late', 'publish_at'];
    const changed: { id: number; before: Record<string, unknown>; after: Record<string, unknown> }[] = [];
    for (const h of rows) {
      const before = pickSnap(db.get<any>('SELECT * FROM assignments WHERE id=?', h.id), keys);
      await callApi(uid, 'PATCH', `/homework/${h.id}`, body);
      const after = pickSnap(db.get<any>('SELECT * FROM assignments WHERE id=?', h.id), keys);
      const diff = keys.filter((x) => (before[x] ?? null) !== (after[x] ?? null));
      if (diff.length) changed.push({ id: h.id, before: pickSnap(before, diff), after: pickSnap(after, diff) });
    }
    if (!changed.length) return `「${rows[0].title}」本来就是这样，没有改动`;
    const now = db.get<HomeworkRow>('SELECT * FROM assignments WHERE id=?', rows[0].id)!;
    const said = [
      body.title !== undefined && `标题改成「${now.title}」`,
      body.body !== undefined && '改了作业要求',
      body.points !== undefined && `满分改成 ${score(now.points)}`,
      body.dueAt !== undefined && (now.due_at ? `截止改到 ${showTime(now.due_at)}` : '改成不设截止'),
      body.allowLate !== undefined && (now.allow_late ? '截止后还能交' : '截止后不收'),
      body.publishAt !== undefined && `${showTime(now.publish_at)} 发布`,
    ].filter(Boolean) as string[];
    const where = rows.length > 1 ? `（${rows.map((h) => `「${classes.get(h.class_id)?.name}」`).join('、')}）` : '';
    recordAction(
      ctx.ref,
      'homework.update',
      { title: `改了「${rows[0].title}」${where}`, lines: [said.join('，')], links: rows.map((h) => homeworkLink(h, classes.get(h.class_id), rows.length > 1)) },
      { kind: 'homework.update', rows: changed },
    );
    return `改好了「${rows[0].title}」${where}：${said.join('，')}`;
  },

  async delete_homework(ctx, a) {
    const { rows, classes } = findHomework(ctx.user.id, String(a.homework ?? ''), text(a.class) || null);
    for (const h of rows) await callApi(ctx.user.id, 'DELETE', `/homework/${h.id}`);
    const where = rows.map((h) => `「${classes.get(h.class_id)?.name}」`).join('、');
    recordAction(ctx.ref, 'homework.delete', { title: `删掉了「${rows[0].title}」`, lines: [where] }, { kind: 'homework.delete', ids: rows.map((h) => h.id) });
    return `删掉了「${rows[0].title}」（${where}，可以撤回）`;
  },

  async homework_detail(ctx, a) {
    const { rows, classes } = findHomework(ctx.user.id, String(a.homework ?? ''), text(a.class) || null);
    tool(ctx.ref, 'ta_look', '查看', { text: `「${rows[0].title}」交的情况` });
    const out: string[] = [];
    for (const h of rows) {
      const d = await callApi<any>(ctx.user.id, 'GET', `/homework/${h.id}`);
      const k = classes.get(h.class_id)!;
      const by = (f: (s: any) => boolean) => d.students.filter(f).map((s: any) => s.name);
      const graded = d.students
        .filter((s: any) => s.status === 'graded')
        .map((s: any) => `${s.name} ${s.score === null ? '只写了评语' : score(s.score)}${s.gradedBy === 'ai' ? '（助教批的）' : ''}`);
      const waiting = d.students.filter((s: any) => s.status === 'submitted' || s.status === 'late');
      const ai = (s: any) =>
        !s.ai
          ? ''
          : s.ai.status === 'queued' || s.ai.status === 'running'
            ? '，助教在批'
            : s.ai.status === 'error'
              ? '，助教没批成'
              : s.ai.flag
                ? `，助教留给老师看：${s.ai.flag}`
                : `，助教拟了 ${score(s.ai.score ?? 0)} 分等发布`;
      const mode = { release: '助教批完直接发', hold: '助教批完老师看过再发', off: '老师自己批' }[d.aiMode as string] || '';
      out.push(
        [
          `「${d.title}」（${k.name}，满分 ${score(d.points)}，${d.dueAt ? `截止 ${showTime(d.dueAt)}` : '不设截止'}${d.publishAt > Date.now() ? `，${showTime(d.publishAt)} 发布` : ''}${mode ? `，${mode}` : ''}）`,
          `已批 ${graded.length}：${graded.join('、') || '无'}`,
          `待批 ${waiting.length}：${waiting.map((s: any) => `${s.name}${s.late ? '（迟交）' : ''}${ai(s)}`).join('、') || '无'}`,
          `退回等重交：${by((s) => s.status === 'returned').join('、') || '无'}`,
          `没交：${by((s) => s.joined && (s.status === 'todo' || s.status === 'missing')).join('、') || '无'}`,
          ...(by((s) => !s.joined).length ? [`还没加入班级：${by((s) => !s.joined).join('、')}`] : []),
        ].join('\n'),
      );
    }
    return out.join('\n\n');
  },

  async view_submission(ctx, a) {
    const { h, k, s } = locate(ctx.user.id, a);
    tool(ctx.ref, 'ta_look', '查看', { text: `${s.name}交的「${h.title}」` });
    const w = await callApi<any>(ctx.user.id, 'GET', `/homework/${h.id}/students/${s.id}`);
    if (!w.joined) return `${s.name}还没加入「${k.name}」`;
    const sub = w.submission;
    if (!sub) return `${s.name}还没交「${h.title}」`;
    return [
      `${s.name}（${s.student_no}）${showTime(sub.submittedAt)} 交的${sub.late ? '（迟交）' : ''}${w.status === 'returned' ? '，已退回等重交' : ''}`,
      sub.text?.trim() ? `内容：\n${sub.text.slice(0, 4000)}` : '没写文字',
      sub.files?.length ? `附件：${sub.files.map((f: any) => f.name).join('、')}` : '',
      sub.score !== null ? `分数 ${score(sub.score)}${sub.gradedBy === 'ai' ? '（助教批的）' : sub.gradedBy === 'teacher' ? '（老师批的）' : ''}` : '还没打分',
      ...(sub.score !== null && sub.items?.length ? sub.items.map((x: any) => `- ${x.title} ${score(x.got)}/${score(x.max)}：${x.why}`) : []),
      sub.score === null && w.ai?.status === 'done' ? `助教拟了 ${score(w.ai.score ?? 0)} 分${w.ai.flag ? `，留给老师看：${w.ai.flag}` : '，等老师发'}` : '',
      sub.comment ? `评语：${sub.comment}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  },

  async grade(ctx, a) {
    const uid = ctx.user.id;
    const { h, k, s } = locate(uid, a);
    if (!s.user_id) throw bad(`${s.name}还没加入「${k.name}」，没有交作业`);
    const sub = db.get<any>('SELECT * FROM submissions WHERE assignment_id=? AND user_id=?', h.id, s.user_id);
    if (!sub) throw bad(`${s.name}还没交「${h.title}」，没法批`);
    const before = pickSnap(sub, SNAP);
    const comment = text(a.comment);
    const back = bool(a.return) === true;
    const sc = num(a.score);
    if (back) await callApi(uid, 'POST', `/homework/${h.id}/students/${s.id}/return`, { comment: comment ?? sub.comment ?? '' });
    else {
      if (sc === undefined && comment === undefined) throw bad('分数和评语都没说');
      await callApi(uid, 'POST', `/homework/${h.id}/students/${s.id}/grade`, {
        score: sc === undefined ? sub.score : sc,
        comment: comment ?? sub.comment ?? '',
      });
    }
    const now = db.get<any>('SELECT * FROM submissions WHERE id=?', sub.id);
    const title = back ? `退回了${s.name}的「${h.title}」` : now.score === null ? `给${s.name}的「${h.title}」写了评语` : `${s.name}「${h.title}」${score(now.score)} 分`;
    recordAction(
      ctx.ref,
      'submission.grade',
      { title, lines: now.comment ? [now.comment] : [], links: [{ label: '看作业', to: `/classes/${h.class_id}/homework/${h.id}` }] },
      { kind: 'submission.grade', submissionId: sub.id, before, after: pickSnap(now, SNAP) },
    );
    return `${title}（${k.name}，满分 ${score(h.points)}）`;
  },

  async grade_homework(ctx, a) {
    const { rows, classes } = findHomework(ctx.user.id, String(a.homework ?? ''), text(a.class) || null);
    const redo = bool(a.redo) === true;
    let total = 0;
    const parts: string[] = [];
    for (const h of rows) {
      const r = await callApi<{ queued: number }>(ctx.user.id, 'POST', `/homework/${h.id}/ai-grade`, { redo });
      total += r.queued;
      parts.push(`「${classes.get(h.class_id)!.name}」${r.queued} 份`);
    }
    recordAction(
      ctx.ref,
      'homework.ai_grade',
      { title: total ? `开始批「${rows[0].title}」` : `「${rows[0].title}」没有要批的`, lines: rows.length > 1 || total ? [parts.join('，')] : [], links: [homeworkLink(rows[0])] },
      null,
    );
    if (!total) return `「${rows[0].title}」没有要批的：交了的都批过了（重批 redo 传 true），或者还没人交`;
    return `开始批「${rows[0].title}」：${parts.join('，')}。在后台批，一份半分钟左右，批完会告诉老师`;
  },

  async homework_review(ctx, a) {
    const uid = ctx.user.id;
    const { rows, classes } = findHomework(uid, String(a.homework ?? ''), text(a.class) || null);
    if (rows.length > 1) throw bad(`「${rows[0].title}」发给了 ${rows.map((h) => `「${classes.get(h.class_id)!.name}」`).join('、')}，讲评一个班一份，说是哪个班的`);
    const h = rows[0],
      k = classes.get(h.class_id)!;
    tool(ctx.ref, 'ta_look', '查看', { text: `「${h.title}」的讲评` });
    let d = await callApi<any>(uid, 'GET', `/homework/${h.id}/review`);
    const stale = d.review?.status === 'ready' && d.graded > (d.review.gradedAtWrite || 0);
    if (!d.review || d.review.status === 'error' || stale || bool(a.rewrite) === true) {
      if (!d.graded) return `「${h.title}」（${k.name}）还没有批好的作业，批完才能写讲评`;
      await callApi(uid, 'POST', `/homework/${h.id}/review`);
    }
    // 等它写完（一般半分钟）
    for (let i = 0; i < 150; i++) {
      d = await callApi<any>(uid, 'GET', `/homework/${h.id}/review`);
      if (d.review?.status !== 'writing') break;
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    if (d.review?.status !== 'ready') return `讲评没写成：${d.review?.error || '再试一次'}`;
    let shared = !!d.review.sharedAt;
    if (bool(a.share) === true && !shared) {
      await callApi(uid, 'POST', `/homework/${h.id}/review/share`, { on: true });
      shared = true;
    }
    const w = d.review.write,
      st = d.review.stats;
    recordAction(
      ctx.ref,
      'homework.review',
      {
        title: `「${h.title}」讲评${shared ? '（已发给学生）' : ''}`,
        lines: [w.summary].filter(Boolean),
        links: [
          { label: '看讲评', to: `/classes/${h.class_id}/homework/${h.id}/review` },
          { label: '下载 Word', href: `/api/homework/${h.id}/review/docx` },
        ],
      },
      null,
    );
    return [
      `「${h.title}」（${k.name}）班里 ${st.total} 人，交了 ${st.submitted} 人，批了 ${st.graded} 份，平均 ${st.avg ?? '—'} 分（满分 ${score(st.points)}）`,
      w.summary,
      ...w.errors.map((e: any, i: number) => `${i + 1}. ${e.title}（${e.students.length} 人：${e.students.join('、')}）；怎么讲：${e.teach}`),
      w.next ? `下节课：${w.next}` : '',
      st.missing.length ? `没交：${st.missing.join('、')}` : '',
      st.similar.length ? `很像的：${st.similar.map((x: any) => `${x.names.join('和')} ${x.ratio}%`).join('；')}` : '',
      shared ? '学生那边已经能看到不带名字的讲评' : '',
    ]
      .filter(Boolean)
      .join('\n');
  },

  async class_grades(ctx, a) {
    const k = findClass(ctx.user.id, String(a.class ?? ''));
    tool(ctx.ref, 'ta_look', '查看', { text: `「${k.name}」的成绩` });
    const g = await callApi<any>(ctx.user.id, 'GET', `/homework/class/${k.id}/grades`);
    if (bool(a.export) === true)
      recordAction(
        ctx.ref,
        'grades.export',
        {
          title: `「${k.name}」的成绩表`,
          lines: [`${g.rows.length} 个学生 · ${g.homework.length} 份作业`],
          links: [
            { label: '下载 Excel', href: `/api/homework/class/${k.id}/grades/export` },
            { label: '看成绩', to: `/classes/${k.id}?tab=grades` },
          ],
        },
        null,
      );
    if (!g.homework.length) return `「${k.name}」还没有发布的作业`;
    const head = g.homework.map((h: any) => `「${h.title}」满分 ${score(h.points)}`).join('，');
    const rows = g.rows.map((r: any) => {
      const cells = g.homework.map((h: any) => {
        const c = r.cells[h.id];
        if (!c) return '—';
        if (c.score !== null) return score(c.score);
        return { todo: '未交', missing: '缺交', submitted: '待批', late: '待批', returned: '退回', graded: '已批' }[c.status as string] || '—';
      });
      return `${r.name}（${r.studentNo}）：${cells.join(' / ')}；平均 ${r.average === null ? '—' : score(r.average)}`;
    });
    return [`「${k.name}」成绩（${head}；平均分是百分制，过了截止没交算 0，没批的不算）`, ...rows, bool(a.export) === true ? '已经给老师放了下载 Excel 的按钮' : '']
      .filter(Boolean)
      .join('\n');
  },

  async search_kb(ctx, a) {
    const words = String(a.query ?? '')
      .split(/\s+/)
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
    if (!words.length) throw bad('要找什么没说');
    tool(ctx.ref, 'search', '查找', { text: String(a.query) });
    const hits: { where: string; snippet: string; score: number }[] = [];
    for (const kb of listKbs(ctx.user.id).filter((k) => k.status === 'active')) {
      for (const e of manifest(kb.id)) {
        // 读文字：笔记、文字版的原件、原件转出来的文字；Word、图片这些原件本身跳过（它们转出来的文字另有一份）
        if (!isTextEntry(e)) continue;
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
    if (!hits.length) return `知识库里没找到「${a.query}」`;
    hits.sort((x, y) => y.score - x.score);
    return hits
      .slice(0, 12)
      .map((h) => `${h.where}：…${h.snippet}…`)
      .join('\n');
  },

  async read_kb(ctx, a) {
    const { kb, e } = kbEntry(ctx.user.id, String(a.path ?? ''));
    tool(ctx.ref, 'read_file', '阅读', { path: `${kb.name}/${e.path}` });
    const body = readEntry(kb.id, e).toString('utf8');
    const from = Math.max(0, num(a.offset) ?? 0);
    const piece = body.slice(from, from + 8000);
    const rest = body.length - from - piece.length;
    return piece + (rest > 0 ? `\n（还有 ${rest} 字，接着读 offset=${from + piece.length}）` : '');
  },

  async read_attachment(ctx, a) {
    const f = attachmentOf(ctx.user.id, Number(a.id));
    tool(ctx.ref, 'read_file', '阅读', { path: f.name });
    if (!f.text_hash) return `「${f.name}」${f.reason || '没有读出文字'}`;
    const body = readBlobText(f.text_hash);
    const from = Math.max(0, num(a.offset) ?? 0);
    const piece = body.slice(from, from + 8000);
    const rest = body.length - from - piece.length;
    return piece + (rest > 0 ? `\n（还有 ${rest} 字，接着读 offset=${from + piece.length}）` : '');
  },

  async hand_to_keeper(ctx, a) {
    const brief = String(a.brief ?? '').trim();
    if (!brief) throw bad('交代是空的');
    const ids = list(a.attachments).map(Number).filter((n) => Number.isFinite(n));
    for (const id of ids) attachmentOf(ctx.user.id, id);
    const jobId = ctx.startJob(brief, text(a.kb)?.trim() || null, ids);
    return `交给整理助手了（后台任务 ${jobId}），它做完会告诉你`;
  },

  async undo(ctx, a) {
    const want = norm(String(a.what ?? ''));
    const done = db.all<{ id: number; title: string }>(
      "SELECT id, title FROM ta_actions WHERE teacher_id=? AND status='done' AND undo IS NOT NULL ORDER BY id DESC LIMIT 50",
      ctx.user.id,
    );
    if (!done.length) return '没有能撤回的事';
    const hit = want ? done.find((x) => norm(x.title).includes(want) || want.includes(norm(x.title))) : done[0];
    if (!hit) return `没找到「${a.what}」。最近办的：${done.slice(0, 6).map((x) => `「${x.title}」`).join('、')}`;
    const message = undoAction(ctx.user.id, hit.id);
    tool(ctx.ref, 'revert_change', '撤回', { title: hit.title });
    return message;
  },

  async reset_password(ctx, a) {
    const who = String(a.student ?? '');
    type Hit = { k: ClassRow; s: ReturnType<typeof findStudent> };
    let hit: Hit;
    if (text(a.class)) {
      const k = findClass(ctx.user.id, String(a.class));
      hit = { k, s: findStudent(k.id, k.name, who) };
    } else {
      const found: Hit[] = [];
      for (const k of classesOf(ctx.user.id))
        try {
          found.push({ k, s: findStudent(k.id, k.name, who) });
        } catch {
          /* 这个班里没有 */
        }
      if (!found.length) throw bad(`哪个班里都没有「${who}」`);
      if (new Set(found.map((f) => f.s.user_id ?? `m${f.s.id}`)).size > 1)
        throw bad(`「${who}」对得上好几个学生：${found.map((f) => `${f.s.name}（${f.s.student_no}，${f.k.name}）`).join('、')}。先问老师是哪一个`);
      hit = found[0];
    }
    if (!hit.s.user_id) throw bad(`${hit.s.name}还没加入「${hit.k.name}」，没有账号`);
    const r = await callApi<{ password: string }>(ctx.user.id, 'POST', `/classes/${hit.k.id}/students/${hit.s.id}/password`);
    recordAction(
      ctx.ref,
      'student.password',
      { title: `重置了${hit.s.name}的密码`, lines: [`学号 ${hit.s.student_no}，用新密码登录，原来的密码不能再用`], secret: r.password },
      null,
    );
    return `已重置${hit.s.name}（${hit.s.student_no}）的密码，新密码在卡片上给老师了`;
  },

  async notify_students(ctx, a) {
    const names = [...new Set(list(a.classes).map((x) => String(x).trim()).filter(Boolean))];
    if (!names.length) throw bad('发给哪个班没说，问老师');
    const message = String(a.message ?? '').trim();
    if (!message) throw bad('通知的话没写');
    const ks = names.map((n) => findClass(ctx.user.id, n)).filter((k, i, all) => all.findIndex((x) => x.id === k.id) === i);
    const hwTitle = text(a.homework)?.trim();
    const out: string[] = [];
    const lines: string[] = [];
    for (const k of ks) {
      const h = hwTitle ? findHomework(ctx.user.id, hwTitle, k.name).rows[0] : null;
      const sent = notifyClass({ classId: k.id, text: message, missingHomework: h?.id ?? null });
      const who = h ? `「${h.title}」没交的 ${sent.length} 人` : `${sent.length} 人`;
      out.push(`「${k.name}」${who}${sent.length && h ? `：${sent.slice(0, 30).join('、')}` : ''}`);
      lines.push(`「${k.name}」${who}`);
    }
    recordAction(ctx.ref, 'students.notify', { title: '发了通知', lines: [message, ...lines] }, null);
    return `通知发出去了：${out.join('；')}${hwTitle ? '' : '。也写进了资料包，学生以后问学伴也知道'}`;
  },

  async reply_student(ctx, a) {
    const r = replyStudent(ctx.user.id, { student: String(a.student ?? ''), reply: String(a.reply ?? ''), question: text(a.question) });
    recordAction(ctx.ref, 'student.reply', { title: `回复了${r.student}`, lines: [`${r.className} · 问的：${r.ask.question.slice(0, 80)}`, String(a.reply ?? '').trim()] }, null);
    return `已经回复${r.className}的${r.student}`;
  },

  async update_pack(ctx, a) {
    const names = [...new Set(list(a.classes).map((x) => String(x).trim()).filter(Boolean))];
    if (!names.length) throw bad('哪个班没说');
    const title = String(a.title ?? '').trim();
    if (!title) throw bad('标题没写');
    const ks = names.map((n) => findClass(ctx.user.id, n)).filter((k, i, all) => all.findIndex((x) => x.id === k.id) === i);
    const where = ks.map((k) => `「${k.name}」`).join('、');
    if (bool(a.remove) === true) {
      const gone = ks.filter((k) => !!dropPack(k.id, title) || revokeFile(k.id, title));
      if (!gone.length) return `${where}的资料包里没有「${title}」`;
      recordAction(ctx.ref, 'pack.update', { title: `资料包去掉了「${title}」`, lines: [gone.map((k) => `「${k.name}」`).join('、')] }, null);
      return `去掉了「${title}」（${gone.map((k) => `「${k.name}」`).join('、')}）`;
    }
    const body = String(a.body ?? '').trim();
    if (!body) throw bad('内容没写');
    const kind = isPackKind(a.kind) && ['rule', 'notice', 'qa'].includes(a.kind) ? a.kind : 'rule';
    for (const k of ks) putPack(k.id, kind, title, body);
    recordAction(ctx.ref, 'pack.update', { title: `资料包写了「${title}」`, lines: [where, body] }, null);
    return `写进了${where}的资料包：「${title}」`;
  },

  async give_files(ctx, a) {
    const names = [...new Set(list(a.classes).map((x) => String(x).trim()).filter(Boolean))];
    if (!names.length) throw bad('哪个班没说');
    const ks = names.map((n) => findClass(ctx.user.id, n)).filter((k, i, all) => all.findIndex((x) => x.id === k.id) === i);
    const files = Array.isArray(a.files) ? a.files : [];
    if (!files.length) throw bad('给哪份没说');
    const done: string[] = [];
    const failed: string[] = [];
    for (const f of files.slice(0, 20)) {
      try {
        const hit = kbOriginal(ctx.user.id, String(f?.path ?? ''));
        for (const k of ks) grantFile(k.id, hit.kb.id, hit.sourceId, hit.name, String(f?.note ?? ''));
        done.push(hit.name);
      } catch (err) {
        failed.push((err as Error).message);
      }
    }
    if (done.length)
      recordAction(ctx.ref, 'pack.files', { title: `资料包放进了 ${done.length} 份文件`, lines: [ks.map((k) => `「${k.name}」`).join('、'), done.join('、')] }, null);
    return [done.length ? `放进了${ks.map((k) => `「${k.name}」`).join('、')}的资料包：${done.map((n) => `「${n}」`).join('、')}，学生问学伴就能拿到` : '', ...failed]
      .filter(Boolean)
      .join('\n');
  },

  async view_pack(ctx, a) {
    const k = findClass(ctx.user.id, String(a.class ?? ''));
    tool(ctx.ref, 'ta_look', '查看', { text: `「${k.name}」的资料包` });
    return renderPack(k.id, { teacherView: true });
  },

  async student_questions(ctx, a) {
    const k = findClass(ctx.user.id, String(a.class ?? ''));
    tool(ctx.ref, 'ta_look', '查看', { text: `「${k.name}」学生问的` });
    const days = Math.min(60, Math.max(1, num(a.days) ?? 7));
    const since = Date.now() - days * 86400_000;
    const members = db.all<{ user_id: number; name: string }>('SELECT user_id, name FROM class_students WHERE class_id=? AND user_id IS NOT NULL', k.id);
    const lines: string[] = [];
    for (const m of members) {
      // 学生还有别的老师的班：只看说到这个班的那几轮
      const all = myClasses(m.user_id).every((c) => c.teacher_id === ctx.user.id);
      for (const r of db.all<{ request: string; class_ids: string | null; created_at: number }>(
        "SELECT request, class_ids, created_at FROM kb_runs WHERE teacher_id=? AND agent='stu' AND kind='chat' AND created_at>=? ORDER BY id",
        m.user_id,
        since,
      ))
        if (all || (JSON.parse(r.class_ids || '[]') as number[]).includes(k.id)) lines.push(`${showTime(r.created_at)} ${m.name}：${r.request.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
    const asks = db.all<{ question: string; status: string; reply: string | null; user: string }>(
      `SELECT a.question, a.status, a.reply, s.name AS user FROM student_asks a JOIN class_students s ON s.class_id=a.class_id AND s.user_id=a.student_id
       WHERE a.class_id=? AND a.created_at>=? AND a.status IN ('teacher','replied') ORDER BY a.id`,
      k.id,
      since,
    );
    if (!lines.length && !asks.length) return `「${k.name}」最近 ${days} 天没有学生问学伴`;
    return [
      `「${k.name}」最近 ${days} 天，${members.length} 个学生里 ${new Set(lines.map((l) => l.split('：')[0].split(' ').pop())).size} 个问过学伴，一共 ${lines.length} 句：`,
      ...lines.slice(-200),
      ...(asks.length ? ['转来问老师的：', ...asks.map((x) => `${x.user}：${x.question.slice(0, 100)}（${x.status === 'replied' ? `已回：${(x.reply || '').slice(0, 60)}` : '还在等老师回'}）`)] : []),
    ].join('\n');
  },
};

/* ---------------- 专门助手 ---------------- */

/** 作业交给哪个专门助手批：改之前每份作业是谁批的（撤回用），改之后是谁 */
function bindHomework(teacherId: number, a: Record<string, any>, to: (current: number | null) => number | null) {
  const { rows } = findHomework(teacherId, String(a.homework ?? ''), text(a.class) || null);
  const before = rows.map((h) => ({ id: h.id, specialist_id: db.value<number>('SELECT specialist_id FROM assignments WHERE id=?', h.id) ?? null }));
  const after = before.map((b) => ({ id: b.id, specialist_id: to(b.specialist_id) }));
  for (const x of after) db.run('UPDATE assignments SET specialist_id=? WHERE id=?', x.specialist_id, x.id);
  return { rows, before, after };
}

Object.assign(handlers, {
  async new_specialist(ctx: TaContext, a: Record<string, any>) {
    const s = createSpecialist(ctx.user.id, { name: a.name, duty: a.duty, guide: a.guide });
    const hw = text(a.homework) ? bindHomework(ctx.user.id, a, () => s.id) : null;
    recordAction(
      ctx.ref,
      'specialist.create',
      { title: `分出专门助手「${s.name}」`, lines: [`管：${s.duty}`, ...(hw ? [`批：${hw.rows.map((h) => `「${h.title}」`).join('、')}`] : [])] },
      { kind: 'specialist.create', id: s.id, homework: hw?.before ?? [] },
    );
    return `分好了「${s.name}」${hw ? `，以后「${hw.rows[0].title}」交上来的由它批` : ''}。这类活以后用 ask_specialist 交给它`;
  },

  async ask_specialist(ctx: TaContext, a: Record<string, any>) {
    const s = findSpecialist(ctx.user.id, a.specialist);
    const task = String(a.task ?? '').trim();
    tool(ctx.ref, 'ta_specialist', `交给「${s.name}」`, { text: task.slice(0, 80) });
    const r = await runSpecialist({ teacherId: ctx.user.id, specialist: s, task, signal: ctx.signal ?? new AbortController().signal });
    return r.text ? `「${s.name}」交回：${r.text}` : `「${s.name}」没交回结果`;
  },

  async edit_specialist(ctx: TaContext, a: Record<string, any>) {
    const s = findSpecialist(ctx.user.id, a.specialist);
    const stop = bool(a.stop_homework) === true;
    const hw = text(a.homework) ? bindHomework(ctx.user.id, a, (cur) => (stop ? (cur === s.id ? null : cur) : s.id)) : null;
    const { before, after, row } = updateSpecialist(ctx.user.id, s.id, { name: a.name, duty: a.duty, guide: a.guide, retire: bool(a.retire) === true });
    const what = [
      after.name ? `名字改成「${after.name}」` : '',
      after.duty ? `管的事改成：${after.duty}` : '',
      after.guide ? '做法改了' : '',
      after.retired_at ? '停用了' : '',
      hw ? (stop ? `「${hw.rows[0].title}」改回你自己批` : `「${hw.rows[0].title}」交给它批`) : '',
    ].filter(Boolean);
    if (!what.length) return '没说要改什么';
    recordAction(
      ctx.ref,
      'specialist.update',
      { title: `改了专门助手「${s.name}」`, lines: what },
      { kind: 'specialist.update', id: s.id, before, after, homework: hw?.before ?? [], homeworkAfter: hw?.after ?? [] },
    );
    return `「${row.name}」${what.join('，')}`;
  },
} satisfies Record<string, Handler>);

/** 办一件事；没办成的把原因交回给助教（它会换个办法或者问老师） */
export async function runTaTool(ctx: TaContext, call: ToolCall): Promise<{ content: string; ok: boolean }> {
  const h = Object.hasOwn(handlers, call.name) ? handlers[call.name] : null;
  if (!h) return { content: `没有「${call.name}」这个工具`, ok: false };
  try {
    return { content: await h(ctx, call.args || {}), ok: true };
  } catch (err) {
    const msg = (err as Error).message || '没办成';
    if (!(err instanceof Error) || !('status' in err)) console.error('[ta] tool', call.name, err);
    return { content: `没办成：${msg}`, ok: false };
  }
}
