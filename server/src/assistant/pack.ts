/**
 * 班级资料包。
 * 助教在建班、布置作业时顺手给这个班的学伴写说明；学伴先看资料包，拿不准再去问助教；助教答过的、老师定过的也写回来。
 * 作业的标题、截止、满分、要求由程序从作业表里现取（改了截止不用重写）；助教写的是说明、规矩、通知、答过的问题。
 * 能发给学生的文件另记一张表（class_files），学伴只能发这里面的。
 */
import { db, now } from '../db/index.js';
import { bad, notFound } from '../lib/http.js';
import { listKbs } from '../kb/bases.js';
import { manifest } from '../kb/repo.js';
import { showTime } from './time.js';

export type PackKind = 'course' | 'homework' | 'rule' | 'notice' | 'qa';
const KINDS: PackKind[] = ['course', 'homework', 'rule', 'notice', 'qa'];
export const isPackKind = (k: unknown): k is PackKind => KINDS.includes(k as PackKind);

export interface PackRow {
  id: number;
  class_id: number;
  kind: PackKind;
  ref_id: number | null;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
}
export interface ClassFileRow {
  id: number;
  class_id: number;
  kb_id: number;
  source_id: string;
  name: string;
  note: string;
  created_at: number;
}

export const packItems = (classId: number) =>
  db.all<PackRow>('SELECT id, class_id, kind, ref_id, title, body, created_at, updated_at FROM class_pack WHERE class_id=? AND deleted_at IS NULL ORDER BY id', classId);
export const classFiles = (classId: number) =>
  db.all<ClassFileRow>('SELECT id, class_id, kb_id, source_id, name, note, created_at FROM class_files WHERE class_id=? AND removed_at IS NULL ORDER BY id', classId);

/** 「王建国」→「王建国老师」；名字本来就带「老师」的不再加 */
export const teacherTitle = (name: string) => (/老师$/.test(name) ? name : `${name}老师`);

