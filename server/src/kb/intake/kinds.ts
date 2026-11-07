/** 老师交来的东西是什么类型、能不能读、读不了怎么跟老师说。 */
export type Kind =
  | 'text'
  | 'code'
  | 'notebook'
  | 'document'
  | 'slides'
  | 'sheet'
  | 'pdf'
  | 'web'
  | 'ebook'
  | 'mindmap'
  | 'subtitle'
  | 'image'
  | 'archive'
  | 'video'
  | 'audio'
  | 'cnki'
  | 'iwork'
  | 'program'
  | 'design'
  | 'font'
  | 'shortcut'
  | 'database'
  | 'partial'
  | 'unknown';

/** 同一文件夹里重名时附在名字后面，老师一眼看得出是哪一份。 */
export const KIND_LABEL: Record<Kind, string> = {
  text: '文本',
  code: '代码',
  notebook: '代码笔记本',
  document: '文档',
  slides: '幻灯片',
  sheet: '表格',
  pdf: 'PDF',
  web: '网页',
  ebook: '电子书',
  mindmap: '思维导图',
  subtitle: '字幕',
  image: '图片',
  archive: '压缩包',
  video: '视频',
  audio: '录音',
  cnki: '知网文献',
  iwork: '苹果办公文档',
  program: '程序',
  design: '设计图',
  font: '字体',
  shortcut: '快捷方式',
  database: '数据库',
  partial: '未下载完的文件',
  unknown: '文件',
};

const EXT: Record<string, Kind> = {};
const add = (kind: Kind, list: string) => list.split(' ').forEach((e) => (EXT[e] = kind));
add('text', 'txt md markdown text log me nfo tex bib rst adoc org');
add(
  'code',
  'py pyw c h cc cpp cxx hpp hh hxx java js mjs cjs jsx ts tsx sql go rs cs kt kts swift rb php r m mm scala lua pl pm sh bash zsh bat cmd ps1 vb vbs asm s v sv vhd vhdl dart f f90 f95 for jl hs ml erl ex exs clj groovy gradle css scss less vue svelte json jsonc yaml yml toml ini cfg conf properties xml xsd xsl csproj sln makefile mk cmake dockerfile proto graphql gql ipynb_checkpoints',
);
add('notebook', 'ipynb');
add('document', 'docx docm dotx dotm doc dot wps wpt odt ott rtf');
add('slides', 'pptx pptm ppsx ppsm potx potm ppt pps pot dps dpt odp otp');
add('sheet', 'xlsx xlsm xltx xltm xlsb xls xlt et ett ods ots csv tsv');
add('pdf', 'pdf');
add('web', 'html htm xhtml mht mhtml shtml');
add('ebook', 'epub');
add('mindmap', 'xmind mm');
add('subtitle', 'srt vtt ass ssa lrc sbv');
add('image', 'png jpg jpeg jpe jfif gif bmp dib webp tif tiff heic heif svg');
add('archive', 'zip rar 7z tar gz tgz bz2 tbz tbz2 xz txz lz lzma z cab iso zipx');
add('video', 'mp4 m4v avi mov wmv flv f4v mkv rmvb rm mpg mpeg mpe 3gp 3g2 webm vob mts m2ts ogv asf swf');
add('audio', 'mp3 wav wma aac flac m4a ogg oga opus amr ape aiff aif mid midi');
add('cnki', 'caj kdh nh caa teb');
add('iwork', 'pages key numbers');
add('program', 'exe msi dll sys apk ipa dmg pkg deb rpm appimage com scr jar class so o obj lib a bin');
add('design', 'psd ai cdr sketch fig xd dwg dxf skp max blend fbx stl 3ds c4d indd eps vsd vsdx mpp');
add('font', 'ttf otf woff woff2 ttc fon');
add('shortcut', 'lnk url webloc desktop');
add('database', 'mdb accdb db sqlite sqlite3 dbf frm myd ibd');
add('partial', 'crdownload part download tmp temp partial');

