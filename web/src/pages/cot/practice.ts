import { num } from '../classes/homework';

/** 错题本里的一项：批好的作业上丢了分的那一项 */
export interface Mistake {
  no: number;
  title: string;
  got: number;
  max: number;
  why: string;
}

/** 「第3题（40分）之二：九九乘法表输出格式」只留冒号后面那截 */
export const shortItem = (t: string) => t.replace(/^.*?[：:]\s*/, '') || t;

/** 点「练一练」带到学伴那里的话：哪份作业哪一项、丢了几分、为什么，让它出一道类似的新题 */
export const practiceAsk = (homework: string, m: Pick<Mistake, 'title' | 'got' | 'max' | 'why'>) =>
  `练一练：「${homework}」的${m.title}我丢了 ${num(m.max - m.got)} 分，${m.why.replace(/\s+/g, ' ').slice(0, 200)}\n照这个出一道类似的新题给我练，我做完你帮我看对不对。`;

export const practiceLink = (homework: string, m: Pick<Mistake, 'title' | 'got' | 'max' | 'why'>) => `/cot?ask=${encodeURIComponent(practiceAsk(homework, m))}`;
