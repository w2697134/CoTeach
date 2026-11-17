/**
 * 消息（2026-11-18）：收件箱、课程群、私聊；群里的通知、签到、选人。表在 db/schema.ts 第 25 次。
 * 全是程序，不经过模型；CoT 助教替老师办的时候调的也是这些接口（assistant/tools.ts 里 callApi），检查一模一样。
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { User } from '../auth.js';
import { db, j, now } from '../db/index.js';
import { bad, conflict, notFound } from '../lib/http.js';
import { showTime } from '../assistant/time.js';

export interface ChatRow {
  id: number;
  kind: 'class' | 'dm';
  class_id: number | null;
  teacher_id: number | null;
  student_id: number | null;
  last_at: number;
  created_at: number;
}
interface ClassLite {
  id: number;
  name: string;
  teacher_id: number;
  archived_at: number | null;
}
interface MessageRow {
  id: number;
  chat_id: number;
  user_id: number;
  kind: 'text' | 'file' | 'notice' | 'checkin' | 'pick';
  text: string;
  file_id: number | null;
  ref_id: number | null;
  created_at: number;
  /** 通知卡：这条通知撤回了没有（查的时候连上 notices，见 WITH_RECALL） */
  recalled_at?: number | null;
}
interface CheckinRow {
  id: number;
  class_id: number;
  teacher_id: number;
  token: string;
  started_at: number;
  ends_at: number;
}

const DAY = 86400_000;
export const isTeacher = (u: Pick<User, 'role'>) => u.role === 'teacher' || u.role === 'admin';
const userName = (id: number) => db.value<string>('SELECT name FROM users WHERE id=?', id) || '';
const short = (s: string, n = 24) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/* ---------------- 谁在哪门课里 ---------------- */

const CLASS = 'SELECT c.id, c.name, c.teacher_id, c.archived_at FROM classes c';
/** 这个人在的课程：老师是自己开的，学生是加入了的（删掉的不算） */
export function classesFor(u: User): ClassLite[] {
  return isTeacher(u)
    ? db.all<ClassLite>(`${CLASS} WHERE c.teacher_id=? AND c.deleted_at IS NULL ORDER BY c.id`, u.id)
    : db.all<ClassLite>(`${CLASS} JOIN class_students s ON s.class_id=c.id AND s.user_id=? WHERE c.deleted_at IS NULL ORDER BY c.id`, u.id);
}
function memberOf(u: User, classId: number): ClassLite | undefined {
  return isTeacher(u)
    ? db.get<ClassLite>(`${CLASS} WHERE c.id=? AND c.teacher_id=? AND c.deleted_at IS NULL`, classId, u.id)
    : db.get<ClassLite>(`${CLASS} JOIN class_students s ON s.class_id=c.id AND s.user_id=? WHERE c.id=? AND c.deleted_at IS NULL`, u.id, classId);
}
/** 老师自己的、没归档的一门课：发通知、签到、选人用（别的老师的、学生都当没有） */
export function teachingClass(u: User, classId: number): ClassLite {
  const k = isTeacher(u) ? memberOf(u, classId) : undefined;
  if (!k) throw notFound('这门课不存在或已经删掉了');
  if (k.archived_at) throw conflict('这门课已经归档了');
  return k;
}
/** 一门课里有账号的学生，名字照学生在这门课里填的 */
export const studentsOf = (classId: number) =>
  db.all<{ user_id: number; name: string }>('SELECT user_id, name FROM class_students WHERE class_id=? AND user_id IS NOT NULL ORDER BY student_no, id', classId);
/** 老师和学生有没有一门共同的课 */
const share = (teacherId: number, studentId: number) =>
  !!db.get('SELECT c.id FROM classes c JOIN class_students s ON s.class_id=c.id AND s.user_id=? WHERE c.teacher_id=? AND c.deleted_at IS NULL LIMIT 1', studentId, teacherId);
/** 学生在老师的课里填的名字（不在就用账号上的名字） */
const studentName = (teacherId: number, studentId: number) =>
  db.value<string>(
    'SELECT s.name FROM class_students s JOIN classes c ON c.id=s.class_id WHERE s.user_id=? AND c.teacher_id=? AND c.deleted_at IS NULL ORDER BY s.id DESC LIMIT 1',
    studentId,
    teacherId,
  ) || userName(studentId);

/* ---------------- 会话 ---------------- */

