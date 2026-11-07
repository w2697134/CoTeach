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
        .replace(/([^\s/：:]+)\/(?=[：:])/g, '$1');

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
  delete_file: '移除',
  move_file: '移动',
  finish: '提交改动',
  done: '完成',
  list_students: '查看名单',
};
export function toolPresentation(data: Record<string, unknown> = {}) {
  const name = typeof data.name === 'string' ? data.name : '';
  let target = fileTitle(data.path);
  if (name === 'move_file') target = [fileTitle(data.from), fileTitle(data.to)].filter(Boolean).join('，移到');
  if (name === 'finish') target = plainText(data.title);
  if (name === 'search') target = typeof data.text === 'string' ? `「${plainText(data.text)}」` : '';
  return { label: Object.hasOwn(LABELS, name) ? LABELS[name] : '整理', target, error: data.error ? readableError(data.error) : '' };
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
