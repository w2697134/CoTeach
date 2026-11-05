/** 把老师交的文件转成文字，供整理助手阅读；原件另外原样保存 */
export async function extractText(buf: Buffer, fileName: string): Promise<string> {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (['md', 'markdown', 'txt'].includes(ext)) return buf.toString('utf8').replace(/^﻿/, '');
  if (['py', 'c', 'cpp', 'h', 'java', 'js', 'ts', 'sql', 'go'].includes(ext)) {
    const lang = ext === 'py' ? 'python' : ext === 'h' ? 'c' : ext;
    return `# ${fileName}\n\n\`\`\`${lang}\n${buf.toString('utf8')}\n\`\`\`\n`;
  }
  if (ext === 'pdf') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await pdfText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    return pages.map((p, i) => `## 第 ${i + 1} 页\n\n${p}`).join('\n\n');
  }
  if (ext === 'docx') {
    const mammoth: any = await import('mammoth');
    const fn = mammoth.convertToMarkdown || mammoth.default?.convertToMarkdown;
    if (fn) {
      const r = await fn({ buffer: buf });
      return String(r.value).replace(/\\([_*.\-#()[\]])/g, '$1');
    }
    const r = await (mammoth.extractRawText || mammoth.default.extractRawText)({ buffer: buf });
    return r.value;
  }
  if (ext === 'pptx') return pptxText(buf);
  throw new Error('暂不支持这种文件，可以交 Word(docx)、PPT(pptx)、PDF、Markdown、TXT 或代码文件');
}

/** PPT：按页取出每段文字 */
async function pptxText(buf: Buffer): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files)
    .map(name => ({ name, n: Number(name.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1] || 0) }))
    .filter(s => s.n)
    .sort((a, b) => a.n - b.n);
  const decode = (s: string) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  const pages: string[] = [];
  for (const s of slides) {
    const xml = await zip.files[s.name].async('string');
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
      .map(p => [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(t => decode(t[1])).join(''))
      .map(t => t.trim())
      .filter(Boolean);
    pages.push(`## 第 ${s.n} 页\n\n${paras.map(t => `- ${t}`).join('\n')}`);
  }
  return pages.join('\n\n');
}
