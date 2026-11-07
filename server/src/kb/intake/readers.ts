import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { htmlToMarkdown, markdownTable } from './html.js';
import { ImageError, MIN_SIDE, fromChannels, prepareImage, tiles, toJpeg, type VisionImage } from './images.js';
import { CANNOT, KIND_LABEL, SNIFF_KIND, extOf, kindFromExt, sniff, type Kind } from './kinds.js';
import { PptEncrypted, readPptStreams, type PptSlide } from './ppt.js';
import { rtfToText } from './rtf.js';
import { decodeText, looksLikeText, normalizeNewlines } from './textcodec.js';
import { attr, child, childrenNamed, elements, findAll, findFirst, local, parseXml, textContent, type XNode } from './xml.js';

/** 一份资料读出来的内容：文字段落，加上需要请模型看图的地方。 */
export type Block = { t: 'md'; text: string } | { t: 'img'; key: string; label: string; image: VisionImage };
export interface ReadOutput {
  kind: Kind;
  blocks: Block[];
  /** 读到一部分时说明哪里没读到，老师看得懂的话 */
  notes: string[];
}
export class ReadError extends Error {
  constructor(
    public reason: string,
    public advice = '',
    public skip = false,
  ) {
    super(reason);
  }
}
export interface ReadOptions {
  /** PDF 字形表、图片解码等附带文件所在目录（结尾带 /） */
  pdfAssets?: { cMapUrl: string; standardFontDataUrl: string; wasmUrl: string };
}

const MAX_CHARS = 3_000_000;
const MAX_SHEET_ROWS = 5000;
const MAX_SHEET_COLS = 60;
const MAX_VISION_PER_FILE = 400;
const meaningful = (s: string) => (s.match(/[\p{L}\p{N}]/gu) || []).length;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ENCRYPTED = () => new ReadError('文件设了密码，打不开', '请去掉密码后再交');
const BROKEN = () => new ReadError('文件打不开，可能已经损坏', '请重新保存一份再交');

/** 先看内容再看扩展名，决定按哪种格式读；压缩包交给解压那一步。 */
export type Route =
  | { kind: 'archive' }
  | { kind: Kind; format: string }
  | { kind: Kind; cannot: { reason: string; advice: string } };

export async function route(name: string, head: Uint8Array, readAll: () => Promise<Uint8Array>): Promise<Route> {
  const ext = extOf(name);
  let kind = kindFromExt(ext);
  const sniffed = sniff(head);
  if (sniffed === 'zip') {
    const z = await openZip(await readAll()).catch(() => null);
    if (!z) return { kind: 'archive' };
    const files = Object.keys(z.files);
    if (z.file('[Content_Types].xml')) {
      if (z.file('word/document.xml')) return { kind: 'document', format: 'docx' };
      if (z.file('ppt/presentation.xml')) return { kind: 'slides', format: 'pptx' };
      if (z.file('xl/workbook.xml') || z.file('xl/workbook.bin')) return { kind: 'sheet', format: 'xlsx' };
      if (files.some((f) => f.startsWith('visio/'))) return { kind: 'design', cannot: CANNOT.design! };
    }
    const mime = z.file('mimetype') ? (await z.file('mimetype')!.async('string')).trim() : '';
    if (mime === 'application/epub+zip') return { kind: 'ebook', format: 'epub' };
    if (mime.startsWith('application/vnd.oasis.opendocument.text')) return { kind: 'document', format: 'odt' };
    if (mime.startsWith('application/vnd.oasis.opendocument.presentation')) return { kind: 'slides', format: 'odp' };
    if (mime.startsWith('application/vnd.oasis.opendocument.spreadsheet')) return { kind: 'sheet', format: 'ods' };
    if (z.file('content.json') || (z.file('content.xml') && ext === 'xmind')) return { kind: 'mindmap', format: 'xmind' };
    if (ext === 'ipa' || ext === 'apk' || ext === 'jar') return { kind: 'program', cannot: CANNOT.program! };
    if (['key', 'pages', 'numbers'].includes(ext)) return { kind: 'iwork', cannot: CANNOT.iwork! };
    if (['docx', 'pptx', 'xlsx', 'epub', 'odt', 'odp', 'ods'].includes(ext)) throw BROKEN();
    return { kind: 'archive' };
  }
  if (sniffed === 'ole') {
    const all = await readAll();
    let cfb: any;
    try {
      cfb = XLSX.CFB.read(all, { type: 'buffer' });
    } catch {
      throw BROKEN();
    }
    const has = (n: string) => !!XLSX.CFB.find(cfb, n);
    if (has('EncryptedPackage') || has('EncryptionInfo')) throw ENCRYPTED();
    if (has('WordDocument')) return { kind: 'document', format: 'doc' };
    if (has('PowerPoint Document')) return { kind: 'slides', format: 'ppt' };
    if (has('Workbook') || has('Book')) return { kind: 'sheet', format: 'xls' };
    if (ext === 'msg') return { kind: 'unknown', cannot: { reason: '邮件文件读不了', advice: '请把邮件正文或附件另存后再交' } };
    if (ext === 'vsd') return { kind: 'design', cannot: CANNOT.design! };
    if (ext === 'msi') return { kind: 'program', cannot: CANNOT.program! };
    return { kind: kind === 'unknown' ? 'unknown' : kind, cannot: CANNOT.unknown! };
  }
  if (sniffed && ['rar', '7z', 'gzip', 'bzip2', 'xz', 'cab'].includes(sniffed)) return { kind: 'archive' };
  if (sniffed === 'pdf') return { kind: 'pdf', format: 'pdf' };
  if (sniffed === 'rtf') return { kind: 'document', format: 'rtf' };
  if (sniffed === 'mhtml') return { kind: 'web', format: 'mhtml' };
  if (sniffed === 'html') return { kind: kind === 'sheet' || kind === 'document' ? kind : 'web', format: 'html' };
  if (sniffed === 'svg') return { kind: 'image', format: 'svg' };
  if (sniffed && SNIFF_KIND[sniffed] === 'image') return { kind: 'image', format: sniffed };
  if (sniffed && SNIFF_KIND[sniffed]) {
    const k = SNIFF_KIND[sniffed]!;
    // 扩展名是文字类而内容是媒体或程序时，以内容为准
    if (CANNOT[k]) return { kind: k, cannot: CANNOT[k]! };
  }
  if (kind === 'archive') {
    if (ext === 'tar' || ext === 'iso' || ext === 'z' || ext === 'lz' || ext === 'lzma' || ext === 'zipx' || ext.startsWith('tar.')) return { kind: 'archive' };
    throw BROKEN();
  }
  if (CANNOT[kind] && kind !== 'unknown') return { kind, cannot: CANNOT[kind]! };
  if (kind === 'image' && ext === 'svg') return { kind: 'image', format: 'svg' };
  if (['document', 'slides', 'sheet', 'pdf', 'ebook', 'image'].includes(kind) && !['csv', 'tsv'].includes(ext)) {
    // 扩展名是 Office 或 PDF，内容却认不出来：多半是文字导出的「伪」文件，按文字试读，否则当作损坏。
    if (looksLikeText(head)) return { kind, format: kind === 'sheet' ? 'csv' : 'text' };
    throw BROKEN();
  }
  if (kind === 'unknown') {
    if (looksLikeText(head)) return { kind: 'text', format: 'text' };
    return { kind: 'unknown', cannot: CANNOT.unknown! };
  }
  const format = kind === 'sheet' ? (ext === 'tsv' ? 'tsv' : 'csv') : kind === 'notebook' ? 'ipynb' : kind === 'mindmap' ? (ext === 'mm' ? 'freemind' : 'xmind') : kind === 'web' ? 'html' : kind;
  return { kind, format };
}