export function extOf(name: string): string {
  const base = name.split('/').pop() || name;
  const lower = base.toLowerCase();
  if (/\.tar\.(gz|bz2|xz|lz|lzma|z)$/.test(lower)) return 'tar.' + lower.split('.').pop();
  if (lower === 'makefile' || lower === 'dockerfile') return lower;
  const dot = lower.lastIndexOf('.');
  return dot > 0 ? lower.slice(dot + 1) : '';
}
export const baseName = (name: string) => {
  const base = name.split('/').pop() || name;
  const lower = base.toLowerCase();
  const tar = lower.match(/\.tar\.(gz|bz2|xz|lz|lzma|z)$/);
  if (tar) return base.slice(0, base.length - tar[0].length);
  const dot = base.lastIndexOf('.');
  return dot > 0 && extOf(base) && kindFromExt(extOf(base)) !== 'unknown' ? base.slice(0, dot) : base;
};
export function kindFromExt(ext: string): Kind {
  if (ext.startsWith('tar.')) return 'archive';
  return Object.hasOwn(EXT, ext) ? EXT[ext] : 'unknown';
}

/** 电脑自动生成、老师在自己电脑上看不见的文件，不当作资料。 */
export function isSystemJunk(path: string): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  if (parts.some((p) => p === '__MACOSX' || p === '.git' || p === '.svn' || p === '__pycache__' || p === 'node_modules' || p === '.ipynb_checkpoints'))
    return true;
  if (/^(\.DS_Store|Thumbs\.db|ehthumbs\.db|desktop\.ini|\.localized|Icon\r)$/i.test(name)) return true;
  if (name.startsWith('~$') || name.startsWith('._') || name.startsWith('.~')) return true;
  if (/\.(pyc|pyo|class|o|obj|swp|swo)$/i.test(name) && parts.length > 1) return true;
  return false;
}

/** 打开文件头几个字节判断真实类型：扩展名写错、被改过或丢了扩展名时以内容为准。 */
export type Sniffed =
  | 'zip'
  | 'ole'
  | 'pdf'
  | 'rtf'
  | 'html'
  | 'mhtml'
  | 'rar'
  | '7z'
  | 'gzip'
  | 'bzip2'
  | 'xz'
  | 'cab'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'bmp'
  | 'tiff'
  | 'webp'
  | 'heic'
  | 'mp4'
  | 'riff-media'
  | 'mpeg-ts'
  | 'ebml'
  | 'flv'
  | 'mp3'
  | 'ogg'
  | 'flac'
  | 'caj'
  | 'pe'
  | 'elf'
  | 'sqlite'
  | 'psd'
  | 'svg'
  | 'xml'
  | null;
