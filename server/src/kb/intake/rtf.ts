import { decodeCodepage } from './textcodec.js';

/** RTF（写字板、旧版 Word 另存的格式）→ 文字。页眉页脚、图片和排版数据不取。 */
const SKIP = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'objdata', 'themedata', 'colorschememapping', 'datastore',
  'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'mmathPr', 'header', 'headerl',
  'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'filetbl', 'revtbl', 'pgdsctbl', 'fldinst', 'bkmkstart',
  'bkmkend', 'protusertbl', 'wgrffmtfilter', 'defchp', 'defpap', 'pnseclvl', 'shppict', 'nonshppict', 'blipuid', 'userprops',
  'docvar', 'xe', 'tc', 'atnid', 'atnauthor', 'annotation', 'falt', 'panose', 'fname', 'listtext', 'pntext', 'pntxta', 'pntxtb',
]);

/** 字体表里的字符集决定 \'hh 字节按哪种编码解：同一份文件里中文、日文、西文字体可以混用。 */
const CHARSET_CODEPAGE: Record<number, number> = {
  0: 1252, 77: 10000, 128: 932, 129: 949, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256,
  186: 1257, 204: 1251, 222: 874, 238: 1250, 254: 437, 255: 850,
};

export function rtfToText(src: string): string {
  let codepage = Number(src.match(/\\ansicpg(\d+)/)?.[1] || 936);
  const fonts = new Map<number, number>();
  const table = src.indexOf('\\fonttbl');
  if (table >= 0)
    for (const m of src.slice(table, table + 200_000).matchAll(/\{\\f(\d+)\\[^{}]*?\\fcharset(\d+)/g)) {
      const cp = CHARSET_CODEPAGE[Number(m[2])];
      if (cp && !fonts.has(Number(m[1]))) fonts.set(Number(m[1]), cp);
    }
  const out: string[] = [];
  const stack: { skip: boolean; uc: number; font: number }[] = [];
  let state = { skip: false, uc: 1, font: -1 };
  let pendingSkip = 0;
  let bytes: number[] = [];
  const flushBytes = () => {
    if (!bytes.length) return;
    if (!state.skip) out.push(decodeCodepage(Uint8Array.from(bytes), fonts.get(state.font) ?? codepage));
    bytes = [];
  };
  const emit = (s: string) => {
    flushBytes();
    if (!state.skip) out.push(s);
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '{') {
      flushBytes();
      stack.push(state);
      state = { ...state };
      i++;
      // {\*\something} 是可以忽略的扩展内容
      if (src.startsWith('\\*', i)) {
        state.skip = true;
        i += 2;
      }
      continue;
    }
    if (ch === '}') {
      flushBytes();
      state = stack.pop() || { skip: false, uc: 1, font: -1 };
      i++;
      continue;
    }
    if (ch === '\\') {
      const next = src[i + 1];
      if (next === "'") {
        const hex = parseInt(src.slice(i + 2, i + 4), 16);
        i += 4;
        if (pendingSkip > 0) {
          pendingSkip--;
          continue;
        }
        if (Number.isFinite(hex)) bytes.push(hex);
        continue;
      }
      if (next === '\\' || next === '{' || next === '}') {
        if (pendingSkip > 0) pendingSkip--;
        else emit(next);
        i += 2;
        continue;
      }
      if (next === '~') {
        emit('\u00a0');
        i += 2;
        continue;
      }
      if (next === '_') {
        emit('-');
        i += 2;
        continue;
      }
      if (next === '-' || next === ':' || next === '|') {
        i += 2;
        continue;
      }
      if (next === '\n' || next === '\r') {
        emit('\n');
        i += 2;
        continue;
      }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i, i + 40));
      if (!m) {
        i += 2;
        continue;
      }
      i += m[0].length;
      const word = m[1],
        arg = m[2] === undefined ? null : Number(m[2]);
      if (SKIP.has(word)) {
        flushBytes();
        state.skip = true;
        continue;
      }
      switch (word) {
        case 'ansicpg':
          if (arg) codepage = arg;
          break;
        case 'f':
          flushBytes();
          if (arg !== null) state.font = arg;
          break;
        case 'uc':
          state.uc = arg ?? 1;
          break;
        case 'u': {
          const code = arg! < 0 ? arg! + 65536 : arg!;
          emit(String.fromCharCode(code));
          pendingSkip = state.uc;
          break;
        }
        case 'par':
        case 'line':
        case 'sect':
        case 'page':
          emit('\n');
          break;
        case 'tab':
          emit('\t');
          break;
        case 'cell':
          emit('\t');
          break;
        case 'row':
          emit('\n');
          break;
        case 'emdash':
          emit('—');
          break;
        case 'endash':
          emit('–');
          break;
        case 'bullet':
          emit('•');
          break;
        case 'lquote':
          emit('‘');
          break;
        case 'rquote':
          emit('’');
          break;
        case 'ldblquote':
          emit('“');
          break;
        case 'rdblquote':
          emit('”');
          break;
        case 'bin':
          i += Math.max(0, arg || 0);
          break;
      }
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (pendingSkip > 0) {
      pendingSkip--;
      i++;
      continue;
    }
    let j = i;
    while (j < n && !'\\{}\r\n'.includes(src[j])) j++;
    emit(src.slice(i, j));
    i = j;
  }
  flushBytes();
  return out.join('');
}
