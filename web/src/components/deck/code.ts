import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import sql from 'highlight.js/lib/languages/sql';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';

/** 课件里的代码只认这几种语言，用 highlight.js 的核心包，不整包引入 */
const GRAMMARS = { python, javascript, typescript, java, c, cpp, sql, bash, json, xml, css };
for (const [name, g] of Object.entries(GRAMMARS)) hljs.registerLanguage(name, g);

export const CODE_LANGS: { id: string; label: string }[] = [
  { id: 'python', label: 'Python' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'java', label: 'Java' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'sql', label: 'SQL' },
  { id: 'bash', label: 'Shell' },
  { id: 'json', label: 'JSON' },
  { id: 'xml', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'text', label: '文本' },
];

const ALIAS: Record<string, string> = {
  py: 'python',
  python3: 'python',
  js: 'javascript',
  ts: 'typescript',
  'c++': 'cpp',
  cc: 'cpp',
  sh: 'bash',
  shell: 'bash',
  html: 'xml',
  htm: 'xml',
  mysql: 'sql',
  plaintext: 'text',
  txt: 'text',
  '': 'text',
};
export const langId = (lang: string) => {
  const l = (lang || '').trim().toLowerCase();
  return ALIAS[l] ?? (l in GRAMMARS ? l : 'text');
};
export const langLabel = (lang: string) => {
  const id = langId(lang);
  return CODE_LANGS.find((x) => x.id === id)?.label || lang || '文本';
};

/** 一小段字和它的颜色类别 */
export type TokKind = '' | 'kw' | 'str' | 'num' | 'com' | 'fn' | 'type' | 'bi' | 'lit' | 'meta' | 'attr' | 'tag' | 'var' | 'sub';
export interface Tok {
  t: string;
  k: TokKind;
}

const KIND: Record<string, TokKind> = {
  keyword: 'kw',
  'selector-tag': 'kw',
  string: 'str',
  regexp: 'str',
  char: 'str',
  number: 'num',
  symbol: 'num',
  bullet: 'num',
  comment: 'com',
  quote: 'com',
  doctag: 'com',
  'title.function_': 'fn',
  'title.class_': 'type',
  title: 'fn',
  section: 'fn',
  'selector-class': 'fn',
  type: 'type',
  'selector-id': 'type',
  built_in: 'bi',
  literal: 'lit',
  meta: 'meta',
  attr: 'attr',
  attribute: 'attr',
  property: 'attr',
  name: 'tag',
  tag: 'tag',
  variable: 'var',
  'template-variable': 'var',
  subst: 'sub',
  params: '',
};

const ENT: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };
const unescape = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (m) => ENT[m] || m);

/** highlight.js 吐出来的 <span class="hljs-…"> 拆成一段一段 */
function classKind(cls: string): TokKind | undefined {
  const names = cls.split(/\s+/).map((c) => c.replace(/^hljs-/, ''));
  const joined = names.join('.');
  if (joined in KIND) return KIND[joined];
  if (names.length > 1 && `${names[0]}.${names[1]}` in KIND) return KIND[`${names[0]}.${names[1]}`];
  return KIND[names[0]];
}

function tokenize(html: string): Tok[] {
  const out: Tok[] = [];
  const stack: (TokKind | undefined)[] = [];
  const re = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) stack.push(classKind(m[1]));
    else if (m[0] === '</span>') stack.pop();
    else {
      let k: TokKind = '';
      for (let i = stack.length - 1; i >= 0; i--)
        if (stack[i] !== undefined) {
          k = stack[i]!;
          break;
        }
      const t = unescape(m[2]);
      const last = out[out.length - 1];
      if (last && last.k === k) last.t += t;
      else out.push({ t, k });
    }
  }
  return out;
}

const memo = new Map<string, Tok[][]>();
/** 代码拆成行，每行一串带颜色类别的小段 */
export function highlightLines(text: string, lang: string): Tok[][] {
  const id = langId(lang);
  const key = `${id}\u0000${text}`;
  const hit = memo.get(key);
  if (hit) return hit;
  let toks: Tok[];
  if (id === 'text') toks = [{ t: text, k: '' }];
  else {
    try {
      toks = tokenize(hljs.highlight(text, { language: id, ignoreIllegals: true }).value);
    } catch {
      toks = [{ t: text, k: '' }];
    }
  }
  const lines: Tok[][] = [[]];
  for (const tok of toks) {
    const parts = tok.t.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ t: p, k: tok.k });
    });
  }
  if (memo.size > 300) memo.clear();
  memo.set(key, lines);
  return lines;
}
