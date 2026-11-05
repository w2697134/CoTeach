import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { requireRole, type AppEnv, type User } from '../auth.js';
import { db, j, now } from '../db/index.js';
import { bus } from '../lib/bus.js';
import { bad, body, forbidden, intParam, notFound } from '../lib/http.js';
import { applyChange, changeDiff, createChange, loadChange, publicChange, rejectChange, revertChange, teacherAuthor, type ChangeRow } from './changes.js';
import { extractText } from './convert.js';
import { activeRun, cancelRun, publicRun, startRun } from './keeper.js';
import {
  cleanPath,
  commitFiles,
  commitRemove,
  createCourse,
  FIXED_FILES,
  hashText,
  history,
  isTextPath,
  listFiles,
  MATERIALS_DIR,
  readBinary,
  readText,
} from './repo.js';

export const kbRoutes = new Hono<AppEnv>();

interface CourseRow {
  id: number;
  name: string;
  description: string | null;
  teacher_id: number;
  created_at: number;
}

function teacher(c: any): User {
  return requireRole(c, 'teacher', 'admin');
}

function course(u: User, id: number): CourseRow {
  const row = db.get<CourseRow>('SELECT * FROM courses WHERE id = ?', id);
  if (!row) throw notFound('课程不存在');
  if (u.role !== 'admin' && row.teacher_id !== u.id) throw forbidden();
  return row;
}

const pendingCount = (courseId: number) => db.value<number>(`SELECT COUNT(*) FROM kb_changes WHERE course_id = ? AND status IN ('pending','conflict')`, courseId) || 0;

/* ---------------------------------------------------------------- 课程 */
kbRoutes.get('/', c => {
  const u = teacher(c);
  const rows = db.all<CourseRow>(u.role === 'admin' ? 'SELECT * FROM courses ORDER BY id' : 'SELECT * FROM courses WHERE teacher_id = ? ORDER BY id', ...(u.role === 'admin' ? [] : [u.id]));
  return c.json({ courses: rows.map(r => ({ id: r.id, name: r.name, description: r.description, pending: pendingCount(r.id), createdAt: r.created_at })) });
});

kbRoutes.post('/', async c => {
  const u = teacher(c);
  const d = await body(c, z.object({ name: z.string().trim().min(1).max(60), description: z.string().max(500).optional() }));
  const id = await createCourse({ name: d.name, description: d.description, teacherId: u.id, teacherName: u.name });
  return c.json({ id });
});

kbRoutes.get('/:id', c => {
  const u = teacher(c);
  const r = course(u, intParam(c));
  return c.json({ course: { id: r.id, name: r.name, description: r.description }, pending: pendingCount(r.id), activeRunId: activeRun(r.id) });
});

/* ---------------------------------------------------------------- 文件 */
kbRoutes.get('/:id/kb/tree', async c => {
  const r = course(teacher(c), intParam(c));
  return c.json({ files: await listFiles(r.id) });
});

kbRoutes.get('/:id/kb/file', async c => {
  const r = course(teacher(c), intParam(c));
  const path = cleanPath(c.req.query('path') || '');
  const text = isTextPath(path) ? readText(r.id, path) : null;
  const bin = text === null ? readBinary(r.id, path) : null;
  if (text === null && !bin) throw notFound('文件不存在');
  const [last] = await history(r.id, { path, limit: 1 });
  return c.json({ path, text, hash: text === null ? null : hashText(text), size: text === null ? bin!.length : Buffer.byteLength(text), last: last || null });
});

