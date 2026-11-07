import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { me, requireRole, sessionStillActive, type AppEnv } from '../auth.js';
import { db, j, now } from '../db/index.js';
import { bus } from '../lib/bus.js';
import { bad, body, forbidden, intParam, notFound, conflict, HttpError } from '../lib/http.js';
import { loadKb, ownKb, students, studentIn, writableKb, normalizeIdentity } from './access.js';
import {
  applyChange,
  changeDiff,
  createChange,
  loadChange,
  publicChange,
  rejectChange,
  revertChange,
  teacherAuthor,
  type ChangeRow,
} from './changes.js';
import { cancelIntake, createIntake, finishIntake, intakeFromBuffers, moveToClass, receiveChunk, resumeIntake, CHUNK_SIZE } from './intake/service.js';
import { blobPath, publicIntake } from './intake/store.js';
import { existsSync, readFileSync } from 'node:fs';
import { activeRun, cancelRun, cancelForArchive, publicRun, startRun, enqueueTask, drainInbox, taskSubject } from './keeper.js';
import {
  cleanPath,
  createKnowledgeBase,
  ensureTeacherKb,
  hashText,
  hashBytes,
  history,
  isTextPath,
  isTextEntry,
  listFiles,
  manifest,
  readBinary,
  readEntry,
  readText,
  saveSource,
  withRepo,
  type FileOp,
} from './repo.js';
import { readKnowledge } from './reader.js';
import { documentName } from './teacher-text.js';

export const kbRoutes = new Hono<AppEnv>();
/** 超过这么长的话按资料收（以前跟整理助手说话的上限也是这个长度） */
export const LONG_PASTE = 4000;
const teacher = (c: any) => requireRole(c, 'teacher', 'admin');
const owned = (c: any) => ownKb(teacher(c), intParam(c));
const pendingCount = (id: number) =>
  db.value<number>("SELECT count(*) FROM kb_changes WHERE kb_id=? AND status IN ('pending','conflict')", id) || 0;
const publicStudents = (id: number) =>
  students(id).map((s) => ({
    id: s.id,
    name: s.name,
    studentNo: s.student_no,
    aliases: s.aliases,
    userId: s.user_id,
  }));
const publicKb = (r: any) => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  className: r.class_name,
  term: r.term,
  status: r.status,
  pending: pendingCount(r.id),
  createdAt: r.created_at,
  archivedAt: r.archived_at,
});
kbRoutes.get('/', async (c) => {
  const u = teacher(c);
  await ensureTeacherKb(u.id, u.name);
  return c.json({
    knowledgeBases: db.all<any>('SELECT * FROM knowledge_bases WHERE teacher_id=? ORDER BY kind DESC,status,id', u.id).map(publicKb),
  });
});
kbRoutes.post('/classes', async (c) => {
  const u = teacher(c),
    d = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(80),
        term: z.string().trim().min(1).max(60),
      }),
    );
  if (db.get('SELECT id FROM knowledge_bases WHERE teacher_id=? AND class_name=? AND term=?', u.id, d.name, d.term))
    throw conflict('这个班级和学期已经存在');
  const id = await createKnowledgeBase({
    teacherId: u.id,
    name: d.name,
    className: d.name,
    term: d.term,
  });
  return c.json({ id });
});
kbRoutes.get('/:id', (c) => {
  const kb = owned(c);
  return c.json({
    knowledgeBase: publicKb(kb),
    course: { id: kb.id, name: kb.name, description: kb.term },
    pending: pendingCount(kb.id),
    activeRunId: activeRun(kb.id),
  });
});

