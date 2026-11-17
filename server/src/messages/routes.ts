/**
 * 消息的接口（老师、学生都用）：会话列表和没读的数、收件箱、群和私聊里的消息、通知、签到、选人。
 * 谁能看什么、能办什么在 core.ts 里查：学生只看得到自己课的群和自己的私聊，通知、签到、选人只有这门课的老师能发起。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { audit, me, type AppEnv } from '../auth.js';
import { body, forbidden, intParam, rateLimit } from '../lib/http.js';
import {
  chatFor,
  chatList,
  checkinById,
  checkinByToken,
  checkinView,
  endCheckin,
  inboxOf,
  inboxRead,
  inboxReadAll,
  isTeacher,
  markCheckin,
  membersOf,
  messagesOf,
  noticeView,
  openDm,
  pickOne,
  pickView,
  recallNotice,
  remindNotice,
  send,
  sendNotice,
  signIn,
  startCheckin,
  unreadCount,
} from './core.js';

export const messageRoutes = new Hono<AppEnv>();

const teacher = (c: Parameters<typeof me>[0]) => {
  const u = me(c);
  if (!isTeacher(u)) throw forbidden();
  return u;
};

messageRoutes.get('/', (c) => c.json(chatList(me(c))));
messageRoutes.get('/unread', (c) => c.json({ count: unreadCount(me(c)) }));

/* ---------------- 收件箱 ---------------- */

messageRoutes.get('/inbox', (c) => c.json({ items: inboxOf(me(c)) }));
messageRoutes.post('/inbox/read', (c) => c.json({ changed: inboxReadAll(me(c)) }));
/** 点开一条算读了；done 是办完了，划掉 */
messageRoutes.post('/inbox/:id', async (c) => {
  const d = await body(c, z.object({ done: z.boolean().optional() }));
  inboxRead(me(c), intParam(c), !!d.done);
  return c.json({ ok: true });
});

/* ---------------- 群、私聊 ---------------- */

/** 打开一个会话：最近的消息（after 是只要这一条以后的），群还带上里面的人 */
messageRoutes.get('/chats/:id', (c) => {
  const u = me(c);
  const { chat, k } = chatFor(u, intParam(c));
  const after = Number(c.req.query('after') || 0) || 0;
  return c.json({
    chat: { id: chat.id, kind: chat.kind, classId: chat.class_id, archived: !!k?.archived_at },
    messages: messagesOf(u, chat, after),
    ...(after ? {} : { members: membersOf(chat) }),
  });
});
messageRoutes.post('/chats/:id', async (c) => {
  const u = me(c);
  rateLimit(`chat:${u.id}`, 40, 60_000);
  const d = await body(c, z.object({ text: z.string().max(4000).optional(), fileId: z.number().int().positive().nullable().optional() }));
  return c.json({ id: send(u, intParam(c), d) });
});
/** 跟一个人私聊：有了就打开，没有就开一个 */
messageRoutes.post('/dm', async (c) => {
  const d = await body(c, z.object({ userId: z.number().int().positive() }));
  return c.json({ id: openDm(me(c), d.userId).id });
});

/* ---------------- 通知 ---------------- */

messageRoutes.post('/notices', async (c) => {
  const u = teacher(c);
  rateLimit(`notice:${u.id}`, 20, 60_000);
  const d = await body(
    c,
    z.object({ classIds: z.array(z.number().int().positive()).min(1).max(20), text: z.string().max(4000), fileIds: z.array(z.number().int().positive()).max(10).optional() }),
  );
  const id = sendNotice(u, d.classIds, d.text, d.fileIds || []);
  audit(c, 'notice.send', `notice:${id}`, { classIds: d.classIds });
  return c.json({ id });
});
/** 看一条通知（学生点开就算读了）；class 是只算这门课的人（群里的卡片用） */
messageRoutes.get('/notices/:id', (c) => c.json(noticeView(me(c), intParam(c), Number(c.req.query('class') || 0) || null)));
messageRoutes.post('/notices/:id/remind', (c) => {
  const u = teacher(c);
  rateLimit(`remind:${u.id}`, 10, 60_000);
  return c.json(remindNotice(u, intParam(c)));
});
/** 撤回（发的老师才能撤）：群里留一行「老师撤回了一条通知」，学生收件箱里那一条去掉 */
messageRoutes.post('/notices/:id/recall', (c) => {
  const u = teacher(c);
  const id = intParam(c);
  recallNotice(u, id);
  audit(c, 'notice.recall', `notice:${id}`);
  return c.json({ ok: true });
});

/* ---------------- 签到 ---------------- */

messageRoutes.post('/checkins', async (c) => {
  const u = teacher(c);
  const d = await body(c, z.object({ classId: z.number().int().positive(), minutes: z.number().int().min(1).max(120).optional() }));
  const id = startCheckin(u, d.classId, d.minutes ?? 5);
  audit(c, 'checkin.start', `checkin:${id}`, { classId: d.classId });
  return c.json({ id });
});
messageRoutes.get('/checkins/:id', (c) => c.json(checkinView(me(c), intParam(c))));
/** 学生点卡片上的「签到」 */
messageRoutes.post('/checkins/:id/sign', (c) => {
  const u = me(c);
  signIn(u, checkinById(u, intParam(c)));
  return c.json({ ok: true });
});
/** 扫二维码、打开签到链接（链接里是这串，只在签到时间里有效） */
messageRoutes.post('/checkin-links/:token', (c) => {
  const u = me(c);
  rateLimit(`checkin-link:${u.id}`, 30, 60_000);
  const k = checkinByToken(c.req.param('token'));
  signIn(u, k);
  return c.json({ id: k.id, className: k.name });
});
/** 老师补签 */
messageRoutes.post('/checkins/:id/mark', async (c) => {
  const d = await body(c, z.object({ userId: z.number().int().positive() }));
  return c.json({ name: markCheckin(teacher(c), intParam(c), d.userId) });
});
messageRoutes.post('/checkins/:id/end', (c) => {
  endCheckin(teacher(c), intParam(c));
  return c.json({ ok: true });
});

/* ---------------- 选人 ---------------- */

messageRoutes.post('/picks', async (c) => {
  const u = teacher(c);
  const d = await body(c, z.object({ classId: z.number().int().positive() }));
  return c.json(pickOne(u, d.classId));
});
messageRoutes.get('/picks/:id', (c) => c.json(pickView(me(c), intParam(c))));
