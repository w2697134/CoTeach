import { Check } from 'lucide-react';
import { cn } from '../ui/cn';
import { HTML_TEMPLATES, type HtmlTemplate } from './kit';
import { previewSlide } from './model';
import { SlideView } from './Slide';
import { THEMES } from './themes';
import { LAYOUTS, LAYOUT_NAMES, type Slide, type SlideLayout } from './types';

/** 新建一页：每种样子用当前主题画一张小样（HTML 页） */
export function TemplateGrid({ theme, onPick }: { theme: string; onPick: (t: HtmlTemplate) => void }) {
  return (
    <div className="grid max-h-[min(560px,70vh)] w-[344px] grid-cols-2 gap-1 overflow-y-auto p-1">
      {HTML_TEMPLATES.map((t) => (
        <button key={t.id} type="button" onClick={() => onPick(t)} className="group rounded-md p-1.5 text-left transition-colors hover:bg-surface-3">
          <SlideView
            slide={{ id: `tpl-${t.id}`, layout: 'points', title: t.name, html: t.html }}
            theme={theme}
            width={152}
            className="rounded-[5px] ring-1 ring-line transition-shadow group-hover:ring-line-strong"
          />
          <span className="mt-1.5 block px-0.5 text-[13px] text-ink-2">{t.name}</span>
        </button>
      ))}
    </div>
  );
}

/** 选版式：每种版式用当前主题画一张小样 */
export function LayoutGrid({ theme, current, onPick }: { theme: string; current?: SlideLayout; onPick: (l: SlideLayout) => void }) {
  return (
    <div className="grid w-[332px] grid-cols-2 gap-1 p-1">
      {LAYOUTS.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => onPick(l)}
          className={cn(
            'group rounded-md p-1.5 text-left transition-colors hover:bg-surface-3',
            current === l && 'bg-brand-soft hover:bg-brand-soft',
          )}
        >
          <SlideView
            slide={previewSlide(l)}
            theme={theme}
            width={148}
            sectionNo={1}
            className={cn('rounded-[5px] ring-1 ring-line transition-shadow group-hover:ring-line-strong', current === l && 'ring-2 ring-brand group-hover:ring-brand')}
          />
          <span className={cn('mt-1.5 flex items-center gap-1 px-0.5 text-[13px] text-ink-2', current === l && 'font-medium text-brand-ink')}>
            {LAYOUT_NAMES[l]}
            {current === l && <Check className="size-3.5" />}
          </span>
        </button>
      ))}
    </div>
  );
}

/** 选主题：拿当前这页在每个主题下各画一张 */
export function ThemeGrid({ slide, current, onPick }: { slide: Slide; current: string; onPick: (id: string) => void }) {
  return (
    <div className="grid w-[460px] max-w-[calc(100vw-24px)] grid-cols-2 gap-1 p-1">
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onPick(t.id)}
          className={cn('group rounded-md p-1.5 text-left transition-colors hover:bg-surface-3', current === t.id && 'bg-brand-soft hover:bg-brand-soft')}
        >
          <SlideView
            slide={slide}
            theme={t.id}
            width={212}
            sectionNo={1}
            className={cn('rounded-[6px] ring-1 ring-line', current === t.id && 'ring-2 ring-brand')}
          />
          <span className="mt-2 flex items-center gap-2 px-0.5 text-[13.5px] text-ink">
            <span className="flex -space-x-1">
              {t.swatch.map((c, i) => (
                <span key={i} className="size-3.5 rounded-full ring-2 ring-surface" style={{ background: c }} />
              ))}
            </span>
            <span className={cn(current === t.id && 'font-medium text-brand-ink')}>{t.name}</span>
            {current === t.id && <Check className="ml-auto size-4 text-brand" />}
          </span>
        </button>
      ))}
    </div>
  );
}
