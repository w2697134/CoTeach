/**
 * 交资料：选文件、选文件夹、拖进来、跟整理助手说话时带上文件、贴很长的一段。
 * 先登记要交的文件（带文件夹里的相对位置），再分块上传；收齐后服务器自己读、自己整理。
 */
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { ApiError, api, get, post } from '../../lib/api';
import { toast } from '../../lib/store';

export type ItemStatus = 'uploading' | 'waiting' | 'reading' | 'done' | 'same' | 'failed' | 'skipped';
export interface IntakeItem {
  id: number;
  parentId: number | null;
  name: string;
  kind: string;
  size: number;
  received: number;
  status: ItemStatus;
  retryable: boolean;
  reason: string | null;
  advice: string | null;
  progress: { done: number; total: number } | null;
  method: string | null;
  notes: string[];
  path: string | null;
}
export interface Intake {
  id: number;
  kbId: number;
  /** 跟整理助手说的一句话带的文件：显示在那句话下面，不单独成卡片 */
  runId?: number | null;
  status: 'uploading' | 'reading' | 'digesting' | 'paused' | 'done' | 'failed' | 'canceled';
  message: string | null;
  error: string | null;
  changeId: number | null;
  digestChangeId: number | null;
  batch: number;
  batches: number;
  counts: Record<ItemStatus, number>;
  total: number;
  upload: { size: number; received: number };
  current: { name: string; progress: { done: number; total: number } | null } | null;
  items: IntakeItem[];
  complete: boolean;
  /** 交到长期库、里面有学生信息的资料 */
  students?: { itemId: number; name: string; path: string | null; classes: { kbId: number; name: string; count: number; active: boolean }[] }[];
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}
/** 选中的一份文件，path 是它在所选文件夹里的位置 */
export interface Picked {
  file: File;
  path: string;
}

export const KIND_LABEL: Record<string, string> = {
  text: '文本',
  code: '代码',
  notebook: '代码笔记本',
  document: '文档',
  slides: '幻灯片',
  sheet: '表格',
  pdf: '便携文档',
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
};

export const intakesQuery = (cid: number) =>
  queryOptions({ queryKey: ['kb-intakes', cid], queryFn: () => get<{ intakes: Intake[] }>(`/knowledge/${cid}/intakes`) });
export const useIntakes = (cid: number) => useQuery(intakesQuery(cid));

/**
 * 推送或操作返回的状态放进列表。只收比手上新的：按「停下」时接口先回当时的状态，
 * 真正停下后的推送可能先到，旧回复后到时不能把新状态盖回去。
 */
export function putIntake(qc: QueryClient, cid: number, intake: Intake) {
  const put = (old: { intakes: Intake[] } | undefined) => {
    const list = old?.intakes || [];
    return list.some((x) => x.id === intake.id)
      ? { intakes: list.map((x) => (x.id === intake.id && intake.updatedAt >= x.updatedAt ? intake : x)) }
      : { intakes: [...list, intake] };
  };
  qc.setQueryData<{ intakes: Intake[] }>(['kb-intakes', cid], put);
  // 整理助手只有一个：它那一栏列着老师所有知识库里交的资料；跟一句话一起发的文件显示在那句话下面，不单列
  qc.setQueryData<{ intakes: Intake[] }>(['keeper-intakes'], (old) => (old && !intake.runId ? put(old) : old));
}
/** 老师所有知识库里交的资料（整理助手那一栏用） */
export const keeperIntakesQuery = () => queryOptions({ queryKey: ['keeper-intakes'], queryFn: () => get<{ intakes: Intake[] }>('/keeper/intakes') });
export const useKeeperIntakes = () => useQuery(keeperIntakesQuery());

export const pickedFromList = (list: FileList | File[]): Picked[] =>
  Array.from(list).map((file) => ({ file, path: file.webkitRelativePath || file.name }));

/** 拖进来的东西：文件夹逐层展开，记住每份文件在文件夹里的位置。必须在 drop 事件里同步调用。 */
export function pickedFromDrop(dt: DataTransfer): Promise<Picked[]> {
  const entries = Array.from(dt.items || [])
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry?.() ?? null)
    .filter((e): e is FileSystemEntry => !!e);
  const files = Array.from(dt.files || []);
  if (!entries.length) return Promise.resolve(pickedFromList(files));
  return (async () => {
    const out: Picked[] = [];
    const walk = async (entry: FileSystemEntry): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        out.push({ file, path: entry.fullPath.replace(/^\/+/, '') || file.name });
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
          if (!batch.length) break;
          for (const child of batch) await walk(child);
        }
      }
    };
    for (const entry of entries) await walk(entry);
    return out;
  })();
}

/** 这个页面正在上传的那几次交资料；页面关了重开，没传完的就显示为上传中断 */
const uploading = new Set<number>();
export const uploadingHere = (id: number) => uploading.has(id);
const warnLeave = (e: BeforeUnloadEvent) => {
  e.preventDefault();
  e.returnValue = '';
};