const same = (a: string, b: string) => a.replace(/[\s「」『』《》"'“”]/g, '').toLowerCase() === b.replace(/[\s「」『』《》"'“”]/g, '').toLowerCase();

/**
 * 写一条：课程说明一个班只有一条；作业说明按作业（ref_id）；别的按标题，同一个标题再写就是改。
 */
export function putPack(classId: number, kind: PackKind, title: string, body: string, refId: number | null = null): { id: number; created: boolean } {
  const t = now();
  const clean = String(body ?? '').trim();
  const name = String(title ?? '').trim().slice(0, 80) || (kind === 'course' ? '课程' : '说明');
  const old =
    kind === 'course'
      ? db.get<PackRow>("SELECT * FROM class_pack WHERE class_id=? AND kind='course' AND deleted_at IS NULL", classId)
      : kind === 'homework' && refId
        ? db.get<PackRow>("SELECT * FROM class_pack WHERE class_id=? AND kind='homework' AND ref_id=? AND deleted_at IS NULL", classId, refId)
        : packItems(classId).find((r) => r.kind === kind && same(r.title, name));
  if (old) {
    db.update('class_pack', old.id, { title: name, body: clean, updated_at: t });
    return { id: old.id, created: false };
  }
  return { id: db.insert('class_pack', { class_id: classId, kind, ref_id: refId, title: name, body: clean, created_at: t, updated_at: t }), created: true };
}

/** 去掉一条（按标题，哪一类都算） */
export function dropPack(classId: number, title: string): PackRow | null {
  const hit = packItems(classId).find((r) => same(r.title, title));
  if (!hit) return null;
  db.update('class_pack', hit.id, { deleted_at: now() });
  return hit;
}

/** 作业删了：它的说明也收起来 */
export function dropHomeworkNote(homeworkId: number) {
  db.run("UPDATE class_pack SET deleted_at=? WHERE kind='homework' AND ref_id=? AND deleted_at IS NULL", now(), homeworkId);
}

/** 知识库里的一份原件：「知识库名/路径」→ 哪个库、原件编号、名字。学生交的作业不能给别的学生（程序拦，不靠助教判断） */
export function kbOriginal(teacherId: number, full: string) {
  const s = String(full || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  const kbs = listKbs(teacherId).filter((k) => k.status === 'active');
  const kb = kbs.find((k) => s === k.name || s.startsWith(k.name + '/'));
  if (!kb) throw notFound(`「${s}」不在知识库里，路径写成「知识库名/路径」`);
  const path = s.slice(kb.name.length + 1);
  const e = manifest(kb.id).find((x) => x.path === path);
  if (!e) throw notFound(`「${kb.name}」里没有「${path}」，先用 search_kb 找`);
  if (e.studentId !== undefined) throw bad(`「${path}」是学生交的，不能发给别的学生`);
  if (!e.sourceId) throw bad(`「${path}」是整理出来的笔记，不能当文件发；要给学生看就把要点写进回话或资料包`);
  // 学生下载到的是原件：名字用原件的（PDF 转出来的文字版路径是 .md，名字不能跟着它）
  const original = db.value<string>('SELECT name FROM kb_sources WHERE id=?', e.sourceId);
  return { kb, sourceId: e.sourceId, name: (original || path).split('/').pop() || path };
}

export function grantFile(classId: number, kbId: number, sourceId: string, name: string, note: string) {
  const t = now();
  const old = db.get<{ id: number }>('SELECT id FROM class_files WHERE class_id=? AND source_id=?', classId, sourceId);
  if (old) {
    db.update('class_files', old.id, { kb_id: kbId, name, note: note.trim(), removed_at: null });
    return old.id;
  }
  return db.insert('class_files', { class_id: classId, kb_id: kbId, source_id: sourceId, name, note: note.trim(), created_at: t });
}
export function revokeFile(classId: number, name: string): boolean {
  const hit = classFiles(classId).find((f) => same(f.name, name));
  if (!hit) return false;
  db.update('class_files', hit.id, { removed_at: now() });
  return true;
}

/* ---------------- 摆出来给模型看 ---------------- */

/** 资料包里最多摆这么多，免得越攒越长：作业取最近的，答过的问题取最近的 */
const MAX_HW = 15;
const MAX_QA = 30;
const MAX_NOTICE = 10;
const MAX_FILES = 40;

interface HwRow {
  id: number;
  title: string;
  body: string;
  points: number;
  due_at: number | null;
  allow_late: number;
  publish_at: number;
}
const score = (n: number) => String(Math.round(n * 10) / 10);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

/**
 * 一个班的资料包，照学伴（也照助教）看的样子：班、老师、课程说明、已经发布的作业（现取的截止和要求，加上助教的说明）、
 * 规矩、通知、答过的问题、能发给学生的文件。teacherView：给助教看时也摆还没发布的作业。
 */
export function renderPack(classId: number, o: { teacherView?: boolean; at?: number } = {}): string {
  const k = db.get<{ id: number; name: string; archived_at: number | null; teacher: string }>(
    'SELECT c.id, c.name, c.archived_at, u.name AS teacher FROM classes c JOIN users u ON u.id=c.teacher_id WHERE c.id=?',
    classId,
  );
  if (!k) return '';
  const t = o.at ?? now();
  const items = packItems(classId);
  const by = (kind: PackKind) => items.filter((r) => r.kind === kind);
  const notes = new Map(by('homework').map((r) => [r.ref_id, r]));
  const hw = db
    .all<HwRow>(
      `SELECT id, title, body, points, due_at, allow_late, publish_at FROM assignments WHERE class_id=? AND deleted_at IS NULL ${o.teacherView ? '' : 'AND publish_at<=?'} ORDER BY publish_at DESC, id DESC LIMIT ${MAX_HW}`,
      ...(o.teacherView ? [classId] : [classId, t]),
    )
    .reverse();
  const out: string[] = [`「${k.name}」（${teacherTitle(k.teacher)}${k.archived_at ? '，已归档' : ''}）`];
  const course = by('course')[0];
  if (course?.body) out.push(`课程：${course.body}`);
  if (hw.length) {
    out.push('作业：');
    for (const h of hw) {
      const files = db.all<{ name: string }>('SELECT name FROM homework_files WHERE assignment_id=? ORDER BY id', h.id).map((f) => f.name);
      const facts = [
        h.publish_at > t ? `${showTime(h.publish_at)} 发布（还没发布）` : '',
        h.due_at ? `截止 ${showTime(h.due_at)}${h.due_at < t ? '（已截止）' : ''}` : '不设截止',
        `满分 ${score(h.points)}`,
        h.due_at ? (h.allow_late ? '截止后还能交（算迟交）' : '截止后不收') : '',
      ].filter(Boolean);
      out.push(`- 「${h.title}」${facts.join('，')}`);
      if (h.body.trim()) out.push(`  要求：${clip(h.body.trim().replace(/\s*\n\s*/g, ' '), 600)}`);
      if (files.length) out.push(`  附件：${files.join('、')}`);
      const note = notes.get(h.id);
      if (note?.body) out.push(`  助教的说明：${note.body}`);
    }
  }
  const list = (label: string, rows: PackRow[], dated = false) => {
    if (!rows.length) return;
    out.push(`${label}：`);
    for (const r of rows) out.push(`- ${dated ? `${showTime(r.updated_at)} ` : ''}「${r.title}」${r.body}`);
  };
  list('规矩', by('rule'));
  list('通知', by('notice').slice(-MAX_NOTICE), true);
  list('答过的问题', by('qa').slice(-MAX_QA));
  const files = classFiles(classId).slice(-MAX_FILES);
  if (files.length) {
    out.push('能发给学生的文件：');
    for (const f of files) out.push(`- 「${f.name}」${f.note ? `：${f.note}` : ''}`);
  }
  return out.join('\n');
}
