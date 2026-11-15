/**
 * 后台的事做完了要告诉助教：先记在它的对话底下，下回老师说话时一起带给它（只写库，不依赖别的模块，整理助手那边也能调）。
 */
import { db, j, now } from '../db/index.js';

export const TA_THREAD = 'ta';

export function ensureThread(ownerId: number, thread = TA_THREAD) {
  db.run('INSERT OR IGNORE INTO agent_threads (owner_id, thread, updated_at) VALUES (?,?,?)', ownerId, thread, now());
}

export function addNote(ownerId: number, text: string, thread = TA_THREAD) {
  ensureThread(ownerId, thread);
  db.tx(() => {
    const row = db.get<{ notes: string }>('SELECT notes FROM agent_threads WHERE owner_id=? AND thread=?', ownerId, thread);
    const notes = j<string[]>(row?.notes, []);
    notes.push(text);
    db.run('UPDATE agent_threads SET notes=?, updated_at=? WHERE owner_id=? AND thread=?', JSON.stringify(notes.slice(-20)), now(), ownerId, thread);
  });
}

/** 取出还没告诉助教的，取了就清掉 */
export function takeNotes(ownerId: number, thread = TA_THREAD): string[] {
  ensureThread(ownerId, thread);
  return db.tx(() => {
    const row = db.get<{ notes: string }>('SELECT notes FROM agent_threads WHERE owner_id=? AND thread=?', ownerId, thread);
    const notes = j<string[]>(row?.notes, []);
    if (notes.length) db.run("UPDATE agent_threads SET notes='[]', updated_at=? WHERE owner_id=? AND thread=?", now(), ownerId, thread);
    return notes;
  });
}
