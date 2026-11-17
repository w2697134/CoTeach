/**
 * 知识库页上看得见的东西：笔记开头几行、哪篇笔记是从哪份原件整理来的、最近谁做了什么、可以跟助教说的话。
 * 全从现有接口的数据（目录、改动记录、笔记正文）在页面上算出来，打开页面不调模型。
 */
import type { Change, ChangeStatus, TreeFile } from './data';
import { fileDir, fileTitle, plainPath, plainText, splitTitle, withoutFrontMatter } from './presentation';

/** 老师交的原件（受保护的，或者读不出文字的文件）；其余是整理出来的笔记 */
export const isOriginal = (f: Pick<TreeFile, 'protected' | 'text'>) => !!f.protected || !f.text;

/** 原件转出来的文字叫「教案.docx.md」：两层扩展名都去掉 */
const DOUBLE = /\.(docx?|wps|pptx?|xlsx?|csv|pdf|txt|rtf|odt|png|jpe?g|gif|webp|bmp|heic|zip|rar|7z|html?|py|c|cpp|java|js|ts|sql|ipynb)\.md$/i;
export const pathName = (path: string) => (DOUBLE.test(path) ? (path.split('/').pop() || '').replace(DOUBLE, '') : fileTitle(path));
/** 原件显示老师交的时候的名字，笔记显示自己的名字 */
export const nameOf = (f: TreeFile) => (isOriginal(f) && f.source?.name ? f.source.name : pathName(f.path));
/** 文件夹的名字（最里面那一层） */
export const folderName = (dir: string) => fileTitle(dir.split('/').pop() || dir);

/* ---------- 笔记开头几行 ---------- */

/** 笔记开头的「出处：」「所属章节：」这几行是写给助教自己看的，摘要里不要 */
const META = /^(出处|来源|所属章节|所属|章节|依据|参考|参考资料|原件|更新|最近更新|整理|整理自)\s*[:：]/;
const inline = (s: string) =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*])\*(?=\S)(.+?)\*(?!\*)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\$\$?([^$]+?)\$\$?/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1')
    .trim();

/** 笔记的头几句：去掉小标题、代码、表格和 Markdown 符号，读起来像一段话 */
export function notePreview(text: string, fallbackTitle: string) {
  const { title, body } = splitTitle(withoutFrontMatter(text), fallbackTitle);
  const pieces: string[] = [];
  let fence = false,
    length = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || !line) continue;
    if (/^#{1,6}\s/.test(line) || line.startsWith('|') || /^([-*_]\s*){3,}$/.test(line) || line.startsWith('![') || line.startsWith('$$')) continue;
    const plain = inline(line.replace(/^>\s*/, '').replace(/^(?:[-*+]|\d+[.)、])\s+/, '').replace(/^\[[ xX]\]\s+/, ''));
    if (!plain || META.test(plain)) continue;
    pieces.push(plain);
    length += plain.length;
    if (length > 150) break;
  }
  let excerpt = '';
  for (const p of pieces) excerpt += excerpt && !/[。！？：；，、.!?:;,）)]$/.test(excerpt) ? '；' + p : p;
  return { title, excerpt: plainText(excerpt).slice(0, 160) };
}

/* ---------- 笔记从哪份原件来 ---------- */

export interface Origins {
  /** 笔记 → 它是从哪几份原件整理来的 */
  from: Map<string, string[]>;
  /** 原件 → 整理成了哪几篇笔记 */
  to: Map<string, string[]>;
}
const squash = (s: string) => s.replace(/[\s（）()【】[\]「」《》·:：,，、_\-—.]+/g, '').toLowerCase();
const HALF_HOUR = 30 * 60_000;

/** 交资料以后半小时内那一次整理，算是整理这批资料的 */
export const uploadBefore = (changes: Change[], c: Change) =>
  changes
    .filter((u) => u.kind === 'upload' && u.status === 'applied' && u.createdAt <= c.createdAt && c.createdAt - u.createdAt < HALF_HOUR)
    .sort((a, b) => a.createdAt - b.createdAt)
    .pop();

/**
 * 哪篇笔记是从哪份原件整理来的：
 * 1. 交了资料，紧接着助教新写的笔记，就是从这批资料来的（一批好几份时按名字配）；
 * 2. 名字对得上的：笔记名里含着原件名（「第1章 Python 安装说明」和「Python 安装说明」），或者一模一样。
 * 笔记正文「出处」那一行写到的原件，翻开笔记时另算（mentionedOriginals）。
 */