export async function readDocument(name: string, bytes: Uint8Array, r: Exclude<Route, { kind: 'archive' } | { cannot: unknown }>, opts: ReadOptions = {}): Promise<ReadOutput> {
  const out: ReadOutput = { kind: r.kind, blocks: [], notes: [] };
  const md = (text: string) => {
    const t = text.trim();
    if (t) out.blocks.push({ t: 'md', text: t });
  };
  const ext = extOf(name);
  switch (r.format) {
    case 'text':
      md(decodeText(bytes));
      break;
    case 'code':
      md(codeBlock(ext, decodeText(bytes)));
      break;
    case 'ipynb':
      md(notebook(decodeText(bytes)));
      break;
    case 'docx':
      await docx(bytes, out);
      break;
    case 'doc':
      md(await doc(bytes));
      break;
    case 'odt':
      md(await odt(bytes));
      break;
    case 'rtf':
      md(tabTables(rtfToText(decodeLatin(bytes))));
      break;
    case 'pptx':
      await pptx(bytes, out);
      break;
    case 'ppt':
      md(slidesMarkdown(ppt(bytes)));
      break;
    case 'odp':
      md(await odp(bytes));
      break;
    case 'xlsx':
    case 'xls':
    case 'ods':
      md(sheets(bytes, null));
      break;
    case 'csv':
    case 'tsv':
      md(sheets(null, decodeText(bytes), r.format === 'tsv' || (r.format === 'csv' && ext === 'tsv')));
      break;
    case 'pdf':
      await pdf(bytes, out, opts);
      break;
    case 'html':
      md(htmlToMarkdown(decodeText(bytes)) || '');
      break;
    case 'mhtml':
      md(mhtml(bytes));
      break;
    case 'epub':
      md(await epub(bytes));
      break;
    case 'xmind':
      md(await xmind(bytes));
      break;
    case 'freemind':
      md(freemind(decodeText(bytes)));
      break;
    case 'subtitle':
      md(subtitles(ext, decodeText(bytes)));
      break;
    case 'svg':
      md(svgText(decodeText(bytes)));
      break;
    default:
      if (r.kind === 'image') image(bytes, out);
      else md(decodeText(bytes));
  }
  const total = out.blocks.reduce((n, b) => n + (b.t === 'md' ? b.text.length : 0), 0);
  if (total > MAX_CHARS) {
    let left = MAX_CHARS;
    out.blocks = out.blocks.flatMap((b): Block[] => {
      if (b.t !== 'md') return [b];
      if (left <= 0) return [];
      const text = b.text.slice(0, left);
      left -= text.length;
      return [{ t: 'md', text }];
    });
    out.notes.push('内容很长，只收了前面一大部分');
  }
  if (!out.blocks.some((b) => b.t === 'img' || meaningful(b.text) > 0)) {
    if (r.kind === 'pdf' || r.kind === 'image') throw new ReadError('里面没有能读出的文字', '如果是扫描件，请确认页面清晰后再交');
    throw new ReadError('里面没有文字', '');
  }
  return out;
}