/** 老师下载资料原件 */
kbRoutes.get('/:id/kb/raw', c => {
  const r = course(teacher(c), intParam(c));
  const path = cleanPath(c.req.query('path') || '');
  const buf = readBinary(r.id, path);
  if (!buf) throw notFound('文件不存在');
  c.header('Content-Type', 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.split('/').pop()!)}`);
  return c.body(new Uint8Array(buf));
});

/** 老师直接改：马上生效，也是一次可以撤回的改动 */
kbRoutes.put('/:id/kb/file', async c => {
  const u = teacher(c);
  const r = course(u, intParam(c));
  const d = await body(c, z.object({ path: z.string().min(1), content: z.string().max(2_000_000), base: z.string().nullable() }));
  const path = cleanPath(d.path);
  if (!isTextPath(path)) throw bad('只能编辑文字文件');
  const content = d.content.endsWith('\n') ? d.content : d.content + '\n';
  const isNew = d.base === null;
  const change = await createChange({
    courseId: r.id,
    title: `${isNew ? '新建' : '修改'}了 ${path}`,
    author: 'teacher',
    authorName: u.name,
    kind: 'teacher',
    ops: [{ path, content, base: d.base }],
    apply: { by: u.id, as: teacherAuthor(u) },
  });
  return c.json({ change: publicChange(change) });
});

kbRoutes.delete('/:id/kb/file', async c => {
  const u = teacher(c);
  const r = course(u, intParam(c));
  const path = cleanPath(c.req.query('path') || '');
  if (FIXED_FILES.includes(path)) throw bad(`${path} 是固定文件，不能删`);
  if (!isTextPath(path)) {
    // 原件是二进制，不走文字对比，直接提交删除
    if (!readBinary(r.id, path)) throw notFound('文件不存在');
    const sha = await commitRemove(r.id, [path], `删除了 ${path}`, teacherAuthor(u));
    const id = db.insert('kb_changes', {
      course_id: r.id,
      title: `删除了 ${path}`,
      author: 'teacher',
      author_name: u.name,
      kind: 'teacher',
      status: 'applied',
      ops: [{ path, content: null, base: 'binary' }],
      commit_sha: sha,
      created_at: now(),
      decided_at: now(),
      decided_by: u.id,
    });
    bus.publish(`kb:${r.id}`, 'change', { id, status: 'applied' });
    bus.publish(`kb:${r.id}`, 'tree', {});
    return c.json({ ok: true });
  }
  const text = readText(r.id, path);
  if (text === null) throw notFound('文件不存在');
  await createChange({
    courseId: r.id,
    title: `删除了 ${path}`,
    author: 'teacher',
    authorName: u.name,
    kind: 'teacher',
    ops: [{ path, content: null, base: hashText(text) }],
    apply: { by: u.id, as: teacherAuthor(u) },
  });
  return c.json({ ok: true });
});

/* ---------------------------------------------------------------- 交资料 */
const safeName = (name: string) =>
  name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120) || '资料';

kbRoutes.post('/:id/kb/upload', async c => {
  const u = teacher(c);
  const r = course(u, intParam(c));
  const form = await c.req.parseBody({ all: true });
  const files = ([] as any[]).concat(form.file || []).filter(f => f && typeof f === 'object' && 'arrayBuffer' in f);
  if (!files.length) throw bad('请选择文件');
  const writes: { path: string; data: Buffer | string }[] = [];
  const done: { name: string; path: string; replaced: boolean }[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const f of files) {
    const name = safeName(f.name);
    if (f.size > 30 * 1024 * 1024) {
      failed.push({ name, error: '超过 30MB' });
      continue;
    }
    const buf = Buffer.from(await f.arrayBuffer());
    try {
      const text = await extractText(buf, name);
      if (!text.trim()) throw new Error('没有提取到文字（可能是扫描版 PDF）');
      const ext = (name.split('.').pop() || '').toLowerCase();
      const stem = name.replace(/\.[^.]+$/, '');
      const textPath = ['md', 'markdown', 'txt'].includes(ext) ? `${MATERIALS_DIR}/${name}` : `${MATERIALS_DIR}/${stem}.md`;
      if (!['md', 'markdown', 'txt'].includes(ext)) writes.push({ path: `${MATERIALS_DIR}/原件/${name}`, data: buf });
      writes.push({ path: textPath, data: text });
      done.push({ name, path: textPath, replaced: readText(r.id, textPath) !== null });
    } catch (err) {
      failed.push({ name, error: (err as Error).message });
    }
  }
  if (!done.length) return c.json({ done, failed, changeId: null, runId: null });
  const title = `交了资料：${done.map(d => d.name).join('、')}`.slice(0, 120);
  const sha = await commitFiles(r.id, writes, title, teacherAuthor(u));
  const changeId = db.insert('kb_changes', {
    course_id: r.id,
    title,
    author: 'teacher',
    author_name: u.name,
    kind: 'upload',
    status: 'applied',
    ops: writes.map(w => ({ path: w.path, content: '', base: null })),
    commit_sha: sha,
    created_at: now(),
    decided_at: now(),
    decided_by: u.id,
  });
  bus.publish(`kb:${r.id}`, 'change', { id: changeId, status: 'applied' });
  bus.publish(`kb:${r.id}`, 'tree', {});
  let runId: number | null = null;
  if (!activeRun(r.id)) {
    const list = done.map(d => `- ${d.path}${d.replaced ? '（换成了新版本）' : ''}`).join('\n');
    runId = startRun(r.id, 'materials', `我交了资料：\n${list}\n请把它们整理进知识库。`, u);
  }
  return c.json({ done, failed, changeId, runId });
});

/* ---------------------------------------------------------------- 改动 */
kbRoutes.get('/:id/kb/changes', c => {
  const r = course(teacher(c), intParam(c));
  const status = c.req.query('status');
  const rows = db.all<any>(
    status === 'pending'
      ? `SELECT * FROM kb_changes WHERE course_id = ? AND status IN ('pending','conflict') ORDER BY id DESC`
      : `SELECT * FROM kb_changes WHERE course_id = ? ORDER BY id DESC LIMIT 100`,
    r.id,
  );
  return c.json({ changes: rows.map(row => publicChange({ ...row, ops: j(row.ops, []) } as ChangeRow)) });
});

kbRoutes.get('/:id/kb/changes/:cid', async c => {
  const r = course(teacher(c), intParam(c));
  const ch = loadChange(intParam(c, 'cid'), r.id);
  const { files, stale } = await changeDiff(ch);
  return c.json({ change: publicChange(ch), files, stale });
});

kbRoutes.post('/:id/kb/changes/:cid/apply', async c => {
  const u = teacher(c);
  const r = course(u, intParam(c));
  const ch = await applyChange(r.id, intParam(c, 'cid'), u.id, teacherAuthor(u));
  return c.json({ change: publicChange(ch) });
});

kbRoutes.post('/:id/kb/changes/:cid/reject', c => {
  const u = teacher(c);
  const r = course(u, intParam(c));
  return c.json({ change: publicChange(rejectChange(r.id, intParam(c, 'cid'), u.id)) });
});

kbRoutes.post('/:id/kb/changes/:cid/revert', async c => {
  const u = teacher(c);
  const r = course(u, intParam(c));
  const ch = await revertChange(r.id, intParam(c, 'cid'), u);
  return c.json({ change: publicChange(ch) });
});

kbRoutes.get('/:id/kb/history', async c => {
  const r = course(teacher(c), intParam(c));
  const path = c.req.query('path');
  return c.json({ commits: await history(r.id, { path: path || undefined, limit: 100 }) });
});

/* ---------------------------------------------------------------- 整理助手 */
function runWithEvents(row: any) {
  const events = db.all<any>('SELECT id, type, data, created_at FROM kb_events WHERE run_id = ? ORDER BY id', row.id).map(e => ({
    id: e.id,
    type: e.type,
    data: j(e.data, {}),
    createdAt: e.created_at,
  }));
  return { ...publicRun(row), events };
}

kbRoutes.get('/:id/kb/runs', c => {
  const r = course(teacher(c), intParam(c));
  const rows = db.all<any>('SELECT * FROM kb_runs WHERE course_id = ? ORDER BY id DESC LIMIT 30', r.id).reverse();
  return c.json({ runs: rows.map(runWithEvents), activeRunId: activeRun(r.id) });
});

kbRoutes.post('/:id/kb/runs', async c => {
  const u = teacher(c);
  const r = course(u, intParam(c));
  const d = await body(c, z.object({ message: z.string().trim().min(1).max(4000) }));
  const runId = startRun(r.id, 'chat', d.message, u);
  return c.json({ runId });
});

kbRoutes.post('/:id/kb/runs/:rid/cancel', c => {
  const r = course(teacher(c), intParam(c));
  cancelRun(r.id, intParam(c, 'rid'));
  return c.json({ ok: true });
});

kbRoutes.get('/:id/kb/stream', c => {
  const r = course(teacher(c), intParam(c));
  return streamSSE(c, async stream => {
    let closed = false;
    const unsub = bus.subscribe(`kb:${r.id}`, msg => {
      if (!closed) stream.writeSSE({ event: msg.event, data: JSON.stringify(msg.data) }).catch(() => {});
    });
    stream.onAbort(() => {
      closed = true;
      unsub();
    });
    while (!closed) {
      await stream.sleep(25_000);
      if (!closed) await stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => {});
    }
  });
});
