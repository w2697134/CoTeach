/**
 * 模型一边写、JSON 还没写完的时候，尽量读出已经写出来的那部分。
 * 做法：从头扫一遍，记着现在是不是在字符串里、开着哪些括号、哪里能切；
 * 停在字符串里就把这个字符串补完（写了一半的字也显示，像在打字），不行就切到最近一个写完的值，补上括号再解析。
 * 读不出来返回 undefined。
 */
export function parsePartialJson(text: string): unknown {
  const s = text.trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    // 没写完，往下补
  }
  const stack: string[] = [];
  const cuts: { at: number; closers: string }[] = [];
  const closers = () => stack.slice().reverse().join('');
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      stack.pop();
      cuts.push({ at: i + 1, closers: closers() });
    } else if (c === ',') cuts.push({ at: i, closers: closers() });
  }
  const tryParse = (t: string) => {
    try {
      return { ok: true as const, v: JSON.parse(t) };
    } catch {
      return { ok: false as const };
    }
  };
  if (inStr) {
    // 停在字符串里：去掉半截的转义，把字符串补完
    let t = s;
    if (esc) t = t.slice(0, -1);
    t = t.replace(/\\u[0-9a-fA-F]{0,3}$/, '');
    const r = tryParse(`${t}"${closers()}`);
    if (r.ok) return r.v;
  } else {
    const r = tryParse(s + closers());
    if (r.ok) return r.v;
  }
  // 切到最近一个写完的值（最多往回试 20 处，免得很长的 JSON 反复解析）
  for (let k = cuts.length - 1, n = 0; k >= 0 && n < 20; k--, n++) {
    const r = tryParse(s.slice(0, cuts[k].at) + cuts[k].closers);
    if (r.ok) return r.v;
  }
  return undefined;
}

/** 一个写到一半的工具调用：哪个工具、读得出来的参数（读不出来是 null） */
export function partialCall(d: { name: string; text: string; wrapped?: boolean }): { name: string; args: Record<string, unknown> } | null {
  const v = parsePartialJson(d.text);
  if (!v || typeof v !== 'object') return null;
  if (!d.wrapped) return Array.isArray(v) ? null : { name: d.name, args: v as Record<string, unknown> };
  // Gemini 接口那种整步的 JSON：取最后一个写着的工具
  const calls = (v as { calls?: unknown }).calls;
  if (!Array.isArray(calls) || !calls.length) return null;
  const last = calls[calls.length - 1] as { tool?: unknown; args?: unknown };
  if (typeof last?.tool !== 'string' || !last.args || typeof last.args !== 'object') return null;
  return { name: last.tool, args: last.args as Record<string, unknown> };
}

/** 隔一会儿才报一次写到哪了（每次都报太费：参数一长，每报一次要从头解析一遍） */
export function throttle(ms = 300) {
  let at = 0;
  let len = 0;
  return (size: number) => {
    const t = Date.now();
    if (size <= len || t - at < ms) return false;
    at = t;
    len = size;
    return true;
  };
}
