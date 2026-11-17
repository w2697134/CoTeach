import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../ui/cn';
import { CODE_LANGS, highlightLines, langLabel } from './code';
import { EditCtx, Field, ListField, quizHooks, setIn, useEdit, type EditApi } from './Editable';
import { useFit } from './fit';
import { letter } from './model';
import { plainText } from './rich';
import { HtmlSlide } from './HtmlSlide';
import { decorKind, decorUrl, themeOf } from './themes';
import type { Slide } from './types';
import './deck.css';

export const SLIDE_W = 1280;
export const SLIDE_H = 720;

export interface SlideViewProps {
  slide: Slide;
  theme?: string;
  /** 第几页（从 0 数），内容页右下角显示页码 */
  index?: number;
  /** 章节页上的大号数字 */
  sectionNo?: number;
  /** 显示宽度（像素），高度按 16:9 算 */
  width?: number;
  /** view：只看（缩略图、导出）；edit：点字直接改；show：放映 */
  mode?: 'view' | 'edit' | 'show';
  /** 练习页是否揭晓了答案 */
  revealed?: boolean;
  onReveal?: (v: boolean) => void;
  /** mode=edit 时必须给 */
  edit?: EditApi;
  /** 字太多、缩到最小也放不下时告诉外面 */
  onOverflow?: (overflow: boolean) => void;
  className?: string;
  style?: CSSProperties;
}

/** 一页课件。缩略图、编辑大图、放映、打印、导出 PPT 都用它 */
export const SlideView = memo(function SlideView({
  slide,
  theme,
  index,
  sectionNo,
  width = SLIDE_W,
  mode = 'view',
  revealed = false,
  onReveal,
  edit,
  onOverflow,
  className,
  style,
}: SlideViewProps) {
  const t = themeOf(theme);
  const scale = width / SLIDE_W;
  const decor = decorUrl(t, decorKind(slide.layout));
  const editing = mode === 'edit' && !!edit;
  const over = useRef({ title: false, main: false });
  const report = (part: 'title' | 'main', v: boolean) => {
    if (over.current[part] === v) return;
    over.current[part] = v;
    onOverflow?.(over.current.title || over.current.main);
  };
  if (typeof slide.html === 'string')
    return (
      <HtmlSlide
        html={slide.html}
        theme={t.id}
        width={width}
        index={index}
        revealed={revealed}
        editable={editing}
        onEdit={editing ? (h) => edit!.set('html', h) : undefined}
        onKeyDown={editing ? edit!.onFrameKey : undefined}
        onContext={editing ? edit!.onFocusField : undefined}
        bind={editing ? edit!.bindHtml : undefined}
        onOverflow={onOverflow}
        className={className}
        style={style}
      />
    );
  const ctx: LayoutProps = { s: slide, theme: t.id, mode, revealed: slide.layout === 'quiz' && revealed, onReveal, sectionNo, report };
  const content = slide.layout === 'cover' || slide.layout === 'section';
  return (
    <div className={cn('dk-frame', className)} style={{ width, height: (width * SLIDE_H) / SLIDE_W, ...style }}>
      <div
        className={cn('dk-slide', `dk-t-${t.id}`, `dk-l-${slide.layout}`, `dk-m-${mode}`, editing && 'dk-editing')}
        style={scale !== 1 ? { transform: `scale(${scale})` } : undefined}
        data-slide={slide.id}
        data-theme-id={t.id}
      >
        {decor && <div className="dk-decor" style={{ backgroundImage: `url("${decor}")` }} />}
        <EditCtx.Provider value={editing ? edit! : null}>
          <Layout {...ctx} />
        </EditCtx.Provider>
        {!content && index !== undefined && (
          <span className="dk-pageno" data-pp="text">
            {String(index + 1).padStart(2, '0')}
          </span>
        )}
      </div>
    </div>
  );
});

interface LayoutProps {
  s: Slide;
  theme: string;
  mode: 'view' | 'edit' | 'show';
  revealed: boolean;
  onReveal?: (v: boolean) => void;
  sectionNo?: number;
  report: (part: 'title' | 'main', v: boolean) => void;
}

