/**
 * 课件里的字只认两种记号：`代码` 和 **加粗**。显示时换成样式，编辑时露出原样的记号。
 * toRaw[i] 是显示出来的第 i 个字在原文里的位置，点进去编辑时用它把光标放回原处。
 */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
const RE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*/g;

export const hasMarks = (text: string) => /`[^`\n]+`|\*\*[^*\n]+?\*\*/.test(text);

export function richHtml(text: string): string {
  let out = '',
    last = 0;
  let m: RegExpExecArray | null;
  RE.lastIndex = 0;
  while ((m = RE.exec(text))) {
    out += esc(text.slice(last, m.index));
    out += m[1] !== undefined ? `<code class="dk-ic">${esc(m[1])}</code>` : `<strong class="dk-b">${esc(m[2])}</strong>`;
    last = RE.lastIndex;
  }
  return out + esc(text.slice(last));
}

/** 显示出来的字（去掉记号）每个字对应原文的位置 */
export function richToRaw(text: string): number[] {
  const map: number[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  RE.lastIndex = 0;
  const plain = (a: number, b: number) => {
    for (let i = a; i < b; i++) map.push(i);
  };
  while ((m = RE.exec(text))) {
    plain(last, m.index);
    const open = m[1] !== undefined ? 1 : 2;
    const inner = (m[1] ?? m[2]).length;
    plain(m.index + open, m.index + open + inner);
    last = RE.lastIndex;
  }
  plain(last, text.length);
  map.push(text.length);
  return map;
}

/** 去掉记号后的纯文字（导出、量字数用） */
export const plainText = (text: string) => text.replace(RE, (_, a, b) => a ?? b);
