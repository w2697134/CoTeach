/**
 * 哪几份作业很像（2026-11-16）：程序比，不是模型判。只给老师看，只说「像」和相同的比例，不说谁抄谁（老师痛点调研：不要让 AI 判作弊）。
 * 比法：去掉空白和标点后切成 5 个字一段；题目里本来就有的、班里很多人都有的段不算（照着题目写、大家都会写的标准写法不该算像），
 * 剩下的看两份重合多少。
 */
import { db } from '../db/index.js';
import { assignmentRow, userName, type SubmissionRow } from './common.js';
import { latestGrades, workText } from './grader.js';
import { assignmentFilesText } from './rubric.js';

const N = 5;
const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
function shingles(s: string) {
  const t = norm(s);
  const out = new Set<string>();
  for (let i = 0; i + N <= t.length; i++) out.add(t.slice(i, i + N));
  return out;
}

/** 每个学生交的这一版读成的文字：批改时读过的直接用，没批过的现读 */
export async function workTexts(assignmentId: number): Promise<Map<number, string>> {
  const a = assignmentRow(assignmentId);
  const out = new Map<number, string>();
  if (!a) return out;
  const graded = latestGrades(assignmentId);
  const subs = db.all<SubmissionRow>(
    'SELECT s.* FROM submissions s JOIN class_students m ON m.class_id=? AND m.user_id=s.user_id WHERE s.assignment_id=?',
    a.class_id,
    a.id,
  );
  for (const s of subs) {
    const g = graded.get(s.user_id);
    out.set(s.user_id, g?.text && g.submitted_at === s.submitted_at ? g.text : await workText(s));
  }
  return out;
}

export interface SimilarPair {
  a: number;
  b: number;
  names: [string, string];
  /** 0–100 */
  ratio: number;
}

/** 很像的两两一对，像的多的在前 */
export async function similarPairs(assignmentId: number, threshold = 0.7): Promise<SimilarPair[]> {
  const a = assignmentRow(assignmentId);
  if (!a) return [];
  const texts = await workTexts(assignmentId);
  const question = shingles(`${a.title}\n${a.body}\n${await assignmentFilesText(a)}`);
  const sets = new Map<number, Set<string>>();
  for (const [uid, t] of texts) {
    const s = shingles(t);
    for (const x of question) s.delete(x);
    sets.set(uid, s);
  }
  // 班里三成以上的人都有的段不算
  const df = new Map<string, number>();
  for (const s of sets.values()) for (const x of s) df.set(x, (df.get(x) || 0) + 1);
  const common = Math.max(3, Math.ceil(sets.size * 0.3));
  for (const s of sets.values()) for (const x of [...s]) if ((df.get(x) || 0) >= common) s.delete(x);
  const ids = [...sets.keys()].filter((id) => sets.get(id)!.size >= 30);
  const pairs: SimilarPair[] = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const x = sets.get(ids[i])!,
        y = sets.get(ids[j])!;
      const [small, big] = x.size < y.size ? [x, y] : [y, x];
      let inter = 0;
      for (const t of small) if (big.has(t)) inter++;
      const ratio = inter / (x.size + y.size - inter);
      if (ratio >= threshold) pairs.push({ a: ids[i], b: ids[j], names: [userName(ids[i]), userName(ids[j])], ratio: Math.round(ratio * 100) });
    }
  return pairs.sort((p, q) => q.ratio - p.ratio);
}
