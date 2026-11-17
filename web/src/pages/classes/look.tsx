import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../../components/ui';

/**
 * 班级的配色，照课堂派的课程卡片：干净的斜向渐变，只带一点看不太出的浅色圆当底纹，字写在上面很清楚。
 * 班级页的大横幅右边再放一张同色系的插图（haovio 生的，跟登录页同一套画风）。
 */
export interface Theme {
  from: string;
  to: string;
  /** 白底上用的同色（小圆标里的字、成员页的标题、作业卡片上的小方块）；都压到 4.5:1 以上，写成字也看得清 */
  ink: string;
  /** 深色模式下黑底上用的同色（亮一些，也在 4.5:1 以上） */
  light: string;
  art: string;
}
const art = (name: string) => `/illustrations/classes/cover-${name}.webp`;
const THEMES: Theme[] = [
  { from: '#2f86f6', to: '#5db7ff', ink: '#2a70cd', light: '#5db7ff', art: art('sky') },
  { from: '#1fb46f', to: '#2ec4b0', ink: '#138150', light: '#2ec4b0', art: art('mint') },
  { from: '#f6833b', to: '#f9c24b', ink: '#ae5724', light: '#f9c24b', art: art('peach') },
  { from: '#6c5ce7', to: '#5091f6', ink: '#6152e0', light: '#a5a8ff', art: art('lavender') },
  { from: '#ee525f', to: '#f77fa2', ink: '#c6404c', light: '#f77fa2', art: art('peach') },
  { from: '#0fadaf', to: '#3fcac8', ink: '#0b7d7e', light: '#3fcac8', art: art('mint') },
];

/**
 * 用这个班的颜色写字：浅色模式用 ink，深色模式换亮的 light。
 * 用法：className={THEME_TEXT} style={inkVars(theme)}
 */
export const THEME_TEXT = 'text-[var(--ink)] dark:text-[var(--ink-l)]';
export const inkVars = (t: Theme) => ({ '--ink': t.ink, '--ink-l': t.light }) as CSSProperties;
/** 每个班固定一种颜色，挨着放的几个班颜色不一样 */
export const themeOf = (classId: number) => THEMES[(classId - 1 + THEMES.length) % THEMES.length];

/** 渐变加两个很淡的白圆 */
export const themeBackground = (t: Theme): CSSProperties => ({
  backgroundImage: [
    'radial-gradient(circle at 88% 118%, rgba(255,255,255,.16) 0 34%, transparent 34.5%)',
    'radial-gradient(circle at 104% 6%, rgba(255,255,255,.12) 0 22%, transparent 22.5%)',
    `linear-gradient(135deg, ${t.from}, ${t.to})`,
  ].join(','),
});

/**
 * 班级页顶上的横幅：渐变底，右边是插图（左边缘淡进底色），字写在左边。
 * 左边压一层很淡的暗色，浅色的班（薄荷、橙、青）上白字也看得清。
 */
export function ThemeBanner({ theme, className, children }: { theme: Theme; className?: string; children?: ReactNode }) {
  return (
    <div className={cn('relative overflow-hidden text-white', className)} style={themeBackground(theme)}>
      <img
        src={theme.art}
        alt=""
        draggable={false}
        className="pointer-events-none absolute inset-y-0 right-0 h-full w-auto max-w-none select-none max-sm:opacity-40"
        style={{ maskImage: 'linear-gradient(to right, transparent, #000 50%)', WebkitMaskImage: 'linear-gradient(to right, transparent, #000 50%)' }}
      />
      <div className="pointer-events-none absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(15,23,42,.2) 0%, rgba(15,23,42,.08) 45%, transparent 70%)' }} />
      <div className="relative h-full">{children}</div>
    </div>
  );
}

/** 空着的时候：一张插图、一句话，可能带一个按钮 */
export function EmptyArt({ src, title, action }: { src: string; title: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <img src={src} alt="" draggable={false} className="size-36 select-none" />
      <p className="mt-2 text-[15px] text-ink-2">{title}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * 作业卡片左边的日子：几月、几号大字、下面一个字说是截止还是发布（像台历撕下来的一页）。
 * 过了的灰一点；soon：两天内截止，用这个班的颜色。
 */
export function DateBlock({ t, label, theme, soon, past }: { t: number | null; label: string; theme: Theme; soon?: boolean; past?: boolean }) {
  const d = t ? new Date(t) : null;
  return (
    <div
      className={cn('flex w-14 shrink-0 flex-col items-center self-start overflow-hidden rounded-lg border text-center leading-none', past ? 'border-line bg-surface-2' : 'border-transparent')}
      style={past ? undefined : { backgroundColor: `${theme.ink}14`, boxShadow: soon ? `0 0 0 2px ${theme.ink}40` : undefined }}
    >
      <span className="w-full py-1 text-[13px] font-medium text-white" style={{ backgroundColor: past ? '#64748b' : theme.ink }}>
        {d ? `${d.getMonth() + 1}月` : '不限'}
      </span>
      <span className={cn('pb-0.5 pt-1.5 text-[24px] font-semibold tabular-nums', past ? 'text-ink-2' : 'text-ink')}>{d ? d.getDate() : '—'}</span>
      <span className="pb-1.5 text-[13px] text-ink-2">{label}</span>
    </div>
  );
}
