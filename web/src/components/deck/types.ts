/**
 * 课件数据：后端照这个格式生成，前端照它渲染、编辑、放映、导出。
 * 每页有 html（模型照 SLIDE_KIT_GUIDE 写的一页 HTML）就按 html 显示；没有 html 的老数据按 layout 版式渲染。
 * 跟最早的约定比多了：html、code.mark（版式页里要突出的行号，从 1 开始）。
 */
export type SlideLayout = 'cover' | 'section' | 'points' | 'code' | 'compare' | 'steps' | 'quiz' | 'table' | 'quote' | 'summary';

export interface Slide {
  id: string;
  layout: SlideLayout;
  title: string;
  /** 一页的 HTML 片段（根元素 <div class="slide">，画布 1280×720）。有它就不看 layout 和下面的版式字段 */
  html?: string;
  subtitle?: string;
  points?: string[];
  code?: { lang: string; text: string; caption?: string; mark?: number[] };
  compare?: { left: { head: string; points: string[] }; right: { head: string; points: string[] } };
  steps?: { head: string; text?: string }[];
  quiz?: { question: string; options: string[]; answer: number[]; explain?: string };
  table?: { head: string[]; rows: string[][] };
  quote?: { text: string; by?: string };
  /** 讲稿 */
  notes?: string;
}

export interface Deck {
  theme: string;
  slides: Slide[];
}

export const LAYOUTS: SlideLayout[] = ['cover', 'section', 'points', 'code', 'compare', 'steps', 'quiz', 'table', 'quote', 'summary'];

export const LAYOUT_NAMES: Record<SlideLayout, string> = {
  cover: '封面',
  section: '章节',
  points: '要点',
  code: '代码',
  compare: '对比',
  steps: '步骤',
  quiz: '练习',
  table: '表格',
  quote: '引用',
  summary: '小结',
};

/** 放映、导出时一页可以有两种样子：练习页先出题，再揭晓答案 */
export interface Page {
  slide: Slide;
  index: number;
  revealed: boolean;
}