kbRoutes.get('/:id/students', (c) => {
  const kb = owned(c);
  return c.json({ students: publicStudents(kb.id) });
});
kbRoutes.post('/:id/students', async (c) => {
  const kb = owned(c);
  writableKb(kb.id);
  if (kb.kind !== 'class') throw bad('请先进入班级');
  const d = await body(
    c,
    z.object({
      students: z
        .array(
          z.object({
            name: z.string().trim().min(1).max(60),
            studentNo: z.string().trim().min(1).max(60),
            aliases: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
            userId: z.number().int().positive().optional(),
          }),
        )
        .min(1)
        .max(500),
    }),
  );
  const skipped: { studentNo: string; name: string }[] = [],
    conflicts: { studentNo: string; name: string; existingName: string }[] = [];
  let added = 0;
  db.tx(() => {
    for (const s of d.students) {
      if(!normalizeIdentity(s.name)||!normalizeIdentity(s.studentNo))throw bad('姓名和学号不能只包含空白字符');
      if (s.userId && !db.get("SELECT id FROM users WHERE id=? AND role='student'", s.userId)) throw bad('关联的学生账号不存在');
      const existing = db.get<any>('SELECT id,name FROM kb_students WHERE kb_id=? AND student_no=?', kb.id, s.studentNo);
      if (existing) {
        if (existing.name === s.name) skipped.push({ studentNo: s.studentNo, name: s.name });
        else conflicts.push({ studentNo: s.studentNo, name: s.name, existingName: existing.name });
        continue;
      }
      db.insert('kb_students', {
        kb_id: kb.id,
        name: s.name,
        student_no: s.studentNo,
        aliases: (s.aliases || []).filter(alias=>normalizeIdentity(alias)),
        user_id: s.userId || null,
        created_at: now(),
      });
      added++;
    }
  });
  bus.publish(`kb:${kb.id}`, 'students', {});
  return c.json({ students: publicStudents(kb.id), added, skipped, conflicts });
});
kbRoutes.put('/:id/students/:sid', async (c) => {
  const kb = owned(c);
  writableKb(kb.id);
  studentIn(kb.id, intParam(c, 'sid'));
  const d = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(60),
      aliases: z.array(z.string().trim().min(1).max(60)).max(20),
      userId: z.number().int().positive().nullable().optional(),
    }),
  );
  if (d.userId && !db.get("SELECT id FROM users WHERE id=? AND role='student'", d.userId)) throw bad('关联的学生账号不存在');
  if (!normalizeIdentity(d.name)) throw bad('姓名不能只包含空白字符');
  const old = studentIn(kb.id, intParam(c, 'sid'));
  db.update('kb_students', old.id, {
    name: d.name,
    aliases: [...new Set([...old.aliases, old.name, ...d.aliases])].filter(alias=>normalizeIdentity(alias)),
    ...(d.userId !== undefined ? { user_id: d.userId } : {}),
  });
  return c.json({ students: publicStudents(kb.id) });
});
kbRoutes.post('/:id/archive', async (c) => {
  const kb = owned(c);
  if (kb.kind !== 'class') throw bad('长期知识库不能按学期封存');
  const u = teacher(c),
    tid = await ensureTeacherKb(u.id, u.name),
    archivedAt = kb.archived_at || now();
  await withRepo(kb.id, async () => {
    cancelForArchive(kb.id);
    db.tx(() => {
      db.update('knowledge_bases', kb.id, {
        status: 'archived',
        archived_at: archivedAt,
      });
      db.run(
        "UPDATE kb_changes SET status='rejected',error='学期封存，未生效的改动已关闭',decided_at=? WHERE kb_id=? AND status IN ('pending','conflict')",
        now(),
        kb.id,
      );
      db.run("UPDATE kb_inbox SET status='dismissed',error='学期已封存' WHERE kb_id=? AND status IN ('pending','error')", kb.id);
      db.run(
        "UPDATE kb_intakes SET status='canceled',error='学期已封存',finished_at=?,updated_at=? WHERE kb_id=? AND status IN ('uploading','reading','digesting','paused')",
        now(),
        now(),
        kb.id,
      );
      enqueueTask(
        tid,
        'term-summary',
        `${kb.id}:${archivedAt}`,
        `请根据「${kb.name}」这个已结束学期的档案，提炼有依据、可供以后教学使用的规律。`,
        kb.id,
      );
    });
  });
  bus.publish(`kb:${kb.id}`, 'archived', {});
  return c.json({ knowledgeBase: publicKb(loadKb(kb.id)) });
});
kbRoutes.post('/:id/summary', async (c) => {
  const kb = owned(c),
    u = teacher(c);
  if (kb.kind !== 'class' || kb.status !== 'archived') throw bad('请先封存这个学期');
  const tid = await ensureTeacherKb(u.id, u.name);
  const prior = db.get<any>(
    "SELECT r.id,r.change_id,r.status AS run_status,c.status FROM kb_runs r LEFT JOIN kb_changes c ON c.id=r.change_id WHERE r.source_kb_id=? AND r.status IN ('running','done') ORDER BY r.id DESC LIMIT 1",
    kb.id,
  );
  if (prior && (!prior.change_id || ['pending', 'applied'].includes(prior.status)))
    return c.json({ runId: prior.id, kbId: tid, status: prior.run_status });
  const jobId = enqueueTask(
    tid,
    'term-summary',
    `${kb.id}:${kb.archived_at}`,
    `请根据「${kb.name}」这个已结束学期的档案，提炼有依据、可供以后教学使用的规律。`,
    kb.id,
  );
  const job = db.get<any>('SELECT * FROM kb_inbox WHERE id=?', jobId)!;
  if (job.status === 'error' || (job.status === 'accepted' && prior && ['rejected', 'reverted'].includes(prior.status)))
    db.update('kb_inbox', jobId, {
      status: 'pending',
      error: null,
      run_id: null,
    });
  queueMicrotask(() => drainInbox(tid));
  return c.json({
    jobId,
    runId: db.get<any>('SELECT run_id FROM kb_inbox WHERE id=?', jobId)?.run_id || null,
    kbId: tid,
    status: job.status === 'running' ? 'running' : 'queued',
  });
});

