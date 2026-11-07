import iconv from 'iconv-lite';

/**
 * 老师电脑上的文字文件常见三种编码：UTF-8、记事本存的 GBK（国标）、Word 另存的 UTF-16。
 * 先看文件头标记，再试严格的 UTF-8，失败才按国标读；不认识的字不会悄悄变成问号。
 */
export function decodeText(input: Uint8Array): string {
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let text: string;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) text = b.subarray(3).toString('utf8');
  else if (b[0] === 0xff && b[1] === 0xfe) text = b.subarray(2).toString('utf16le');
  else if (b[0] === 0xfe && b[1] === 0xff) text = iconv.decode(b.subarray(2), 'utf16be');
  else if (looksUtf16(b, 0)) text = b.toString('utf16le');
  else if (looksUtf16(b, 1)) text = iconv.decode(b, 'utf16be');
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch {
      const gb = iconv.decode(b, 'gb18030');
      // 国标读出来仍然大面积不可见时，多半是繁体大五码。
      text = badRatio(gb) > 0.02 ? pickBetter(gb, iconv.decode(b, 'big5')) : gb;
    }
  }
  return normalizeNewlines(text);
}

export function normalizeNewlines(s: string): string {
  return s
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, '');
}

/** 没有扩展名或扩展名不认识时，判断它是不是文字文件。 */
export function looksLikeText(input: Uint8Array): boolean {
  const b = input.subarray(0, Math.min(input.length, 8192));
  if (!b.length) return false;
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return true;
  if (looksUtf16(Buffer.from(b), 0) || looksUtf16(Buffer.from(b), 1)) return true;
  let control = 0;
  for (const c of b) if (c === 0 || (c < 9 && c !== 7) || (c > 13 && c < 32 && c !== 27)) control++;
  return control / b.length < 0.01;
}

function looksUtf16(b: Buffer, zeroAt: 0 | 1): boolean {
  const n = Math.min(b.length - (b.length % 2), 4000);
  if (n < 8) return false;
  let zeros = 0,
    other = 0;
  for (let i = 0; i < n; i += 2) {
    if (b[i + zeroAt] === 0) zeros++;
    if (b[i + 1 - zeroAt] === 0) other++;
  }
  // 英文为主的 UTF-16 文件每隔一个字节是 0；中文为主时这个规律不明显，靠文件头标记识别。
  return zeros / (n / 2) > 0.4 && other / (n / 2) < 0.05;
}

function badRatio(s: string): number {
  if (!s.length) return 0;
  let bad = 0;
  for (const ch of s) if (ch === '�' || /[\u0080-\u009f-]/.test(ch)) bad++;
  return bad / s.length;
}

function pickBetter(a: string, b: string): string {
  return badRatio(b) < badRatio(a) ? b : a;
}

/** 压缩包里没有标记编码的文件名：合法 UTF-8 就按 UTF-8，否则按国标。 */
export function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return iconv.decode(Buffer.from(bytes), 'gb18030');
  }
}

export function decodeCodepage(bytes: Uint8Array, codepage: number): string {
  const name = CODEPAGES[codepage] || 'gb18030';
  return iconv.decode(Buffer.from(bytes), name);
}
const CODEPAGES: Record<number, string> = {
  936: 'gb18030',
  950: 'big5',
  932: 'shift_jis',
  949: 'euc-kr',
  1252: 'win1252',
  1250: 'win1250',
  1251: 'win1251',
  1253: 'win1253',
  1254: 'win1254',
  1255: 'win1255',
  1256: 'win1256',
  1257: 'win1257',
  1258: 'win1258',
  874: 'win874',
  437: 'cp437',
  850: 'cp850',
  10000: 'macintosh',
  65001: 'utf8',
  10008: 'gb18030',
};
