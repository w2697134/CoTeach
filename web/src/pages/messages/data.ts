import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';
import type { AskData } from '../assistant/cards';

/** 消息的数据（跟后端 server/src/messages/core.ts 一个样子） */

export interface ChatItem {
  id: number;
  kind: 'class' | 'dm';
  classId: number | null;
  title: string;
  /** recalled：最后一条是撤回了的通知（text 已经写成「你撤回了一条通知」，前面不加「我：」） */
  last: { text: string; at: number; mine: boolean; recalled?: boolean } | null;
  unread: number;
}
export interface ChatListData {
  inbox: { unread: number; last: { text: string; at: number } | null };
  chats: ChatItem[];
}
export interface FileRef {
  id: number;
  name: string;
  size: number;
}
export interface Message {
  id: number;
  kind: 'text' | 'file' | 'notice' | 'checkin' | 'pick';
  text: string;
  at: number;
  mine: boolean;
  from: { id: number; name: string; teacher: boolean };
  file: FileRef | null;
  ref: number | null;
  /** 通知卡：老师撤回了（摆一行灰字） */
  recalled?: boolean;
}
export interface Member {
  id: number;
  name: string;
  teacher: boolean;
}
export interface ChatData {
  chat: { id: number; kind: 'class' | 'dm'; classId: number | null; archived: boolean };
  messages: Message[];
  members?: Member[];
}
export interface InboxItem {
  id: number;
  kind: string;
  ref: number;
  title: string;
  body: string;
  link: string | null;
  at: number;
  read: boolean;
  done: boolean;
  /** 学生来问、助教提议分专门助手的卡片（在收件箱里就能答） */
  card?: AskData | null;
  live?: boolean;
  followup?: { status: string; reply: string | null; error: string | null } | null;
}
export interface NoticeData {
  id: number;
  text: string;
  at: number;
  teacher: string;
  classes: { id: number; name: string }[];
  files: FileRef[];
  /** 老师看的：读了几个、一共几个、没读的是谁（撤回了的不再算） */
  read?: number;
  total?: number;
  unread?: string[];
  /** 老师撤回了：学生那边 text 是空的 */
  recalled?: boolean;
}
export interface CheckinData {
  id: number;
  classId: number;
  className: string;
  startedAt: number;
  endsAt: number;
  open: boolean;
  /** 服务器的现在（倒计时照它校准，本机时钟不准也不怕） */
  now: number;
  /** 老师看的 */
  token?: string;
  total?: number;
  signed?: number;
  people?: { id: number; name: string; at: number | null; by: 'self' | 'teacher' | null }[];
  /** 学生看的：自己签了没有 */
  mine?: number | null;
}
export interface PickData {
  id: number;
  classId: number;
  className: string;
  name: string;
  round: number;
  left: number;
  total: number;
  at: number;
}

/** 会话列表：打开消息页时几秒刷一次 */
export const useChatList = (every: number | false = 5000) => useQuery({ queryKey: ['messages'], queryFn: () => get<ChatListData>('/messages'), refetchInterval: every });
/** 左边栏「消息」上的数 */
export const useUnread = (enabled: boolean) =>
  useQuery({ queryKey: ['messages', 'unread'], queryFn: () => get<{ count: number }>('/messages/unread'), enabled, refetchInterval: 15_000 });
export const useInbox = () => useQuery({ queryKey: ['inbox'], queryFn: () => get<{ items: InboxItem[] }>('/messages/inbox'), refetchInterval: 5000 });
/** 打开着的会话：三秒刷一次 */
export const useChat = (id: number) =>
  useQuery({ queryKey: ['chat', id], queryFn: () => get<ChatData>(`/messages/chats/${id}`), enabled: id > 0, refetchInterval: 3000 });
/** 通知卡：读了几个跟着变 */
export const useNotice = (id: number, classId?: number | null, every: number | false = 5000) =>
  useQuery({ queryKey: ['notice', id, classId ?? 0], queryFn: () => get<NoticeData>(`/messages/notices/${id}${classId ? `?class=${classId}` : ''}`), refetchInterval: every });
/** 签到卡：还在签的时候两秒刷一次 */
export const useCheckin = (id: number) =>
  useQuery({
    queryKey: ['checkin', id],
    queryFn: () => get<CheckinData>(`/messages/checkins/${id}`),
    refetchInterval: (q) => (q.state.data && !q.state.data.open ? false : 2000),
  });
export const usePick = (id: number) => useQuery({ queryKey: ['pick', id], queryFn: () => get<PickData>(`/messages/picks/${id}`), staleTime: Infinity });

export const checkinLink = (token: string) => `${window.location.origin}/checkin/${token}`;
/** 撤回了的通知留一行灰字（照微信） */
export const recallLine = (mine: boolean) => (mine ? '你撤回了一条通知' : '老师撤回了一条通知');
const pad = (n: number) => String(n).padStart(2, '0');
/** 倒计时的样子：04:36 */
export const mmss = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};
/** 几点几分：05:18 */
export const hhmm = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** 签到还剩多久：照服务器的时间往下数，一秒走一下 */
export function useLeft(c: CheckinData | undefined) {
  const [, tick] = useState(0);
  const skew = useRef(0);
  useEffect(() => {
    if (c) skew.current = c.now - Date.now();
  }, [c]);
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!c) return 0;
  return Math.max(0, c.endsAt - (Date.now() + skew.current));
}
/** 消息旁边的时间：今天只写几点，昨天写「昨天」，再早写日期（照微信） */
export function chatTime(t: number, full = false) {
  const d = new Date(t),
    now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return full ? `昨天 ${hm}` : '昨天';
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return full ? `${md} ${hm}` : md;
}
