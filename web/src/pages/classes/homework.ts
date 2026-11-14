import { useQuery } from '@tanstack/react-query';
import { api, get } from '../../lib/api';

/** 学生在一份作业上的状态：未交（截止前）、缺交（过了截止）、已交、迟交、已批、已退回 */
export type HwStatus = 'todo' | 'missing' | 'submitted' | 'late' | 'graded' | 'returned';
export interface HwFile {
  id: number;
  name: string;
  size: number;
}
export interface Homework {
  id: number;
  classId: number;
  title: string;
  body: string;
  points: number;
  dueAt: number | null;
  allowLate: boolean;
  publishAt: number;
  createdAt: number;
  /** 老师看到的 */
  submitted?: number;
  graded?: number;
  total?: number;
  /** 学生看到的 */
  status?: HwStatus;
  score?: number | null;
}
export interface Submission {
  text: string;
  submittedAt: number;
  late: boolean;
  score: number | null;
  comment: string | null;
  gradedAt: number | null;
  returnedAt: number | null;
  files: HwFile[];
}
export interface HomeworkDetail extends Homework {
  className: string;
  archived: boolean;
  files: HwFile[];
  /** 老师：班里每个学生交的情况 */
  students?: { id: number; studentNo: string; name: string; joined: boolean; status: HwStatus | null; submittedAt: number | null; late: boolean; score: number | null }[];
  /** 学生：自己交的、还能不能交 */
  mine?: Submission | null;
  lock?: string | null;
}
export interface StudentWork {
  id: number;
  studentNo: string;
  name: string;
  joined: boolean;
  status: HwStatus | null;
  submission: Submission | null;
}

export const useHomeworkList = (classId: number) =>
  useQuery({ queryKey: ['homework', 'class', classId], queryFn: () => get<{ homework: Homework[] }>(`/homework/class/${classId}`) });
export const useHomework = (id: number) => useQuery({ queryKey: ['homework', id], queryFn: () => get<HomeworkDetail>(`/homework/${id}`), enabled: id > 0 });

/** 传一个附件，拿到编号 */
export const uploadFile = (file: File) => api<HwFile>(`/homework/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
export const fileUrl = (f: HwFile, inline = false) => `/api/homework/files/${f.id}${inline ? '?inline=1' : ''}`;
export const canPreview = (name: string) => /\.(png|jpe?g|gif|webp|pdf)$/i.test(name);
export const isImage = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);

export const STATUS: Record<HwStatus, { label: string; tone: string }> = {
  todo: { label: '未交', tone: 'bg-surface-3 text-ink-3' },
  missing: { label: '缺交', tone: 'bg-bad-soft text-bad' },
  submitted: { label: '已交', tone: 'bg-info-soft text-info' },
  late: { label: '迟交', tone: 'bg-warn-soft text-warn' },
  graded: { label: '已批', tone: 'bg-ok-soft text-ok' },
  returned: { label: '已退回', tone: 'bg-warn-soft text-warn' },
};

/** 分数写成「8.5」「10」 */
export const num = (n: number) => String(Math.round(n * 10) / 10);

const pad = (n: number) => String(n).padStart(2, '0');
/** 时间写成「今天 23:59」「明天 08:00」「11月20日 23:59」，不是今年的带年份 */
export function when(t: number) {
  const d = new Date(t),
    today = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(today)) / 86_400_000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `明天 ${hm}`;
  if (diff === -1) return `昨天 ${hm}`;
  const md = `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return d.getFullYear() === today.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}
/** datetime-local 输入框用的「2026-11-20T23:59」和毫秒互换 */
export const toLocalInput = (t: number | null) => {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (s: string) => (s ? new Date(s).getTime() : null);
/** 文件大小写成「7 KB」「2.3 MB」 */
export const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** 成绩表：一行一个学生，一列一份已发布的作业；average 是百分制平均分 */
export interface Grades {
  homework: { id: number; title: string; points: number; dueAt: number | null }[];
  rows: { id: number; studentNo: string; name: string; joined: boolean; cells: Record<number, { status: HwStatus | null; score: number | null }>; average: number | null }[];
}
export const useGrades = (classId: number) => useQuery({ queryKey: ['homework', 'grades', classId], queryFn: () => get<Grades>(`/homework/class/${classId}/grades`) });
