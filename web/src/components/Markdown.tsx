import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Play, Workflow } from 'lucide-react';
import ReactMarkdown, { type Options } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { useTheme } from '../lib/store';
import { listifyMarkdown } from '../lib/listLines';
import { cn } from './ui';

const LANG_LABEL: Record<string, string> = {
  python: 'Python',
  py: 'Python',
  c: 'C',
  cpp: 'C++',
  java: 'Java',
  javascript: 'JavaScript',
  js: 'JavaScript',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  sql: 'SQL',
  bash: 'Shell',
  sh: 'Shell',
  json: 'JSON',
  text: '文本',
  mermaid: 'Mermaid',
};

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in (node as any)) return textOf((node as any).props.children);
  return '';
}

export function CodeBlock({
  lang,
  code,
  children,
  onRun,
}: {
  lang?: string;
  code: string;
  children?: ReactNode;
  onRun?: (code: string, lang: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const label = LANG_LABEL[lang || ''] || lang || '代码';
  const runnable = !!onRun && ['python', 'py', 'c', 'cpp', 'javascript', 'js'].includes(lang || '');
  return (
    <div className="code-block group/code">
      <div className="flex h-9 items-center justify-between border-b border-line bg-surface-2 px-3.5 text-[13px] text-ink-3">
        <span className="font-medium">{label}</span>
        <div className="flex items-center gap-1 opacity-70 transition-opacity group-hover/code:opacity-100">
          {runnable && (
            <button
              onClick={() => onRun!(code, lang === 'py' ? 'python' : lang === 'js' ? 'javascript' : lang!)}
              className="flex items-center gap-1 rounded px-2 py-1 hover:bg-surface-3 hover:text-ink"
            >
              <Play className="size-3.5" />
              运行
            </button>
          )}
          <button
            onClick={() => {
              navigator.clipboard?.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="flex items-center gap-1 rounded px-2 py-1 hover:bg-surface-3 hover:text-ink"
          >
            {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>
      <pre>{children ?? <code>{code}</code>}</pre>
    </div>
  );
}

/** 修正模型常见的 Mermaid 写法问题：时序图中的引号会被原样显示 */
function sanitizeMermaid(code: string): string {
  let c = code.trim();
  if (/^sequenceDiagram/.test(c)) {
    c = c.replace(/(participant|actor)\s+(\S+)\s+as\s+"([^"]+)"/g, '$1 $2 as $3').replace(/:\s*"([^"\n]*)"\s*$/gm, ': $1');
  }
  return c;
}

let mermaidLoader: Promise<any> | null = null;
function loadMermaid() {
  if (!mermaidLoader) mermaidLoader = import('mermaid').then(m => m.default);
  return mermaidLoader;
}

/** Mermaid 图，用到时才加载；代码还没输出完时先显示源码 */
export function MermaidBlock({ code, final }: { code: string; final: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const { dark } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!final) return;
    let cancelled = false;
    loadMermaid().then(async mermaid => {
      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'base',
          fontFamily: 'Inter Variable, PingFang SC, Microsoft YaHei, sans-serif',
          themeVariables: dark
            ? { primaryColor: '#1d2333', primaryBorderColor: '#7b7ff5', primaryTextColor: '#e8ebf4', lineColor: '#6d768c', fontSize: '14px' }
            : {
                primaryColor: '#eef0ff',
                primaryBorderColor: '#6366f1',
                primaryTextColor: '#0f172a',
                lineColor: '#94a3b8',
                secondaryColor: '#ecfeff',
                tertiaryColor: '#f8fafc',
                fontSize: '14px',
              },
          flowchart: { curve: 'basis', htmlLabels: true },
        });
        const { svg } = await mermaid.render(`m${id}${Date.now()}`, sanitizeMermaid(code));
        if (!cancelled) {
          setSvg(svg);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, final, dark, id]);
  if (svg && !failed) return <div className="mermaid-box" dangerouslySetInnerHTML={{ __html: svg }} />;
  return (
    <div className="code-block">
      <div className="flex h-9 items-center gap-1.5 border-b border-line bg-surface-2 px-3.5 text-[13px] text-ink-3">
        <Workflow className="size-3.5" />
        {final ? (failed ? '图表语法有误，显示源码' : '正在绘制图表…') : '正在生成图表…'}
      </div>
      <pre className="text-ink-3">{code}</pre>
    </div>
  );
}

interface MarkdownProps {
  children: string;
  className?: string;
  /** 内容是否已生成完毕（未完毕时不渲染 Mermaid） */
  final?: boolean;
  onRunCode?: (code: string, lang: string) => void;
  compact?: boolean;
  /** 额外的 rehype 插件和自定义元素（改动对比用） */
  plugins?: NonNullable<Options['rehypePlugins']>;
  extraComponents?: Record<string, unknown>;
}

export const Markdown = memo(function Markdown({ children, className, final = true, onRunCode, compact, plugins, extraComponents }: MarkdownProps) {
  const components = useMemo(
    () => ({
      pre: ({ children: c }: any) => {
        const codeEl = Array.isArray(c) ? c[0] : c;
        const cls: string = codeEl?.props?.className || '';
        const lang = /language-([\w+-]+)/.exec(cls)?.[1];
        const raw = textOf(codeEl?.props?.children).replace(/\n$/, '');
        if (lang === 'mermaid') return <MermaidBlock code={raw} final={final} />;
        return (
          <CodeBlock lang={lang} code={raw} onRun={onRunCode}>
            {c}
          </CodeBlock>
        );
      },
      a: ({ href, children: c }: any) => (
        <a href={href} target={href?.startsWith('/') ? undefined : '_blank'} rel="noreferrer">
          {c}
        </a>
      ),
      table: ({ children: c }: any) => <table>{c}</table>,
      input: (props: any) => <input {...props} disabled className="mr-1.5 translate-y-px accent-[var(--c-primary)]" />,
      ...extraComponents,
    }),
    [final, onRunCode, extraComponents],
  );
  return (
    <div className={cn('md', compact && 'text-[14.5px]', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeKatex, { throwOnError: false, strict: false }],
          [rehypeHighlight, { detect: false, ignoreMissing: true }],
          ...(plugins || []),
        ]}
        components={components as any}
      >
        {/* 句子里挤着的「1）… 2）…」分条，每条另起一行 */}
        {listifyMarkdown(children)}
      </ReactMarkdown>
    </div>
  );
});

/** 流式文本节流：把高频的逐字更新合并到动画帧中，减少重复渲染 */
export function useThrottledText(text: string, active: boolean) {
  const [shown, setShown] = useState(text);
  const raf = useRef<number | null>(null);
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => {
    if (!active) {
      setShown(text);
      return;
    }
    if (raf.current !== null) return;
    raf.current = window.setTimeout(() => {
      raf.current = null;
      setShown(latest.current);
    }, 60) as unknown as number;
  }, [text, active]);
  useEffect(
    () => () => {
      if (raf.current !== null) clearTimeout(raf.current);
    },
    [],
  );
  return active ? shown : text;
}
