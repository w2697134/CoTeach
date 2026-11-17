/**
 * 班级、作业、课堂、学伴这几页用的字色。全站的绿、蓝、红、橙放在白底和浅色底上不到 4.5:1（绿 3.8、蓝 3.6、红 4.2），
 * 这里用深一档的；深色模式下底是黑的，照旧用亮的那一档。
 */
export const INK = {
  ok: 'text-[#047857] dark:text-[#34d399]',
  bad: 'text-[#b91c1c] dark:text-[#f87171]',
  info: 'text-[#0369a1] dark:text-[#38bdf8]',
  warn: 'text-[#b45309] dark:text-[#fbbf24]',
} as const;

/** 小标签：浅底 + 上面那档字色 */
export const CHIP = {
  ok: `bg-ok-soft ${INK.ok}`,
  bad: `bg-bad-soft ${INK.bad}`,
  info: `bg-info-soft ${INK.info}`,
  warn: `bg-warn-soft ${INK.warn}`,
  brand: 'bg-brand-soft text-brand-ink',
  gray: 'bg-surface-3 text-ink-2',
} as const;

/** 分数的颜色：不到六成写红的，别的照常 */
export const scoreInk = (score: number, points: number) => (points > 0 && score / points < 0.6 ? INK.bad : 'text-ink');