kbRoutes.get('/:id/kb/tree', async (c) => {
  const kb = owned(c);
  return c.json({ files: await listFiles(kb.id) });
});
// 老师在自己的知识库里找东西：名字（不含扩展名）或文字内容里有这几个字就算，附一小段上下文
kbRoutes.get('/:id/kb/search', (c) => {
  const kb = owned(c),
    q = (c.req.query('q') || '').trim().slice(0, 100),
    needle = q.toLowerCase();
  const results: { path: string; protected: boolean; snippet: string }[] = [];
  if (!needle) return c.json({ results });
  for (const e of manifest(kb.id)) {
    if (results.length >= 50) break;
    const nameHit = e.path.replace(/\.[^./]+$/, '').toLowerCase().includes(needle);
    let snippet = '';
    if (isTextEntry(e)) {
      const text = readEntry(kb.id, e).toString('utf8'),
        at = text.toLowerCase().indexOf(needle);
      // 截取时不留下半个表情符号
      if (at >= 0)
        snippet = text
          .slice(Math.max(0, at - 30), at + needle.length + 60)
          .replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, '')
          .replace(/\s+/g, ' ')
          .trim();
    }
    if (nameHit || snippet) results.push({ path: e.path, protected: !!e.sourceId, snippet });
  }
  return c.json({ results });
});
kbRoutes.get('/:id/kb/file', async (c) => {
  const kb = owned(c),
    path = cleanPath(c.req.query('path') || ''),
    e = manifest(kb.id).find((e) => e.path === path);
  if (!e) throw notFound('文件不存在');
  const buf = readBinary(kb.id, path)!;
  const text = isTextEntry(e) ? buf.toString('utf8') : null;
  const [last] = await history(kb.id, { path, limit: 1 });
  const source = e.sourceId ? db.get<any>('SELECT id,name,source_class,term FROM kb_sources WHERE id=?', e.sourceId) : null;
  return c.json({
    id: e.id,
    path,
    text,
    hash: hashBytes(buf),
    size: buf.length,
    last: last || null,
    protected: !!e.sourceId,
    studentId: e.studentId || null,
    student: e.studentId ? { id: e.studentId, name: studentIn(kb.id, e.studentId).name } : null,
    source: source
      ? {
          id: source.id,
          name: source.name,
          sourceClass: source.source_class,
          term: source.term,
        }
      : null,
  });
});
kbRoutes.get('/:id/kb/raw', (c) => {
  const kb = owned(c),
    path = cleanPath(c.req.query('path') || ''),
    buf = readBinary(kb.id, path);
  if (!buf) throw notFound('文件不存在');
  c.header('Content-Type', 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.split('/').pop()!)}`);
  return c.body(new Uint8Array(buf));
});
kbRoutes.get('/:id/sources/:sid/raw', (c) => {
  const kb = owned(c),
    source = db.get<any>('SELECT * FROM kb_sources WHERE id=? AND kb_id=?', c.req.param('sid'), kb.id);
  if (!source) throw notFound();
  // 原件下载独立入口，原件不经过文本转换。
  const bytes = readSourceOriginal(source.id);
  c.header('Content-Type', 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(source.name.split('/').pop())}`);
  return c.body(new Uint8Array(bytes));
});
import { sourceBytes as readSourceBytes } from './repo.js';
const readSourceOriginal = (id: string) => readSourceBytes(id, 'original');
kbRoutes.put('/:id/kb/file', async (c) => {
  const u = teacher(c),
    kb = ownKb(u, intParam(c)),
    d = await body(
      c,
      z.object({
        path: z.string().min(1),
        content: z.string().max(2_000_000),
        base: z.string().nullable(),
        baseEntryId: z.string().nullable().optional(),
        studentId: z.number().int().positive().optional(),
        requestKey: z.string().max(100).optional(),
      }),
    );
  const path = cleanPath(d.path),
    content = d.content.endsWith('\n') ? d.content : d.content + '\n';
  const change = await createChange({
    kbId: kb.id,
    title: `${d.base === null ? '新建' : '修改'}了「${documentName(path)}」`,
    author: 'teacher',
    authorName: u.name,
    kind: 'teacher',
    ops: [
      {
        path,
        content,
        base: d.base,
        baseEntryId: d.baseEntryId,
        studentId: d.studentId,
      },
    ],
    requestKey: d.requestKey,
    apply: { by: u.id, as: teacherAuthor(u) },
  });
  return c.json({ change: publicChange(change) });
});
kbRoutes.delete('/:id/kb/file', async (c) => {
  const u = teacher(c),
    kb = ownKb(u, intParam(c)),
    path = cleanPath(c.req.query('path') || ''),
    buf = readBinary(kb.id, path);
  if (!buf) throw notFound('文件不存在');
  const base = c.req.query('base');
  if (base !== hashBytes(buf)) throw conflict('文件已更新，请重新打开后再删除');
  const change = await createChange({
    kbId: kb.id,
    title: `移除了「${documentName(path)}」`,
    author: 'teacher',
    authorName: u.name,
    kind: 'teacher',
    ops: [{ path, content: null, base, baseEntryId: c.req.query('baseEntryId') }],
    apply: { by: u.id, as: teacherAuthor(u) },
  });
  return c.json({ change: publicChange(change) });
});
kbRoutes.post('/:id/kb/move', async (c) => {
  const u = teacher(c),
    kb = ownKb(u, intParam(c)),
    d = await body(
      c,
      z.object({
        from: z.string(),
        to: z.string(),
        base: z.string(),
        baseEntryId: z.string().optional(),
      }),
    );
  const from = cleanPath(d.from),
    to = cleanPath(d.to),
    change = await createChange({
      kbId: kb.id,
      title: `移动了「${documentName(from)}」`,
      reason: `新位置：${to.split('/').map(documentName).join(' · ')}`,
      author: 'teacher',
      authorName: u.name,
      kind: 'tidy',
      ops: [
        {
          from,
          path: to,
          content: null,
          base: d.base,
          baseEntryId: d.baseEntryId,
        },
      ],
      apply: { by: u.id, as: teacherAuthor(u) },
    });
  return c.json({ change: publicChange(change) });
});
/**
 * 交资料：先登记这次要交的文件（文件夹里的相对路径照带），再分块上传每个文件；
 * 收齐后在后台读、解压、认图片里的字，读好的一起放进知识库，再分批交给整理助手。
 */
