import { LAYOUTS, type Deck, type Page, type Slide, type SlideLayout } from './types';
import { DEFAULT_THEME, THEMES } from './themes';
import { htmlHasAnswer, htmlKind, htmlTitle } from './html';

/** 网址是 http 的时候 crypto.randomUUID 用不了，自己拼一个 */
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const strs = (v: unknown) => (Array.isArray(v) ? v.map(str) : typeof v === 'string' && v ? [v] : []);

/** 新加一页的样子：字都空着，编辑时显示占位提示 */
export function blankSlide(layout: SlideLayout): Slide {
  const id = uid();
  switch (layout) {
    case 'cover':
    case 'section':
      return { id, layout, title: '', subtitle: '' };
    case 'points':
    case 'summary':
      return { id, layout, title: '', points: [''] };
    case 'code':
      return { id, layout, title: '', code: { lang: 'python', text: '' } };
    case 'compare':
      return { id, layout, title: '', compare: { left: { head: '', points: [''] }, right: { head: '', points: [''] } } };
    case 'steps':
      return { id, layout, title: '', steps: [{ head: '' }, { head: '' }, { head: '' }] };
    case 'quiz':
      return { id, layout, title: '', quiz: { question: '', options: ['', '', '', ''], answer: [0] } };
    case 'table':
      return { id, layout, title: '', table: { head: ['', '', ''], rows: [['', '', ''], ['', '', '']] } };
    case 'quote':
      return { id, layout, title: '', quote: { text: '', by: '' } };
  }
}

/** 选版式时预览用的样子 */
export function previewSlide(layout: SlideLayout): Slide {
  const id = `preview-${layout}`;
  switch (layout) {
    case 'cover':
      return { id, layout, title: '课程标题', subtitle: '第 1 讲 · 副标题' };
    case 'section':
      return { id, layout, title: '章节名称', subtitle: '这一部分讲什么' };
    case 'points':
      return { id, layout, title: '要点', points: ['第一条要点', '第二条要点', '第三条要点'] };
    case 'summary':
      return { id, layout, title: '小结', points: ['收获一', '收获二', '收获三', '收获四'] };
    case 'code':
      return {
        id,
        layout,
        title: '代码',
        code: { lang: 'python', text: 'def greet(name):\n    return f"你好，{name}"\n\nprint(greet("同学"))' },
      };
    case 'compare':
      return {
        id,
        layout,
        title: '对比',
        compare: { left: { head: '方案甲', points: ['特点一', '特点二'] }, right: { head: '方案乙', points: ['特点一', '特点二'] } },
      };
    case 'steps':
      return { id, layout, title: '步骤', steps: [{ head: '第一步' }, { head: '第二步' }, { head: '第三步' }] };
    case 'quiz':
      return { id, layout, title: '练习', quiz: { question: '下面哪一项是对的？', options: ['选项一', '选项二', '选项三', '选项四'], answer: [1] } };
    case 'table':
      return {
        id,
        layout,
        title: '表格',
        table: {
          head: ['名称', '作用', '例子'],
          rows: [
            ['甲', '说明', '示例'],
            ['乙', '说明', '示例'],
            ['丙', '说明', '示例'],
          ],
        },
      };
    case 'quote':
      return { id, layout, title: '', quote: { text: '一句值得记住的话', by: '出处' } };
  }
}

/* ---------------- 换版式：尽量把原来的内容搬过去 ---------------- */

/** 一页里的主要内容摊成一列字 */
function itemsOf(s: Slide): string[] {
  switch (s.layout) {
    case 'points':
    case 'summary':
      return s.points || [];
    case 'steps':
      return (s.steps || []).map((x) => (x.text ? `${x.head}：${x.text}` : x.head));
    case 'compare':
      return [...(s.compare?.left.points || []), ...(s.compare?.right.points || [])];
    case 'quiz':
      return s.quiz?.options || [];
    case 'table':
      return (s.table?.rows || []).map((r) => r.filter(Boolean).join('：'));
    case 'quote':
      return s.quote?.text ? [s.quote.text] : [];
    case 'code':
      return s.code?.caption ? [s.code.caption] : [];
    default:
      return s.subtitle ? [s.subtitle] : [];
  }
}

const splitHead = (t: string) => {
  const m = t.match(/^(.{1,24}?)[：:]\s*(.+)$/s);
  return m ? { head: m[1].trim(), text: m[2].trim() } : { head: t };
};

