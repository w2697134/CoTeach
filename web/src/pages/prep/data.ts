import { queryOptions, useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';

/** 备课的数据（跟后端 server/src/prep/lessons.ts 一个样子） */

export type SlideLayout = 'cover' | 'section' | 'points' | 'code' | 'compare' | 'steps' | 'quiz' | 'table' | 'quote' | 'summary';
export interface Slide {
  id: string;
  layout: SlideLayout;
  title: string;
  subtitle?: string;
  points?: string[];
  code?: { lang: string; text: string; caption?: string };
  compare?: { left: { head: string; points: string[] }; right: { head: string; points: string[] } };
  steps?: { head: string; text?: string }[];
  quiz?: { question: string; options: string[]; answer: number[]; explain?: string };
  table?: { head: string[]; rows: string[][] };
  quote?: { text: string; by?: string };
  notes?: string;
}
export interface Deck {
  theme: string;
  slides: Slide[];
}

export interface PlanStep {
  name: string;
  minutes: number | null;
  content: string;
}
export interface Plan {
  title: string;
  goals: string[];
  focus: string;
  hard: string;
  review: string;
  steps: PlanStep[];
  board?: string;
  sources: string[];
}

export type QType = 'single' | 'multi' | 'judge' | 'blank' | 'short' | 'code';
export const QTYPE_NAME: Record<QType, string> = { single: '单选', multi: '多选', judge: '判断', blank: '填空', short: '简答', code: '编程' };
export interface Question {
  id: string;
  type: QType;
  stem: string;
  code?: string;
  options?: string[];
  answer: string;
  choice?: number[];
  explain?: string;
  points?: number;
  rubric?: string;
}

export interface BriefPoint {
  title: string;
  what: string;
  teach: string;
  lost: number;
  asked: number;
  homework: string[];
}
export interface Brief {
  points: BriefPoint[];
  basis: { graded: number; asks: number } | null;
  updatedAt: number | null;
}

export type LaneKey = 'brief' | 'plan' | 'deck' | 'questions' | 'check';
export interface Lane {
  status: 'wait' | 'doing' | 'done' | 'error' | 'skip';
  note?: string;
  at?: number;
}
export const LANES: { key: LaneKey; name: string }[] = [
  { key: 'brief', name: '学情' },
  { key: 'plan', name: '教案' },
  { key: 'deck', name: '课件' },
  { key: 'questions', name: '练习和作业' },
  { key: 'check', name: '核对' },
];

export type Part = 'plan' | 'deck' | 'practice' | 'homework';
export const PART_NAME: Record<Part, string> = { plan: '教案', deck: '课件', practice: '课堂练习', homework: '课后作业' };

export interface LessonCard {
  id: number;
  classId: number;
  className: string;
  title: string;
  request: string | null;
  minutes: number | null;
  status: 'making' | 'ready' | 'error';
  error: string | null;
  lanes: Partial<Record<LaneKey, Lane>>;
  counts: { slides: number; practice: number; homework: number };
  cover: { theme: string; slide: Slide } | null;
  assignmentId: number | null;
  createdAt: number;
  updatedAt: number;
  making: boolean;
}
export interface Ask {
  id: number;
  message: string;
  status: 'running' | 'done' | 'error';
  reply: string | null;
  changed: Part[];
  error: string | null;
  at: number;
}
export interface Lesson extends LessonCard {
  brief: Brief | null;
  plan: Plan | null;
  deck: Deck | null;
  practice: Question[] | null;
  homework: Question[] | null;
  versions: Partial<Record<Part, { count: number; lastBy: 'teacher' | 'ta'; at: number }>>;
  asking: boolean;
  asks: Ask[];
}

export const useLessons = () =>
  useQuery({
    queryKey: ['lessons'],
    queryFn: () => get<{ lessons: LessonCard[] }>('/prep'),
    refetchInterval: (q) => (q.state.data?.lessons.some((l) => l.making) ? 3000 : false),
  });

export const lessonQuery = (id: number) =>
  queryOptions({
    queryKey: ['lesson', id],
    queryFn: () => get<{ lesson: Lesson }>(`/prep/${id}`),
    refetchInterval: (q) => {
      const l = q.state.data?.lesson;
      return l && (l.making || l.asking) ? 1500 : false;
    },
  });
export const useLesson = (id: number) => useQuery(lessonQuery(id));

/** 正在做哪一手（列表卡片上、页面顶上写一句） */
export function doingNow(lanes: Partial<Record<LaneKey, Lane>>) {
  const l = LANES.find((x) => lanes[x.key]?.status === 'doing');
  return l ? `在做${l.name}` : '在备';
}
