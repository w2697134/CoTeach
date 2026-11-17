/**
 * 一位老师可以有好几个知识库：名字和放什么都由老师（或整理助手）定，不分种类。
 * 这里管新建、改名、删除，以及把文件从一个库挪到另一个库。
 */
import { randomUUID } from 'node:crypto';
import { db, now } from '../db/index.js';
import { bad, conflict, forbidden, notFound } from '../lib/http.js';
import { writableKb, type KnowledgeBase } from './access.js';
import { createChange, revertChange, teacherAuthor, type ChangeRow } from './changes.js';
import { checkOps, cleanPath, createKnowledgeBase, hashBytes, isTextEntry, manifest, readEntry, type Author, type Entry, type FileOp } from './repo.js';
import { documentName } from './teacher-text.js';

/** 老师还在用的知识库，按建的先后 */
export function listKbs(teacherId: number): KnowledgeBase[] {
  return db.all<KnowledgeBase>('SELECT * FROM knowledge_bases WHERE teacher_id=? AND deleted_at IS NULL ORDER BY id', teacherId);
}

function cleanName(teacherId: number, value: unknown, except?: number): string {
  const name = String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) throw bad('知识库要起个名字');
  if (name.length > 40) throw bad('名字最多 40 个字');
  const key = name.toLocaleLowerCase();
  if (listKbs(teacherId).some((k) => k.id !== except && k.name.trim().toLocaleLowerCase() === key)) throw conflict(`已经有叫「${name}」的知识库了`);
  return name;
}

/** 按名字找老师自己的知识库（整理助手用名字指代，不用编号） */
export function findKb(teacherId: number, name: unknown): KnowledgeBase {
  const key = String(name ?? '').trim().toLocaleLowerCase();
  const all = listKbs(teacherId);
  const kb = all.find((k) => k.name.trim().toLocaleLowerCase() === key);
  if (!kb) throw notFound(`没有叫「${String(name ?? '').trim()}」的知识库，现有：${all.map((k) => `「${k.name}」`).join('、')}`);
  return kb;
}

export async function createKb(teacherId: number, name: unknown): Promise<number> {
  return createKnowledgeBase({ teacherId, name: cleanName(teacherId, name) });
}

export function renameKb(kbId: number, name: unknown) {
  const kb = writableKb(kbId);
  db.update('knowledge_bases', kb.id, { name: cleanName(kb.teacher_id, name, kb.id) });
}

/**
 * 删除只做记号：仓库、原件、改动记录都留着。最后一个也能删；整理助手只能删已经清空的。
 * busy：整理助手正在这个库里干活
 */
export function deleteKb(kb: KnowledgeBase, opts: { onlyEmpty: boolean; busy: boolean }) {
  if (kb.deleted_at) throw notFound('这个知识库已经删掉了');
  if (opts.busy) throw conflict('整理助手正在这个知识库里忙，等它做完再删');
  if (db.value<number>("SELECT count(*) FROM kb_intakes WHERE kb_id=? AND status IN ('uploading','reading','digesting')", kb.id))
    throw conflict('交给这个知识库的资料还在处理，处理完再删');
  if (opts.onlyEmpty && manifest(kb.id).length) throw bad(`「${kb.name}」里还有东西，挪走后才能删`);
  db.tx(() => {
    db.update('knowledge_bases', kb.id, { deleted_at: now() });
    db.run("UPDATE kb_inbox SET status='dismissed',error='知识库已删除' WHERE kb_id=? AND status IN ('pending','error')", kb.id);
  });
}

export interface Actor {
  author: 'teacher' | 'keeper';
  authorName: string;
  as: Author;
  /** 老师自己挪的记老师；整理助手挪的为空 */
  by: number | null;
  runId?: number | null;
}

/**
 * 把文件或整个文件夹从一个知识库挪到另一个：路径、内容、保护状态都不变。
 * 先在那边放好，再从这边拿走，两边各记一笔，都能撤回；这边拿不走就把那边的也撤掉，不会一份变两份。
 */
