import { authorizeReader, checkIdentity, type Reader } from './access.js';
import { db } from '../db/index.js';
import { bad, forbidden, notFound } from '../lib/http.js';
import { manifest, readEntry, type Entry } from './repo.js';
import { drainInbox } from './keeper.js';

/** 唯一供其他助手使用的读取入口。不给仓库、历史、原件或文件路径读权限。 */
export function visibleEntries(kbId: number, reader: Reader): Entry[] {
  const kb = authorizeReader(kbId, reader),
    privileged = reader.role === 'teacher' || reader.role === 'keeper';
  return manifest(kbId).filter((e) => {
    if (!privileged && e.sourceId) return false;
    if (e.studentId !== undefined && !privileged && e.studentId !== reader.studentId) return false;
    if (!privileged) {
      try {
        checkIdentity(kbId, e.path + '\n' + readEntry(kbId, e).toString('utf8'), e.studentId);
      } catch {
        return false;
      }
    }
    return true;
  });
}
export function readKnowledge(kbId: number, reader: Reader, fileId?: string, query?: string) {
  const entries = visibleEntries(kbId, reader);
  if (fileId && !entries.some((e) => e.id === fileId)) throw notFound('内容不存在或不在当前可见范围');
  return entries
    .filter((e) => !fileId || e.id === fileId)
    .map((e) => ({
      id: e.id,
      title: e.path,
      text: readEntry(kbId, e).toString('utf8'),
    }))
    .filter((e) => !query || e.title.includes(query) || e.text.includes(query));
}
export function submitObservation(
  reader: Reader,
  input: {
    kbId: number;
    studentId?: number;
    sourceId: string;
    sender: string;
    content: string;
  },
) {
  if (!input.content.trim() || input.content.length > 20000 || !input.sourceId || input.sourceId.length > 200 || !input.sender || input.sender.length > 80)
    throw bad('观察记录格式不正确');
  if (reader.role !== 'assistant') throw forbidden();
  const kb = authorizeReader(input.kbId, reader);
  if (kb.kind !== 'class' || kb.status !== 'active') throw bad('请交给仍在使用的对应班级');
  if (input.studentId !== undefined && input.studentId !== reader.studentId) throw forbidden();
  const subject = reader.studentId ?? null;
  const old = db.get<any>('SELECT id,student_id FROM kb_inbox WHERE kb_id=? AND sender=? AND source_id=?', kb.id, input.sender, input.sourceId);
  if (old) {
    if (old.student_id !== subject) throw bad('同一来源编号不能用于不同学生');
    return old.id;
  }
  const id = db.insert('kb_inbox', {
    kb_id: kb.id,
    student_id: subject,
    sender: input.sender,
    source_id: input.sourceId,
    content: input.content,
    status: 'pending',
    created_at: Date.now(),
  });
  queueMicrotask(() => drainInbox(kb.id));
  return id;
}
