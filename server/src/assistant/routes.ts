/**
 * 学生跟 CoT 学伴说话的接口（/api/cot），老师看自己班学生跟学伴说了什么也在这里。
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { me, requireRole, sessionStillActive, type AppEnv } from '../auth.js';
import { db } from '../db/index.js';
import { bus } from '../lib/bus.js';
import { body, intParam, notFound } from '../lib/http.js';
import { sourceBytes } from '../kb/repo.js';
import { cancelStuRun, myClasses, newStuSession, ownStuSession, runsSeenBy, startStuTurn, stuBusy, stuRun, stuSessions } from './buddy.js';
import { studentSession } from './bridge.js';

export const cotRoutes = new Hono<AppEnv>();
const student = (c: any) => requireRole(c, 'student');

/** 一段会话的每一轮（不传 session 是现在这段） */
cotRoutes.get('/runs', (c) => {
  const u = student(c);
  const raw = c.req.query('session');
  const session = raw && raw !== 'current' ? ownStuSession(u.id, Number(raw) || null) : studentSession(u.id);
  return c.json({
    runs: db.all<any>("SELECT * FROM kb_runs WHERE teacher_id=? AND agent='stu' AND session_id=? ORDER BY id DESC LIMIT 100", u.id, session).reverse().map(stuRun),
    session,
    activeRunId: stuBusy(u.id)?.runId || null,
  });
});
cotRoutes.get('/sessions', (c) => {
  const u = student(c);
  return c.json({ sessions: stuSessions(u.id), current: studentSession(u.id) });
});
cotRoutes.post('/sessions', (c) => {
  const u = student(c);
  return c.json({ id: newStuSession(u.id) });
});
cotRoutes.post('/messages', async (c) => {
  const u = student(c);
  const d = await body(c, z.object({ message: z.string().trim().min(1).max(4000), session: z.number().int().positive().nullable().optional() }));
  return c.json({ runId: startStuTurn(u, { message: d.message, session: d.session }) });
});
cotRoutes.post('/runs/:rid/cancel', (c) => {
  const u = student(c);
  cancelStuRun(u.id, intParam(c, 'rid'));
  return c.json({ ok: true });
});
cotRoutes.get('/stream', (c) => {
  const uid = student(c).id;
  return streamSSE(c, async (stream) => {
    let closed = false;
    const unsub = bus.subscribe(`keeper:${uid}`, (msg) => {
      if (!closed && !sessionStillActive(c)) {
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
          if (!sessionStillActive(c)) {
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

const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain; charset=utf-8',
};
/** 学伴发的文件：只有资料包里放着的、学生在这个班里的才给（老师也能点开看） */
cotRoutes.get('/files/:id', (c) => {
  const u = me(c);
  const f = db.get<{ id: number; class_id: number; source_id: string; name: string }>(
    'SELECT id, class_id, source_id, name FROM class_files WHERE id=? AND removed_at IS NULL',
    intParam(c),
  );
  if (!f) throw notFound('这份文件已经不给了');
  const ok =
    u.role === 'student'
      ? myClasses(u.id).some((k) => k.id === f.class_id)
      : !!db.get('SELECT id FROM classes WHERE id=? AND teacher_id=? AND deleted_at IS NULL', f.class_id, u.id);
  if (!ok) throw notFound('这份文件已经不给了');
  let bytes: Buffer;
  try {
    bytes = sourceBytes(f.source_id, 'original');
  } catch {
    throw notFound('文件不在了');
  }
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  const inline = c.req.query('inline') === '1' && /^(pdf|png|jpe?g|gif|webp)$/.test(ext);
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="file.${ext || 'bin'}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'Cache-Control': 'private, no-store',
    },
  });
});

/** 老师看自己班一个学生跟学伴说的（班级页「成员」里点开）：只看说到这位老师的班的那几轮 */
cotRoutes.get('/students/:sid', (c) => {
  const u = requireRole(c, 'teacher', 'admin');
  const classId = Number(c.req.query('class') || 0);
  const m = db.get<{ user_id: number | null; name: string; student_no: string }>(
    'SELECT s.user_id, s.name, s.student_no FROM class_students s JOIN classes c ON c.id=s.class_id WHERE s.id=? AND s.class_id=? AND c.teacher_id=? AND c.deleted_at IS NULL',
    intParam(c, 'sid'),
    classId,
    u.id,
  );
  if (!m) throw notFound('这个学生不在你的班里');
  return c.json({ name: m.name, studentNo: m.student_no, joined: !!m.user_id, runs: m.user_id ? runsSeenBy(u.id, m.user_id) : [] });
});
