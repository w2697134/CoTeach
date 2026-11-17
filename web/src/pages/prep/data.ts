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
  /** 做成幻灯片的这一页（照课件样式写的 HTML）；没有就按上面的内容和版式显示 */
  html?: string;
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
  /** 还在备的时候：写到一半的教案、课件、题目，做好了还没存进课件的幻灯片页（第几页 → HTML） */
  live: Live | null;
}
export interface Live {
  plan?: Partial<Plan>;
  slides?: Slide[];
  pages?: Record<string, string>;
  practice?: Question[];
  homework?: Question[];
  /** 还没动笔时在干什么：在翻知识库里的哪一份、在找什么 */
  activity?: string;
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

/** 正在做哪一手（列表卡片上写一句） */
export function doingNow(lanes: Partial<Record<LaneKey, Lane>>) {
  const at = (k: LaneKey) => lanes[k]?.status === 'doing';
  if (at('brief')) return '正在看这个班卡在哪';
  if (at('plan')) return '正在写教案';
  if (at('deck') && at('questions')) return '正在做课件、出题';
  if (at('deck')) return '正在做课件';
  if (at('questions')) return '正在出题';
  if (at('check')) return '正在核对';
  return '正在备';
}

/**
 * 备课页顶上那一句：助教跟老师说现在做到哪了，用「我」说，说具体的（写到哪个环节、第几页、出了几道）。
 */
export function doingLine(l: Lesson): string {
  const at = (k: LaneKey) => l.lanes[k]?.status === 'doing';
  const live = l.live || {};
  if (at('brief')) return '我先看看这个班最近的作业，大家卡在哪';
  if (at('plan')) {
    const steps = live.plan?.steps || [];
    const last = steps[steps.length - 1];
    if (last) return `教案写到「${last.name || `第 ${steps.length} 个环节`}」这一段了`;
    if (live.plan?.goals?.length) return '教案写到教学目标了';
    return live.activity || '我开始写教案了';
  }
  const parts: string[] = [];
  if (at('deck')) {
    const note = l.lanes.deck?.note || '';
    const refine = note.match(/精修 (\d+) 页/);
    if (!l.deck) {
      const s = live.slides || [];
      // 模型多半是想好了一口气写完（中间看不到写到哪页），只能说一般要多久
      parts.push(s.length ? `课件写到第 ${s.length} 页「${s[s.length - 1].title}」了` : live.activity || '课件我照着教案在写，这一步一般要两三分钟');
    } else if (refine) parts.push(`有 ${refine[1]} 页字太多，我在删减，细节挪进讲稿`);
    else {
      const total = l.deck.slides.length;
      const done = l.deck.slides.filter((s, i) => s.html || live.pages?.[i]).length;
      parts.push(done ? `课件排好 ${done} 页了，一共 ${total} 页` : `${total} 页课件写好了，我在一页页排版`);
    }
  }
  if (at('questions')) {
    const p = (l.practice || live.practice || []).length;
    const h = (l.homework || live.homework || []).length;
    parts.push(p || h ? `练习出好 ${p} 道、作业 ${h} 道了` : at('deck') ? '题目我也在出' : '题目我在出');
  }
  if (parts.length) return parts.join('；');
  if (at('check')) return '最后我把答案和代码再核对一遍，一般要两三分钟';
  return '正在备';
}