export function originsOf(files: TreeFile[], changes: Change[] = []): Origins {
  const originals = files.filter(isOriginal),
    notes = files.filter((f) => !isOriginal(f));
  const isOrig = new Set(originals.map((f) => f.path)),
    isNote = new Set(notes.map((f) => f.path));
  const key = new Map(files.map((f) => [f.path, squash(nameOf(f))]));
  // 名字最对得上的那一份：一模一样 > 笔记名里含着原件名（越长越准） > 原件名里含着笔记名（越短越准）
  const best = (note: string, candidates: string[]) => {
    const n = key.get(note) || '';
    let pick: string | null = null,
      score = 0;
    for (const o of candidates) {
      const k = key.get(o) || '';
      if (k.length < 2 || n.length < 2) continue;
      const s = k === n ? 3000 : n.includes(k) ? 2000 + k.length : k.includes(n) ? 1000 - k.length : 0;
      if (s > score) (pick = o), (score = s);
    }
    return pick;
  };
  const from = new Map<string, string[]>();
  const sorted = [...changes].sort((a, b) => a.createdAt - b.createdAt);
  for (const c of sorted) {
    if (c.author !== 'keeper' || c.status === 'rejected' || c.status === 'canceled' || c.status === 'reverted') continue;
    const upload = uploadBefore(sorted, c);
    const batch = upload ? upload.files.filter((f) => !f.deleted && isOrig.has(f.path)).map((f) => f.path) : [];
    if (!batch.length) continue;
    for (const f of c.files) {
      if (!f.added || f.deleted || !isNote.has(f.path) || from.has(f.path)) continue;
      const pick = best(f.path, batch) || (batch.length === 1 ? batch[0] : null);
      if (pick) from.set(f.path, [pick]);
    }
  }
  const all = originals.map((o) => o.path);
  for (const n of notes) {
    if (from.has(n.path)) continue;
    const pick = best(n.path, all);
    if (pick) from.set(n.path, [pick]);
  }
  const to = new Map<string, string[]>();
  for (const [note, list] of from) for (const o of list) to.set(o, [...(to.get(o) || []), note]);
  return { from, to };
}

/** 笔记「出处」那一行写到的原件（写的是位置或带扩展名的文件名才算，「参考《课程大纲》」这种不算） */
export function mentionedOriginals(text: string, originals: TreeFile[]): string[] {
  // 只看「出处：」这样开头的行（目录里「……（原件）」那种提一句的不算）
  const lines = text
    .split(/\r?\n/)
    .filter((l) => /^[\s>*_-]*(出处|来源|依据|整理自|资料来源)[*_\s]*[:：]/.test(l))
    .join('\n');
  if (!lines) return [];
  return originals
    .filter((o) => {
      const file = o.path.split('/').pop() || o.path;
      const names = [o.path, o.path.replace(/\.md$/i, ''), file];
      if (DOUBLE.test(file)) names.push(file.replace(/\.md$/i, ''));
      return names.some((n) => n.length > 3 && lines.includes(n));
    })
    .map((o) => o.path);
}

/* ---------- 每份文件最近一次改是什么时候 ---------- */

const LIVE: ChangeStatus[] = ['applied', 'pending', 'conflict'];
export function touchedAt(changes: Change[]) {
  const at = new Map<string, { at: number; added: boolean }>();
  for (const c of changes) {
    if (!LIVE.includes(c.status)) continue;
    for (const f of c.files) {
      if (f.deleted) continue;
      const prev = at.get(f.path);
      if (!prev || prev.at < c.createdAt) at.set(f.path, { at: c.createdAt, added: f.added && !f.from });
    }
  }
  return at;
}

/* ---------- 最近：每一次改动一句话 ---------- */

/** 一句话里的一段：字，或者一份文件（还在库里的能点开） */
export type Piece = string | { path: string | null; name: string };
export interface Activity {
  change: Change;
  /** 助教做的，还是老师自己做的 */
  who: 'ta' | 'teacher';
  at: number;
  pieces: Piece[];
}