const LANG: Record<string, string> = {
  py: 'python', pyw: 'python', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', java: 'java',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', sql: 'sql', go: 'go', rs: 'rust',
  cs: 'csharp', kt: 'kotlin', kts: 'kotlin', swift: 'swift', rb: 'ruby', php: 'php', r: 'r', m: 'matlab', scala: 'scala', lua: 'lua',
  pl: 'perl', sh: 'bash', bash: 'bash', zsh: 'bash', bat: 'batch', cmd: 'batch', ps1: 'powershell', vb: 'vbnet', asm: 'x86asm',
  v: 'verilog', sv: 'verilog', vhd: 'vhdl', vhdl: 'vhdl', dart: 'dart', f90: 'fortran', jl: 'julia', hs: 'haskell', css: 'css',
  scss: 'scss', less: 'less', vue: 'xml', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', xml: 'xml', proto: 'protobuf',
  makefile: 'makefile', dockerfile: 'dockerfile', graphql: 'graphql',
};
export function codeBlock(ext: string, code: string): string {
  const body = code.replace(/\n+$/, '');
  const fence = '`'.repeat(Math.max(3, ...(body.match(/`{3,}/g) || []).map((s) => s.length + 1)));
  return `${fence}${LANG[ext] || ''}\n${body}\n${fence}`;
}

function notebook(src: string): string {
  let nb: any;
  try {
    nb = JSON.parse(src);
  } catch {
    throw BROKEN();
  }
  const lang = String(nb?.metadata?.kernelspec?.language || nb?.metadata?.language_info?.name || 'python').toLowerCase();
  const ext = Object.keys(LANG).find((k) => LANG[k] === lang) || (lang === 'python' ? 'py' : '');
  const join = (v: unknown) => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '');
  const parts: string[] = [];
  for (const cell of Array.isArray(nb?.cells) ? nb.cells : []) {
    const source = join(cell.source).replace(/\n+$/, '');
    if (!source.trim()) continue;
    if (cell.cell_type === 'markdown' || cell.cell_type === 'raw') parts.push(source);
    else if (cell.cell_type === 'code') {
      parts.push(codeBlock(ext, source));
      const outputs = (Array.isArray(cell.outputs) ? cell.outputs : [])
        .map((o: any) => (o.output_type === 'stream' ? join(o.text) : join(o.data?.['text/plain']) || (o.ename ? `${o.ename}: ${o.evalue}` : '')))
        .join('')
        .trim();
      if (outputs) parts.push('运行结果：\n\n' + codeBlock('', outputs.length > 3000 ? outputs.slice(0, 3000) + '\n…' : outputs));
    }
  }
  return parts.join('\n\n');
}

/** Word 表格转出来是一行一格、用制表符隔开的，连着几行就拼成表格。 */
export function tabTables(text: string): string {
  const lines = normalizeNewlines(text).split('\n');
  const out: string[] = [];
  let table: string[][] = [];
  const flush = () => {
    if (table.length >= 2) out.push('', markdownTable(table.map((r) => r.map((c) => c.trim().replace(/\|/g, '\\|')))), '');
    else for (const r of table) out.push(r.join(' '));
    table = [];
  };
  for (const line of lines) {
    const cells = line.replace(/\t+$/, '').split('\t');
    if (cells.length >= 2) table.push(cells);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function openZip(bytes: Uint8Array) {
  return JSZip.loadAsync(bytes, { checkCRC32: false });
}
async function zipText(z: JSZip, path: string): Promise<string | null> {
  const f = z.file(path) || z.file(Object.keys(z.files).find((k) => k.toLowerCase() === path.toLowerCase()) || '');
  return f ? f.async('string') : null;
}
const zipBytes = async (z: JSZip, path: string) => {
  const f = z.file(path);
  return f ? new Uint8Array(await f.async('uint8array')) : null;
};

async function docx(bytes: Uint8Array, out: ReadOutput) {
  const mammoth: any = await import('mammoth');
  const lib = mammoth.convertToHtml ? mammoth : mammoth.default;
  const images: { data: Uint8Array; type: string }[] = [];
  let html: string;
  try {
    const r = await lib.convertToHtml(
      { buffer: Buffer.from(bytes) },
      {
        externalFileAccess: false,
        convertImage: lib.images.imgElement(async (image: any) => {
          try {
            images.push({ data: new Uint8Array(await image.read()), type: image.contentType });
          } catch {}
          return { src: '' };
        }),
      },
    );
    html = r.value;
  } catch {
    throw BROKEN();
  }
  const text = htmlToMarkdown(html);
  if (text) out.blocks.push({ t: 'md', text });
  // 整份文档几乎只有贴进去的图片（扫描页贴进 Word 很常见）时，才去看图。
  if (meaningful(text) < 100 && images.length) addVision(out, images.map((i) => i.data), (k) => `第 ${k + 1} 张图`);
}

async function doc(bytes: Uint8Array): Promise<string> {
  const WordExtractor = (await import('word-extractor')).default as any;
  let d: any;
  try {
    d = await new WordExtractor().extract(Buffer.from(bytes));
  } catch (err) {
    if (/encrypt|password/i.test(String((err as Error)?.message))) throw ENCRYPTED();
    throw BROKEN();
  }
  const parts = [d.getBody(), d.getTextboxes?.({ includeHeadersAndFooters: false, includeBody: true }), d.getFootnotes(), d.getEndnotes()]
    .map((s: unknown) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);
  return tabTables(parts.join('\n\n'));
}

function decodeLatin(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('latin1');
}

function odfBlocks(node: XNode, out: string[]) {
  for (const c of elements(node)) {
    const name = local(c.name);
    if (name === 'h') {
      const level = Math.min(6, Number(attr(c, 'outline-level')) || 1);
      const t = odfInline(c).trim();
      if (t) out.push('#'.repeat(level) + ' ' + t);
    } else if (name === 'p') {
      const t = odfInline(c).trim();
      if (t) out.push(t);
    } else if (name === 'list') {
      const items: string[] = [];
      for (const item of childrenNamed(c, 'list-item')) {
        const inner: string[] = [];
        odfBlocks(item, inner);
        if (inner.length) items.push('- ' + inner.join('\n  '));
      }
      if (items.length) out.push(items.join('\n'));
    } else if (name === 'table') {
      const rows: string[][] = [];
      for (const row of findAll(c, 'table-row')) {
        const cells: string[] = [];
        for (const cell of childrenNamed(row, 'table-cell')) {
          const inner: string[] = [];
          odfBlocks(cell, inner);
          const repeat = Math.min(Number(attr(cell, 'number-columns-repeated')) || 1, 20);
          const text = inner.join(' ').replace(/^- /gm, '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
          for (let k = 0; k < repeat; k++) cells.push(text);
        }
        while (cells.length && !cells[cells.length - 1]) cells.pop();
        if (cells.some(Boolean)) rows.push(cells);
      }
      const t = markdownTable(rows);
      if (t) out.push(t);
    } else if (['section', 'text', 'body', 'frame', 'text-box', 'g', 'custom-shape', 'index-body', 'table-of-content'].includes(name)) odfBlocks(c, out);
  }
}
function odfInline(node: XNode): string {
  return node.children
    .map((c) => {
      if (typeof c === 'string') return c;
      const n = local(c.name);
      if (n === 's') return ' '.repeat(Math.min(Number(attr(c, 'c')) || 1, 8));
      if (n === 'tab') return '\t';
      if (n === 'line-break') return '\n';
      if (n === 'note') return '';
      return odfInline(c);
    })
    .join('');
}
async function odt(bytes: Uint8Array) {
  const z = await openZip(bytes).catch(() => {
    throw BROKEN();
  });
  const xml = await zipText(z, 'content.xml');
  if (!xml) throw BROKEN();
  if (xml.includes('manifest:encryption-data') || (await zipText(z, 'META-INF/manifest.xml'))?.includes('encryption-data')) throw ENCRYPTED();
  const body = findFirst(parseXml(xml), 'text');
  const out: string[] = [];
  if (body) odfBlocks(body, out);
  return out.join('\n\n');
}

async function odp(bytes: Uint8Array) {
  const z = await openZip(bytes).catch(() => {
    throw BROKEN();
  });
  const xml = await zipText(z, 'content.xml');
  if (!xml) throw BROKEN();
  const slides: PptSlide[] = [];
  for (const page of findAll(parseXml(xml), 'page')) {
    let title = '';
    const texts: string[] = [];
    const notes: string[] = [];
    for (const frame of elements(page)) {
      if (local(frame.name) === 'notes') {
        const inner: string[] = [];
        for (const f of findAll(frame, 'frame')) if (attr(f, 'class') === 'notes') odfBlocks(f, inner);
        notes.push(...inner);
        continue;
      }
      const inner: string[] = [];
      odfBlocks({ ...frame, children: [frame] }, inner);
      if (!inner.length) continue;
      if (!title && attr(frame, 'class') === 'title') title = inner.join(' ');
      else texts.push(inner.join('\n'));
    }
    slides.push({ title, texts, notes });
  }
  return slidesMarkdown(slides);
}

function ppt(bytes: Uint8Array): PptSlide[] {
  let cfb: any;
  try {
    cfb = XLSX.CFB.read(bytes, { type: 'buffer' });
  } catch {
    throw BROKEN();
  }
  const doc = XLSX.CFB.find(cfb, 'PowerPoint Document');
  if (!doc) throw BROKEN();
  if (XLSX.CFB.find(cfb, 'EncryptedSummary')) throw ENCRYPTED();
  const cu = XLSX.CFB.find(cfb, 'Current User');
  try {
    return readPptStreams(new Uint8Array(doc.content as unknown as ArrayLike<number>), cu ? new Uint8Array(cu.content as unknown as ArrayLike<number>) : null);
  } catch (err) {
    if (err instanceof PptEncrypted) throw ENCRYPTED();
    throw BROKEN();
  }
}

export function slidesMarkdown(slides: PptSlide[]): string {
  return slides
    .map((s, i) => {
      const head = `## 第 ${i + 1} 页${s.title ? ' · ' + s.title.replace(/\s+/g, ' ').trim() : ''}`;
      const body = s.texts.map((t) => t.trim()).filter(Boolean).join('\n\n');
      const notes = s.notes.length ? '备注：' + s.notes.join('\n') : '';
      return [head, body, notes].filter(Boolean).join('\n\n');
    })
    .join('\n\n');
}

async function pptx(bytes: Uint8Array, out: ReadOutput) {
  let z: JSZip;
  try {
    z = await openZip(bytes);
  } catch {
    throw BROKEN();
  }
  const rels = async (path: string) => {
    const dir = path.slice(0, path.lastIndexOf('/') + 1);
    const relPath = dir + '_rels/' + path.slice(dir.length) + '.rels';
    const xml = await zipText(z, relPath);
    const map = new Map<string, { type: string; target: string }>();
    if (!xml) return map;
    for (const r of findAll(parseXml(xml), 'Relationship')) {
      const target = r.attrs.Target || '';
      map.set(r.attrs.Id, { type: (r.attrs.Type || '').split('/').pop() || '', target: r.attrs.TargetMode === 'External' ? '' : resolvePath(dir, target) });
    }
    return map;
  };
  const presentation = await zipText(z, 'ppt/presentation.xml');
  if (!presentation) throw BROKEN();
  const pres = parseXml(presentation);
  const presRels = await rels('ppt/presentation.xml');
  const size = findFirst(pres, 'sldSz');
  const slideArea = (Number(size?.attrs.cx) || 9144000) * (Number(size?.attrs.cy) || 6858000);
  const order = findAll(pres, 'sldId')
    .map((s) => presRels.get(Object.entries(s.attrs).find(([k]) => k.endsWith(':id'))?.[1] || ''))
    .filter((r): r is { type: string; target: string } => !!r && r.type === 'slide')
    .map((r) => r.target);
  const slides: (PptSlide & { pictures: { target: string; area: number }[] })[] = [];
  for (const path of order) {
    const xml = await zipText(z, path);
    if (!xml) continue;
    const tree = parseXml(xml);
    const slideRels = await rels(path);
    let title = '';
    const texts: string[] = [];
    const pictures: { target: string; area: number }[] = [];
    const diagramTexts: { slide: number; target: string }[] = [];
    const walk = (node: XNode) => {
      for (const c of elements(node)) {
        const n = local(c.name);
        if (n === 'sp') {
          const ph = findFirst(c, 'ph');
          const type = ph?.attrs.type || '';
          if (['sldNum', 'dt', 'ftr', 'hdr'].includes(type)) continue;
          const body = child(c, 'txBody');
          const t = body ? drawingText(body) : '';
          if (!t.trim()) continue;
          if (!title && (type === 'title' || type === 'ctrTitle')) title = t.replace(/\s+/g, ' ').trim();
          else texts.push(t);
        } else if (n === 'graphicFrame') {
          const tbl = findFirst(c, 'tbl');
          if (tbl) {
            const rows = childrenNamed(tbl, 'tr').map((tr) => childrenNamed(tr, 'tc').map((tc) => drawingText(tc).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')));
            const t = markdownTable(rows.filter((r) => r.some(Boolean)));
            if (t) texts.push(t);
            continue;
          }
          const dgm = findFirst(c, 'relIds');
          const dataRel = dgm ? slideRels.get(dgm.attrs['r:dm']) : undefined;
          if (dataRel) diagramTexts.push({ slide: slides.length, target: dataRel.target });
        } else if (n === 'pic') {
          const blip = findFirst(c, 'blip');
          const rel = blip ? slideRels.get(blip.attrs['r:embed']) : undefined;
          const ext = findFirst(c, 'ext');
          if (rel?.target) pictures.push({ target: rel.target, area: (Number(ext?.attrs.cx) || 0) * (Number(ext?.attrs.cy) || 0) });
        } else if (n === 'Fallback') continue;
        else if (!['clrMapOvr', 'timing', 'transition', 'extLst', 'bg', 'nvGrpSpPr', 'grpSpPr'].includes(n)) walk(c);
      }
    };
    walk(tree);
    for (const d of diagramTexts) {
      const dx = await zipText(z, d.target);
      if (dx) {
        const parts = findAll(parseXml(dx), 't')
          .map((t) => textContent(t).trim())
          .filter(Boolean);
        if (parts.length) texts.push(parts.map((p) => '- ' + p).join('\n'));
      }
    }
    const notesRel = [...slideRels.values()].find((r) => r.type === 'notesSlide');
    const notes: string[] = [];
    if (notesRel) {
      const nx = await zipText(z, notesRel.target);
      if (nx)
        for (const sp of findAll(parseXml(nx), 'sp')) {
          const ph = findFirst(sp, 'ph');
          if (ph?.attrs.type !== 'body') continue;
          const body = child(sp, 'txBody');
          const t = body ? drawingText(body).trim() : '';
          if (t) notes.push(t);
        }
    }
    slides.push({ title, texts, notes, pictures });
  }
  if (!slides.length) throw BROKEN();
  // 一页几乎没有字、主要是一张大图时（截图、扫描页做成的课件），才请模型看这张图。
  let budget = MAX_VISION_PER_FILE;
  const blocks: Block[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length) blocks.push({ t: 'md', text: buffer.join('\n\n') });
    buffer = [];
  };
  for (const [i, s] of slides.entries()) {
    buffer.push(slidesMarkdown([s]).replace(/^## 第 1 页/, `## 第 ${i + 1} 页`));
    const words = meaningful(s.texts.join(''));
    const big = s.pictures.filter((p) => p.area >= slideArea * 0.25).sort((a, b) => b.area - a.area)[0];
    if (words < 15 && big && budget > 0) {
      const data = await zipBytes(z, big.target);
      if (!data) continue;
      try {
        const images = prepareImage(data);
        flush();
        for (const [k, img] of images.entries()) {
          if (budget-- <= 0) break;
          blocks.push({ t: 'img', key: sha(img.data), label: `第 ${i + 1} 页的图片${images.length > 1 ? `（${k + 1}）` : ''}`, image: img });
        }
      } catch {
        out.notes.push(`第 ${i + 1} 页的图片读不了`);
      }
    }
  }
  flush();
  if (budget <= 0) out.notes.push('图片太多，后面几页的图片没有看');
  out.blocks.push(...blocks);
}

/** 幻灯片、表格单元格里的段落：保留项目符号层级。 */
function drawingText(node: XNode): string {
  const lines: string[] = [];
  for (const p of findAll(node, 'p')) {
    const parts: string[] = [];
    for (const c of elements(p)) {
      const n = local(c.name);
      if (n === 'r' || n === 'fld') parts.push(textContent(child(c, 't') || { name: '', attrs: {}, children: [] }));
      else if (n === 'br') parts.push('\n');
    }
    const t = parts.join('').replace(/[ \t]+/g, ' ').trim();
    if (!t) continue;
    const ppr = child(p, 'pPr');
    const lvl = Number(ppr?.attrs.lvl) || 0;
    const bullet = ppr && (child(ppr, 'buChar') || child(ppr, 'buAutoNum')) && !child(ppr, 'buNone');
    lines.push(lvl || bullet ? '  '.repeat(lvl) + '- ' + t : t);
  }
  return lines.join('\n');
}

function resolvePath(dir: string, target: string) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (dir + target).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

function sheets(bytes: Uint8Array | null, text: string | null, tsv = false): string {
  let wb: XLSX.WorkBook;
  try {
    wb = bytes
      ? XLSX.read(bytes, { type: 'buffer', cellDates: true, cellHTML: false, cellFormula: false, sheetStubs: false, dense: true })
      : XLSX.read(text!, { type: 'string', raw: false, dense: true, cellDates: true, ...(tsv ? { FS: '\t' } : {}) });
  } catch (err) {
    if (/password|encrypt/i.test(String((err as Error)?.message))) throw ENCRYPTED();
    throw BROKEN();
  }
  const parts: string[] = [];
  const many = wb.SheetNames.length > 1;
  let truncated = false;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '', blankrows: false, dateNF: 'yyyy-mm-dd' });
    const clean = rows
      .map((r) => (Array.isArray(r) ? r : []).slice(0, MAX_SHEET_COLS).map((v) => String(v ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()))
      .filter((r) => r.some(Boolean));
    if (!clean.length) continue;
    let width = 0;
    for (const r of clean) for (let k = r.length - 1; k >= 0; k--) if (r[k]) { width = Math.max(width, k + 1); break; }
    let used = clean.map((r) => r.slice(0, width));
    if (used.length > MAX_SHEET_ROWS) {
      used = used.slice(0, MAX_SHEET_ROWS);
      truncated = true;
    }
    const table = width === 1 ? used.map((r) => r[0]).join('\n') : markdownTable(used);
    parts.push((many ? `## ${name}\n\n` : '') + table);
  }
  if (truncated) parts.push('（表格很长，每张表只收了前 ' + MAX_SHEET_ROWS + ' 行）');
  return parts.join('\n\n');
}

async function pdf(bytes: Uint8Array, out: ReadOutput, opts: ReadOptions) {
  const { getDocumentProxy, extractImages } = await import('unpdf');
  let doc: any;
  try {
    doc = await getDocumentProxy(new Uint8Array(bytes), {
      ...(opts.pdfAssets ? { cMapUrl: opts.pdfAssets.cMapUrl, cMapPacked: true, standardFontDataUrl: opts.pdfAssets.standardFontDataUrl, wasmUrl: opts.pdfAssets.wasmUrl } : {}),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    } as any);
  } catch (err) {
    const name = (err as Error)?.name || '';
    if (/Password/i.test(name) || /password/i.test(String((err as Error)?.message))) throw ENCRYPTED();
    throw BROKEN();
  }
  try {
    const pages: number = doc.numPages;
    let budget = MAX_VISION_PER_FILE;
    const empty: number[] = [];
    let buffer: string[] = [];
    const flush = () => {
      if (buffer.length) out.blocks.push({ t: 'md', text: buffer.join('\n\n') });
      buffer = [];
    };
    for (let n = 1; n <= pages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items as any[]) {
        if (typeof item.str !== 'string') continue;
        text += item.str + (item.hasEOL ? '\n' : '');
      }
      text = normalizeNewlines(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      const garbled = text.length > 0 && (text.match(/[�-]/g) || []).length / text.length > 0.2;
      if (garbled) text = '';
      if (meaningful(text) >= 20) {
        buffer.push(`## 第 ${n} 页\n\n${text}`);
        page.cleanup?.();
        continue;
      }
      let images: { data: Uint8ClampedArray; width: number; height: number; channels: number }[] = [];
      try {
        images = (await extractImages(doc, n)) as any;
      } catch {}
      const largest = Math.max(0, ...images.map((i) => i.width * i.height));
      const useful = images.filter((i) => i.width >= 200 && i.height >= 200 && i.width * i.height >= largest * 0.25);
      if (!useful.length || budget <= 0) {
        if (text) buffer.push(`## 第 ${n} 页\n\n${text}`);
        else if (!useful.length) empty.push(n);
        page.cleanup?.();
        continue;
      }
      buffer.push(`## 第 ${n} 页${text ? '\n\n' + text : ''}`);
      flush();
      for (const img of useful) {
        if (budget <= 0) break;
        const raster = fromChannels(img.width, img.height, img.data, img.channels);
        for (const t of tiles(raster)) {
          if (budget-- <= 0) break;
          const jpg = toJpeg(t);
          out.blocks.push({ t: 'img', key: sha(jpg.data), label: `第 ${n} 页`, image: jpg });
        }
      }
      page.cleanup?.();
    }
    flush();
    if (budget <= 0) out.notes.push('扫描页太多，后面的页没有读');
    if (empty.length && empty.length < pages) out.notes.push(`${pageList(empty)}没有文字`);
  } finally {
    await doc.destroy?.().catch?.(() => {});
  }
}

export function pageList(pages: number[]): string {
  if (pages.length > 6) return `第 ${pages.slice(0, 5).join('、')} 页等 ${pages.length} 页`;
  return `第 ${pages.join('、')} 页`;
}

function mhtml(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1');
  const boundary = raw.match(/boundary="?([^";\r\n]+)"?/i)?.[1];
  const parts = boundary ? raw.split('--' + boundary) : [raw];
  for (const part of parts) {
    const split = part.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const head = part.slice(0, split);
    if (!/content-type:\s*text\/html/i.test(head)) continue;
    let body = part.slice(split).replace(/^\r?\n\r?\n/, '');
    let buf: Buffer;
    if (/content-transfer-encoding:\s*base64/i.test(head)) buf = Buffer.from(body.replace(/\s+/g, ''), 'base64');
    else if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) {
      body = body.replace(/=\r?\n/g, '');
      buf = Buffer.from(body.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    } else buf = Buffer.from(body, 'latin1');
    return htmlToMarkdown(decodeText(buf));
  }
  throw BROKEN();
}

async function epub(bytes: Uint8Array): Promise<string> {
  const z = await openZip(bytes).catch(() => {
    throw BROKEN();
  });
  if (z.file('META-INF/encryption.xml')) {
    const enc = (await zipText(z, 'META-INF/encryption.xml')) || '';
    if (/EncryptedData/.test(enc) && !/obfuscation|font/i.test(enc)) throw new ReadError('这本电子书有版权保护，打不开', '请交没有加密的版本或纸质书的扫描件');
  }
  const container = await zipText(z, 'META-INF/container.xml');
  const opfPath = container ? findFirst(parseXml(container), 'rootfile')?.attrs['full-path'] : undefined;
  const opfXml = opfPath ? await zipText(z, opfPath) : null;
  if (!opfPath || !opfXml) throw BROKEN();
  const opf = parseXml(opfXml);
  const dir = opfPath.slice(0, opfPath.lastIndexOf('/') + 1);
  const manifest = new Map(findAll(opf, 'item').map((i) => [i.attrs.id, i.attrs.href]));
  const title = textContent(findFirst(opf, 'title') || { name: '', attrs: {}, children: [] }).trim();
  const parts: string[] = title ? [`# ${title}`] : [];
  for (const ref of findAll(opf, 'itemref')) {
    const href = manifest.get(ref.attrs.idref);
    if (!href) continue;
    const html = await zipText(z, resolvePath(dir, decodeURIComponent(href)));
    if (html) {
      const md = htmlToMarkdown(html);
      if (md) parts.push(md);
    }
  }
  return parts.join('\n\n');
}

async function xmind(bytes: Uint8Array): Promise<string> {
  const z = await openZip(bytes).catch(() => {
    throw BROKEN();
  });
  const lines: string[] = [];
  const json = await zipText(z, 'content.json');
  if (json) {
    let sheets: any[];
    try {
      sheets = JSON.parse(json);
    } catch {
      throw BROKEN();
    }
    const walk = (topic: any, depth: number) => {
      if (!topic) return;
      const t = String(topic.title ?? '').trim();
      if (t) lines.push(depth === 0 ? `## ${t}` : '  '.repeat(depth - 1) + '- ' + t.replace(/\n/g, ' '));
      const note = topic.notes?.plain?.content;
      if (typeof note === 'string' && note.trim()) lines.push('  '.repeat(Math.max(0, depth)) + '  ' + note.trim().replace(/\n/g, ' '));
      for (const c of topic.children?.attached || []) walk(c, depth + 1);
    };
    for (const s of Array.isArray(sheets) ? sheets : []) walk(s.rootTopic, 0);
    return lines.join('\n');
  }
  const xml = await zipText(z, 'content.xml');
  if (!xml) throw BROKEN();
  const walk = (topic: XNode, depth: number) => {
    const t = textContent(child(topic, 'title') || { name: '', attrs: {}, children: [] }).trim();
    if (t) lines.push(depth === 0 ? `## ${t}` : '  '.repeat(depth - 1) + '- ' + t.replace(/\n/g, ' '));
    const kids = child(topic, 'children');
    if (kids) for (const group of childrenNamed(kids, 'topics')) for (const c of childrenNamed(group, 'topic')) walk(c, depth + 1);
  };
  for (const sheet of findAll(parseXml(xml), 'sheet')) {
    const root = child(sheet, 'topic');
    if (root) walk(root, 0);
  }
  return lines.join('\n');
}

function freemind(src: string): string {
  const lines: string[] = [];
  const walk = (node: XNode, depth: number) => {
    for (const c of childrenNamed(node, 'node')) {
      const t = (c.attrs.TEXT || textContent(child(c, 'richcontent') || { name: '', attrs: {}, children: [] })).trim();
      if (t) lines.push(depth === 0 ? `## ${t}` : '  '.repeat(depth - 1) + '- ' + t.replace(/\s+/g, ' '));
      walk(c, depth + 1);
    }
  };
  const map = findFirst(parseXml(src), 'map');
  if (!map) throw BROKEN();
  walk(map, 0);
  return lines.join('\n');
}

function subtitles(ext: string, src: string): string {
  const lines: string[] = [];
  for (const raw of src.split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    if (ext === 'ass' || ext === 'ssa') {
      if (!/^Dialogue:/i.test(line)) continue;
      line = line.split(',').slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, ' ').trim();
    } else if (ext === 'lrc') {
      line = line.replace(/\[[^\]]*\]/g, '').trim();
    } else {
      if (/^\d+$/.test(line) || /^WEBVTT/i.test(line) || /^(NOTE|STYLE|REGION)\b/.test(line)) continue;
      if (/\d{1,2}:\d{2}(:\d{2})?[.,]\d{1,3}\s*(-->|,)/.test(line)) continue;
      line = line.replace(/<[^>]+>/g, '').trim();
    }
    if (line && lines[lines.length - 1] !== line) lines.push(line);
  }
  return lines.join('\n');
}