export async function transferFiles(fromId: number, toId: number, paths: string[], actor: Actor) {
  const from = writableKb(fromId),
    to = writableKb(toId);
  if (from.id === to.id) throw bad(`已经在「${to.name}」里了`);
  if (from.teacher_id !== to.teacher_id) throw forbidden();
  const entries = manifest(from.id),
    picked = new Map<string, Entry>();
  for (const raw of paths) {
    const p = cleanPath(String(raw ?? ''));
    if (!p) throw bad('请指明要挪的文件');
    const hits = entries.filter((e) => e.path === p || e.path.startsWith(p + '/'));
    if (!hits.length) throw notFound(`「${documentName(p)}」不在「${from.name}」里`);
    for (const e of hits) picked.set(e.id, e);
  }
  const moving = [...picked.values()];
  if (moving.length > 500) throw bad('一次挪的文件太多，分几次挪');
  if (moving.some((e) => e.studentId !== undefined)) throw bad('学生的个人记录不能挪到别的知识库');
  const there = new Set(manifest(to.id).map((e) => e.path.toLocaleLowerCase()));
  const clash = moving.filter((e) => there.has(e.path.toLocaleLowerCase()));
  if (clash.length) throw conflict(`「${to.name}」里已经有同名的：${clash.slice(0, 5).map((e) => `「${documentName(e.path)}」`).join('、')}`);
  const bytes = new Map(moving.map((e) => [e.id, readEntry(from.id, e)]));
  const removeOps: FileOp[] = moving.map((e) => ({ path: e.path, content: null, base: hashBytes(bytes.get(e.id)!), baseEntryId: e.id }));
  if (checkOps(from.id, removeOps).length) throw conflict('内容刚有改动，重新打开再挪');
  // 原件在那边另登记一份，指向同一份存储；这边的历史照样能打开
  const copied: string[] = [];
  const addOps: FileOp[] = moving.map((e) => {
    const b = bytes.get(e.id)!;
    if (e.sourceId) {
      const s = db.get<Record<string, unknown>>('SELECT * FROM kb_sources WHERE id=?', e.sourceId);
      if (!s) throw notFound('原始资料不存在');
      const sid = randomUUID();
      db.insert('kb_sources', { ...s, id: sid, kb_id: to.id, created_at: now() });
      copied.push(sid);
      return { path: e.path, content: e.sourcePart === 'original' ? '' : b.toString('utf8'), base: null, sourceId: sid, sourcePart: e.sourcePart || 'text' };
    }
    if (!isTextEntry(e)) throw bad(`「${documentName(e.path)}」不能挪`);
    return { path: e.path, content: b.toString('utf8'), base: null };
  });
  const one = moving.length === 1 ? `「${documentName(moving[0].path)}」` : `${moving.length} 份`;
  let added: ChangeRow;
  try {
    added = await createChange({
      kbId: to.id,
      title: `从「${from.name}」挪来${one}`,
      author: actor.author,
      authorName: actor.authorName,
      kind: 'tidy',
      ops: addOps,
      apply: { by: actor.by, as: actor.as },
      restore: true,
    });
  } catch (err) {
    for (const sid of copied) db.run('DELETE FROM kb_sources WHERE id=?', sid);
    throw err;
  }
  try {
    await createChange({
      kbId: from.id,
      title: `把${one}挪到「${to.name}」`,
      author: actor.author,
      authorName: actor.authorName,
      kind: 'tidy',
      ops: removeOps,
      runId: actor.runId ?? null,
      apply: { by: actor.by, as: actor.as },
    });
  } catch (err) {
    const owner = db.get<{ id: number; name: string }>('SELECT id,name FROM users WHERE id=?', to.teacher_id)!;
    await revertChange(to.id, added.id, owner).catch((e) => console.error('[kb] transfer rollback', to.id, added.id, (e as Error).message));
    throw err;
  }
  return { moved: moving.map((e) => e.path), to: { id: to.id, name: to.name } };
}

export const teacherActor = (u: { id: number; name: string }): Actor => ({ author: 'teacher', authorName: u.name, as: teacherAuthor(u), by: u.id });
