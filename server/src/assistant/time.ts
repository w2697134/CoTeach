/**
 * 时间一律按北京时间说：服务器在洛杉矶，不能用服务器本地时间。中国没有夏令时，固定 +08:00。
 */
const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});
const WEEK: Record<string, string> = { Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六', Sun: '日' };

function pieces(ms: number) {
  const p = Object.fromEntries(parts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: p.year, m: p.month, d: p.day, hh: p.hour, mm: p.minute, w: WEEK[p.weekday] || '' };
}

/** 「2026-11-16 周一 02:40」：每一轮告诉助教现在几点，「下周五」它自己算 */
export function nowLine(ms = Date.now()) {
  const p = pieces(ms);
  return `${p.y}-${p.m}-${p.d} 周${p.w} ${p.hh}:${p.mm}`;
}

/** 给助教、给老师看的时间：「11月27日 周五 23:59」，不是今年的带年份 */
export function showTime(ms: number, base = Date.now()) {
  const p = pieces(ms),
    b = pieces(base);
  const md = `${Number(p.m)}月${Number(p.d)}日 周${p.w} ${p.hh}:${p.mm}`;
  return p.y === b.y ? md : `${p.y}年${md}`;
}

/** 助教给的「2026-11-27 23:59」「2026-11-27」按北京时间换成毫秒；只给日期的算当天 23:59；认不出返回 null */
export function parseTime(s: string): number | null {
  const m = String(s || '')
    .trim()
    .replace(/[年月/.]/g, '-')
    .replace(/日/g, '')
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2})[:：](\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h = '23', mi = '59'] = m;
  const pad = (x: string) => x.padStart(2, '0');
  const t = Date.parse(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${mi}:00+08:00`);
  return Number.isFinite(t) ? t : null;
}

/** 一周后的晚上 23:59（跟页面上布置作业的默认截止一样） */
export function weekLater(ms = Date.now()) {
  const p = pieces(ms + 7 * 86_400_000);
  return Date.parse(`${p.y}-${p.m}-${p.d}T23:59:00+08:00`);
}

/* ---------------- 老师怎么说就怎么收：日期由程序算，不让模型心算 ---------------- */

const CN: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 「十二」「二十三」「三十一」「8」→ 数字 */
function cnNum(s: string): number | null {
  const t = s.trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (!/^[零〇一二两三四五六七八九十]+$/.test(t)) return null;
  if (!t.includes('十')) return t.length === 1 ? CN[t] : null;
  const [a, b] = t.split('十');
  return (a ? CN[a] : 1) * 10 + (b ? CN[b] : 0);
}
const NUM = '[0-9零〇一二两三四五六七八九十]+';
const WEEK_CN: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 末: 6 };

/** 北京时间那一天的零点（毫秒） */
function dayStart(ms: number) {
  const p = pieces(ms);
  return Date.parse(`${p.y}-${p.m}-${p.d}T00:00:00+08:00`);
}
const isoWeekday = (ms: number) => ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7 })[pieces(ms).w as '一'] || 1;

/** 一天里的几点：「晚上10点」「8点半」「22:00」「中午」；没说返回 null */
function timeOfDay(s: string): { h: number; m: number } | null {
  const hm = s.match(/(\d{1,2})[:：](\d{2})/);
  if (hm) return { h: Number(hm[1]), m: Number(hm[2]) };
  const m = s.match(new RegExp(`(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|今晚|明晚|明早)?\\s*(${NUM})\\s*[点时](半|一刻|三刻|(${NUM})\\s*分?)?`));
  if (m) {
    let h = cnNum(m[2]);
    if (h === null || h > 24) return null;
    const part = m[1] || (/(今晚|明晚)/.test(s) ? '晚上' : /明早/.test(s) ? '早上' : '');
    if (/下午|傍晚|晚上|夜里|今晚|明晚/.test(part) && h < 12) h += 12;
    if (part === '中午' && h < 6) h += 12;
    const min = m[3] === '半' ? 30 : m[3] === '一刻' ? 15 : m[3] === '三刻' ? 45 : m[4] ? (cnNum(m[4]) ?? 0) : 0;
    return { h: h === 24 ? 23 : h, m: h === 24 ? 59 : min };
  }
  if (/中午/.test(s)) return { h: 12, m: 0 };
  return null;
}

export interface WhenOptions {
  /** 只说了哪天、没说几点时用几点：截止默认 23:59，发布默认早上 8:00 */
  hour: number;
  minute: number;
  /** 「往后推两天」「提前一天」从哪个时间算（改截止时是原来的截止） */
  from?: number | null;
  base?: number;
}

/**
 * 老师说的时间换成毫秒（北京时间）。认得：2026-11-27 23:59、11月30日晚上10点、12月1号、今天/明天/后天、
 * N天后、周五/这周五/下周五/下下周一、往后推两天/延期一周/提前一天，再加几点。认不出返回 null。
 */
export function parseWhen(raw: string, o: WhenOptions): number | null {
  const base = o.base ?? Date.now();
  const s = String(raw || '')
    .trim()
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ');
  if (!s) return null;
  const exact = parseTime(s);
  if (exact !== null) return exact;
  const at = (day: number) => {
    const t = timeOfDay(s) ?? { h: o.hour, m: o.minute };
    return day + (t.h * 60 + t.m) * 60_000;
  };
  const UNIT = '(天|日|周|星期|礼拜|小时|钟头)';
  const unitMs = (u: string) => (/小时|钟头/.test(u) ? 3600_000 : /周|星期|礼拜/.test(u) ? 7 * 86_400_000 : 86_400_000);
  // 往后推、延期、提前：从原来的时间挪，几点不变。挪的词后面紧跟着几天才算（「11月19日」里的「19日」不算），
  // 又写了日期又写了「往后推一天」的，照「往后推一天」从原来的算（日期是模型自己算的，可能算错）
  const shift =
    s.match(new RegExp(`(往后|向后|延后|推迟|推后|延期|延长|顺延|往前|向前|提前)\\s*推?\\s*(${NUM})\\s*个?\\s*${UNIT}`)) ||
    s.match(new RegExp(`()推\\s*(${NUM})\\s*个?\\s*${UNIT}`));
  if (shift) {
    const n = cnNum(shift[2]);
    if (n !== null) return (o.from ?? base) + (/往前|向前|提前/.test(shift[1]) ? -1 : 1) * n * unitMs(shift[3]);
  }
  // 「三天后」「两周后」：从今天数到那天，几点照默认；「三小时后」就是三小时以后
  const later = s.match(new RegExp(`(${NUM})\\s*个?\\s*${UNIT}\\s*(?:之|以)?后`));
  if (later) {
    const n = cnNum(later[1]);
    if (n !== null) return /小时|钟头/.test(later[2]) ? base + n * 3600_000 : at(dayStart(base) + n * unitMs(later[2]));
  }
  // 几月几号
  const md = s.match(new RegExp(`(?:(\\d{4})\\s*[年\\-/.])?\\s*(${NUM})\\s*[月\\-/.]\\s*(${NUM})\\s*[日号]?`));
  if (md) {
    const p = pieces(base);
    const y = md[1] ? Number(md[1]) : Number(p.y);
    const mo = cnNum(md[2]),
      d = cnNum(md[3]);
    if (mo && d && mo <= 12 && d <= 31) {
      let day = Date.parse(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+08:00`);
      // 没说年份、日子已经过去好几个月了：说的是明年
      if (!md[1] && day < dayStart(base) - 60 * 86_400_000) day = Date.parse(`${y + 1}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+08:00`);
      if (Number.isFinite(day)) return at(day);
    }
  }
  // 今天、明天、后天、大后天
  const rel = s.match(/(今天|今晚|今日|明天|明晚|明早|明日|后天|大后天)/);
  if (rel) {
    const add = { 今天: 0, 今晚: 0, 今日: 0, 明天: 1, 明晚: 1, 明早: 1, 明日: 1, 后天: 2, 大后天: 3 }[rel[1] as '今天'];
    return at(dayStart(base) + add * 86_400_000);
  }
  // 周几：这周、下周、下下周；光说「周五」是接下来那个周五（今天就是周五的话算下周五）
  const wk = s.match(/(这|本|下下|下)?\s*(?:个)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天末])/);
  if (wk) {
    const want = WEEK_CN[wk[2]];
    const today = isoWeekday(base);
    const monday = dayStart(base) - (today - 1) * 86_400_000;
    let day: number;
    if (wk[1] === '这' || wk[1] === '本') day = monday + (want - 1) * 86_400_000;
    else if (wk[1] === '下') day = monday + (7 + want - 1) * 86_400_000;
    else if (wk[1] === '下下') day = monday + (14 + want - 1) * 86_400_000;
    else day = dayStart(base) + ((want - today + 7) % 7 || 7) * 86_400_000;
    return at(day);
  }
  // 只说了几点（「晚上10点」）：今天的那个时候
  const only = timeOfDay(s);
  if (only) return dayStart(base) + (only.h * 60 + only.m) * 60_000;
  return null;
}
