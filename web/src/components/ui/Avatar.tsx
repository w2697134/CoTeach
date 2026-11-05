import { useState } from 'react';
import { Bot, BookOpen, ChartLine, Compass, Megaphone, PenLine, Puzzle, ShieldCheck, Sparkles, Terminal, type LucideIcon } from 'lucide-react';
import { cn } from './cn';

/** 用户头像：姓名首字 + 由用户 id 决定的柔和渐变 */
const GRADIENTS = [
  ['#6366f1', '#8b5cf6'],
  ['#0ea5e9', '#6366f1'],
  ['#14b8a6', '#0ea5e9'],
  ['#f59e0b', '#ef4444'],
  ['#ec4899', '#8b5cf6'],
  ['#10b981', '#14b8a6'],
  ['#f97316', '#f59e0b'],
  ['#64748b', '#334155'],
];

export function Avatar({
  name,
  seed,
  size = 32,
  className,
  ring,
}: {
  name?: string | null;
  seed?: number | string;
  size?: number;
  className?: string;
  ring?: boolean;
}) {
  const n = String(seed ?? name ?? '?');
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  const [a, b] = GRADIENTS[h % GRADIENTS.length];
  const text = (name || '?').trim();
  const initial = /[一-鿿]/.test(text) ? (text.slice(-2).length === 2 && text.length > 2 ? text.slice(-2) : text.slice(-1)) : text.slice(0, 1).toUpperCase();
  return (
    <span
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium text-white',
        ring && 'ring-2 ring-surface',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, size * (initial.length > 1 ? 0.34 : 0.42)),
        background: `linear-gradient(135deg, ${a}, ${b})`,
      }}
      title={name || undefined}
    >
      {initial}
    </span>
  );
}

const ICONS: Record<string, LucideIcon> = {
  compass: Compass,
  'book-open': BookOpen,
  puzzle: Puzzle,
  'shield-check': ShieldCheck,
  'pen-line': PenLine,
  'chart-line': ChartLine,
  megaphone: Megaphone,
  sparkles: Sparkles,
  terminal: Terminal,
  bot: Bot,
};

const BUILTIN = new Set(['orchestrator', 'lesson', 'question', 'reviewer', 'grader', 'analyst', 'steward', 'tutor', 'coach', 'keeper']);

export interface AgentLike {
  key: string;
  name?: string;
  avatar?: string;
  color?: string;
}

/** 智能体头像：内置智能体使用插画头像，自定义智能体使用图标 + 主题色 */
export function AgentAvatar({
  agent,
  size = 36,
  className,
  active,
  status,
}: {
  agent: AgentLike;
  size?: number;
  className?: string;
  active?: boolean;
  status?: 'running' | 'done' | 'error' | null;
}) {
  const [broken, setBroken] = useState(false);
  const color = agent.color || '#6366f1';
  const Icon = ICONS[agent.avatar || ''] || Bot;
  const showImg = BUILTIN.has(agent.key) && !broken;
  return (
    <span className={cn('relative inline-flex shrink-0', className)} style={{ width: size, height: size, ['--agent' as any]: color }}>
      <span
        className={cn('inline-flex size-full items-center justify-center overflow-hidden rounded-full', active && 'agent-pulse')}
        style={{ background: showImg ? 'transparent' : `linear-gradient(140deg, ${color}, color-mix(in srgb, ${color} 55%, #0f172a))` }}
      >
        {showImg ? (
          <img
            src={`/agents/${agent.key === 'orchestrator' ? 'tutor' : agent.key}.webp`}
            alt={agent.name || agent.key}
            className="size-full object-cover"
            onError={() => setBroken(true)}
            draggable={false}
          />
        ) : (
          <Icon className="text-white" style={{ width: size * 0.5, height: size * 0.5 }} />
        )}
      </span>
      {status && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-surface',
            status === 'running' ? 'animate-pulse-soft bg-brand' : status === 'done' ? 'bg-ok' : 'bg-bad',
          )}
          style={{ width: Math.max(8, size * 0.28), height: Math.max(8, size * 0.28) }}
        />
      )}
    </span>
  );
}
