/**
 * 给前端看的改动：每个文件给出改之前和改之后的全文。
 * 前端把两版合成一份排好版的修订稿，新加的标绿、删掉的划掉，老师不用看代码式的对比。
 */
export interface FileDiff {
  path: string;
  from?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary?: boolean;
  sourceChanged?: boolean;
  /** 改之前的全文，新建的文件是 null */
  before: string | null;
  /** 改之后的全文，删掉的文件是 null */
  after: string | null;
  /** 文件太长，只给了前面一段 */
  truncated?: boolean;
}

const MAX_CHARS = 200_000;

export function fileDiff(path: string, before: string | null, after: string | null, extra: Partial<FileDiff> = {}): FileDiff {
  const long = (before?.length ?? 0) > MAX_CHARS || (after?.length ?? 0) > MAX_CHARS;
  return {
    path,
    ...extra,
    status: extra.status ?? (before === null ? 'added' : after === null ? 'deleted' : 'modified'),
    before: before === null ? null : before.slice(0, MAX_CHARS),
    after: after === null ? null : after.slice(0, MAX_CHARS),
    ...(long ? { truncated: true } : {}),
  };
}
