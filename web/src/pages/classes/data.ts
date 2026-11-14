import { useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';

/** 老师看到的班带人数（已经加入的）、前几个学生（卡片上摆头像）和加课码，学生看到的班带老师 */
export interface ClassItem {
  id: number;
  name: string;
  count?: number;
  preview?: { id: number; name: string }[];
  teacher?: string;
  code?: string;
  joinOpen?: boolean;
  archived?: boolean;
  /** 学生：还要交几份作业；老师：交上来还没批的有几份 */
  todo?: number;
  pending?: number;
}
/** joined：学生自己用加课码加入了；inRoster：老师导的名单上有他；canReset：自己注册的账号，老师能帮他重置密码 */
export interface ClassStudent {
  id: number;
  studentNo: string;
  name: string;
  joined: boolean;
  inRoster: boolean;
  joinedAt?: number | null;
  canReset?: boolean;
}
export interface ClassDetail {
  id: number;
  name: string;
  /** 加课码、允许加入，只有老师看得到 */
  code?: string;
  joinOpen?: boolean;
  archived?: boolean;
  students?: ClassStudent[];
  teacher?: string;
  /** 学生看到的同学，只有名字 */
  classmates?: { id: number; name: string; me: boolean }[];
}
/** 输了加课码先看到的：哪个班、哪位老师、进不进得去 */
export interface ClassPeek {
  id: number;
  name: string;
  teacher: string;
  joined: boolean;
  open: boolean;
  archived: boolean;
}
/** 读名单文件：认出表头的直接给名单；认不出的给整张表，让老师选列 */
export type RosterRead =
  | { name: string | null; students: { studentNo: string; name: string }[]; unread: string[] }
  | { table: { rows: string[][]; noCol: number; nameCol: number } };

export const useClasses = () => useQuery({ queryKey: ['classes'], queryFn: () => get<{ classes: ClassItem[] }>('/classes') });
export const useClass = (id: number) => useQuery({ queryKey: ['class', id], queryFn: () => get<ClassDetail>(`/classes/${id}`) });

/** 名单放在框里是一行一个「学号 姓名」 */
export const rosterText = (list: { studentNo: string; name: string }[]) => list.map((s) => `${s.studentNo} ${s.name}`).join('\n');
export const rosterCount = (text: string) => text.split(/\r?\n/).filter((l) => l.trim()).length;
export const unreadNote = (lines: string[]) =>
  lines.length ? `这几行没认出来：${lines.slice(0, 5).map((l) => `「${l}」`).join('、')}${lines.length > 5 ? ` 等 ${lines.length} 行` : ''}` : '';
/** 跟服务器认学号的规矩一样：字母、数字、短横，至少带三位数字 */
export const looksNo = (s: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(s) && /\d{3}/.test(s);
/** 加课码：大写，去掉空格和短横 */
export const normalCode = (s: string) => s.toUpperCase().replace(/[\s-]/g, '');
/** 扫码、点链接打开的网址 */
export const joinLink = (code: string) => `${window.location.origin}/join/${code}`;