const NUMBER = ['', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];
const count = (n: number, unit: string) => `${n <= 10 ? NUMBER[n] : `${n} `}${unit}`;

function phrase(c: Change, upload: Change | undefined, known: Set<string>): Piece[] {
  const ref = (path: string): Piece => ({ path: known.has(path) ? path : null, name: pathName(path) });
  // 超过两份只说几份；两份同名（好几个学生交的都叫「作业2」）也只说几份，免得看着像重复
  const refs = (paths: string[], unit: string): Piece[] =>
    paths.length > 2 || (paths.length === 2 && pathName(paths[0]) === pathName(paths[1])) ? [count(paths.length, unit)] : paths.map(ref);
  const moved = c.files.filter((f) => f.from && !f.deleted);
  const rest = c.files.filter((f) => !f.from);
  const added = rest.filter((f) => f.added && !f.deleted).map((f) => f.path);
  let changed = rest.filter((f) => !f.added && !f.deleted).map((f) => f.path);
  const removed = rest.filter((f) => f.deleted).map((f) => f.path);
  const teacher = c.author !== 'keeper';
  const clauses: Piece[][] = [];

  if (c.kind === 'upload') {
    if (added.length) clauses.push(['你交了', ...refs(added, '份资料')]);
    if (changed.length) clauses.push([added.length ? '还交了' : '你交了', ...refs(changed, '份原件'), '的新版本']);
  } else if (teacher) {
    if (added.length) clauses.push(['你新建了', ...refs(added, '份')]);
    if (changed.length) clauses.push([added.length ? '改了' : '你改了', ...refs(changed, '份')]);
    if (removed.length) clauses.push([clauses.length ? '移除了' : '你移除了', ...refs(removed, '份')]);
  } else {
    const batch = upload ? upload.files.filter((f) => !f.deleted).map((f) => f.path) : [];
    if (batch.length && added.length) {
      clauses.push([
        '把你交的',
        ...refs(batch, '份资料'),
        '整理成',
        ...(added.length > 2 ? [count(added.length, '篇笔记')] : ['笔记', ...refs(added, '篇笔记')]),
      ]);
    } else if (batch.length && changed.length) {
      clauses.push(['照你交的', ...refs(batch, '份资料'), '改了', ...refs(changed, '份')]);
      changed = [];
    } else if (added.length) clauses.push(['新写了', ...refs(added, '篇笔记')]);
    if (changed.length)
      clauses.push(clauses.length ? (changed.length > 2 ? [`另外改了${count(changed.length, '份')}`] : [...refs(changed, '份'), '也跟着改了']) : ['改了', ...refs(changed, '份')]);
    if (removed.length) clauses.push(['删掉了', ...refs(removed, '份')]);
    // 只改了一份的：助教自己写的标题说了改的是什么（「第五节迟交扣分改为 20%」），接在后面
    if (changed.length === 1 && !added.length && !removed.length && !moved.length && !upload) {
      const name = pathName(changed[0]);
      let detail = plainText(c.title).trim();
      for (const head of [`《${name}》`, `「${name}」`, name])
        if (detail.startsWith(head)) {
          detail = detail.slice(head.length).trim();
          break;
        }
      if (detail && !detail.includes(name) && !/^(改了|修改了?|更新了?|整理了?)\s*([一二三四五六七八九十\d]+\s*份)?$/.test(detail) && detail.length <= 40)
        clauses[clauses.length - 1].push('：', detail);
    }
  }
  if (moved.length === 1) {
    const where = fileDir(moved[0].path);
    const renamed = fileDir(moved[0].from!) === where;
    clauses.push(
      renamed
        ? [teacher && !clauses.length ? '你把' : '把', ref(moved[0].from!), '改名叫', ref(moved[0].path)]
        : [teacher && !clauses.length ? '你把' : '把', ref(moved[0].path), where ? `挪进了「${plainPath(where)}」` : '挪到了最外面'],
    );
  } else if (moved.length > 1) clauses.push([`${teacher && !clauses.length ? '你' : ''}挪了 ${moved.length} 份的位置`]);
  if (!clauses.length) return [plainText(c.title).replace(/^(助教|整理助手)/, '')];
  return clauses.flatMap((cl, i) => (i ? ['，', ...cl] : cl));
}

