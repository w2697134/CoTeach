import { useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';
import type { Deck, QType, Question, Slide } from '../prep/data';

/** 课堂的数据（跟后端 server/src/classroom/lecture.ts 一个样子） */

/** 一堂课：列表一行、页面头上 */
export interface LectureCard {
  id: number;
  classId: number;
  className: string;
  lessonId: number | null;
  title: string;
  status: 'live' | 'ended';
  startedAt: number;
  endedAt: number | null;
  attended: number;
  classSize: number;
  pushed: number;
  /** 下课小结里的正确率（能判对错的作答里答对的比例） */
  rate: number | null;
}

/** 选择题每个选项几个人选；判断题对、错各几个；填空写得最多的几种 */
export interface Bar {
  label: string;
  text?: string;
  count: number;
  right: boolean;
}
export interface Wrong {
  text: string;
  count: number;
  option?: string;
}
/** 老师看到的一道推了的题：题目（带答案）、几个人答、几个人对、每个人交的 */
export interface Pushed {
  id: number;
  n: number;
  source: string | null;
  status: 'open' | 'revealed';
  pushedAt: number;
  revealedAt: number | null;
  q: Question;
  answered: number;
  correct: number | null;
  bars: Bar[] | null;
  wrong: Wrong | null;
  answers: { name: string; text: string; correct: boolean | null; at: number }[];
}
export interface TeacherState {
  id: number;
  status: 'live' | 'ended';
  page: number;
  screen: number | null;
  startedAt: number;
  endedAt: number | null;
  attendance: { count: number; total: number; people: { id: number; name: string; at: number }[]; absent: string[] };
  questions: Pushed[];
  asks: { id: number; name: string; text: string; at: number }[];
  call: { id: number; name: string; round: number; at: number } | null;
}
export interface SummaryQuestion {
  id: number;
  n: number;
  type: QType;
  stem: string;
  answered: number;
  correct: number | null;
  rate: number | null;
  bars: Bar[] | null;
  wrong: Wrong | null;
}
export interface Summary {
  minutes: number;
  attended: number;
  classSize: number;
  absent: string[];
  rate: number | null;
  questions: SummaryQuestion[];
  asks: { name: string; text: string; at: number }[];
  calls: { name: string; at: number }[];
}
export interface LectureDetail {
  lecture: LectureCard;
  deck: Deck | null;
  practice: Question[];
  summary: Summary | null;
}

/** 学生看到的一道题：公布之前没有答案、解析和全班的情况 */
export interface StudentQuestion {
  id: number;
  n: number;
  type: QType;
  stem: string;
  code?: string;
  options?: string[];
  status: 'open' | 'revealed';
  pushedAt: number;
  mine: { choice?: number[]; text?: string; at: number } | null;
  answer?: string;
  choice?: number[];
  explain?: string;
  correct?: boolean | null;
  stats?: { answered: number; correct: number | null; bars: Bar[] | null };
}
export interface StudentState {
  id: number;
  classId: number;
  title: string;
  teacher: string;
  className: string;
  status: 'live' | 'ended';
  startedAt: number;
  endedAt: number | null;
  page: number;
  pages: number;
  theme: string | null;
  slide: Slide | null;
  questions: StudentQuestion[];
  asks: { id: number; text: string; at: number }[];
}
/** 学生那边：自己班正在上的课 */
export interface LiveItem {
  id: number;
  title: string;
  classId: number;
  className: string;
  teacher: string;
  startedAt: number;
}

export const useLectures = () => useQuery({ queryKey: ['lectures'], queryFn: () => get<{ live: LectureCard[]; past: LectureCard[] }>('/classroom') });

/** 正在上的课。老师：侧栏的小红点、备课页的「上课」；学生：学伴页顶上的卡片 */
export function useLiveLectures<T extends LectureCard | LiveItem>(enabled: boolean, every: number | false = false) {
  return useQuery({
    queryKey: ['lectures', 'live'],
    queryFn: () => get<{ live: T[] }>('/classroom/live'),
    enabled,
    refetchInterval: every,
  });
}

export const useLecture = (id: number) => useQuery({ queryKey: ['lecture', id], queryFn: () => get<LectureDetail>(`/classroom/${id}`), enabled: id > 0 });

/** 老师上课时约 1.5 秒刷一次；下课了就不刷 */
export const useLectureState = (id: number, enabled: boolean) =>
  useQuery({
    queryKey: ['lecture', id, 'state'],
    queryFn: () => get<TeacherState>(`/classroom/${id}/state`),
    enabled: enabled && id > 0,
    refetchInterval: (q) => (q.state.data?.status === 'ended' ? false : 1500),
  });

/** 学生上课时约 2 秒刷一次 */
export const useStudentLecture = (id: number) =>
  useQuery({
    queryKey: ['lecture', id, 'student'],
    queryFn: () => get<StudentState>(`/classroom/${id}/student`),
    enabled: id > 0,
    refetchInterval: (q) => (q.state.data?.status === 'ended' ? false : 2000),
  });

export const letter = (n: number) => String.fromCharCode(65 + n);
/** 选项原文常常自己带着「A. 」，前面已经有字母了，去掉免得写成「A A. [1, 2]」 */
export const optionText = (o: string, label: string) => (/^[A-H]$/.test(label) ? o.replace(new RegExp('^\\s*' + label + '\\s*[.．、:：)）]\\s*'), '') : o);
export const isChoice = (t: QType) => t === 'single' || t === 'multi';
/** 正确率写成「75%」 */
export const percent = (r: number | null | undefined) => (r === null || r === undefined ? '—' : `${Math.round(r * 100)}%`);
/** 上了多久：「12 分钟」「1 小时 5 分」 */
export function lasted(from: number, to: number) {
  const m = Math.max(to > from ? 1 : 0, Math.floor((to - from) / 60_000));
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
}
