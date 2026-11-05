/** 时间、数字、百分比等格式化（中文习惯） */
const DAY = 86400_000;

function startOfDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const pad = (n: number) => String(n).padStart(2, '0');

export function hm(t: number) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 今天 14:32 / 昨天 09:10 / 9月12日 14:32 / 2025年9月12日 */
export function fmtTime(t?: number | null, withTime = true): string {
  if (!t) return '—';
  const d = new Date(t);
  const today = startOfDay(Date.now());
  const day = startOfDay(t);
  const time = withTime ? ` ${hm(t)}` : '';
  if (day === today) return `今天${time}`;
  if (day === today - DAY) return `昨天${time}`;
  if (day === today + DAY) return `明天${time}`;
  if (d.getFullYear() === new Date().getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日${time}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function fmtDate(t?: number | null) {
  if (!t) return '—';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtDateTime(t?: number | null) {
  if (!t) return '—';
  const d = new Date(t);
  return `${fmtDate(t)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 刚刚 / 5 分钟前 / 3 小时前 / 昨天 / 4 天前 / 日期 */
export function fromNow(t?: number | null): string {
  if (!t) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return fmtTime(t);
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < DAY && startOfDay(t) === startOfDay(Date.now())) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (startOfDay(t) === startOfDay(Date.now()) - DAY) return `昨天 ${hm(t)}`;
  if (diff < 7 * DAY) return `${Math.ceil(diff / DAY)} 天前`;
  return fmtTime(t, false);
}

/** 截止时间：还剩 2 天 3 小时 / 还剩 45 分钟 / 已截止 */
export function fmtDue(t?: number | null): { text: string; level: 'ok' | 'soon' | 'urgent' | 'over' | 'none' } {
  if (!t) return { text: '不限时', level: 'none' };
  const diff = t - Date.now();
  if (diff <= 0) return { text: '已截止', level: 'over' };
  const d = Math.floor(diff / DAY);
  const h = Math.floor((diff % DAY) / 3600_000);
  const m = Math.floor((diff % 3600_000) / 60_000);
  if (d >= 1) return { text: `还剩 ${d} 天${h ? ` ${h} 小时` : ''}`, level: d >= 3 ? 'ok' : 'soon' };
  if (h >= 1) return { text: `还剩 ${h} 小时 ${m} 分`, level: 'urgent' };
  return { text: `还剩 ${m} 分钟`, level: 'urgent' };
}

export function pct(v?: number | null, digits = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtNum(n?: number | null, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(digits)}亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(digits)}万`;
  return n.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

export function fmtCompact(n?: number | null): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

export function fmtMs(ms?: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

export function fmtScore(v?: number | null): string {
  if (v === null || v === undefined) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
}

export function fmtSize(bytes?: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '晚上好';
  if (h < 11) return '早上好';
  if (h < 13) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

export function todayText(): string {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY[d.getDay()]}`;
}

export const QTYPE: Record<string, string> = { single: '单选题', multiple: '多选题', judge: '判断题', fill: '填空题', short: '简答题', code: '编程题' };
export const QTYPE_SHORT: Record<string, string> = { single: '单选', multiple: '多选', judge: '判断', fill: '填空', short: '简答', code: '编程' };
export const LETTERS = 'ABCDEFGH';

/** 题干摘要：去掉代码块和 Markdown 符号，只留文字，代码在展开后查看；题干首行是标题时单独返回 */
export function stemParts(stem: string): { title: string | null; text: string } {
  const plain = (s: string) =>
    s
      // 填空题的空位（___）先换成占位符，免得被当成加粗记号去掉
      .replace(/_{3,}/g, '\u0001')
      // 「**样例输入**」「输出：」这类小标题和它后面的代码块一起去掉
      .replace(/(^|\n)[ \t]*(?:\*\*[^*\n]{1,16}\*\*[：:]?|#{1,6}[ \t]+[^\n]{1,16}|[^\n]{1,12}[：:])[ \t]*\n+```[\s\S]*?(```|$)/g, '\n')
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
      .replace(/\*\*|__|~~/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\u0001/g, '____')
      .trim();
  const lines = (stem || '').split('\n');
  const first = lines.findIndex(l => l.trim());
  const head = first >= 0 ? lines[first].trim() : '';
  const heading = head.match(/^#{1,6}\s+(.+)$/) || head.match(/^\*\*([^*]+)\*\*$/);
  const title = heading ? plain(heading[1]) : null;
  const text = plain(heading ? lines.slice(first + 1).join('\n') : stem || '');
  return { title, text: text || (title ? '' : plain((stem || '').replace(/```\w*/g, ''))) };
}

export function stemSummary(stem: string): string {
  const { title, text } = stemParts(stem);
  return [title, text].filter(Boolean).join(' ');
}