/**
 * 最近的改动，每次一句话，新的在前。交了资料、紧接着助教整理的，合成一句（「把你交的《A》整理成笔记《B》」）。
 * 撤回本身不单列：被撤回的那一条上标着「已撤回」。
 */
export function activitiesOf(changes: Change[], files: TreeFile[]): Activity[] {
  const known = new Set(files.map((f) => f.path));
  const sorted = [...changes].sort((a, b) => a.createdAt - b.createdAt);
  const merged = new Set<number>();
  const out: Activity[] = [];
  for (const c of sorted) {
    if (c.kind === 'revert') continue;
    const upload = c.author === 'keeper' ? uploadBefore(sorted, c) : undefined;
    // 这一句已经说了「把你交的《A》……」，交资料那一次就不再单列
    if (upload && c.files.some((f) => !f.deleted && !f.from)) merged.add(upload.id);
    out.push({ change: c, who: c.author === 'keeper' ? 'ta' : 'teacher', at: c.createdAt, pieces: phrase(c, upload, known) });
  }
  return out.filter((a) => !merged.has(a.change.id)).sort((a, b) => b.at - a.at);
}

/** 每一次改动的一句话（全部改动、改动详情、顶栏用；交资料的那次也单独有一句） */
export function sentencesOf(changes: Change[], files: TreeFile[]): Map<number, Piece[]> {
  const known = new Set(files.map((f) => f.path));
  const sorted = [...changes].sort((a, b) => a.createdAt - b.createdAt);
  return new Map(sorted.map((c) => [c.id, phrase(c, c.author === 'keeper' ? uploadBefore(sorted, c) : undefined, known)]));
}

export const STATUS_NOTE: Partial<Record<ChangeStatus, string>> = {
  pending: '等你确认',
  conflict: '要重新核对',
  rejected: '没要',
  reverted: '已撤回',
  canceled: '停下了',
};

/** 一句话的纯文字版（位置导航、提示里用） */
export const piecesText = (pieces: Piece[]) => pieces.map((p) => (typeof p === 'string' ? p : `《${p.name}》`)).join('');

/* ---------- 可以直接跟助教说的话 ---------- */

/**
 * 右边助教那一栏还没说过话时，摆几句老师会说的话，点一下就发。
 * 都从这个库现有的样子来：按笔记、资料分的文件夹，同一章好几篇笔记，交了还没整理的原件，有大纲的。
 */
export function suggestionsFor(files: TreeFile[], origins: Origins): string[] {
  const out: string[] = [];
  if (!files.length) return out;
  const notes = files.filter((f) => !isOriginal(f));
  const tops = new Map<string, { notes: number; originals: number }>();
  for (const f of files) {
    if (!f.path.includes('/')) continue;
    const top = f.path.split('/')[0];
    const t = tops.get(top) || { notes: 0, originals: 0 };
    if (isOriginal(f)) t.originals++;
    else t.notes++;
    tops.set(top, t);
  }
  const byType =
    [...tops].some(([name, t]) => /笔记|整理/.test(name) && t.notes && !t.originals) &&
    [...tops].some(([name, t]) => /资料|原件/.test(name) && t.originals && !t.notes);
  if (byType) out.push('别按笔记、资料分了，按内容分文件夹');
  const chapters = new Map<string, number>();
  for (const n of notes) {
    const title = pathName(n.path);
    if (/教案|大纲/.test(title)) continue;
    const m = title.match(/第\s*[0-9一二三四五六七八九十]+\s*[章单讲节]/);
    if (m) chapters.set(m[0].replace(/\s+/g, ''), (chapters.get(m[0].replace(/\s+/g, '')) || 0) + 1);
  }
  const twin = [...chapters].find(([, n]) => n >= 2);
  if (twin) out.push(`${twin[0]}的${count(twin[1], '篇笔记')}合成一篇`);
  const raw = files.find((f) => isOriginal(f) && !origins.to.has(f.path) && !f.studentId);
  if (raw) {
    const name = nameOf(raw);
    out.push(`把《${name.length > 14 ? name.slice(0, 13) + '…' : name}》整理成笔记`);
  }
  if (files.some((f) => /大纲/.test(nameOf(f)))) out.push('对着大纲看看还缺哪几章');
  if (!out.length && notes.length >= 3) out.push('看看哪几篇笔记该合到一起');
  return out.slice(0, 3);
}