const KEEP: Record<SlideLayout, (keyof Slide)[]> = {
  cover: [],
  section: [],
  points: ['points'],
  summary: ['points'],
  code: ['code'],
  compare: ['compare'],
  steps: ['steps'],
  quiz: ['quiz'],
  table: ['table'],
  quote: ['quote'],
};
const CONTENT: (keyof Slide)[] = ['points', 'code', 'compare', 'steps', 'quiz', 'table', 'quote'];

export function adaptLayout(s: Slide, to: SlideLayout): Slide {
  if (s.layout === to) return s;
  const items = itemsOf(s).filter((t) => t.trim());
  const next: Slide = { ...s, layout: to };
  switch (to) {
    case 'points':
    case 'summary':
      next.points = s.points && (s.layout === 'points' || s.layout === 'summary') ? s.points : items.length ? items : [''];
      break;
    case 'steps':
      next.steps = items.length ? items.map(splitHead) : blankSlide('steps').steps;
      break;
    case 'compare': {
      if (s.layout === 'table' && s.table && s.table.head.length >= 2) {
        next.compare = {
          left: { head: s.table.head[0], points: s.table.rows.map((r) => r[0] || '').filter(Boolean) },
          right: { head: s.table.head[1], points: s.table.rows.map((r) => r[1] || '').filter(Boolean) },
        };
      } else {
        const half = Math.ceil(items.length / 2);
        next.compare = {
          left: { head: '', points: items.slice(0, half).length ? items.slice(0, half) : [''] },
          right: { head: '', points: items.slice(half).length ? items.slice(half) : [''] },
        };
      }
      break;
    }
    case 'quiz':
      next.quiz = { question: s.layout === 'cover' || s.layout === 'section' ? s.subtitle || '' : '', options: items.length >= 2 ? items.slice(0, 6) : ['', '', '', ''], answer: [0] };
      break;
    case 'table': {
      if (s.layout === 'compare' && s.compare) {
        const n = Math.max(s.compare.left.points.length, s.compare.right.points.length);
        next.table = {
          head: [s.compare.left.head, s.compare.right.head],
          rows: Array.from({ length: n }, (_, i) => [s.compare!.left.points[i] || '', s.compare!.right.points[i] || '']),
        };
      } else if (s.layout === 'steps' && s.steps) {
        next.table = { head: ['步骤', '说明'], rows: s.steps.map((x) => [x.head, x.text || '']) };
      } else if (items.length) {
        next.table = { head: ['', ''], rows: items.map((t) => { const h = splitHead(t); return [h.head, h.text || '']; }) };
      } else next.table = blankSlide('table').table;
      break;
    }
    case 'quote':
      next.quote = { text: items[0] || s.subtitle || '', by: '' };
      break;
    case 'code':
      next.code = { lang: 'python', text: '', caption: items[0] };
      if (!next.code.caption) delete next.code.caption;
      break;
    case 'cover':
    case 'section':
      if (!next.subtitle && items[0]) next.subtitle = items[0];
      break;
  }
  for (const k of CONTENT) if (!KEEP[to].includes(k)) delete next[k];
  return next;
}

/* ---------------- 读进来的数据收拾一下，缺的补上 ---------------- */