function Layout(p: LayoutProps) {
  switch (p.s.layout) {
    case 'cover':
      return <Cover {...p} />;
    case 'section':
      return <Section {...p} />;
    case 'code':
      return <Code {...p} />;
    case 'compare':
      return <Compare {...p} />;
    case 'steps':
      return <Steps {...p} />;
    case 'quiz':
      return <Quiz {...p} />;
    case 'table':
      return <Table {...p} />;
    case 'quote':
      return <Quote {...p} />;
    case 'summary':
      return <Summary {...p} />;
    default:
      return <Points {...p} />;
  }
}

/** 这页的内容变了才重新量字号 */
const contentKey = (s: Slide, extra = '') => {
  const { notes: _n, id: _i, ...rest } = s;
  return JSON.stringify(rest) + extra;
};

/* ================================================================ 内容页骨架：标题 + 主体 */
function Frame({ s, theme, mode, report, children, minFit = 0.5, extraKey = '' }: LayoutProps & { children: ReactNode; minFit?: number; extraKey?: string }) {
  const edit = useEdit();
  const title = useRef<HTMLElement>(null);
  const main = useRef<HTMLDivElement>(null);
  useFit(title, `${s.title}|${theme}|${mode}`, { name: '--tfit', min: 0.6, onDone: (_, o) => report('title', o) });
  useFit(main, contentKey(s, `|${theme}|${mode}|${extraKey}`), { min: minFit, onDone: (_, o) => report('main', o) });
  const showTitle = !!edit || !!s.title.trim();
  const showSub = edit ? s.subtitle !== undefined : !!s.subtitle?.trim();
  return (
    <div className="dk-body">
      {(showTitle || showSub) && (
        <header className="dk-head">
          <i className="dk-bar" data-pp="shape" />
          {showTitle && <Field k="title" value={s.title} ph="标题" className="dk-title" as="h2" elRef={title} />}
          {showSub && <Field k="subtitle" value={s.subtitle || ''} ph="副标题" className="dk-sub" />}
        </header>
      )}
      <div className="dk-main" ref={main}>
        {children}
      </div>
    </div>
  );
}

/** 编辑时空着的列表也留一条可以点进去写；看的时候空的不显示 */
function visible(items: string[] | undefined, editing: boolean) {
  const list = items || [];
  if (editing) return (list.length ? list : ['']).map((v, i) => ({ v, i }));
  return list.map((v, i) => ({ v, i })).filter((x) => x.v.trim());
}

/* ================================================================ 封面 */
function Cover({ s, theme, mode, report }: LayoutProps) {
  const edit = useEdit();
  const title = useRef<HTMLElement>(null);
  useFit(title, `${s.title}|${theme}|${mode}`, { name: '--tfit', min: 0.5, onDone: (_, o) => report('title', o) });
  return (
    <div className="dk-cover">
      <i className="dk-cover-bar" data-pp="shape" />
      <Field k="title" value={s.title} ph="课件标题" className="dk-cover-title" as="h1" elRef={title} />
      {(edit ? s.subtitle !== undefined : !!s.subtitle?.trim()) && <Field k="subtitle" value={s.subtitle || ''} ph="副标题" className="dk-cover-sub" />}
    </div>
  );
}

/* ================================================================ 章节 */
function Section({ s, theme, mode, sectionNo, report }: LayoutProps) {
  const edit = useEdit();
  const title = useRef<HTMLElement>(null);
  useFit(title, `${s.title}|${theme}|${mode}`, { name: '--tfit', min: 0.55, onDone: (_, o) => report('title', o) });
  return (
    <div className="dk-section">
      <span className="dk-secno" data-pp="text">
        {String(sectionNo ?? 1).padStart(2, '0')}
      </span>
      <div className="dk-sectext">
        <i className="dk-bar" data-pp="shape" />
        <Field k="title" value={s.title} ph="章节名称" className="dk-sectitle" as="h2" elRef={title} />
        {(edit ? s.subtitle !== undefined : !!s.subtitle?.trim()) && <Field k="subtitle" value={s.subtitle || ''} ph="副标题" className="dk-secsub" />}
      </div>
    </div>
  );
}

/* ================================================================ 要点 */
function Points(p: LayoutProps) {
  const edit = useEdit();
  const items = visible(p.s.points, !!edit);
  const twoCol = items.length >= 6 && items.every((x) => plainText(x.v).length <= 18);
  return (
    <Frame {...p}>
      <ul className={cn('dk-points', twoCol && 'dk-2col')}>
        {items.map(({ v, i }) => (
          <li className="dk-point" key={i}>
            <i className="dk-mark" data-pp="shape" />
            <ListField path="points" i={i} value={v} ph="要点" className="dk-ptext" />
          </li>
        ))}
      </ul>
    </Frame>
  );
}

