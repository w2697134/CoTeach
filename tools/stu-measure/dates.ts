/**
 * 尺子里用的日期（北京时间）。不碰数据库：尺子的总进程只读这些，不去占开发数据目录（开发服务开着也能量）。
 */

/** 北京时间某天 23:59（相对今天往后几天） */
export function dayAt(daysFromToday: number, hh = 23, mm = 59, base = Date.now()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(base + daysFromToday * 86_400_000))
      .map((x) => [x.type, x.value]),
  );
  return Date.parse(`${p.year}-${p.month}-${p.day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`);
}

/** 「11月17日」这样的说法 */
export function dateWords(t: number) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]),
  );
  return `${p.month}月${p.day}日`;
}
