import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { cn } from './cn';

const base =
  'w-full rounded-md border border-line bg-surface text-ink placeholder:text-ink-3 transition-[border-color,box-shadow] duration-150 hover:border-line-strong focus:border-brand focus:outline-none focus:shadow-[var(--ring)] disabled:opacity-60 disabled:bg-surface-2';

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode; suffix?: ReactNode; sizeVariant?: 'sm' | 'md' | 'lg' }
>(function Input({ className, icon, suffix, sizeVariant = 'md', ...rest }, ref) {
  const h = sizeVariant === 'sm' ? 'h-8 text-[14px]' : sizeVariant === 'lg' ? 'h-11 text-[16px]' : 'h-9 text-sm';
  if (!icon && !suffix) return <input ref={ref} className={cn(base, h, 'px-3', className)} {...rest} />;
  return (
    <div className={cn('relative flex items-center', className)}>
      {icon && <span className="pointer-events-none absolute left-3 text-ink-3 [&>svg]:size-4">{icon}</span>}
      <input ref={ref} className={cn(base, h, icon ? 'pl-9' : 'pl-3', suffix ? 'pr-10' : 'pr-3')} {...rest} />
      {suffix && <span className="absolute right-2 flex items-center text-ink-3">{suffix}</span>}
    </div>
  );
});

export function SearchInput({
  value,
  onChange,
  placeholder = '搜索…',
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Input
      icon={<Search />}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className={className}
      sizeVariant="sm"
      suffix={
        value ? (
          <button type="button" className="rounded p-0.5 hover:bg-surface-3" onClick={() => onChange('')} aria-label="清空">
            <X className="size-3.5" />
          </button>
        ) : null
      }
    />
  );
}

/** 自动增高的多行输入框 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { autoGrow?: boolean; maxRows?: number }>(
  function Textarea({ className, autoGrow, maxRows = 12, onInput, ...rest }, ref) {
    const inner = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => inner.current!);
    const resize = () => {
      const el = inner.current;
      if (!el || !autoGrow) return;
      el.style.height = 'auto';
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
      el.style.height = Math.min(el.scrollHeight, lh * maxRows + 20) + 'px';
    };
    useEffect(resize, [rest.value, autoGrow]);
    return (
      <textarea
        ref={inner}
        className={cn(base, 'px-3 py-2 text-sm leading-relaxed', autoGrow && 'resize-none overflow-y-auto', className)}
        onInput={e => {
          resize();
          onInput?.(e);
        }}
        {...rest}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { sizeVariant?: 'sm' | 'md' }>(function Select(
  { className, children, sizeVariant = 'md', ...rest },
  ref,
) {
  return (
    <div className={cn('relative', className)}>
      <select ref={ref} className={cn(base, 'appearance-none pl-3 pr-9', sizeVariant === 'sm' ? 'h-8 text-[14px]' : 'h-9 text-sm')} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
    </div>
  );
});

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
  extra,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
  extra?: ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {(label || extra) && (
        <div className="flex items-center justify-between gap-2">
          {label && (
            <label className="text-[14px] font-medium text-ink-2">
              {label}
              {required && <span className="ml-0.5 text-bad">*</span>}
            </label>
          )}
          {extra}
        </div>
      )}
      {children}
      {error ? <p className="text-[13px] text-bad">{error}</p> : hint ? <p className="text-[13px] leading-relaxed text-ink-3">{hint}</p> : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  size = 'md',
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  label?: string;
}) {
  const w = size === 'sm' ? 'w-8 h-[18px]' : 'w-10 h-[22px]';
  const k = size === 'sm' ? 'size-[14px]' : 'size-[18px]';
  const tx = size === 'sm' ? 'translate-x-[14px]' : 'translate-x-[18px]';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full p-[2px] transition-colors duration-200 disabled:opacity-50',
        w,
        checked ? 'bg-brand' : 'bg-line-strong',
      )}
    >
      <span className={cn('rounded-full bg-white shadow-sm transition-transform duration-200', k, checked ? tx : 'translate-x-0')} />
    </button>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  indeterminate,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  indeterminate?: boolean;
}) {
  return (
    <label className={cn('inline-flex cursor-pointer select-none items-center gap-2 text-sm', disabled && 'cursor-not-allowed opacity-60')}>
      <span
        className={cn(
          'flex size-4 items-center justify-center rounded-[5px] border transition-colors',
          checked || indeterminate ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface',
        )}
      >
        {indeterminate ? (
          <span className="h-0.5 w-2 rounded bg-white" />
        ) : checked ? (
          <svg viewBox="0 0 16 16" className="size-3">
            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </span>
      <input type="checkbox" className="sr-only" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  size = 'md',
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; icon?: ReactNode }[];
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div className={cn('inline-flex rounded-md bg-surface-3 p-[3px]', className)}>
      {options.map(o => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-[7px] font-medium transition-all',
            size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-8 px-3 text-[14px]',
            value === o.value ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}) {
  const p = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={e => onChange(Number(e.target.value))}
      className={cn('h-1.5 w-full cursor-pointer appearance-none rounded-full accent-[var(--c-primary)]', className)}
      style={{ background: `linear-gradient(90deg, var(--c-primary) ${p}%, var(--c-surface-3) ${p}%)` }}
    />
  );
}
