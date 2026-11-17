/**
 * 一段话里挤着「1）… 2）…」的分条（模型常这么写）：拆出来每条另起一行。
 * 夹在句子中间的编号看着像乱码。
 *
 * 认 1）、1)、（1）、(1)、1、、1.、①；从 1 开始按顺序至少两条才拆，每条至少四个字。
 * 编号前面得是开头、空白或标点，range(1, 2)、「选 1）或 2）」、3.14 这种不拆。
 */
const MARK = /(^|[\s：:，,。；;？?！!])(?:[（(]\s*([1-9])\s*[)）]|([1-9])\s*[)）、]|([1-9])\.(?!\d)|([①-⑨]))\s*/g;

export interface InlineList {
  /** 编号前面那一句（可能是空的） */
  head: string;
  /** 每一条（不带编号） */
  items: string[];
}

export function splitInlineList(text: string): InlineList | null {
  const hits: { at: number; end: number; n: number }[] = [];
  for (const m of text.matchAll(MARK)) {
    const n = m[2] || m[3] || m[4] ? Number(m[2] || m[3] || m[4]) : m[5].charCodeAt(0) - 0x2460 + 1;
    hits.push({ at: (m.index ?? 0) + m[1].length, end: (m.index ?? 0) + m[0].length, n });
  }
  const run: typeof hits = [];
  for (const h of hits) if (h.n === run.length + 1) run.push(h);
  if (run.length < 2) return null;
  const items = run.map((h, i) => text.slice(h.end, i + 1 < run.length ? run[i + 1].at : text.length).trim());
  if (items.some((t) => [...t].length < 4)) return null;
  return { head: text.slice(0, run[0].at).trim(), items };
}

/**
 * Markdown 里的一行行字：挤在一行里的分条改成 Markdown 的编号单子（代码块、带行内代码的行不动）。
 * 以「1. 」开头、后面又跟着「；2. 」的一行也拆开；别的列表行不动。
 */
export function listifyMarkdown(md: string): string {
  let fence = false;
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (fence || line.includes('`') || /^\s*([-*+]|[2-9]\d*[.)]|1\d+[.)])\s/.test(line)) return line;
      const l = splitInlineList(line);
      if (!l) return line;
      return [l.head, ...l.items.map((t, i) => `${i + 1}. ${t}`)].filter(Boolean).join('\n');
    })
    .join('\n');
}