export function sniff(b: Uint8Array): Sniffed {
  const at = (s: string, off = 0) => s.split('').every((c, i) => b[off + i] === c.charCodeAt(0));
  const hex = (h: number[], off = 0) => h.every((v, i) => b[off + i] === v);
  if (hex([0x50, 0x4b, 0x03, 0x04]) || hex([0x50, 0x4b, 0x05, 0x06]) || hex([0x50, 0x4b, 0x07, 0x08])) return 'zip';
  if (hex([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  if (hex([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar';
  if (hex([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (hex([0x1f, 0x8b])) return 'gzip';
  if (at('BZh')) return 'bzip2';
  if (hex([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'xz';
  if (at('MSCF')) return 'cab';
  if (hex([0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (hex([0xff, 0xd8, 0xff])) return 'jpeg';
  if (at('GIF8')) return 'gif';
  if (at('BM') && b.length > 26) return 'bmp';
  if (at('II*\0') || at('MM\0*')) return 'tiff';
  if (at('RIFF') && at('WEBP', 8)) return 'webp';
  if (at('RIFF') && (at('AVI ', 8) || at('WAVE', 8))) return 'riff-media';
  if (at('ftyp', 4)) {
    const brand = String.fromCharCode(...b.subarray(8, 12));
    return /^(heic|heix|hevc|heim|heis|mif1|msf1|avif)$/.test(brand) ? 'heic' : 'mp4';
  }
  if (hex([0x1a, 0x45, 0xdf, 0xa3])) return 'ebml';
  if (at('FLV')) return 'flv';
  if (at('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && b.length > 1000 && !hex([0xff, 0xd8]))) return 'mp3';
  if (at('OggS')) return 'ogg';
  if (at('fLaC')) return 'flac';
  if (at('CAJ') || at('KDH ')) return 'caj';
  if (b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47) return 'mpeg-ts';
  if (at('MZ')) return 'pe';
  if (hex([0x7f, 0x45, 0x4c, 0x46])) return 'elf';
  if (at('SQLite format 3')) return 'sqlite';
  if (at('8BPS')) return 'psd';
  const head = Buffer.from(b.subarray(0, 2048)).toString('latin1');
  if (head.slice(0, 1024).includes('%PDF-')) return 'pdf';
  const lower = head.replace(/^﻿|^\xef\xbb\xbf/, '').trimStart().toLowerCase();
  if (lower.startsWith('{\\rtf')) return 'rtf';
  if (/^mime-version:/m.test(lower.slice(0, 1024)) && /multipart\/related/.test(lower)) return 'mhtml';
  if (lower.startsWith('<!doctype html') || lower.startsWith('<html') || /^<\?xml[^>]*>\s*(<!doctype html|<html)/.test(lower)) return 'html';
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(lower)) return 'svg';
  if (lower.startsWith('<?xml')) return 'xml';
  if (/^<(head|body|meta|table|div|p)[\s>]/.test(lower)) return 'html';
  return null;
}

/** 读不了的类型各自怎么跟老师说。 */
export const CANNOT: Partial<Record<Kind, { reason: string; advice: string }>> = {
  video: { reason: '视频里的内容读不了', advice: '可以把讲稿、字幕或课件交上来' },
  audio: { reason: '录音里的内容读不了', advice: '可以把讲稿或文字记录交上来' },
  cnki: { reason: '知网专用格式读不了', advice: '请在知网选「PDF下载」后再交' },
  iwork: { reason: '苹果办公软件的格式读不了', advice: '请在原软件里导出成 Word、PPT、Excel 或 PDF 再交' },
  program: { reason: '这是程序或安装包，不是资料', advice: '' },
  design: { reason: '设计软件的文件读不了', advice: '请导出成图片或 PDF 再交' },
  font: { reason: '这是字体文件，不是资料', advice: '' },
  shortcut: { reason: '这是快捷方式，不是文件本身', advice: '请交原来的文件' },
  database: { reason: '数据库文件读不了', advice: '请导出成表格再交' },
  partial: { reason: '文件没有下载完整', advice: '请重新下载后再交' },
  unknown: { reason: '不认识这种文件', advice: '请转成文档、幻灯片、表格、PDF 或图片再交' },
};
export const SNIFF_KIND: Partial<Record<Exclude<Sniffed, null>, Kind>> = {
  pdf: 'pdf',
  rtf: 'document',
  html: 'web',
  mhtml: 'web',
  rar: 'archive',
  '7z': 'archive',
  gzip: 'archive',
  bzip2: 'archive',
  xz: 'archive',
  cab: 'archive',
  png: 'image',
  jpeg: 'image',
  gif: 'image',
  bmp: 'image',
  tiff: 'image',
  webp: 'image',
  heic: 'image',
  svg: 'image',
  mp4: 'video',
  'riff-media': 'video',
  'mpeg-ts': 'video',
  ebml: 'video',
  flv: 'video',
  mp3: 'audio',
  ogg: 'audio',
  flac: 'audio',
  caj: 'cnki',
  pe: 'program',
  elf: 'program',
  sqlite: 'database',
  psd: 'design',
};