/** 网络断一下就等一会儿再传这一块；服务器明确拒绝的不重试 */
async function retrying<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const transient = err instanceof ApiError && (err.status === 0 || err.status >= 500);
      if (!transient || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

/**
 * 交资料。text 是直接贴过来的一大段，message 是老师随资料说的话。
 * 登记好就回调 onCreated（页面马上能看到这次交的进度），然后在后台分块上传。
 */
export async function sendIntake(
  cid: number | null,
  picked: Picked[],
  opts: { message?: string; text?: string; onCreated?: (intake: Intake) => void } = {},
): Promise<Intake> {
  // 在最外层交的（cid 为空）：先放在一个库里，整理助手看内容再放到合适的库
  const created = await post<{
    intake: Intake;
    uploads: { itemId: number; index: number; size: number; received: number }[];
    chunkSize: number;
  }>(cid === null ? '/keeper/intakes' : `/knowledge/${cid}/intakes`, {
    message: opts.message?.trim() || null,
    text: opts.text || null,
    files: picked.map((p) => ({ name: p.path, size: p.file.size })),
  });
  opts.onCreated?.(created.intake);
  await uploadItems(created.intake.kbId, created.intake.id, created.uploads, picked, created.chunkSize);
  return created.intake;
}

/** 分块上传登记好的文件：三路同时传，网络断一下就等一会儿再传这一块；传的时候离开页面先提醒 */
export async function uploadItems(
  kb: number,
  id: number,
  uploads: { itemId: number; index: number; size: number; received: number }[],
  picked: Picked[],
  chunkSize: number,
) {
  if (!uploads.length) return;
  uploading.add(id);
  if (uploading.size === 1) window.addEventListener('beforeunload', warnLeave);
  try {
    const queue = [...uploads];
    const lane = async () => {
      for (let u = queue.shift(); u; u = queue.shift()) {
        const file = picked[u.index]?.file;
        if (!file) continue;
        let offset = u.received;
        while (offset < u.size) {
          const at = offset;
          const r = await retrying(() =>
            api<{ received: number; complete: boolean }>(`/knowledge/${kb}/intakes/${id}/items/${u!.itemId}?offset=${at}`, {
              method: 'PUT',
              body: file.slice(at, Math.min(u!.size, at + chunkSize)),
            }),
          );
          if (r.complete) break;
          offset = r.received;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, lane));
  } finally {
    uploading.delete(id);
    if (!uploading.size) window.removeEventListener('beforeunload', warnLeave);
  }
}

/**
 * 跟整理助手说一句话，可以带文件（像聊天发附件）：先登记，马上回来（对话里就出现这句话和带的文件），
 * 文件在后台分块上传；文件读完整理助手才开始看。
 */
export async function sendMessage(message: string, kbId: number | null, file: string | null, picked: Picked[], session?: number | null, place?: 'kb') {
  const r = await post<{
    runId?: number;
    intake?: Intake;
    uploads?: { itemId: number; index: number; size: number; received: number }[];
    chunkSize?: number;
  }>('/keeper/messages', {
    message,
    kbId,
    file,
    files: picked.map((p) => ({ name: p.path, size: p.file.size })),
    // 跟 CoT 助教的哪段会话说（不传是现在这段）
    ...(session !== undefined ? { session } : {}),
    // 在知识库页右边说的：知识库页只摆这些
    ...(place ? { place } : {}),
  });
  if (r.intake && r.uploads?.length)
    void uploadItems(r.intake.kbId, r.intake.id, r.uploads, picked, r.chunkSize || 0).catch((err) => toast.fromError(err));
  return r;
}

/** 页面上各处交资料都走这里：登记好就在整理助手那边显示出来，上传在后台继续，出错弹提示 */
export const handIn = (qc: QueryClient, cid: number | null, files: Picked[], message?: string) =>
  new Promise<void>((resolve) => {
    sendIntake(cid, files, { message, onCreated: (intake) => (putIntake(qc, intake.kbId, intake), resolve()) })
      .catch((err) => {
        toast.fromError(err);
        resolve();
      })
      .finally(() => {
        qc.invalidateQueries({ queryKey: ['kb-intakes'] });
        qc.invalidateQueries({ queryKey: ['keeper-intakes'] });
      });
  });

/** 粘贴进来的截图没有像样的名字，按时间起一个 */
export function pastedFiles(list: FileList): Picked[] {
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '');
  return Array.from(list).map((file, i) => {
    const plain = !file.name || /^image\.\w+$/i.test(file.name);
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return { file, path: plain ? `粘贴的图片 ${stamp}${list.length > 1 ? `-${i + 1}` : ''}.${ext}` : file.name };
  });
}

export const resumeIntake = (cid: number, id: number) => post<{ intake: Intake }>(`/knowledge/${cid}/intakes/${id}/resume`, {});
export const cancelIntake = (cid: number, id: number) => post<{ intake: Intake }>(`/knowledge/${cid}/intakes/${id}/cancel`, {});
export const finishIntake = (cid: number, id: number) => post<{ intake: Intake }>(`/knowledge/${cid}/intakes/${id}/finish`, {});
export const moveToClass = (cid: number, id: number, itemId: number, classId: number) =>
  post<{ intake: Intake }>(`/knowledge/${cid}/intakes/${id}/items/${itemId}/to-class`, { classId });