/* ================================================================ 小结 */
function Summary(p: LayoutProps) {
  const edit = useEdit();
  const items = visible(p.s.points, !!edit);
  const n = items.length;
  const three = (n === 3 || n === 5 || n === 6 || n === 9) && items.every((x) => plainText(x.v).length <= (n === 3 ? 40 : 24));
  return (
    <Frame {...p}>
      <div className={cn('dk-summary', three && 'dk-3col')}>
        {items.map(({ v, i }, k) => (
          <div className="dk-sitem" key={i} data-pp="shape">
            <span className="dk-sno" data-pp="text">
              {k + 1}
            </span>
            <ListField path="points" i={i} value={v} ph="要点" className="dk-stext" />
          </div>
        ))}
      </div>
    </Frame>
  );
}

/* ================================================================ 代码 */
function Code(p: LayoutProps) {
  const edit = useEdit();
  const code = p.s.code || { lang: 'python', text: '' };
  const lines = highlightLines(code.text, code.lang);
  const marks = new Set(code.mark || []);
  const gw = Math.max(2, String(lines.length).length);
  const wrap = code.text.split('\n').some((l) => l.length > 78);
  const showCaption = edit ? code.caption !== undefined : !!code.caption?.trim();
  const toggleMark = (n: number) =>
    edit?.patch((s) => {
      const cur = new Set(s.code?.mark || []);
      if (cur.has(n)) cur.delete(n);
      else cur.add(n);
      const mark = [...cur].sort((a, b) => a - b);
      return setIn(s, 'code.mark', mark.length ? mark : undefined);
    });
  return (
    <Frame {...p} minFit={0.55}>
      <div className="dk-code">
        <div className={cn('dk-codewin', wrap && 'dk-wrap', marks.size > 0 && 'dk-has-mark')} data-pp="shape">
          <div className="dk-codebar" data-pp="shape">
            <i className="dk-dot" data-pp="shape" />
            <i className="dk-dot" data-pp="shape" />
            <i className="dk-dot" data-pp="shape" />
            <span className="dk-codetab" data-pp="text">
              {langLabel(code.lang)}
              {edit && (
                <select className="dk-langsel" value={CODE_LANGS.some((l) => l.id === code.lang) ? code.lang : 'text'} onChange={(e) => edit.patch((s) => setIn(s, 'code.lang', e.target.value))} aria-label="语言">
                  {CODE_LANGS.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
              )}
            </span>
          </div>
          <div className="dk-codebody" data-pp="code" style={{ ['--dk-gw' as string]: gw }}>
            {lines.map((toks, i) => (
              <div className={cn('dk-cl', marks.has(i + 1) && 'is-mark')} key={i}>
                <span className="dk-ln" onMouseDown={edit ? (e) => (e.preventDefault(), toggleMark(i + 1)) : undefined}>
                  {i + 1}
                </span>
                <span className="dk-lt">
                  {toks.map((t, j) => (
                    <span key={j} className={t.k ? `dk-tk-${t.k}` : undefined}>
                      {t.t}
                    </span>
                  ))}
                </span>
              </div>
            ))}
            {edit && <CodeInput text={code.text} gw={gw} />}
          </div>
        </div>
        {showCaption && (
          <div className="dk-caption">
            <i className="dk-capbar" data-pp="shape" />
            <Field k="code.caption" value={code.caption || ''} ph="说明" className="dk-captext" multiline />
          </div>
        )}
      </div>
    </Frame>
  );
}

/** 代码编辑：透明的输入框盖在上色的代码上；Tab 缩进，回车自动接上缩进（行尾是冒号再多缩一层） */
function CodeInput({ text, gw }: { text: string; gw: number }) {
  const edit = useEdit()!;
  const ref = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    const r = edit.req.current;
    if (r?.key === 'code' && ref.current) {
      edit.req.current = null;
      ref.current.focus({ preventScroll: true });
      const at = r.caret === 'end' ? ref.current.value.length : r.caret;
      ref.current.setSelectionRange(at, at);
    }
  }, [edit.tick, edit.req]);
  useLayoutEffect(() => {
    if (pending.current && ref.current) {
      ref.current.setSelectionRange(...pending.current);
      pending.current = null;
    }
  });
  const put = (value: string, sel: [number, number]) => {
    pending.current = sel;
    edit.set('code.text', value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const ta = e.currentTarget;
    const { selectionStart: a, selectionEnd: b, value } = ta;
    if (e.key === 'Tab') {
      e.preventDefault();
      const ls = value.lastIndexOf('\n', a - 1) + 1;
      if (a === b && !e.shiftKey) return put(value.slice(0, a) + '    ' + value.slice(b), [a + 4, a + 4]);
      const le = value.indexOf('\n', Math.max(a, b - 1));
      const end = le === -1 ? value.length : le;
      const block = value.slice(ls, end).split('\n');
      let first = 0,
        total = 0;
      const next = block.map((l, i) => {
        if (e.shiftKey) {
          const n = l.match(/^ {1,4}/)?.[0].length || 0;
          if (i === 0) first = -n;
          total -= n;
          return l.slice(n);
        }
        if (i === 0) first = 4;
        total += 4;
        return '    ' + l;
      });
      return put(value.slice(0, ls) + next.join('\n') + value.slice(end), [Math.max(ls, a + first), b + total]);
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const ls = value.lastIndexOf('\n', a - 1) + 1;
      const line = value.slice(ls, a);
      const indent = line.match(/^ */)![0] + (/[:{([]\s*$/.test(line) ? '    ' : '');
      const ins = '\n' + indent;
      return put(value.slice(0, a) + ins + value.slice(b), [a + ins.length, a + ins.length]);
    }
    if (e.key === 'Escape') ta.blur();
  };
  return (
    <textarea
      ref={ref}
      className="dk-codeinput"
      style={{ left: `calc(${gw}ch + 44px)` }}
      value={text}
      placeholder="代码"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      wrap="off"
      data-field="code"
      onChange={(e) => edit.set('code.text', e.target.value)}
      onKeyDown={onKeyDown}
      onFocus={() => edit.onFocusField?.('code')}
      onBlur={() => edit.onFocusField?.(null)}
    />
  );
}

/* ================================================================ 对比 */
function Compare(p: LayoutProps) {
  const edit = useEdit();
  const c = p.s.compare || { left: { head: '', points: [] }, right: { head: '', points: [] } };
  const side = (key: 'left' | 'right', cls: string) => {
    const sd = c[key];
    const items = visible(sd.points, !!edit);
    return (
      <div className={cn('dk-side', cls)} data-pp="shape">
        {(edit || sd.head.trim()) && (
          <Field k={`compare.${key}.head`} value={sd.head} ph="名称" className="dk-side-head" onEnter={() => edit?.focus(`compare.${key}.points.0`, 'end')} />
        )}
        <ul>
          {items.map(({ v, i }) => (
            <li className="dk-point" key={i}>
              <i className="dk-mark" data-pp="shape" />
              <ListField path={`compare.${key}.points`} i={i} value={v} ph="要点" className="dk-ptext" />
            </li>
          ))}
        </ul>
      </div>
    );
  };
  return (
    <Frame {...p}>
      <div className="dk-compare">
        {side('left', 'dk-side-a')}
        <div className="dk-vs" data-pp="text">
          VS
        </div>
        {side('right', 'dk-side-b')}
      </div>
    </Frame>
  );
}

/* ================================================================ 步骤 */
function Steps(p: LayoutProps) {
  const edit = useEdit();
  const all = p.s.steps || [];
  const steps = edit ? (all.length ? all : [{ head: '' }]).map((x, i) => ({ x, i })) : all.map((x, i) => ({ x, i })).filter(({ x }) => x.head.trim() || x.text?.trim());
  const n = steps.length;
  const horizontal = n >= 2 && n <= 4 && steps.every(({ x }) => plainText(x.head).length <= 14 && plainText(x.text || '').length <= 46);
  const stepField = (x: { head: string; text?: string }, i: number) => {
    const headKey = `steps.${i}.head`,
      textKey = `steps.${i}.text`;
    const addAfter = () => {
      edit!.patch((s) => {
        const a = [...(s.steps || [])];
        a.splice(i + 1, 0, { head: '' });
        return { ...s, steps: a };
      });
      edit!.focus(`steps.${i + 1}.head`, 0);
    };
    const remove = () => {
      if ((p.s.steps || []).length <= 1) return;
      edit!.patch((s) => ({ ...s, steps: (s.steps || []).filter((_, j) => j !== i) }));
      edit!.focus(i > 0 ? `steps.${i - 1}.text` : 'steps.0.head', 'end');
    };
    return (
      <>
        <Field
          k={headKey}
          value={x.head}
          ph="步骤"
          className="dk-step-head"
          onEnter={() => edit?.focus(textKey, 'end')}
          onBackspaceStart={(t) => {
            if (t === '' && !x.text) remove();
            else if (i > 0) edit?.focus(`steps.${i - 1}.text`, 'end');
          }}
        />
        {(edit || x.text?.trim()) && (
          <Field
            k={textKey}
            value={x.text || ''}
            ph="说明"
            className="dk-step-text"
            onEnter={addAfter}
            onBackspaceStart={() => edit?.focus(headKey, 'end')}
          />
        )}
      </>
    );
  };
  if (horizontal)
    return (
      <Frame {...p} extraKey="h">
        <div className="dk-steps-h" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
          {steps.map(({ x, i }, k) => (
            <div className="dk-step" key={i}>
              {k < n - 1 && <i className="dk-steps-line" data-pp="shape" style={{ width: 'calc(100% + 30px)' }} />}
              <span className="dk-stepno" data-pp="text">
                {k + 1}
              </span>
              {stepField(x, i)}
            </div>
          ))}
        </div>
      </Frame>
    );
  return (
    <Frame {...p} extraKey="v">
      <div className="dk-steps-v">
        {steps.map(({ x, i }, k) => (
          <div className="dk-step" key={i}>
            {k < n - 1 && <i className="dk-steps-line" data-pp="shape" style={{ height: 'calc(100% + 20px * var(--fit, 1))', bottom: 'auto' }} />}
            <span className="dk-stepno" data-pp="text">
              {k + 1}
            </span>
            <div className="dk-step-body">{stepField(x, i)}</div>
          </div>
        ))}
      </div>
    </Frame>
  );
}

/* ================================================================ 练习 */
function Quiz(p: LayoutProps) {
  const edit = useEdit();
  const q = p.s.quiz || { question: '', options: [], answer: [] };
  const opts = visible(q.options, !!edit);
  const multi = q.answer.length > 1;
  const short = opts.every((x) => plainText(x.v).length <= 18);
  const grid2 = short && (opts.length === 4 || opts.length === 2);
  const toggle = (i: number) =>
    edit?.patch((s) => {
      const cur = new Set(s.quiz?.answer || []);
      if (cur.has(i)) cur.delete(i);
      else cur.add(i);
      return setIn(s, 'quiz.answer', [...cur].sort((a, b) => a - b));
    });
  const canReveal = p.mode !== 'view' && q.answer.length > 0;
  return (
    <>
      <Frame {...p} extraKey={p.revealed ? 'r' : ''}>
        <div className="dk-quizq">
          <span className="dk-qtag" data-pp="text">
            {multi ? '多选' : '单选'}
          </span>
          <Field k="quiz.question" value={q.question} ph="题目" className="dk-qtext" multiline />
        </div>
        <ol className={cn('dk-opts', !grid2 && 'dk-1col')}>
          {opts.map(({ v, i }) => {
            const right = q.answer.includes(i);
            return (
              <li key={i} className={cn('dk-opt', p.revealed && (right ? 'is-right' : 'is-dim'))} data-pp="shape">
                <span
                  className="dk-optkey"
                  data-pp="text"
                  onMouseDown={edit ? (e) => (e.preventDefault(), toggle(i)) : undefined}
                  title={edit ? (right ? '取消这个答案' : '设为答案') : undefined}
                >
                  {letter(i)}
                  {edit && right && !p.revealed && <i className="dk-anskey" />}
                </span>
                <ListField path="quiz.options" i={i} value={v} ph="选项" className="dk-opttext" hooks={quizHooks} />
                {p.revealed && right && (
                  <span className="dk-check" data-pp="text">
                    ✓
                  </span>
                )}
              </li>
            );
          })}
        </ol>
        {p.revealed && (edit || q.explain?.trim()) && (
          <div className="dk-explain" data-pp="shape">
            <span className="dk-explain-label" data-pp="text">
              解析
            </span>
            <Field k="quiz.explain" value={q.explain || ''} ph="为什么选它" className="dk-explain-text" multiline />
          </div>
        )}
      </Frame>
      {canReveal && (
        <button
          type="button"
          className={cn('dk-reveal', p.revealed && 'is-on')}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            p.onReveal?.(!p.revealed);
          }}
        >
          {p.revealed ? '收起答案' : '揭晓答案'}
        </button>
      )}
    </>
  );
}

/* ================================================================ 表格 */
function Table(p: LayoutProps) {
  const edit = useEdit();
  const t = p.s.table || { head: [], rows: [] };
  const cols = Math.max(1, t.head.length);
  const rows = edit ? t.rows.map((r, i) => ({ r, i })) : t.rows.map((r, i) => ({ r, i })).filter(({ r }) => r.some((c) => c.trim()));
  const showHead = !!edit || t.head.some((h) => h.trim());
  const cellKey = (row: number, col: number) => (row < 0 ? `table.head.${col}` : `table.rows.${row}.${col}`);
  const move = (row: number, col: number, dir: 1 | -1) => {
    let r = row,
      c = col + dir;
    if (c >= cols) {
      c = 0;
      r++;
    } else if (c < 0) {
      c = cols - 1;
      r--;
    }
    if (r < -1) return true;
    if (r >= t.rows.length) {
      edit!.patch((s) => ({ ...s, table: { ...s.table!, rows: [...s.table!.rows, Array(cols).fill('')] } }));
    }
    edit!.focus(cellKey(r, c), 'end');
    return true;
  };
  const down = (row: number, col: number) => {
    if (row + 1 >= t.rows.length) edit!.patch((s) => ({ ...s, table: { ...s.table!, rows: [...s.table!.rows, Array(cols).fill('')] } }));
    edit!.focus(cellKey(row + 1, col), 'end');
  };
  const cell = (row: number, col: number, value: string) => (
    <Field
      k={cellKey(row, col)}
      value={value}
      ph={row < 0 ? '表头' : ''}
      onTab={edit ? (shift) => move(row, col, shift ? -1 : 1) : undefined}
      onEnter={edit ? () => down(row, col) : undefined}
    />
  );
  return (
    <Frame {...p}>
      <div className="dk-tablewrap">
        <table className="dk-table" data-pp="table">
          {showHead && (
            <thead>
              <tr>
                {Array.from({ length: cols }, (_, j) => (
                  <th key={j}>{cell(-1, j, t.head[j] || '')}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rows.map(({ r, i }) => (
              <tr key={i}>
                {Array.from({ length: cols }, (_, j) => (
                  <td key={j}>{cell(i, j, r[j] || '')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  );
}

/* ================================================================ 引用 */
function Quote({ s, theme, mode, report }: LayoutProps) {
  const edit = useEdit();
  const q = s.quote || { text: '' };
  const box = useRef<HTMLDivElement>(null);
  useFit(box, contentKey(s, `|${theme}|${mode}`), { min: 0.5, onDone: (_, o) => report('main', o) });
  return (
    <div className="dk-quotebox">
      <span className="dk-qmark" data-pp="text">
        “
      </span>
      {(edit || s.title.trim()) && <Field k="title" value={s.title} ph="标题" className="dk-qlabel" />}
      <div className="dk-qfit" ref={box}>
        <Field k="quote.text" value={q.text} ph="引用的话" className="dk-qbody" multiline />
      </div>
      {(edit || q.by?.trim()) && (
        <div className="dk-qby" style={{ display: 'flex', gap: 12 }}>
          <span data-pp="text">——</span>
          <Field k="quote.by" value={q.by || ''} ph="出处" />
        </div>
      )}
    </div>
  );
}

/* ================================================================ 外面按容器大小放一页 */
/** 在一个盒子里放得下的最大 16:9 宽度 */
export function useContainWidth(pad = 0) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const avail = Math.max(0, r.width - pad * 2),
        availH = Math.max(0, r.height - pad * 2);
      setW(Math.floor(Math.min(avail, (availH * SLIDE_W) / SLIDE_H)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pad]);
  return [ref, w] as const;
}