function normalizeSlide(raw: any): Slide | null {
  if (!raw || typeof raw !== 'object') return null;
  const layout: SlideLayout = LAYOUTS.includes(raw.layout) ? raw.layout : 'points';
  const s: Slide = { id: str(raw.id) || uid(), layout, title: str(raw.title) };
  if (typeof raw.html === 'string') s.html = raw.html;
  if (raw.subtitle !== undefined && raw.subtitle !== null) s.subtitle = str(raw.subtitle);
  if (raw.notes !== undefined && raw.notes !== null) s.notes = str(raw.notes);
  if (raw.points !== undefined) s.points = strs(raw.points);
  if (raw.code && typeof raw.code === 'object') {
    s.code = { lang: str(raw.code.lang) || 'python', text: str(raw.code.text).replace(/\r\n?/g, '\n').replace(/\t/g, '    ') };
    if (raw.code.caption) s.code.caption = str(raw.code.caption);
    if (Array.isArray(raw.code.mark)) s.code.mark = raw.code.mark.map(Number).filter((n: number) => Number.isInteger(n) && n > 0);
  }
  if (raw.compare && typeof raw.compare === 'object') {
    const side = (x: any) => ({ head: str(x?.head), points: strs(x?.points) });
    s.compare = { left: side(raw.compare.left), right: side(raw.compare.right) };
  }
  if (Array.isArray(raw.steps))
    s.steps = raw.steps.map((x: any) => (typeof x === 'string' ? splitHead(x) : { head: str(x?.head), ...(x?.text ? { text: str(x.text) } : {}) }));
  if (raw.quiz && typeof raw.quiz === 'object') {
    const options = strs(raw.quiz.options);
    const ans = (Array.isArray(raw.quiz.answer) ? raw.quiz.answer : [raw.quiz.answer])
      .map((a: unknown) => (typeof a === 'string' && /^[A-Za-z]$/.test(a) ? a.toUpperCase().charCodeAt(0) - 65 : Number(a)))
      .filter((n: number) => Number.isInteger(n) && n >= 0 && n < options.length);
    s.quiz = { question: str(raw.quiz.question), options, answer: [...new Set<number>(ans)].sort((a, b) => a - b) };
    if (raw.quiz.explain) s.quiz.explain = str(raw.quiz.explain);
  }
  if (raw.table && typeof raw.table === 'object') {
    const head = strs(raw.table.head);
    const rows: string[][] = Array.isArray(raw.table.rows) ? raw.table.rows.map(strs) : [];
    const n = Math.max(1, head.length, ...rows.map((r) => r.length));
    const pad = (r: string[]) => [...r, ...Array(n - r.length).fill('')];
    s.table = { head: pad(head), rows: rows.map(pad) };
  }
  if (raw.quote && typeof raw.quote === 'object') {
    s.quote = { text: str(raw.quote.text) };
    if (raw.quote.by) s.quote.by = str(raw.quote.by);
  } else if (typeof raw.quote === 'string') s.quote = { text: raw.quote };
  // 版式要的内容没给，补成空的，编辑时有占位
  const blank = blankSlide(layout);
  for (const k of KEEP[layout]) if (s[k] === undefined) (s as any)[k] = blank[k];
  return s;
}

export function normalizeDeck(raw: unknown): Deck {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  const theme = typeof r.theme === 'string' && THEMES.some((t) => t.id === r.theme) ? r.theme : DEFAULT_THEME;
  const seen = new Set<string>();
  const slides = (Array.isArray(r.slides) ? r.slides : []).map(normalizeSlide).filter(Boolean) as Slide[];
  for (const s of slides) {
    if (seen.has(s.id)) s.id = uid();
    seen.add(s.id);
  }
  return { theme, slides };
}

export const cloneSlide = (s: Slide): Slide => ({ ...structuredClone(s), id: uid() });

/** 第几个章节页（章节页上的大号数字） */
export function sectionNumbers(slides: Slide[]) {
  const m = new Map<string, number>();
  let n = 0;
  for (const s of slides) if (s.layout === 'section') m.set(s.id, ++n);
  return m;
}

/** 一页的标题：有 title 用 title，HTML 页从页面里找最像标题的字 */
export const slideTitle = (s: Slide) => s.title.trim() || (typeof s.html === 'string' ? htmlTitle(s.html) : '');

/** 这页有没有答案可以揭晓 */
export const hasAnswer = (s: Slide | undefined) =>
  !!s && (typeof s.html === 'string' ? htmlHasAnswer(s.html) : s.layout === 'quiz' && !!s.quiz?.answer.length);

/** 课件叫什么：封面的标题，没有封面用第一页的 */
export function deckTitle(deck: Deck) {
  const isCover = (x: Slide) => (typeof x.html === 'string' ? htmlKind(x.html) === 'cover' : x.layout === 'cover');
  const s = deck.slides.find((x) => isCover(x) && slideTitle(x)) || deck.slides.find((x) => slideTitle(x));
  return (s && slideTitle(s)) || '课件';
}

/** 放映、导出的每一页；练习页在 answers 时多一页揭晓答案 */
export function expandPages(deck: Deck, answers: boolean): Page[] {
  const out: Page[] = [];
  deck.slides.forEach((slide, index) => {
    out.push({ slide, index, revealed: false });
    if (answers && hasAnswer(slide)) out.push({ slide, index, revealed: true });
  });
  return out;
}

export const letter = (i: number) => String.fromCharCode(65 + i);
