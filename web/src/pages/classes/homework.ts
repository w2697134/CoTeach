import { useQuery } from '@tanstack/react-query';
import { api, get } from '../../lib/api';
import { CHIP } from './tone';

/** 学生在一份作业上的状态：未交（截止前）、缺交（过了截止）、已交、迟交、已批、已退回 */
export type HwStatus = 'todo' | 'missing' | 'submitted' | 'late' | 'graded' | 'returned';
export interface HwFile {
  id: number;
  name: string;
  size: number;
}
/** 批改方式：助教批完直接发、助教批完老师看过再发、老师自己批 */
export type AiMode = 'release' | 'hold' | 'off';
export const AI_MODES: { value: AiMode; label: string }[] = [
  { value: 'release', label: '助教批，批完直接发' },
  { value: 'hold', label: '助教批，我看过再发' },
  { value: 'off', label: '我自己批' },
];
/** 评分标准的一项（只有老师看得到） */
export interface RubricItem {
  title: string;
  points: number;
  criteria: string;
  answer: string;
}
export interface Rubric {
  items: RubricItem[];
  source: 'ai' | 'teacher';
  status: 'drafting' | 'ready' | 'error';
  error: string | null;
  updatedAt: number;
}
/** 批出来的一项 */
export interface GradeItem {
  title: string;
  max: number;
  got: number;
  why: string;
}
/** 批注：批改稿里 start 到 end 那一段（找不到原文是 -1） */
export interface Mark {
  quote: string;
  kind: 'wrong' | 'good';
  note: string;
  start: number;
  end: number;
}
/** 助教对一份的批改 */
export interface AiGrade {
  id: number;
  status: 'queued' | 'running' | 'done' | 'error';
  score: number | null;
  items: GradeItem[];
  marks: Mark[];
  comment: string | null;
  flag: string | null;
  workText: string | null;
  released: boolean;
  error: string | null;
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
  aiMode?: AiMode;
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
  /** 发出去的批改：谁批的、每项、批注和批改稿 */
  gradedBy?: 'ai' | 'teacher' | null;
  items?: GradeItem[];
  marks?: Mark[];
  workText?: string | null;
  /** 学生：助教正在批 */
  grading?: boolean;
  /** 老师：采用的是助教哪一次批的 */
  aiGradeId?: number | null;
}
/** 发给学生的讲评（不带名字） */
export interface StudentReview {
  summary: string;
  errors: { title: string; why: string; n: number }[];
  avg: number | null;
  points: number | null;
  sharedAt: number;
}
export interface HomeworkDetail extends Homework {
  className: string;
  archived: boolean;
  files: HwFile[];
  /** 老师：班里每个学生交的情况 */
  students?: {
    id: number;
    studentNo: string;
    name: string;
    joined: boolean;
    status: HwStatus | null;
    submittedAt: number | null;
    late: boolean;
    score: number | null;
    gradedBy: 'ai' | 'teacher' | null;
    ai: { status: AiGrade['status']; score: number | null; flag: string | null; released: boolean; error: string | null } | null;
  }[];
  rubric?: Rubric | null;
  /** 老师：交给了哪个专门助手批（助教分出来的） */
  specialist?: { id: number; name: string; avatar: string } | null;
  /** 正在批几份 */
  grading?: number;
  review?: { status: 'writing' | 'ready' | 'error'; shared: boolean } | null;
  /** 学生：自己交的、还能不能交 */
  mine?: Submission | null;
  lock?: string | null;
  /** 学生：老师发了的讲评 */
  studentReview?: StudentReview | null;
}
export interface StudentWork {
  id: number;
  studentNo: string;
  name: string;
  joined: boolean;
  status: HwStatus | null;
  submission: Submission | null;
  ai: AiGrade | null;
}

export const useHomeworkList = (classId: number) =>
  useQuery({ queryKey: ['homework', 'class', classId], queryFn: () => get<{ homework: Homework[] }>(`/homework/class/${classId}`) });
/** 助教在批、在拟评分标准、在写讲评时隔两秒半刷一次 */
const busy = (h?: HomeworkDetail) => !!h && (!!h.grading || h.rubric?.status === 'drafting' || h.review?.status === 'writing' || !!h.mine?.grading);
export const useHomework = (id: number) =>
  useQuery({
    queryKey: ['homework', id],
    queryFn: () => get<HomeworkDetail>(`/homework/${id}`),
    enabled: id > 0,
    // 老师开着作业页：学生随时会交，隔一会儿也刷一次
    refetchInterval: (q) => (busy(q.state.data) ? 2500 : q.state.data?.students ? 15_000 : false),
  });

/** 传一个附件，拿到编号 */
export const uploadFile = (file: File) => api<HwFile>(`/homework/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
export const fileUrl = (f: HwFile, inline = false) => `/api/homework/files/${f.id}${inline ? '?inline=1' : ''}`;
export const canPreview = (name: string) => /\.(png|jpe?g|gif|webp|pdf)$/i.test(name);
export const isImage = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);

export const STATUS: Record<HwStatus, { label: string; tone: string }> = {
  todo: { label: '未交', tone: CHIP.gray },
  missing: { label: '缺交', tone: CHIP.bad },
  submitted: { label: '已交', tone: CHIP.info },
  late: { label: '迟交', tone: CHIP.warn },
  graded: { label: '已批', tone: CHIP.ok },
  returned: { label: '已退回', tone: CHIP.warn },
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
