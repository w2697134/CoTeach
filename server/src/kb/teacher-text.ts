import type { HttpError } from '../lib/http.js';

export const documentName = (path: string) =>
  (path.split('/').pop() || path).replace(/\.(md|markdown|txt|docx?|pptx?|pdf|py|c|cpp|h|java|js|ts|sql|go|json|csv)$/i, '');
/** 仅用于教师 HTTP 响应；模型工具收到的纠错原话保持原样。 */
export function teacherError(err: HttpError, method: string) {
  if (err.code === 'student_identity')
    return `内容中提到了${((err.details?.terms as string[]) || []).map((x) => `「${x}」`).join('、')}，请放到该学生的个人记录中`;
  if (/内容已被更新|文件已更新/.test(err.message)) return method === 'PUT' ? '内容有更新。草稿仍在，请先复制，再重新打开核对' : '内容有更新，请重新打开后再操作';
  if (/隐藏路径|上级目录/.test(err.message)) return '这个名称不能使用，请换个名称';
  if (/文件与目录的位置冲突/.test(err.message)) return '这个位置已被同名文件占用，请换个位置或名称';
  return err.message;
}
