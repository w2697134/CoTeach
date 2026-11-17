import { db, j } from '../db/index.js';
import { bad, forbidden, notFound, conflict } from '../lib/http.js';

export interface KnowledgeBase {
  id: number;
  teacher_id: number;
  kind: 'teacher' | 'class';
  name: string;
  class_name: string | null;
  term: string | null;
  status: 'active' | 'archived';
  head_sha: string | null;
  created_at: number;
  archived_at: number | null;
  /** 老师删掉的知识库只做记号，内容和记录都还在 */
  deleted_at: number | null;
}
export interface Student {
  id: number;
  kb_id: number;
  name: string;
  student_no: string;
  aliases: string[];
  user_id: number | null;
}
export type Principal = { id: number; role: string };
export type Reader = {
  role: 'teacher' | 'keeper' | 'assistant' | 'student';
  teacherId: number;
  classId?: number;
  studentId?: number;
};

export function loadKb(id: number): KnowledgeBase {
  const row = db.get<KnowledgeBase>('SELECT * FROM knowledge_bases WHERE id=?', id);
  if (!row) throw notFound('知识库不存在');
  return row;
}
export function ownKb(user: Principal, id: number): KnowledgeBase {
  const kb = loadKb(id);
  if (!['teacher', 'admin'].includes(user.role) || kb.teacher_id !== user.id) throw forbidden('你没有这个知识库的访问权限');
  if (kb.deleted_at) throw notFound('这个知识库已经删掉了');
  return kb;
}
export function writableKb(id: number): KnowledgeBase {
  const kb = loadKb(id);
  if (kb.deleted_at) throw notFound('这个知识库已经删掉了');
  if (kb.status === 'archived') throw conflict('这个学期已封存，只能查阅');
  return kb;
}
export function students(kbId: number): Student[] {
  return db
    .all<any>('SELECT * FROM kb_students WHERE kb_id=? ORDER BY student_no,id', kbId)
    .map(asStudent);
}
function asStudent(row: any): Student {
  const aliases=j<unknown>(row.aliases,[]);
  return {...row,aliases:Array.isArray(aliases)?aliases.filter((v):v is string=>typeof v==='string'):[]};
}
export function studentIn(kbId: number, id: number): Student {
  const s = students(kbId).find((s) => s.id === id);
  if (!s) throw forbidden('学生不属于这个班级');
  return s;
}
export function authorizeReader(kbId: number, reader: Reader) {
  const kb = loadKb(kbId);
  if (kb.teacher_id !== reader.teacherId || kb.deleted_at) throw forbidden();
  if (reader.role === 'student' && (kb.kind !== 'class' || reader.studentId === undefined)) throw forbidden();
  if (kb.kind === 'class' && reader.classId !== kb.id) throw forbidden('先进到对应班级里再看');
  if (reader.studentId !== undefined) {
    if (!reader.classId) throw forbidden();
    const classroom = loadKb(reader.classId);
    if (classroom.teacher_id !== kb.teacher_id || classroom.kind !== 'class') throw forbidden();
    studentIn(classroom.id, reader.studentId);
  }
  if (reader.role === 'student' && reader.studentId === undefined) throw forbidden();
  return kb;
}
// 身份依据来自老师登记的名单；匹配词仅供已授权教师定位输入错误。
export const normalizeIdentity = (s: string) =>
  s
    .replace(/[\p{White_Space}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu, '')
    .normalize('NFKC')
    .replace(/[\p{White_Space}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu, '')
    .toLocaleLowerCase();
const normalize = normalizeIdentity;
export function identityHits(teacherId: number, text: string): Student[] {
  const normalized = normalize(text);
  const rows = db.all<any>('SELECT s.* FROM kb_students s JOIN knowledge_bases k ON k.id=s.kb_id WHERE k.teacher_id=?', teacherId);
  return rows
    .map(asStudent)
    .filter((s) => [s.name, s.student_no, ...s.aliases].some((v) => v && normalize(v) && normalized.includes(normalize(v))));
}
export function checkIdentity(kbId: number, text: string, studentId?: number | null) {
  const kb = loadKb(kbId);
  const normalized=normalize(text);
  if (studentId != null) {
    if (kb.kind !== 'class') throw bad('学生个人记录只能放在对应班级');
    studentIn(kbId, studentId);
  }
  const own = studentId != null ? studentIn(kbId, studentId) : null;
  const allowed = new Set(own ? [own.name, own.student_no, ...own.aliases].map(normalize) : []);
  const hits = identityHits(kb.teacher_id, text);
  const blocked = [
    ...new Set(
      hits
        .flatMap((s) => [s.name, s.student_no, ...s.aliases])
        .filter((term) => normalize(term) && normalized.includes(normalize(term)) && !allowed.has(normalize(term))),
    ),
  ];
  if (blocked.length)
    throw bad(
      kb.kind === 'teacher' ? '这段内容包含已登记的学生身份，请交给对应班级整理' : '个人情况不能放进全班共有内容，也不能写进其他学生的记录',
      'student_identity',
      { terms: blocked },
    );
  const sourceTerms = db
    .all<{
      term: string;
    }>('SELECT term FROM kb_identity_terms WHERE teacher_id=?', kb.teacher_id)
    .filter((r) => normalize(r.term) && normalized.includes(normalize(r.term)) && !allowed.has(normalize(r.term)))
    .map((r) => r.term);
  if (sourceTerms.length)
    throw bad('内容含原始资料中明确标出的学生姓名，请放在归属已确认的本人记录中', 'student_identity', { terms: sourceTerms });
}

/** 只从明确的学生身份字段提取拦截词，不创建班级或学生。未知姓名仍需核实。 */
export function registerSourceIdentities(kbId: number, text: string, source: string) {
  const teacherId = loadKb(kbId).teacher_id,
    terms = new Set<string>();
  for (const line of text.split('\n')) {
    if (/(?:关注的学生|学生名单|学生姓名)/.test(line)) {
      const value = line.replace(/^.*?(?:关注的学生|学生名单|学生姓名)[*：:\s]*/, '');
      for (const match of value.matchAll(/(?:^|[、，,；;])\s*([\p{Script=Han}]{2,5})\s*(?=[（(、，,；;]|$)/gu)) terms.add(match[1]);
    }
  }
  for (const term of terms)
    db.run('INSERT OR IGNORE INTO kb_identity_terms(teacher_id,term,source) VALUES(?,?,?)', teacherId, term, source);
}
