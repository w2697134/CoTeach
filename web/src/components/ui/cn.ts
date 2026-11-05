import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 拼接类名，并按 Tailwind 规则合并冲突：后传入的类覆盖组件默认样式（如 hidden 覆盖 inline-flex） */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
