import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../../components/ui';

/**
 * 班级的配色，照课堂派的课程卡片：干净的斜向渐变，只带一点看不太出的浅色圆当底纹，字写在上面很清楚。
 * 班级页的大横幅右边再放一张同色系的插图（haovio 生的，跟登录页同一套画风）。
 */
export interface Theme {
  from: string;
  to: string;
  /** 白底上用的同色（小圆标里的字、成员页的标题） */
  ink: string;
  art: string;
}
const art = (name: string) => `/illustrations/classes/cover-${name}.webp`;
const THEMES: Theme[] = [
  { from: '#2f86f6', to: '#5db7ff', ink: '#2f7fe8', art: art('sky') },
  { from: '#1fb46f', to: '#2ec4b0', ink: '#18a566', art: art('mint') },
  { from: '#f6833b', to: '#f9c24b', ink: '#ec7631', art: art('peach') },
  { from: '#6c5ce7', to: '#5091f6', ink: '#6152e0', art: art('lavender') },
  { from: '#ee525f', to: '#f77fa2', ink: '#e64a58', art: art('peach') },
  { from: '#0fadaf', to: '#3fcac8', ink: '#0e9fa1', art: art('mint') },
];
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

/** 班级页顶上的横幅：渐变底，右边是插图（左边缘淡进底色），字写在左边 */
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
