import * as XLSX from 'xlsx';
import { decodeText } from '../kb/intake/textcodec.js';
import { bad } from '../lib/http.js';

export interface RosterStudent {
  studentNo: string;
  name: string;
}
/** 读出来的名单：班名（认不出是 null）、学生、没认出来的行（原样给老师看） */
export interface Roster {
  name: string | null;
  students: RosterStudent[];
  unread: string[];
  /** 班名是从「班级」列或班号认出来的（不是整个标题） */
  sure?: boolean;
}

/** 一格里的字：数字照原样写出来（学号不能变成 2.0251E+9），去掉看不见的字符和两头的引号 */
function cell(v: unknown): string {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v !== 'string') return '';
  return v
    .replace(/[​-‏⁠﻿]/g, '')
    .replace(/　/g, ' ')
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim();
}
/** 学号：字母、数字、短横，至少带三位数字 */
const looksNo = (s: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(s) && /\d{3}/.test(s);
/** 名单里两个字的名字常常中间垫空格对齐（「王  磊」）；全是汉字的去掉空格，外文名留一个空格 */
function cleanName(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return /^[\p{Script=Han}·•\s]+$/u.test(t) ? t.replace(/\s/g, '').replace(/•/g, '·') : t;
}
const looksName = (s: string) => s.length > 0 && s.length <= 30 && /[\p{Script=Han}A-Za-z]/u.test(s) && !/\d/.test(s);

const label = (s: string) => s.replace(/[\s*＊:：()（）]/g, '');
function headerOf(row: string[]) {
  const no = row.findIndex((c) => /^(学生)?学号$|^学籍号$/.test(label(c)));
  const name = row.findIndex((c) => /^(学生)?姓名$/.test(label(c)));
  if (no < 0 || name < 0) return null;
  return { no, name, cls: row.findIndex((c) => /^(行政)?班级(名称)?$|^行政班$/.test(label(c))) };
}

/** 粘贴的一行：有制表符、逗号就按它们分；只有空格时，认「学号 姓名」或「姓名 学号」（外文名中间的空格留着） */
export function splitLine(line: string): string[] {
  if (/[\t,，;；]/.test(line)) return line.split(/[\t,，;；]/);
  const t = line.trim();
  const first = t.match(/^(\S+)\s+(.+)$/);
  if (first && looksNo(first[1])) return [first[1], first[2]];
  const last = t.match(/^(.+?)\s+(\S+)$/);
  if (last && looksNo(last[2])) return [last[1], last[2]];
  return t.split(/\s+/);
}

/** 标题、文件名里像班号的那段：「软工2402」「计科2505班」「计算机科学与技术2025级5班」 */
function classToken(s: string | null | undefined): string | null {
  return (s || '').match(/\p{Script=Han}{2,10}\d{2,4}(?:级\d{1,2}班|班)?/u)?.[0] ?? null;
}
/** 从标题、文件名里取班名：去掉「学生名单」「花名册」这类字和括号里的说明 */
function className(s: string | null | undefined): string | null {
  const t = (s || '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[（(][^()（）]*[)）]\s*$/, '')
    .replace(/(学生)?(花名册|名单|名册)$/, '')
    .trim();
  return t && t.length <= 40 ? t : null;
}

/**
 * 一张表读成名单。有「学号」「姓名」表头就按表头那两列读，表头上面那行当标题；
 * 没有表头（粘贴的）就每行找一格像学号的、一格像姓名的。学号重复的只留一个；同一学号两个名字的，算没认出来。
 */
export function rosterFromRows(input: unknown[][]): Roster {
  const rows = input.map((r) => r.map(cell)).filter((r) => r.some(Boolean));
  const at = rows.findIndex((r) => headerOf(r));
  const header = at >= 0 ? headerOf(rows[at])! : null;
  const students = new Map<string, RosterStudent>(),
    unread: string[] = [],
    classes = new Set<string>();
  let title: string | null = at > 0 ? rows[0].find(Boolean) || null : null;
  for (const row of at >= 0 ? rows.slice(at + 1) : rows) {
    const text = row.filter(Boolean).join(' ');
    let no = '',
      name = '';
    if (header) {
      no = row[header.no] || '';
      name = cleanName(row[header.name] || '');
      // 表尾的「共 42 人」「制表人」这类行，学号、姓名两格都不像
      if (!no && !looksName(name)) continue;
      if (header.cls >= 0 && row[header.cls]) classes.add(row[header.cls]);
    } else {
      const i = row.findIndex(looksNo);
      const j = row.findIndex((c, k) => k !== i && looksName(cleanName(c)));
      if (i < 0) {
        // 名单前面不带学号的那行当标题
        if (!students.size && !unread.length && !title) title = text;
        else unread.push(text);
        continue;
      }
      no = row[i];
      name = j >= 0 ? cleanName(row[j]) : '';
    }
    if (!looksNo(no) || !looksName(name)) {
      unread.push(text);
      continue;
    }
    const had = students.get(no);
    if (had && had.name !== name) unread.push(text);
    else if (!had) students.set(no, { studentNo: no, name });
  }
  const onlyClass = classes.size === 1 ? [...classes][0] : null;
  // 班名先认「班级」那列，再认标题里的班号；都没有才拿整个标题（成绩表的标题多半是课程名，不可靠）
  const sure = className(onlyClass) || classToken(title);
  return { name: sure || className(title), students: [...students.values()], unread, sure: !!sure };
}

export const rosterFromText = (text: string): Roster => rosterFromRows(text.split(/\r?\n/).map(splitLine));

/** 教务网导出的表（xlsx、xls、ods）或文字文件（csv、txt）。几张表的取第一张有学生的；班名表里没有就用文件名 */
export function rosterFromFile(fileName: string, bytes: Uint8Array): Roster {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  let tables: unknown[][][];
  if (['csv', 'txt', 'tsv'].includes(ext)) tables = [decodeText(bytes).split(/\r?\n/).map(splitLine)];
  else {
    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(bytes, { type: 'buffer', dense: true, cellDates: false, cellHTML: false, cellFormula: false, cellText: false });
    } catch {
      throw bad('这个文件里没认出学号和姓名');
    }
    tables = wb.SheetNames.map((n) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, raw: true, defval: '', blankrows: false }));
  }
  const found = tables.map(rosterFromRows).find((r) => r.students.length);
  if (!found) throw bad('这个文件里没认出学号和姓名');
  const { sure, ...roster } = found;
  return { ...roster, name: (sure ? found.name : classToken(fileName) || found.name) || className(fileName) };
}