/** 一门课的群：第一次用到时建 */
export function groupOf(classId: number): ChatRow {
  db.run("INSERT OR IGNORE INTO chats (kind, class_id, last_at, created_at) VALUES ('class', ?, 0, ?)", classId, now());
  return db.get<ChatRow>("SELECT * FROM chats WHERE kind='class' AND class_id=?", classId)!;
}

/** 能看的会话：群是这门课的老师和学生，私聊是两边的人 */
export function chatFor(u: User, chatId: number): { chat: ChatRow; k: ClassLite | null } {
  const chat = db.get<ChatRow>('SELECT * FROM chats WHERE id=?', chatId);
  if (chat?.kind === 'class') {
    const k = memberOf(u, chat.class_id!);
    if (k) return { chat, k };
  } else if (chat && (chat.teacher_id === u.id || chat.student_id === u.id)) return { chat, k: null };
  throw notFound('这个会话不在了');
}

/** 私聊：同一门课里的老师和学生之间，谁先开口都行；两个人只有一个私聊 */
export function openDm(u: User, otherId: number): ChatRow {
  const other = db.get<{ id: number; role: string }>('SELECT id, role FROM users WHERE id=?', otherId);
  const teacher = isTeacher(u);
  const ok = other && other.id !== u.id && (teacher ? other.role === 'student' : other.role === 'teacher' || other.role === 'admin');
  const [t, s] = teacher ? [u.id, otherId] : [otherId, u.id];
  if (!ok || !share(t, s)) throw notFound('只能跟同一门课里的老师、学生私聊');
  db.run("INSERT OR IGNORE INTO chats (kind, teacher_id, student_id, last_at, created_at) VALUES ('dm', ?, ?, 0, ?)", t, s, now());
  return db.get<ChatRow>("SELECT * FROM chats WHERE kind='dm' AND teacher_id=? AND student_id=?", t, s)!;
}

function markRead(chatId: number, userId: number, upto: number) {
  db.run(
    'INSERT INTO chat_reads (chat_id, user_id, last_id) VALUES (?,?,?) ON CONFLICT(chat_id, user_id) DO UPDATE SET last_id=max(last_id, excluded.last_id)',
    chatId,
    userId,
    upto,
  );
}

/** 写一条（调的地方查过权限） */
function say(chatId: number, userId: number, m: { kind: MessageRow['kind']; text?: string; fileId?: number | null; refId?: number | null }) {
  const t = now();
  const id = db.insert('chat_messages', { chat_id: chatId, user_id: userId, kind: m.kind, text: m.text ?? '', file_id: m.fileId ?? null, ref_id: m.refId ?? null, created_at: t });
  db.run('UPDATE chats SET last_at=? WHERE id=?', t, chatId);
  markRead(chatId, userId, id);
  return id;
}

/** 自己传上来、还没用在别处的文件（作业、交的作业、别的消息、通知都没挂过） */
function freeFile(u: User, fileId: number) {
  const f = db.get<{ id: number; name: string }>(
    'SELECT id, name FROM homework_files WHERE id=? AND owner_id=? AND assignment_id IS NULL AND submission_id IS NULL',
    fileId,
    u.id,
  );
  const used =
    db.get('SELECT id FROM chat_messages WHERE file_id=?', fileId) ||
    db.get('SELECT n.id FROM notices n, json_each(n.file_ids) f WHERE f.value=?', fileId);
  if (!f || used) throw bad('文件没传上，重新加一下');
  return f;
}

/** 发一条：文字或者一个文件（图片也是文件） */
export function send(u: User, chatId: number, m: { text?: string; fileId?: number | null }): number {
  const { chat, k } = chatFor(u, chatId);
  if (k?.archived_at) throw conflict('这门课已经归档了');
  if (chat.kind === 'dm' && !share(chat.teacher_id!, chat.student_id!)) throw conflict('你们已经不在同一门课里了');
  const text = (m.text || '').trim().slice(0, 2000);
  if (m.fileId) {
    freeFile(u, m.fileId);
    return say(chat.id, u.id, { kind: 'file', fileId: m.fileId, text });
  }
  if (!text) throw bad('先写点什么');
  return say(chat.id, u.id, { kind: 'text', text });
}

