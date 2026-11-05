/**
 * 分词、截断和 Markdown 清理。
 * 课程资料检索（BM25）和相似度计算会用到。
 */
const STOP = new Set([
  '的',
  '了',
  '是',
  '在',
  '和',
  '与',
  '或',
  '就',
  '都',
  '而',
  '及',
  '等',
  '这',
  '那',
  '一个',
  '我们',
  '你们',
  '他们',
  '可以',
  '如果',
  '因为',
  '所以',
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'is',
  'are',
  'and',
  'or',
  'for',
  'on',
  'with',
  'as',
  'by',
  'be',
  'it',
  'this',
  'that',
]);

const CJK = /[一-鿿㐀-䶿]/;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  // 英文/数字/标识符
  for (const m of lower.matchAll(/[a-z_][a-z0-9_]*|\d+(?:\.\d+)?/g)) {
    const w = m[0];
    if (w.length < 2 && !/\d/.test(w)) continue;
    if (STOP.has(w)) continue;
    tokens.push(w);
    // 按下划线拆开
    if (w.includes('_')) for (const p of w.split('_')) if (p.length > 1) tokens.push(p);
  }
  // 中文按单字和相邻两字切分
  for (const m of text.matchAll(/[一-鿿㐀-䶿]+/g)) {
    const seg = m[0];
    for (let i = 0; i < seg.length; i++) {
      const ch = seg[i];
      if (!STOP.has(ch)) tokens.push(ch);
      if (i + 1 < seg.length) {
        const bi = seg.slice(i, i + 2);
        if (!STOP.has(bi)) tokens.push(bi);
      }
    }
  }
  return tokens;
}

export function termFreq(tokens: string[]): Record<string, number> {
  const tf: Record<string, number> = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

export function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 粗略估算 token 数（中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token） */
export function estimateTokens(s: string): number {
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) if (CJK.test(ch)) cjk++;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

/** 按标题和长度把 Markdown 切成检索片段 */
export function chunkMarkdown(md: string, maxLen = 700): { heading: string; text: string }[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const sections: { heading: string; lines: string[] }[] = [];
  let current = { heading: '', lines: [] as string[] };
  let inCode = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) inCode = !inCode;
    const h = !inCode && /^(#{1,4})\s+(.+)/.exec(line);
    if (h) {
      if (current.lines.join('').trim()) sections.push(current);
      current = { heading: h[2].trim(), lines: [line] };
    } else current.lines.push(line);
  }
  if (current.lines.join('').trim()) sections.push(current);

  const chunks: { heading: string; text: string }[] = [];
  for (const sec of sections) {
    const text = sec.lines.join('\n').trim();
    if (text.length <= maxLen) {
      chunks.push({ heading: sec.heading, text });
      continue;
    }
    // 按段落继续切分，尽量不拆开代码块
    const paras = text.split(/\n{2,}/);
    let buf = '';
    for (const p of paras) {
      if ((buf + '\n\n' + p).length > maxLen && buf) {
        chunks.push({ heading: sec.heading, text: buf.trim() });
        buf = sec.heading ? `（续）${sec.heading}\n${p}` : p;
      } else buf = buf ? buf + '\n\n' + p : p;
    }
    if (buf.trim()) chunks.push({ heading: sec.heading, text: buf.trim() });
  }
  return chunks;
}

export function normalizeAnswer(s: string): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[，,；;。.]/g, '')
    .replace(/[“”"'‘’`]/g, '');
}
