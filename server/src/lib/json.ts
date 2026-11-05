/**
 * 从模型输出里取出 JSON。
 * 能处理 ```json 代码块、前后多余的文字、尾逗号、中文引号和字符串里的换行。
 */
export function extractJson<T = any>(text: string): T | null {
  if (!text) return null;
  const candidates: string[] = [];
  const trimmed = text.trim();
  // 先整段解析，因为字段里可能有 ```python 代码块，不能当成 JSON 代码块
  if (/^[\[{]/.test(trimmed)) candidates.push(trimmed);
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) if (/^\s*[\[{]/.test(m[1])) candidates.push(m[1]);
  const balanced = findBalanced(text);
  if (balanced) candidates.push(balanced);
  candidates.push(text);
  for (const c of candidates) {
    const v = tryParse(c.trim());
    if (v !== undefined) return v as T;
  }
  return null;
}

function tryParse(s: string): unknown {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    /* 继续尝试修复 */
  }
  // 字符串里有没转义的引号时括号会配错，所以再试从第一个括号到最后一个括号
  const bases: string[] = [];
  const inner = findBalanced(s);
  if (inner) bases.push(inner);
  const start = s.search(/[\[{]/);
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (start >= 0 && end > start) bases.push(s.slice(start, end + 1));
  if (start >= 0) bases.push(s.slice(start));
  if (!bases.length) bases.push(s);
  for (const b of bases) {
    try {
      return JSON.parse(repair(b));
    } catch {
      /* 换下一种 */
    }
  }
  return undefined;
}

/** 判断引号是否是字符串的结尾：后面（跳过空白）是 , : } ] 或已到末尾 */
function isClosingQuote(s: string, i: number): boolean {
  for (let k = i + 1; k < s.length; k++) {
    const c = s[k];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') continue;
    return c === ',' || c === '}' || c === ']' || c === ':';
  }
  return true;
}

/** 找第一个括号配对完整的 {...} 或 [...]，字符串里的括号不算 */
export function findBalanced(s: string): string | null {
  const start = s.search(/[\[{]/);
  if (start < 0) return null;
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (!stack.length) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function repair(s: string): string {
  let out = s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/^﻿/, '');
  // 字符串里的换行要转义，中间没转义的引号当普通字符
  let result = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inStr) {
      if (esc) {
        esc = false;
        result += ch;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        result += ch;
        continue;
      }
      if (ch === '"') {
        if (!isClosingQuote(out, i)) {
          result += '\\"';
          continue;
        }
        inStr = false;
      }
      if (ch === '\n') {
        result += '\\n';
        continue;
      }
      if (ch === '\r') continue;
      if (ch === '\t') {
        result += '\\t';
        continue;
      }
      result += ch;
    } else {
      if (ch === '"') inStr = true;
      result += ch;
    }
  }
  // 补括号：中间漏掉的当场补上，结尾缺的补在最后
  const stack: string[] = [];
  let fixed = '';
  inStr = false;
  esc = false;
  for (const ch of result) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      fixed += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (!stack.includes(ch)) continue; // 多出来的右括号跳过
      while (stack.length && stack[stack.length - 1] !== ch) fixed += stack.pop();
      stack.pop();
    }
    fixed += ch;
  }
  out = fixed;
  if (inStr) out += '"';
  while (stack.length) out += stack.pop();
  return out.replace(/,\s*([}\]])/g, '$1');
}

/**
 * 解析工具调用参数。部分网关会返回形如 `{}{"a":1}` 的拼接参数，取最后一个完整对象。
 */
export function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    /* 处理拼接 */
  }
  const objects: string[] = [];
  let rest = raw;
  while (rest.length) {
    const b = findBalanced(rest);
    if (!b) break;
    objects.push(b);
    rest = rest.slice(rest.indexOf(b) + b.length);
  }
  for (let i = objects.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(objects[i]);
      if (v && typeof v === 'object' && Object.keys(v).length) return v;
    } catch {
      /* ignore */
    }
  }
  const v = extractJson(raw);
  return v && typeof v === 'object' ? v : {};
}
