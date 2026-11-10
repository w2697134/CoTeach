/** 文件名末尾的扩展名（.docx、.zip、.png……）老师都不需要看到；扩展名以字母开头，名字里的「3.2」这类不受影响 */
const EXT = /\.[a-z][a-z0-9]{0,4}$/i;
export const fileTitle = (path: unknown) => (typeof path === 'string' ? (path.split('/').pop() || '').replace(EXT, '') : '');
export const fileDir = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const plainPath = (path: unknown) => (typeof path === 'string' ? path.split('/').filter(Boolean).map(fileTitle).join(' · ') : '');
export const plainText = (value: unknown) =>
  typeof value !== 'string'
    ? ''
    : value
        .replace(/（系统记录：[^）]+）/g, '')
        .replace(/(?:[^\s，。、；;：:（）()「」『』《》"'“”‘’]+\/)+[^\s，。、；;：:（）()「」『』《》"'“”‘’]+/g, (match) =>
          /^https?:/i.test(match) ? match : plainPath(match),
        )
        .replace(/\.(?:md|markdown|docx?|pptx?|pdf|txt)(?![A-Za-z0-9])/gi, '')
        // 「笔记/ 下新建」「资料/：」这种文件夹名后面的斜杠也去掉
        .replace(/([^\s/：:]+)\/(?=[\s：:]|$)/g, '$1');

/** 今天的只写几点，别的日子写几月几日 */
export function when(t: number) {
  const d = new Date(t),
    today = new Date();
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === today.toDateString() ? time : `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}

export function readableError(error: unknown): string {
  const text = typeof error === 'string' ? error : (error as Error)?.message || '';
  if (/402|余额|insufficient.*balance/i.test(text)) return '整理服务余额不足，请联系管理员充值';
  if (/401|403|API.?key|api_key|unauthorized|authentication/i.test(text)) return '整理服务暂时无法连接，请联系管理员检查';
  if (/DeepSeek|模型配置|模型返回|JSON|https?:|HTTP|fetch|network|timeout/i.test(text)) return '整理服务暂时不可用，请稍后重试';
  if (/调用 done|暂存修改|工具|二进制|student_id|核对发现问题/.test(text)) return '这一步没有完成';
  return /[\u3400-\u9fff]/.test(text) ? plainText(text) : '操作未完成，请稍后重试';
}
const LABELS: Record<string, string> = {
  place_experience: '整理经验',
  source_evidence: '核对来源',
  list_source_files: '查看封存目录',
  read_source_file: '阅读封存记录',
  search_source: '查找封存记录',
  review_summary: '核对改动',
  list_files: '查看目录',
  read_file: '阅读',
  search: '查找',
  write_file: '整理',
  edit_file: '修改',
  delete_file: '移除',
  move_file: '移动',
  finish: '提交改动',
  done: '完成',
  list_students: '查看名单',
  list_knowledge_bases: '看全部知识库',
  create_knowledge_base: '新建知识库',
  rename_knowledge_base: '知识库改名',
  move_to_knowledge_base: '挪到别的知识库',
  delete_knowledge_base: '删除知识库',
};
const quoted = (v: unknown) => (typeof v === 'string' && v ? `「${plainText(v)}」` : '');
export function toolPresentation(data: Record<string, unknown> = {}) {
  const name = typeof data.name === 'string' ? data.name : '';
  let target = fileTitle(data.path);
  if (name === 'move_file') target = [fileTitle(data.from), fileTitle(data.to)].filter(Boolean).join('，移到');
  if (name === 'finish') target = plainText(data.title);
  if (name === 'search') target = typeof data.text === 'string' ? `「${plainText(data.text)}」` : '';
  if (name === 'create_knowledge_base' || name === 'delete_knowledge_base') target = quoted(data.base);
  if (name === 'rename_knowledge_base') target = data.to ? `${quoted(data.from)}改成${quoted(data.to)}` : quoted(data.base);
  if (name === 'move_to_knowledge_base') {
    const what = typeof data.path === 'string' ? `「${fileTitle(data.path)}」` : typeof data.count === 'number' ? `${data.count} 份` : '';
    target = data.to ? `${data.from ? `从${quoted(data.from)}` : ''}${what}挪到${quoted(data.to)}` : '';
  }
  return { label: Object.hasOwn(LABELS, name) ? LABELS[name] : '整理', target, error: data.error ? readableError(data.error) : '' };
}

/* ---------- 中间一格一格摆着的文件夹和文件 ---------- */
export type FolderItem<F extends { path: string }> =
  | { kind: 'folder'; path: string; name: string; count: number; pending: boolean }
  | { kind: 'file'; file: F; name: string; pending: boolean };
/** 一个文件夹里直接放着的东西：文件夹在前、文件在后，各自按名字排（第2章排在第10章前面）；里面有改动等确认的文件夹也标出来 */
export function folderItems<F extends { path: string }>(files: F[], dir: string, pending: Set<string> = new Set()): FolderItem<F>[] {
  const prefix = dir ? dir + '/' : '';
  const folders = new Map<string, { children: Set<string>; pending: boolean }>();
  const list: FolderItem<F>[] = [];
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const [first, ...more] = f.path.slice(prefix.length).split('/');
    if (!more.length) {
      list.push({ kind: 'file', file: f, name: fileTitle(first), pending: pending.has(f.path) });
      continue;
    }
    const folder = folders.get(first) || { children: new Set<string>(), pending: false };
    folder.children.add(more[0]);
    if (pending.has(f.path)) folder.pending = true;
    folders.set(first, folder);
  }
  const byName = (a: FolderItem<F>, b: FolderItem<F>) => a.name.localeCompare(b.name, 'zh', { numeric: true });
  const dirs: FolderItem<F>[] = [...folders].map(([name, v]) => ({ kind: 'folder', path: prefix + name, name, count: v.children.size, pending: v.pending }));
  return [...dirs.sort(byName), ...list.sort(byName)];
}

/* ---------- 中间翻开的一页 ---------- */
/** 文件开头的 --- 元信息块只给程序看，翻开时不显示 */
export const withoutFrontMatter = (text: string) => text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');

/** 文档自己的大标题拿出来单独排，下面接一行谁写的；没有大标题就用给的名字 */
export function splitTitle(text: string, fallback: string) {
  const m = text.match(/^\s*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/);
  return m ? { title: plainText(m[1]), body: text.slice(m[0].length) } : { title: fallback, body: text };
}

/**
 * 正文里写到的知识库位置（笔记里的出处「资料/第7章 递归.md」这种）变成能点的链接，点了翻到那一页。
 * 只认带文件夹的位置或带扩展名的名字，免得把「规矩」「目录」这样的普通词当成链接。
 * 要放在去扩展名的那一步前面：链接里的字随后也会去掉扩展名、斜杠换成「·」。
 */
export const KB_LINK = '#kb:';
type Hast = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Hast[] };
export function rehypeKbLinks(paths: string[]) {
  const mentions = new Map<string, string>();
  for (const p of paths) {
    mentions.set(p, p);
    const bare = p.replace(/\.[^./]+$/, '');
    if (p.includes('/') && bare !== p && !mentions.has(bare)) mentions.set(bare, p);
  }
  const keys = [...mentions.keys()].filter((k) => k.includes('/') || /\.[^./]+$/.test(k)).sort((a, b) => b.length - a.length);
  const re = keys.length ? new RegExp(keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  return () => (tree: Hast) => {
    if (!re) return;
    const walk = (node: Hast) => {
      if (!node.children || node.tagName === 'code' || node.tagName === 'pre' || node.tagName === 'a') return;
      const out: Hast[] = [];
      for (const child of node.children) {
        if (child.type !== 'text') {
          walk(child);
          out.push(child);
          continue;
        }
        const v = child.value || '';
        let at = 0;
        re.lastIndex = 0;
        for (let m = re.exec(v); m; m = re.exec(v)) {
          if (m.index > at) out.push({ type: 'text', value: v.slice(at, m.index) });
          out.push({
            type: 'element',
            tagName: 'a',
            properties: { href: KB_LINK + encodeURIComponent(mentions.get(m[0])!) },
            children: [{ type: 'text', value: m[0] }],
          });
          at = m.index + m[0].length;
        }
        if (!at) out.push(child);
        else if (at < v.length) out.push({ type: 'text', value: v.slice(at) });
      }
      node.children = out;
    };
    walk(tree);
  };
}

/** 链接指向知识库里的哪一页：正文里认出来的位置，或者 [进度](进度.md) 这样的相对链接；外面的网址不算 */
export function kbTarget(href: string | undefined, from: string, known: Set<string>): string | null {
  if (!href) return null;
  if (href.startsWith(KB_LINK)) return decodeURIComponent(href.slice(KB_LINK.length));
  if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(href.split('#')[0]);
  } catch {
    return null;
  }
  const parts = from.includes('/') ? from.slice(0, from.lastIndexOf('/')).split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  // 有的链接是从知识库最外层写起的
  for (const p of [parts.join('/'), rel.replace(/^\.\//, '')]) {
    if (known.has(p)) return p;
    if (known.has(p + '.md')) return p + '.md';
  }
  return null;
}

export function parseRoster(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      if (/[\t,，]/.test(line)) {
        const columns = line.split(/[\t,，]/).map((part) => part.trim());
        if (columns.length !== 2) throw new Error(`「${line.trim()}」请只填写学号和姓名两列`);
        if (!columns[0] || !columns[1]) throw new Error(`「${line.trim()}」缺少学号或姓名`);
        return { studentNo: columns[0], name: columns[1] };
      }
      const match = line.trim().match(/^([^\s,，]+)[\s,，]+(.+)$/);
      if (!match) throw new Error(`「${line.trim()}」缺少学号或姓名`);
      return { studentNo: match[1], name: match[2].trim() };
    });
}
