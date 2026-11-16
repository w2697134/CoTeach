import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Info, Loader2, XCircle } from 'lucide-react';
import { cn } from './cn';

/* ---------------- Card ---------------- */
export function Card({
  className,
  children,
  hover,
  padded = true,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { hover?: boolean; padded?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-lg border border-line bg-surface shadow-xs',
        padded && 'p-6',
        hover && 'transition-all duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** 板块标题：只显示标题本身；desc / icon 保留参数以兼容调用处，但不再渲染（界面不写解释性小字） */
export function CardHeader({
  title,
  actions,
  className,
}: {
  title: ReactNode;
  desc?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-3 flex flex-wrap items-center justify-between gap-3', className)}>
      <h3 className="min-w-0 truncate text-[16px] font-semibold leading-tight text-ink">{title}</h3>
      {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ---------------- Badge ---------------- */
type Tone = 'gray' | 'brand' | 'ok' | 'warn' | 'bad' | 'info' | 'violet' | 'teal' | 'amber' | 'rose';
const tones: Record<Tone, string> = {
  gray: 'bg-surface-3 text-ink-2',
  brand: 'bg-brand-soft text-brand-ink',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
  violet: 'bg-violet-500/12 text-violet-600 dark:text-violet-300',
  teal: 'bg-teal-500/12 text-teal-700 dark:text-teal-300',
  amber: 'bg-amber-500/14 text-amber-700 dark:text-amber-300',
  rose: 'bg-rose-500/12 text-rose-600 dark:text-rose-300',
};

export function Badge({
  tone = 'gray',
  children,
  className,
  dot,
  icon,
  style,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
  icon?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <span
      style={style}
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[13px] font-medium [&>svg]:size-3.5',
        tones[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {icon}
      {children}
    </span>
  );
}

/* ---------------- Spinner / Skeleton ---------------- */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-ink-3', className)}>
      <Loader2 className="size-4 animate-spin" />
      {label && <span className="text-sm">{label}</span>}
    </span>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cn('skeleton', className)} style={style} />;
}

export function PageLoading({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="flex h-[50vh] items-center justify-center">
      <Spinner label={label} />
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const denied = (error as { status?: number })?.status === 403;
  const missing = (error as { status?: number })?.status === 404;
  return (
    <div className="flex h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-bad-soft text-bad">
        <XCircle className="size-6" />
      </div>
      <p className="text-[16px] font-medium text-ink">{denied ? '没有访问权限' : missing ? '内容已不存在' : '加载失败'}</p>
      {!denied && <p className="max-w-sm text-[14px] text-ink-3">{(error as Error)?.message || '请稍后重试'}</p>}
      {onRetry && !denied && !missing && (
        <button onClick={onRetry} className="mt-1 rounded-md border border-line px-4 py-1.5 text-sm text-ink-2 hover:bg-surface-3">
          重试
        </button>
      )}
      {(denied || missing) && (
        <a href="/knowledge" className="text-brand">
          返回知识库
        </a>
      )}
    </div>
  );
}

/* ---------------- Empty ---------------- */
/** 空白状态：一句话 + 可选的一个按钮；desc / image 不再渲染 */
export function Empty({
  icon,
  title,
  desc,
  action,
  className,
  compact,
}: {
  icon?: ReactNode;
  title: ReactNode;
  desc?: ReactNode;
  action?: ReactNode;
  className?: string;
  image?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'gap-2 py-8' : 'gap-3 py-14', className)}>
      {icon && <div className="text-ink-3 [&>svg]:size-6">{icon}</div>}
      <p className="text-[15px] text-ink-2">{title}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/* ---------------- Alert ---------------- */
export function Alert({
  tone = 'info',
  title,
  children,
  className,
  icon,
}: {
  tone?: 'info' | 'ok' | 'warn' | 'bad' | 'brand';
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  icon?: ReactNode;
}) {
  const map = {
    info: ['bg-info-soft', 'text-info', <Info key="i" />],
    ok: ['bg-ok-soft', 'text-ok', <CheckCircle2 key="o" />],
    warn: ['bg-warn-soft', 'text-warn', <AlertTriangle key="w" />],
    bad: ['bg-bad-soft', 'text-bad', <XCircle key="b" />],
    brand: ['bg-brand-soft', 'text-brand-ink', <Info key="br" />],
  } as const;
  const [bg, fg, defIcon] = map[tone];
  return (
    <div className={cn('flex gap-2.5 rounded-md px-3.5 py-3 text-[14px] leading-relaxed', bg, className)}>
      <span className={cn('mt-0.5 shrink-0 [&>svg]:size-4', fg)}>{icon ?? defIcon}</span>
      <div className="min-w-0 text-ink-2">
        {title && <p className={cn('mb-0.5 font-medium', fg)}>{title}</p>}
        {children}
      </div>
    </div>
  );
}

/* ---------------- Progress ---------------- */
export function Progress({
  value,
  className,
  color,
  height = 6,
  track,
}: {
  value: number;
  className?: string;
  color?: string;
  height?: number;
  track?: string;
}) {
  const v = Math.max(0, Math.min(1, value || 0));
  return (
    <div className={cn('w-full overflow-hidden rounded-full', className)} style={{ height, background: track || 'var(--c-surface-3)' }}>
      <div
        className="h-full rounded-full transition-[width] duration-700 ease-out"
        style={{
          width: `${v * 100}%`,
          background: color || 'var(--c-primary)',
        }}
      />
    </div>
  );
}

/* ---------------- Kbd / Divider ---------------- */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-surface-2 px-1 font-mono text-[12.5px] text-ink-3">
      {children}
    </kbd>
  );
}

export function Divider({ className, label }: { className?: string; label?: ReactNode }) {
  if (!label) return <div className={cn('h-px w-full bg-line', className)} />;
  return (
    <div className={cn('flex items-center gap-3 text-[13px] text-ink-3', className)}>
      <div className="h-px flex-1 bg-line" />
      {label}
      <div className="h-px flex-1 bg-line" />
    </div>
  );
}

/* ---------------- PageHeader ---------------- */
/** 页面标题：标题 + 操作按钮；desc / icon 不再渲染 */
export function PageHeader({
  title,
  actions,
  back,
  className,
  meta,
}: {
  title: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  back?: ReactNode;
  className?: string;
  meta?: ReactNode;
}) {
  return (
    <div className={cn('mb-5 flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="min-w-0">
        {back && <div className="mb-2">{back}</div>}
        <h1 className="truncate text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {meta && <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ---------------- Stat tile ---------------- */
/** 数字卡片：名称 + 数字（+ 变化量）；hint / icon 不再渲染 */
export function Stat({
  label,
  value,
  unit,
  delta,
  deltaGood,
  spark,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  delta?: string | null;
  deltaGood?: boolean;
  hint?: ReactNode;
  icon?: ReactNode;
  spark?: ReactNode;
  className?: string;
  accent?: string;
}) {
  return (
    <Card className={cn('relative overflow-hidden', className)}>
      <p className="text-[14px] text-ink-2">{label}</p>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="text-[28px] font-semibold leading-none tracking-tight text-ink">{value}</span>
        {unit && <span className="text-sm text-ink-3">{unit}</span>}
        {delta && (
          <span className={cn('ml-2 text-[13px] font-medium', deltaGood === undefined ? 'text-ink-2' : deltaGood ? 'text-ok' : 'text-bad')}>
            {delta}
          </span>
        )}
      </div>
      {spark && <div className="mt-3">{spark}</div>}
    </Card>
  );
}

/* ---------------- Tabs ---------------- */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
  className,
  variant = 'line',
  end,
}: {
  value: T;
  onChange: (v: T) => void;
  items: {
    value: T;
    label: ReactNode;
    icon?: ReactNode;
    count?: number | null;
  }[];
  className?: string;
  variant?: 'line' | 'pill' | 'page';
  /** page 那种分栏右边摆的按钮（这一栏的事：布置作业、导出 Excel、邀请学生） */
  end?: ReactNode;
}) {
  if (variant === 'page') {
    // 一个页面的几大块（班级页：作业、学情、成绩、成员）：字大一号、隔得开些，这一栏要做的事摆在右边，不另起一行
    return (
      <div className={cn('flex items-center gap-4 border-b border-line', className)}>
        <div className="no-scrollbar -mb-px flex min-w-0 flex-1 gap-8 self-end overflow-x-auto">
          {items.map((it) => (
            <button
              key={it.value}
              type="button"
              onClick={() => onChange(it.value)}
              className={cn(
                'relative inline-flex shrink-0 items-center gap-2 border-b-2 pb-3 pt-1 text-[16px] font-medium transition-colors [&>svg]:size-[18px]',
                value === it.value ? 'border-brand text-ink' : 'border-transparent text-ink-3 hover:text-ink-2',
              )}
            >
              {it.icon}
              {it.label}
              {it.count !== undefined && it.count !== null && (
                <span className={cn('rounded-full px-1.5 text-[12.5px] leading-4', value === it.value ? 'bg-brand-soft text-brand-ink' : 'bg-surface-3 text-ink-3')}>
                  {it.count}
                </span>
              )}
            </button>
          ))}
        </div>
        {end && <div className="flex shrink-0 items-center gap-2 pb-2">{end}</div>}
      </div>
    );
  }
  if (variant === 'pill') {
    return (
      <div className={cn('flex flex-wrap gap-1.5', className)}>
        {items.map((it) => (
          <button
            key={it.value}
            type="button"
            onClick={() => onChange(it.value)}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[14px] font-medium transition-colors [&>svg]:size-4',
              value === it.value ? 'bg-ink text-surface' : 'bg-surface text-ink-2 ring-1 ring-line hover:text-ink hover:ring-line-strong',
            )}
          >
            {it.icon}
            {it.label}
            {it.count !== undefined && it.count !== null && (
              <span className={cn('text-[13px]', value === it.value ? 'opacity-70' : 'text-ink-3')}>{it.count}</span>
            )}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className={cn('no-scrollbar flex gap-6 overflow-x-auto border-b border-line', className)}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          onClick={() => onChange(it.value)}
          className={cn(
            'relative -mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 pb-2.5 pt-1 text-sm font-medium transition-colors [&>svg]:size-4',
            value === it.value ? 'border-brand text-ink' : 'border-transparent text-ink-3 hover:text-ink-2',
          )}
        >
          {it.icon}
          {it.label}
          {it.count !== undefined && it.count !== null && (
            <span
              className={cn(
                'rounded-full px-1.5 text-[12.5px] leading-4',
                value === it.value ? 'bg-brand-soft text-brand-ink' : 'bg-surface-3 text-ink-3',
              )}
            >
              {it.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Clamp：超出高度时折叠，底部渐隐并提供展开按钮 ---------------- */
export function Clamp({
  children,
  max = 180,
  className,
  moreText = '展开全部',
  lessText = '收起',
}: {
  children: ReactNode;
  max?: number;
  className?: string;
  moreText?: string;
  lessText?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOver(el.scrollHeight > max + 24);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [max]);
  return (
    <div className={className}>
      <div className="relative">
        <div
          ref={ref}
          className="overflow-hidden transition-[max-height] duration-300"
          style={{ maxHeight: open || !over ? undefined : max }}
        >
          {children}
        </div>
        {over && !open && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-surface to-transparent" />
        )}
      </div>
      {over && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline"
        >
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
          {open ? lessText : moreText}
        </button>
      )}
    </div>
  );
}
