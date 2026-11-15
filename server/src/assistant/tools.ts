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
import { classesOf, findClass, findHomework, findStudent, type ClassRow, type HomeworkRow } from './resolve.js';
import { parseWhen, showTime, weekLater } from './time.js';

export interface TaContext {
  user: { id: number; name: string };
  ref: RunRef;
  /** 交给后台整理助手一件活，返回后台任务的编号 */
  startJob: (brief: string, kbName: string | null, attachmentIds: number[]) => number;
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

const SNAP = ['score', 'comment', 'graded_at', 'returned_at', 'submitted_at'] as const;
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
    const used: string[] = [];
    const points = num(a.points) ?? (used.push('满分 100'), 100);
    let dueAt: number | null;
    if (a.due === undefined || a.due === null || String(a.due).trim() === '') {
      dueAt = weekLater();
      used.push(`截止 ${showTime(dueAt)}（一周后）`);
    } else dueAt = due(a.due, '截止时间');
    const allowLate = bool(a.allow_late) ?? (used.push('截止后还能交（标迟交）'), true);
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
    return `布置好了「${title}」，发给 ${ks.map((k) => `「${k.name}」`).join('、')}；${facts.join('，')}${fileNames.length ? `；附件 ${fileNames.join('、')}` : ''}。${
      used.length ? `老师没说、按常规定的：${used.join('、')}。` : ''
    }`;
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
      const graded = d.students.filter((s: any) => s.status === 'graded').map((s: any) => `${s.name} ${s.score === null ? '只写了评语' : score(s.score)}`);
      const waiting = d.students.filter((s: any) => s.status === 'submitted' || s.status === 'late').map((s: any) => `${s.name}${s.late ? '（迟交）' : ''}`);
      out.push(
        [
          `「${d.title}」（${k.name}，满分 ${score(d.points)}，${d.dueAt ? `截止 ${showTime(d.dueAt)}` : '不设截止'}${d.publishAt > Date.now() ? `，${showTime(d.publishAt)} 发布` : ''}）`,
          `已批 ${graded.length}：${graded.join('、') || '无'}`,
          `待批 ${waiting.length}：${waiting.join('、') || '无'}`,
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
      sub.score !== null ? `分数 ${score(sub.score)}` : '还没打分',
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
};

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
