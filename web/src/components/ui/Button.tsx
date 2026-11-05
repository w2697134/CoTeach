import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'soft' | 'danger' | 'outline' | 'gradient';
type Size = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  block?: boolean;
}

const variants: Record<Variant, string> = {
  primary: 'bg-brand text-white shadow-xs hover:bg-brand-hover active:translate-y-px',
  // 历史名称保留，外观与主按钮一致（不用渐变）
  gradient: 'bg-brand text-white shadow-xs hover:bg-brand-hover active:translate-y-px',
  secondary: 'bg-surface text-ink border border-line shadow-xs hover:bg-surface-2 hover:border-line-strong',
  outline: 'border border-line text-ink-2 hover:text-ink hover:border-line-strong hover:bg-surface-2',
  ghost: 'text-ink-2 hover:text-ink hover:bg-surface-3',
  soft: 'bg-brand-soft text-brand-ink hover:brightness-95 dark:hover:brightness-125',
  danger: 'bg-bad text-white hover:brightness-110',
};

const sizes: Record<Size, string> = {
  xs: 'h-7 px-2.5 text-[13px] gap-1 rounded-sm',
  sm: 'h-8 px-3 text-[14px] gap-1.5 rounded-sm',
  md: 'h-9 px-4 text-sm gap-2 rounded-md',
  lg: 'h-11 px-5 text-[16px] gap-2 rounded-lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, iconRight, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center font-medium whitespace-nowrap transition-all duration-150 disabled:opacity-55 disabled:pointer-events-none',
        variants[variant],
        sizes[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
      {iconRight}
    </button>
  );
});

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { size?: 'sm' | 'md' | 'lg'; active?: boolean; label?: string }
>(function IconButton({ size = 'md', active, label, className, children, type = 'button', ...rest }, ref) {
  const s = size === 'sm' ? 'size-7 rounded-sm' : size === 'lg' ? 'size-10 rounded-lg' : 'size-8 rounded-md';
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center justify-center text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-40',
        s,
        active && 'bg-surface-3 text-ink',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
