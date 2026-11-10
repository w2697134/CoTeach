import type { Workspace } from '../workspace.js';

/**
 * 交资料整理完，这批原件里还没和文档放在一起的，挪到这次写的、同名的那份文档旁边；
 * 没有同名的，找正文里用书名号提到它的。都找不到就留在原处。撞名时原件名后加「（原件）」。
 * 整理助手只管写文档、分文件夹，原件跟着它写的文档走。
 */
export function planFiling(
  files: { id: string; path: string; protected?: boolean; pending?: string }[],
  handedIn: Set<string>,
  textOf: (path: string) => string,
): { from: string; to: string }[] {
  const dir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const stem = (p: string) => (p.split('/').pop() || '').replace(/\.[^./]+$/, '');
  const docs = files.filter((f) => !f.protected);
  const written = docs.filter((f) => f.pending === '待提交' && dir(f.path));
  const docDirs = new Set(docs.map((f) => dir(f.path)));
  const taken = new Set(files.map((f) => f.path.toLowerCase()));
  const moves: { from: string; to: string }[] = [];
  for (const o of files.filter((f) => handedIn.has(f.id))) {
    if (dir(o.path) && docDirs.has(dir(o.path))) continue;
    const name = stem(o.path),
      ext = o.path.match(/\.[^./]+$/)?.[0] || '';
    const target = written.find((d) => stem(d.path) === name) ?? written.find((d) => textOf(d.path).includes(`《${name}》`));
    if (!target) continue;
    const folder = dir(target.path);
    let to = `${folder}/${name}${ext}`;
    for (let k = 1; taken.has(to.toLowerCase()); k++) to = `${folder}/${name}（原件${k > 1 ? k : ''}）${ext}`;
    taken.delete(o.path.toLowerCase());
    taken.add(to.toLowerCase());
    moves.push({ from: o.path, to });
  }
  return moves;
}

export async function fileOriginals(ws: Workspace, handedIn: Set<string>): Promise<{ from: string; to: string }[]> {
  const done: { from: string; to: string }[] = [];
  for (const m of planFiling(await ws.list(), handedIn, (p) => ws.read(p) || '')) {
    try {
      ws.move(m.from, m.to);
      done.push(m);
    } catch {
      // 挪不了就留在原处，老师看得到
    }
  }
  return done;
}