function svgText(src: string): string {
  const tree = parseXml(src);
  const parts = [...findAll(tree, 'title'), ...findAll(tree, 'desc'), ...findAll(tree, 'text')]
    .map((t) => textContent(t).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return [...new Set(parts)].join('\n');
}

function image(bytes: Uint8Array, out: ReadOutput) {
  let images: VisionImage[];
  try {
    images = prepareImage(bytes);
  } catch (err) {
    const code = err instanceof ImageError ? err.code : 'corrupt';
    if (code === 'heic') throw new ReadError('苹果手机的照片格式读不了', '用微信把照片发到电脑上，或把相机格式改成「兼容性最佳」后再交');
    if (code === 'tiny') throw new ReadError('图片太小，看不出内容', '', true);
    if (code === 'toolarge') throw new ReadError('图片太大，读不了', '请缩小后再交');
    if (code === 'unsupported') throw new ReadError('这种图片格式读不了', '请另存为 JPG 或 PNG 再交');
    throw BROKEN();
  }
  if (!images.length) throw new ReadError('图片太小，看不出内容', '', true);
  images.slice(0, MAX_VISION_PER_FILE).forEach((img, k) =>
    out.blocks.push({ t: 'img', key: sha(img.data), label: images.length > 1 ? `第 ${k + 1} 段` : '', image: img }),
  );
}

function addVision(out: ReadOutput, list: Uint8Array[], label: (k: number) => string) {
  let n = 0;
  for (const [k, data] of list.entries()) {
    if (n >= MAX_VISION_PER_FILE) break;
    try {
      for (const img of prepareImage(data)) {
        if (img.width < MIN_SIDE * 5 && img.height < MIN_SIDE * 5) continue;
        out.blocks.push({ t: 'img', key: sha(img.data), label: label(k), image: img });
        n++;
      }
    } catch {}
  }
}

export const kindLabel = (k: Kind) => KIND_LABEL[k];