const intakeOf = (c: any) => {
  const kb = owned(c),
    row = db.get<any>('SELECT * FROM kb_intakes WHERE id=? AND kb_id=?', intParam(c, 'iid'), kb.id);
  if (!row) throw notFound('这次交的资料不存在');
  return { kb, row };
};
kbRoutes.get('/:id/intakes', (c) => {
  const kb = owned(c);
  return c.json({
    intakes: db
      .all<any>('SELECT * FROM kb_intakes WHERE kb_id=? ORDER BY id DESC LIMIT 50', kb.id)
      .reverse()
      .map((r) => publicIntake(r, false)),
  });
});
kbRoutes.get('/:id/intakes/:iid', (c) => c.json({ intake: publicIntake(intakeOf(c).row, true) }));
kbRoutes.post('/:id/intakes', async (c) => {
  const u = teacher(c),
    kb = ownKb(u, intParam(c));
  const d = await body(
    c,
    z.object({
      message: z.string().max(4000).nullable().optional(),
      text: z.string().max(2_000_000).nullable().optional(),
      files: z.array(z.object({ name: z.string().min(1).max(1000), size: z.number().int().min(0) })).max(1000),
    }),
  );
  return c.json(createIntake(kb.id, u, d));
});
kbRoutes.put('/:id/intakes/:iid/items/:item', async (c) => {
  const u = teacher(c),
    kb = ownKb(u, intParam(c));
  const offset = Number(c.req.query('offset'));
  if (!Number.isSafeInteger(offset) || offset < 0) throw bad('上传的数据位置不对，请重新交');
  const declared = Number(c.req.header('content-length') || 0);
  if (declared > CHUNK_SIZE + 1024) throw bad('上传的数据块太大');
  const chunk = new Uint8Array(await c.req.arrayBuffer());
  return c.json(await receiveChunk(kb.id, intParam(c, 'iid'), intParam(c, 'item'), offset, chunk));
});
kbRoutes.post('/:id/intakes/:iid/resume', (c) => {
  const { kb, row } = intakeOf(c);
  return c.json({ intake: resumeIntake(kb.id, row.id) });
});
kbRoutes.post('/:id/intakes/:iid/cancel', (c) => {
  const { kb, row } = intakeOf(c);
  return c.json({ intake: cancelIntake(kb.id, row.id) });
});
kbRoutes.post('/:id/intakes/:iid/finish', async (c) => {
  const u = teacher(c);
  const { kb, row } = intakeOf(c);
  return c.json({ intake: await finishIntake(kb.id, row.id, u) });
});
// 交到长期库的资料里只有一个班的学生：改交到那个班
kbRoutes.post('/:id/intakes/:iid/items/:item/to-class', async (c) => {
  const u = teacher(c);
  const { kb, row } = intakeOf(c);
  const d = await body(c, z.object({ classId: z.number().int().positive() }));
  return c.json(await moveToClass(kb.id, row.id, intParam(c, 'item'), d.classId, u));
});
kbRoutes.get('/:id/intakes/:iid/items/:item/raw', (c) => {
  const { row } = intakeOf(c);
  const item = db.get<any>('SELECT * FROM kb_intake_items WHERE id=? AND intake_id=?', intParam(c, 'item'), row.id);
  // 读不了的文件交完就清理了，原件不在时照实说
  if (!item?.hash || !existsSync(blobPath(item.hash))) throw notFound('这份文件没有收到或已经清理');
  c.header('Content-Type', 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.name.split('/').pop())}`);
  return c.body(new Uint8Array(readFileSync(blobPath(item.hash))));
});
/** 旧页面一次性上传的方式仍然可用：收下后等读完，再告诉老师哪些读好了。 */
// 这条老路整份读进内存，只留给小批量（和以前一样：最多 30 份、每份 30MB、一次 50MB）；大资料走分块上传
kbRoutes.post(
  '/:id/kb/upload',
  bodyLimit({
    maxSize: 50 * 1024 * 1024,
    onError: () => {
      throw bad('一次交的资料太大，请用「交资料」按钮分块上传');
    },
  }),
  async (c) => {
  const u = teacher(c),
    kb = ownKb(u, intParam(c));
  writableKb(kb.id);
  const form = await c.req.parseBody({ all: true }),
    files = ([] as any[]).concat(form.file || []).filter((f) => f && typeof f === 'object' && 'arrayBuffer' in f);
  if (!files.length || files.length > 30) throw bad('每次请选择 1 至 30 份资料');
  if (files.some((f) => f.size > 30 * 1024 * 1024)) throw bad('有资料超过 30MB，请用「交资料」按钮分块上传');
  const row = await intakeFromBuffers(
    kb.id,
    u,
    await Promise.all(files.map(async (f) => ({ name: String(f.name || '资料'), data: new Uint8Array(await f.arrayBuffer()) }))),
  );
  const items = publicIntake(row, true).items.filter((i) => i.kind !== 'archive' || i.status === 'failed');
  const runId = db.get<any>('SELECT id FROM kb_runs WHERE intake_id=? ORDER BY id DESC LIMIT 1', row.id)?.id || null;
  return c.json({
    intakeId: row.id,
    done: items.filter((i) => i.status === 'done' || i.status === 'same').map((i) => ({ name: i.name, path: i.path, replaced: i.status === 'same' })),
    failed: items.filter((i) => i.status === 'failed').map((i) => ({ name: i.name, error: [i.reason, i.advice].filter(Boolean).join('，') })),
    changeId: row.change_id,
    runId,
    queued: !runId && row.status === 'digesting',
  });
  },
);

kbRoutes.get('/:id/kb/changes', (c) => {
  const kb = owned(c),
    pending = c.req.query('status') === 'pending';
  const rows = db.all<any>(
    `SELECT * FROM kb_changes WHERE kb_id=? ${pending ? "AND status IN ('pending','conflict')" : ''} ORDER BY id DESC LIMIT 500`,
    kb.id,
  );
  return c.json({
    changes: rows.map((r) => publicChange({ ...r, ops: j(r.ops, []) } as ChangeRow)),
  });
});
kbRoutes.get('/:id/kb/changes/:cid', async (c) => {
  const kb = owned(c),
    ch = loadChange(intParam(c, 'cid'), kb.id),
    result = await changeDiff(ch);
  return c.json({ change: publicChange(ch), ...result });
});
kbRoutes.post('/:id/kb/changes/:cid/apply', async (c) => {
  const u = teacher(c),
    kb = ownKb(u, intParam(c));
  return c.json({
    change: publicChange(await applyChange(kb.id, intParam(c, 'cid'), u.id, teacherAuthor(u))),
  });
});
kbRoutes.post('/:id/kb/changes/:cid/reject', (c) => {
  const u = teacher(c),
    kb = ownKb(u, intParam(c));
  return c.json({
    change: publicChange(rejectChange(kb.id, intParam(c, 'cid'), u.id)),
  });
});
kbRoutes.post('/:id/kb/changes/:cid/revert', async (c) => {
  const u = teacher(c),
    kb = ownKb(u, intParam(c));
  return c.json({
    change: publicChange(await revertChange(kb.id, intParam(c, 'cid'), u)),
  });
});
kbRoutes.get('/:id/kb/history', async (c) => {
  const kb = owned(c);
  return c.json({
    commits: await history(kb.id, {
      path: c.req.query('path') || undefined,
      limit: 500,
    }),
  });
});
function runWithEvents(r: any) {
  return {
    ...publicRun(r),
    events: db.all<any>('SELECT * FROM kb_events WHERE run_id=? ORDER BY id', r.id).map((e) => ({
      id: e.id,
      type: e.type,
      data: j(e.data, {}),
      createdAt: e.created_at,
    })),
  };
}
kbRoutes.get('/:id/kb/runs', (c) => {
  const kb = owned(c);
  return c.json({
    runs: db.all<any>('SELECT * FROM kb_runs WHERE kb_id=? ORDER BY id DESC LIMIT 100', kb.id).reverse().map(runWithEvents),
    activeRunId: activeRun(kb.id),
  });
});
kbRoutes.post('/:id/kb/runs', async (c) => {
  const u = teacher(c),
    kb = ownKb(u, intParam(c)),
    d = await body(c, z.object({ message: z.string().trim().min(1).max(2_000_000) }));
  // 很长的一段（教案、讲稿、整章内容）直接贴过来：原样存成一份资料，再交给整理助手消化
  if (d.message.length > LONG_PASTE) return c.json({ intakeId: createIntake(kb.id, u, { text: d.message, files: [] }).intake.id });
  return c.json({ runId: startRun(kb.id, 'chat', d.message, u) });
});
kbRoutes.post('/:id/kb/runs/:rid/cancel', (c) => {
  const kb = owned(c);
  cancelRun(kb.id, intParam(c, 'rid'));
  return c.json({ ok: true });
});
kbRoutes.get('/:id/inbox', (c) => {
  const kb = owned(c);
  return c.json({
    items: db
      .all<any>("SELECT * FROM kb_inbox WHERE kb_id=? AND sender<>'intake' AND status IN ('pending','running','error') ORDER BY id", kb.id)
      .map((item) => ({ ...item, task: taskSubject(item) })),
  });
});
kbRoutes.post('/:id/inbox/:iid/process', (c) => {
  const u = teacher(c),
    kb = ownKb(u, intParam(c));
  writableKb(kb.id);
  const item = db.get<any>("SELECT * FROM kb_inbox WHERE id=? AND kb_id=? AND status IN ('pending','error')", intParam(c, 'iid'), kb.id);
  if (!item) throw notFound();
  db.update('kb_inbox', item.id, { status: 'pending', error: null });
  drainInbox(kb.id);
  return c.json({
    runId: db.get<any>('SELECT run_id FROM kb_inbox WHERE id=?', item.id)?.run_id || null,
  });
});
kbRoutes.post('/:id/inbox/:iid/dismiss', (c) => {
  const kb = owned(c);
  writableKb(kb.id);
  db.run("UPDATE kb_inbox SET status='dismissed' WHERE id=? AND kb_id=?", intParam(c, 'iid'), kb.id);
  return c.json({ ok: true });
});
kbRoutes.get('/:id/kb/stream', (c) => {
  const kb = owned(c),
    uid = teacher(c).id;
  return streamSSE(c, async (stream) => {
    let closed = false;
    const unsub = bus.subscribe(`kb:${kb.id}`, (msg) => {
      if (!closed && (!sessionStillActive(c) || loadKb(kb.id).teacher_id !== uid)) {
        closed = true;
        unsub();
        void stream.close().catch(() => {});
        return;
      }
      if (!closed) void stream.writeSSE({ event: msg.event, data: JSON.stringify(msg.data) }).catch(() => {});
    });
    stream.onAbort(() => {
      closed = true;
      unsub();
    });
    try {
      while (!closed) {
        await stream.sleep(25000);
        if (!closed) {
          if (!sessionStillActive(c) || loadKb(kb.id).teacher_id !== uid) {
            closed = true;
            unsub();
            await stream.close();
            break;
          }
          await stream.writeSSE({ event: 'ping', data: '{}' });
        }
      }
    } finally {
      closed = true;
      unsub();
    }
  });
});
// 学生不能指定别人的身份、读取档案或查看教师工作记录。
kbRoutes.get('/:id/context', (c) => {
  const u = me(c),
    kb = loadKb(intParam(c));
  if (u.role !== 'student' || kb.kind !== 'class') throw forbidden();
  const classId = Number(c.req.query('classId') || kb.id),
    classroom = loadKb(classId);
  const student = db.get<any>('SELECT id FROM kb_students WHERE kb_id=? AND user_id=?', classId, u.id);
  if (!student || classId !== kb.id || classroom.teacher_id !== kb.teacher_id) throw forbidden();
  return c.json({
    documents: readKnowledge(
      kb.id,
      {
        role: 'student',
        teacherId: kb.teacher_id,
        classId,
        studentId: student.id,
      },
      c.req.query('fileId'),
      c.req.query('q'),
    ),
  });
});

/** 课程首页保留原有功能，课程卡片通向老师同一份知识库。 */
export const courseRoutes = new Hono<AppEnv>();
courseRoutes.get('/', async (c) => {
  const u = teacher(c),
    kbId = await ensureTeacherKb(u.id, u.name);
  return c.json({
    courses: db.all<any>('SELECT * FROM courses WHERE teacher_id=? ORDER BY id', u.id).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      kbId,
      pending: pendingCount(kbId),
      createdAt: r.created_at,
    })),
  });
});
courseRoutes.post('/', async (c) => {
  const u = teacher(c),
    d = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(60),
        description: z.string().max(500).optional(),
      }),
    );
  const kbId = await ensureTeacherKb(u.id, u.name);
  const id = db.insert('courses', {
    name: d.name,
    description: d.description || null,
    teacher_id: u.id,
    kb_id: kbId,
    created_at: now(),
  });
  return c.json({ id });
});
courseRoutes.get('/:id', async (c) => {
  const u = teacher(c),
    r = db.get<any>('SELECT * FROM courses WHERE id=? AND teacher_id=?', intParam(c), u.id);
  if (!r) throw notFound('课程不存在');
  const legacyPrefix = db.get<{ prefix: string }>('SELECT prefix FROM kb_imports WHERE course_id=?', r.id)?.prefix || '';
  return c.json({
    course: r,
    kbId: await ensureTeacherKb(u.id, u.name),
    legacyPrefix,
  });
});