/** 别人在群里、私聊里发的文件，看得到这个会话的人才下载得到；通知带的附件，收到通知的人才下载得到（撤回了就下载不到，老师自己传的照样能下） */
export function fileShared(u: User, fileId: number): boolean {
  for (const r of db.all<{ chat_id: number }>('SELECT chat_id FROM chat_messages WHERE file_id=?', fileId))
    try {
      chatFor(u, r.chat_id);
      return true;
    } catch {
      /* 看不到这个会话 */
    }
  for (const n of db.all<{ id: number; teacher_id: number }>('SELECT n.id, n.teacher_id FROM notices n, json_each(n.file_ids) f WHERE f.value=? AND n.recalled_at IS NULL', fileId)) {
    if (n.teacher_id === u.id) return true;
    if (db.all<{ class_id: number }>('SELECT class_id FROM notice_classes WHERE notice_id=?', n.id).some((x) => memberOf(u, x.class_id))) return true;
  }
  return false;
}

const fileView = (ids: number[]) =>
  ids.length ? db.all<{ id: number; name: string; size: number }>(`SELECT id, name, size FROM homework_files WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];

/** 取消息时连上通知撤回了没有：撤回了的通知卡换成一行灰字（照微信） */
const WITH_RECALL = "SELECT m.*, n.recalled_at FROM chat_messages m LEFT JOIN notices n ON m.kind='notice' AND n.id=m.ref_id";
const recallLine = (mine: boolean) => (mine ? '你撤回了一条通知' : '老师撤回了一条通知');

/** 会话里的消息：最近 80 条，或者某一条以后的（打开着的会话几秒刷一次）；看了就算读到最后一条 */
export function messagesOf(u: User, chat: ChatRow, after = 0) {
  const rows = after
    ? db.all<MessageRow>(`${WITH_RECALL} WHERE m.chat_id=? AND m.id>? ORDER BY m.id LIMIT 200`, chat.id, after)
    : db.all<MessageRow>(`SELECT * FROM (${WITH_RECALL} WHERE m.chat_id=? ORDER BY m.id DESC LIMIT 80) ORDER BY id`, chat.id);
  const teacherId = chat.kind === 'class' ? db.value<number>('SELECT teacher_id FROM classes WHERE id=?', chat.class_id)! : chat.teacher_id!;
  const names = new Map<number, string>();
  const nameOf = (id: number) => {
    if (!names.has(id)) names.set(id, id === teacherId ? userName(id) : studentName(teacherId, id));
    return names.get(id)!;
  };
  const files = new Map(fileView(rows.filter((r) => r.file_id).map((r) => r.file_id!)).map((f) => [f.id, f]));
  if (rows.length) markRead(chat.id, u.id, rows[rows.length - 1].id);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    // 撤回了的通知：话不再给出去，页面上摆「老师撤回了一条通知」
    text: r.recalled_at ? '' : r.text,
    at: r.created_at,
    mine: r.user_id === u.id,
    from: { id: r.user_id, name: nameOf(r.user_id), teacher: r.user_id === teacherId },
    file: r.file_id ? files.get(r.file_id) || null : null,
    ref: r.ref_id,
    ...(r.recalled_at ? { recalled: true } : {}),
  }));
}

/** 会话的名字：群是课程名，私聊是对方 */
function chatTitle(u: User, chat: ChatRow) {
  if (chat.kind === 'class') return db.value<string>('SELECT name FROM classes WHERE id=?', chat.class_id) || '';
  return chat.teacher_id === u.id ? studentName(u.id, chat.student_id!) : userName(chat.teacher_id!);
}
const preview = (m: MessageRow, files: Map<number, { name: string }>) =>
  m.kind === 'text'
    ? m.text
    : m.kind === 'file'
      ? /\.(png|jpe?g|gif|webp)$/i.test(files.get(m.file_id!)?.name || '')
        ? '[图片]'
        : `[文件] ${files.get(m.file_id!)?.name || ''}`
      : m.kind === 'notice'
        ? `[通知] ${m.text}`
        : m.kind === 'checkin'
          ? '[签到]'
          : `[选人] 点到${m.text}`;

/** 这个人的会话：在用的课程各一个群（没有就建），私聊 */
function chatsOf(u: User): ChatRow[] {
  const groups = classesFor(u)
    .filter((k) => !k.archived_at)
    .map((k) => groupOf(k.id));
  const dms = db.all<ChatRow>("SELECT * FROM chats WHERE kind='dm' AND (teacher_id=? OR student_id=?)", u.id, u.id);
  return [...groups, ...dms];
}
/** 没读的条数：撤回了的通知卡不算 */
const unreadIn = (chatId: number, userId: number) =>
  db.value<number>(
    `SELECT count(*) FROM chat_messages m WHERE m.chat_id=? AND m.user_id<>? AND m.id>coalesce((SELECT last_id FROM chat_reads WHERE chat_id=? AND user_id=?), 0)
       AND NOT EXISTS (SELECT 1 FROM notices n WHERE m.kind='notice' AND n.id=m.ref_id AND n.recalled_at IS NOT NULL)`,
    chatId,
    userId,
    chatId,
    userId,
  ) || 0;

/** 会话列表：收件箱钉在最上面（页面上摆），下面是群和私聊，最近有动静的在前 */
export function chatList(u: User) {
  const list = chatsOf(u).map((c) => {
    const last = db.get<MessageRow>(`${WITH_RECALL} WHERE m.chat_id=? ORDER BY m.id DESC LIMIT 1`, c.id);
    const files = new Map(fileView(last?.file_id ? [last.file_id] : []).map((f) => [f.id, f]));
    const mine = last?.user_id === u.id;
    return {
      id: c.id,
      kind: c.kind,
      classId: c.class_id,
      title: chatTitle(u, c),
      // 最后一条是撤回了的通知：写「你撤回了一条通知」，前面不加「我：」（recalled）
      last: last
        ? { text: short(last.recalled_at ? recallLine(mine) : preview(last, files), 40), at: last.created_at, mine, ...(last.recalled_at ? { recalled: true } : {}) }
        : null,
      unread: unreadIn(c.id, u.id),
      sort: last?.created_at || c.created_at,
    };
  });
  list.sort((a, b) => b.sort - a.sort);
  if (isTeacher(u)) sweepDue(u.id);
  const inbox = db.get<{ unread: number; title: string | null; at: number | null }>(
    'SELECT (SELECT count(*) FROM inbox WHERE user_id=? AND read_at IS NULL) AS unread, title, created_at AS at FROM inbox WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 1',
    u.id,
    u.id,
  );
  return { inbox: { unread: inbox?.unread ?? 0, last: inbox?.title ? { text: inbox.title, at: inbox.at } : null }, chats: list.map(({ sort: _, ...c }) => c) };
}

/** 左边栏「消息」上的数：收件箱没读的加上各个会话没读的 */
export function unreadCount(u: User) {
  if (isTeacher(u)) sweepDue(u.id);
  const inbox = db.value<number>('SELECT count(*) FROM inbox WHERE user_id=? AND read_at IS NULL', u.id) || 0;
  return inbox + chatsOf(u).reduce((n, c) => n + unreadIn(c.id, u.id), 0);
}

/** 群里的人：老师和加入了的学生（私聊从这里点名字开） */
export function membersOf(chat: ChatRow) {
  if (chat.kind !== 'class') return [];
  const k = db.get<{ teacher_id: number }>('SELECT teacher_id FROM classes WHERE id=?', chat.class_id)!;
  return [{ id: k.teacher_id, name: userName(k.teacher_id), teacher: true }, ...studentsOf(chat.class_id!).map((s) => ({ id: s.user_id, name: s.name, teacher: false }))];
}

/* ---------------- 收件箱 ---------------- */

/** 进收件箱：同一件事（kind + ref）只留一条，再来就顶到最上面、重新算没读 */
export function inboxPut(userId: number, kind: string, refId: number, title: string, body = '', link: string | null = null) {
  db.run(
    `INSERT INTO inbox (user_id, kind, ref_id, title, body, link, created_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(user_id, kind, ref_id) DO UPDATE SET title=excluded.title, body=excluded.body, link=excluded.link, created_at=excluded.created_at, read_at=NULL, done_at=NULL`,
    userId,
    kind,
    refId,
    title.slice(0, 200),
    body.slice(0, 2000),
    link,
    now(),
  );
}
/** 办完了：划掉（也算读了） */
export function inboxDone(userId: number, kind: string, refId: number) {
  const t = now();
  db.run('UPDATE inbox SET read_at=coalesce(read_at, ?), done_at=coalesce(done_at, ?) WHERE user_id=? AND kind=? AND ref_id=?', t, t, userId, kind, refId);
}

/** 快截止了（一天以内）还有人没交：老师的收件箱来一条，一份作业只来一次 */
function sweepDue(teacherId: number) {
  const t = now();
  const rows = db.all<{ id: number; title: string; due_at: number; class_id: number; class_name: string }>(
    `SELECT a.id, a.title, a.due_at, a.class_id, c.name AS class_name FROM assignments a JOIN classes c ON c.id=a.class_id AND c.deleted_at IS NULL AND c.archived_at IS NULL
     WHERE a.teacher_id=? AND a.deleted_at IS NULL AND a.publish_at<=? AND a.due_at>? AND a.due_at<=?
       AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.user_id=? AND i.kind='due' AND i.ref_id=a.id)`,
    teacherId,
    t,
    t,
    t + DAY,
    teacherId,
  );
  for (const a of rows) {
    const handed = new Set(db.all<{ user_id: number }>('SELECT user_id FROM submissions WHERE assignment_id=?', a.id).map((s) => s.user_id));
    const missing = studentsOf(a.class_id).filter((s) => !handed.has(s.user_id));
    if (!missing.length) continue;
    inboxPut(
      teacherId,
      'due',
      a.id,
      `「${a.title}」${showTime(a.due_at)} 截止，还有 ${missing.length} 人没交`,
      `${a.class_name}：${missing.map((s) => s.name).join('、')}`,
      `/classes/${a.class_id}/homework/${a.id}`,
    );
  }
}

interface InboxRow {
  id: number;
  kind: string;
  ref_id: number;
  title: string;
  body: string;
  link: string | null;
  created_at: number;
  read_at: number | null;
  done_at: number | null;
}
/**
 * 收件箱：新的在前。学生来问、助教提议分专门助手的卡片（kind=ask）带上卡片本身，在这里就能答；答了就算办完。
 * 通知、签到带编号，页面上摆成卡片。
 */
export function inboxOf(u: User) {
  if (isTeacher(u)) sweepDue(u.id);
  const rows = db.all<InboxRow>('SELECT * FROM inbox WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 100', u.id);
  return rows.map((r) => {
    const base = { id: r.id, kind: r.kind, ref: r.ref_id, title: r.title, body: r.body, link: r.link, at: r.created_at, read: !!r.read_at, done: !!r.done_at };
    if (r.kind !== 'ask') return base;
    const run = db.get<{ status: string }>("SELECT status FROM kb_runs WHERE id=? AND teacher_id=? AND agent='ta'", r.ref_id, u.id);
    const ev = db.get<{ data: string }>("SELECT data FROM kb_events WHERE run_id=? AND type='ask' ORDER BY id DESC LIMIT 1", r.ref_id);
    // 老师在卡片上答了以后助教接着办的那一轮（转告学生、分专门助手），回话摆在卡片下面
    const next = db.get<{ status: string; reply: string | null; error: string | null }>(
      "SELECT r.status, r.reply, r.error FROM kb_events e JOIN kb_runs r ON r.id=e.run_id WHERE e.type='answer' AND json_extract(e.data, '$.askRunId')=? ORDER BY r.id DESC LIMIT 1",
      r.ref_id,
    );
    const live = run?.status === 'waiting';
    return { ...base, done: base.done || !live, card: ev ? j<Record<string, unknown>>(ev.data, {}) : null, live, followup: next ?? null };
  });
}

export function inboxRead(u: User, id: number, done: boolean) {
  const t = now();
  const r = db.run(`UPDATE inbox SET read_at=coalesce(read_at, ?)${done ? ', done_at=coalesce(done_at, ?)' : ''} WHERE id=? AND user_id=?`, ...(done ? [t, t, id, u.id] : [t, id, u.id]));
  if (!r.changes) throw notFound('这一条不在了');
}
export const inboxReadAll = (u: User) => db.run('UPDATE inbox SET read_at=? WHERE user_id=? AND read_at IS NULL', now(), u.id).changes;

/* ---------------- 通知 ---------------- */

/** 发通知：每门课的群里出一张通知卡，每个学生的收件箱也来一条 */
export function sendNotice(u: User, classIds: number[], text: string, fileIds: number[]): number {
  const ks = [...new Set(classIds)].map((id) => teachingClass(u, id));
  if (!ks.length) throw bad('发给哪门课？');
  const body = text.trim().slice(0, 4000);
  if (!body) throw bad('通知写什么？');
  const files = [...new Set(fileIds)];
  files.forEach((f) => freeFile(u, f));
  return db.tx(() => {
    const id = db.insert('notices', { teacher_id: u.id, text: body, file_ids: files.length ? JSON.stringify(files) : null, created_at: now() });
    for (const k of ks) {
      db.run('INSERT INTO notice_classes (notice_id, class_id) VALUES (?,?)', id, k.id);
      say(groupOf(k.id).id, u.id, { kind: 'notice', text: body, refId: id });
      for (const s of studentsOf(k.id)) inboxPut(s.user_id, 'notice', id, `${k.name}的通知`, body);
    }
    return id;
  });
}

interface NoticeRow {
  id: number;
  teacher_id: number;
  text: string;
  file_ids: string | null;
  created_at: number;
  recalled_at: number | null;
}
const noticeClasses = (id: number) =>
  db.all<{ id: number; name: string }>('SELECT c.id, c.name FROM notice_classes x JOIN classes c ON c.id=x.class_id WHERE x.notice_id=? AND c.deleted_at IS NULL ORDER BY c.id', id);

/** 一条通知的收件人（几门课里的学生，同一个人只算一次）和谁读了；classId 只算这门课的 */
function noticeStats(n: NoticeRow, classId?: number | null) {
  const people = new Map<number, string>();
  for (const k of noticeClasses(n.id)) if (!classId || k.id === classId) for (const s of studentsOf(k.id)) if (!people.has(s.user_id)) people.set(s.user_id, s.name);
  const read = new Set(db.all<{ user_id: number }>('SELECT user_id FROM notice_reads WHERE notice_id=?', n.id).map((r) => r.user_id));
  const unread = [...people].filter(([id]) => !read.has(id));
  return { total: people.size, read: people.size - unread.length, unread };
}

function noticeRow(u: User, id: number): NoticeRow {
  const n = db.get<NoticeRow>('SELECT * FROM notices WHERE id=?', id);
  const ok = n && (isTeacher(u) ? n.teacher_id === u.id : noticeClasses(id).some((k) => memberOf(u, k.id)));
  if (!n || !ok) throw notFound('这条通知不在了');
  return n;
}

/** 看一条通知：老师看到读了几个、没读的是谁；学生点开就算读了。撤回了的：学生那边话和附件都没有了，谁也不再算读没读 */
export function noticeView(u: User, id: number, classId?: number | null) {
  const n = noticeRow(u, id);
  const base = { id: n.id, text: n.text, at: n.created_at, teacher: userName(n.teacher_id), classes: noticeClasses(n.id), files: fileView(j<number[]>(n.file_ids, [])) };
  if (n.recalled_at) return { ...base, ...(isTeacher(u) ? {} : { text: '', files: [] }), recalled: true };
  if (isTeacher(u)) {
    const s = noticeStats(n, classId);
    return { ...base, total: s.total, read: s.read, unread: s.unread.map(([, name]) => name) };
  }
  db.run('INSERT OR IGNORE INTO notice_reads (notice_id, user_id, read_at) VALUES (?,?,?)', n.id, u.id, now());
  inboxDone(u.id, 'notice', n.id);
  return base;
}

/** 提醒还没读的：他们收件箱里那一条顶上来、重新算没读 */
export function remindNotice(u: User, id: number) {
  const n = noticeRow(u, id);
  if (!isTeacher(u)) throw notFound('这条通知不在了');
  if (n.recalled_at) throw conflict('这条通知已经撤回了');
  const { unread } = noticeStats(n);
  for (const [uid] of unread) inboxPut(uid, 'notice', n.id, '老师提醒你看通知', n.text);
  return { reminded: unread.length, names: unread.map(([, name]) => name) };
}

/**
 * 撤回一条通知（发的老师才能撤）：群里那张卡换成一行灰字「老师撤回了一条通知」，学生收件箱里那一条去掉，不再算读没读，附件学生也下载不到了。
 * 页面上点「撤回」、跟助教说「把刚才那条通知撤回」（assistant/actions.ts 的 undoAction）都走这里。
 * 助教发通知时写进资料包的那条也收起来（学伴不再照它答）；助教记的那一笔标成撤回了（老师再跟它说「撤回」，不会又找到这条）。
 */
export function recallNotice(u: User, id: number) {
  const n = noticeRow(u, id);
  if (!isTeacher(u)) throw notFound('这条通知不在了');
  const t = now();
  db.tx(() => {
    if (!db.run('UPDATE notices SET recalled_at=? WHERE id=? AND recalled_at IS NULL', t, n.id).changes) throw conflict('这条通知已经撤回了');
    db.run("DELETE FROM inbox WHERE kind='notice' AND ref_id=?", n.id);
    db.run(
      "UPDATE class_pack SET deleted_at=? WHERE kind='notice' AND body=? AND deleted_at IS NULL AND class_id IN (SELECT class_id FROM notice_classes WHERE notice_id=?)",
      t,
      n.text,
      n.id,
    );
    db.run(
      "UPDATE ta_actions SET status='undone', undone_at=? WHERE teacher_id=? AND status='done' AND json_extract(undo, '$.kind')='notice.recall' AND json_extract(undo, '$.noticeId')=?",
      t,
      n.teacher_id,
      n.id,
    );
  });
}

/** 最近的一条通知（助教说「刚才那个通知」时用） */
export const latestNotice = (teacherId: number) => db.value<number>('SELECT max(id) FROM notices WHERE teacher_id=?', teacherId) ?? null;

/** 照开头几个字找老师发过的通知，新的先对；撤回了的不算 */
export function findNotice(teacherId: number, ref: string | null | undefined): number {
  const want = (ref || '').replace(/\s+/g, '');
  const rows = db.all<{ id: number; text: string; recalled_at: number | null }>('SELECT id, text, recalled_at FROM notices WHERE teacher_id=? ORDER BY id DESC LIMIT 50', teacherId);
  const match = want ? rows.filter((n) => n.text.replace(/\s+/g, '').includes(want)) : rows;
  const hit = match.find((n) => !n.recalled_at);
  if (!hit) throw match.length ? conflict(want ? `说「${ref}」的那条通知已经撤回了` : '发过的通知都撤回了') : notFound(want ? `没有说「${ref}」的通知` : '还没发过通知');
  return hit.id;
}

/* ---------------- 签到 ---------------- */

/** 发起签到：群里出一张签到卡，学生收件箱也来一条；这门课还开着的签到先结束 */
export function startCheckin(u: User, classId: number, minutes: number): number {
  const k = teachingClass(u, classId);
  const t = now();
  return db.tx(() => {
    db.run('UPDATE checkins SET ends_at=? WHERE class_id=? AND ends_at>?', t, k.id, t);
    const id = db.insert('checkins', { class_id: k.id, teacher_id: u.id, token: randomBytes(6).toString('hex'), started_at: t, ends_at: t + minutes * 60_000 });
    say(groupOf(k.id).id, u.id, { kind: 'checkin', text: `签到 ${minutes} 分钟`, refId: id });
    for (const s of studentsOf(k.id)) inboxPut(s.user_id, 'checkin', id, `${k.name}在签到`, `${showTime(t + minutes * 60_000).replace(/^.* /, '')} 前签到`);
    return id;
  });
}

function checkinRow(u: User, id: number): CheckinRow & { name: string } {
  const c = db.get<CheckinRow & { name: string }>('SELECT k.*, c.name FROM checkins k JOIN classes c ON c.id=k.class_id AND c.deleted_at IS NULL WHERE k.id=?', id);
  if (!c || !memberOf(u, c.class_id)) throw notFound('这次签到不在了');
  return c;
}

/** 看一次签到：老师看到每个人签了没有（谁补签的），学生看到自己签了没有 */
export function checkinView(u: User, id: number) {
  const c = checkinRow(u, id);
  const t = now();
  const marks = new Map(db.all<{ user_id: number; at: number; by: string }>('SELECT user_id, at, by FROM checkin_marks WHERE checkin_id=?', c.id).map((m) => [m.user_id, m]));
  const base = { id: c.id, classId: c.class_id, className: c.name, startedAt: c.started_at, endsAt: c.ends_at, open: t < c.ends_at, now: t };
  if (!isTeacher(u)) return { ...base, mine: marks.get(u.id)?.at ?? null };
  const people = studentsOf(c.class_id).map((s) => ({ id: s.user_id, name: s.name, at: marks.get(s.user_id)?.at ?? null, by: marks.get(s.user_id)?.by ?? null }));
  return { ...base, token: c.token, total: people.length, signed: people.filter((p) => p.at).length, people };
}

/** 学生签到（点卡片、扫码、开链接都走这里）：在这门课里、还在签到时间里 */
export function signIn(u: User, c: CheckinRow) {
  if (isTeacher(u) || !studentsOf(c.class_id).some((s) => s.user_id === u.id)) throw notFound('你不在这门课里');
  if (now() >= c.ends_at) throw conflict('签到已经结束了');
  db.run("INSERT OR IGNORE INTO checkin_marks (checkin_id, user_id, at, by) VALUES (?,?,?,'self')", c.id, u.id, now());
  inboxDone(u.id, 'checkin', c.id);
}
export const checkinById = (u: User, id: number) => checkinRow(u, id);
export function checkinByToken(token: string) {
  const c = db.get<CheckinRow & { name: string }>('SELECT k.*, c.name FROM checkins k JOIN classes c ON c.id=k.class_id AND c.deleted_at IS NULL WHERE k.token=?', token);
  if (!c) throw notFound('这个签到链接不对');
  return c;
}

/** 老师补签：签到结束了也能补 */
export function markCheckin(u: User, id: number, userId: number) {
  const c = checkinRow(u, id);
  if (!isTeacher(u)) throw notFound('这次签到不在了');
  const s = studentsOf(c.class_id).find((x) => x.user_id === userId);
  if (!s) throw notFound('这门课里没有这个学生');
  db.run("INSERT OR IGNORE INTO checkin_marks (checkin_id, user_id, at, by) VALUES (?,?,?,'teacher')", c.id, userId, now());
  inboxDone(userId, 'checkin', c.id);
  return s.name;
}

/** 提前结束 */
export function endCheckin(u: User, id: number) {
  const c = checkinRow(u, id);
  if (!isTeacher(u)) throw notFound('这次签到不在了');
  db.run('UPDATE checkins SET ends_at=? WHERE id=? AND ends_at>?', now(), c.id, now());
}

/** 一门课最近一次签到（助教说「谁没签到」时用） */
export const latestCheckin = (teacherId: number, classId?: number | null) =>
  db.value<number>(`SELECT max(id) FROM checkins WHERE teacher_id=? ${classId ? 'AND class_id=?' : ''}`, ...(classId ? [teacherId, classId] : [teacherId])) ?? null;

/* ---------------- 选人 ---------------- */

/** 随机点一个这门课的学生：一轮里不重复，人点完了开新一轮；群里出一张卡 */
export function pickOne(u: User, classId: number) {
  const k = teachingClass(u, classId);
  const all = studentsOf(k.id);
  if (!all.length) throw conflict('这门课还没有学生');
  let round = db.value<number>('SELECT round FROM picks WHERE class_id=? ORDER BY id DESC LIMIT 1', k.id) ?? 1;
  const done = new Set(db.all<{ user_id: number }>('SELECT user_id FROM picks WHERE class_id=? AND round=?', k.id, round).map((p) => p.user_id));
  let pool = all.filter((s) => !done.has(s.user_id));
  if (!pool.length) {
    round++;
    pool = all;
  }
  const s = pool[randomInt(pool.length)];
  const id = db.insert('picks', { class_id: k.id, user_id: s.user_id, round, created_at: now() });
  say(groupOf(k.id).id, u.id, { kind: 'pick', text: s.name, refId: id });
  return pickView(u, id);
}

export function pickView(u: User, id: number) {
  const p = db.get<{ id: number; class_id: number; user_id: number; round: number; created_at: number; name: string }>(
    'SELECT p.*, c.name FROM picks p JOIN classes c ON c.id=p.class_id AND c.deleted_at IS NULL WHERE p.id=?',
    id,
  );
  if (!p || !memberOf(u, p.class_id)) throw notFound('不在了');
  const all = studentsOf(p.class_id);
  const done = db.value<number>('SELECT count(*) FROM picks WHERE class_id=? AND round=? AND id<=?', p.class_id, p.round, p.id) || 0;
  return {
    id: p.id,
    classId: p.class_id,
    className: p.name,
    name: all.find((s) => s.user_id === p.user_id)?.name || userName(p.user_id),
    round: p.round,
    left: Math.max(0, all.length - done),
    total: all.length,
    at: p.created_at,
  };
}

/* ---------------- 给助教的 ---------------- */

/** 每轮带给助教的：最近几天发的通知读了多少，正在签到的签了多少（事实，程序数的） */
export function messageFacts(teacherId: number): string | null {
  const t = now();
  const notices = db
    .all<NoticeRow>('SELECT * FROM notices WHERE teacher_id=? AND created_at>? AND recalled_at IS NULL ORDER BY id DESC LIMIT 3', teacherId, t - 3 * DAY)
    .map((n) => {
      const s = noticeStats(n);
      return `「${short(n.text)}」（发给${noticeClasses(n.id)
        .map((k) => k.name)
        .join('、')}，${showTime(n.created_at)}，读了 ${s.read}/${s.total}）`;
    });
  const open = db
    .all<CheckinRow & { name: string }>('SELECT k.*, c.name FROM checkins k JOIN classes c ON c.id=k.class_id WHERE k.teacher_id=? AND k.ends_at>? ORDER BY k.id', teacherId, t)
    .map((c) => {
      const signed = db.value<number>('SELECT count(*) FROM checkin_marks WHERE checkin_id=?', c.id) || 0;
      return `「${c.name}」签了 ${signed}/${studentsOf(c.class_id).length}，${showTime(c.ends_at).replace(/^.* /, '')} 结束`;
    });
  const lines = [notices.length ? `最近发的通知：${notices.join('；')}` : '', open.length ? `正在签到：${open.join('；')}` : ''].filter(Boolean);
  return lines.length ? `（${lines.join('。')}）` : null;
}
