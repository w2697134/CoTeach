import { create } from 'zustand';
import { useCallback, useEffect, useState, useRef } from 'react';
import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { get, subscribe } from '../../lib/api';
import { useAuth } from '../../lib/store';
import { intakesQuery, putIntake, type Intake } from './intake';

export interface TreeFile {
  id: string;
  protected?: boolean;
  studentId?: number;
  path: string;
  text: boolean;
  /** 老师交的原件：名字、类型、哪天交的 */
  source?: { name: string; kind: string; createdAt: number };
}

export interface CommitInfo {
  sha: string;
  author: string;
  committer: string;
  time: number;
  title: string;
  body: string;
  changeId: number | null;
  files: { status: string; path: string; from?: string }[];
}

export interface FileData {
  id: string;
  protected: boolean;
  studentId: number | null;
  student: { id: number; name: string } | null;
  source: {
    id: string;
    name: string;
    kind: string;
    createdAt: number;
    sourceClass: string | null;
    term: string | null;
  } | null;
  path: string;
  text: string | null;
  hash: string | null;
  size: number;
  last: CommitInfo | null;
}

export type ChangeStatus = 'pending' | 'applied' | 'rejected' | 'conflict' | 'reverted' | 'canceled';

export interface Change {
  source?: { kbId: number; name: string; term: string | null } | null;
  id: number;
  title: string;
  reason: string | null;
  author: string;
  authorName: string;
  kind: 'teacher' | 'upload' | 'keeper' | 'tidy' | 'revert';
  status: ChangeStatus;
  files: { path: string; deleted: boolean; added: boolean }[];
  commit: string | null;
  runId: number | null;
  reverts: number | null;
  error: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface FileDiff {
  sourceChanged?: boolean;
  path: string;
  from?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary?: boolean;
  before: string | null;
  after: string | null;
  truncated?: boolean;
}

/* 老师看到的文件名不带 .md：笔记都是 .md 文件，扩展名对老师没用 */
export { fileTitle, fileDir, plainPath, plainText } from './presentation';
import { plainText } from './presentation';

/** 整理助手的话里提到文件名时也去掉 .md */
/** 显示知识库文档时，正文里提到的文件名也去掉 .md；代码里的不动。编辑时看到的还是原文 */
export const rehypePlainNames = () => (tree: { type: string; tagName?: string; value?: string; children?: any[] }) => {
  const walk = (n: typeof tree) => {
    if (n.tagName === 'code' || n.tagName === 'pre') return;
    if (n.type === 'text') n.value = plainText(n.value!);
    n.children?.forEach(walk);
  };
  walk(tree);
};
export const PLAIN_NAMES = [rehypePlainNames];

export interface RunEvent {
  id: number;
  /** action：CoT 助教办成的一件事；ask：它问老师；job：它交给整理助手的后台活；job_files：后台活带了哪几份文件 */
  type: 'say' | 'tool' | 'change' | 'error' | 'action' | 'ask' | 'answer' | 'job' | 'job_files';
  data: Record<string, any>;
  createdAt: number;
}

export interface Attachment {
  id: number;
  intakeId: number;
  kbId: number;
  name: string;
  kind: string;
  /** 文件大小（字节）；旧的记录可能没有 */
  size?: number;
  status: string;
  reason: string | null;
  path: string | null;
}
export interface Run {
  id: number;
  /** 这一轮挂在哪个知识库上（老师在最外层说的话为空） */
  kbId?: number | null;
  /** 这一轮在各个知识库里交的改动 */
  changes?: { id: number; kbId: number; kbName: string; status: ChangeStatus; title: string }[];
  /** 老师这句话带的文件 */
  attachments?: Attachment[] | null;
  moreAttachments?: number;
  /** 拖进来的整个文件夹：名字、一共几份、几份没读出来、几份和库里一模一样没再存 */
  attachmentFolders?: { name: string; count: number; failed: number; same?: number }[];
  /** 带的文件还在收、在读 */
  receiving?: { status: string; done: number; total: number } | null;
  kind: 'materials' | 'chat' | 'summary' | 'observation' | 'job' | 'student_ask';
  /** waiting：CoT 助教问了老师，在等回答；queued：交给整理助手的后台活排着队 */
  status: 'running' | 'done' | 'error' | 'canceled' | 'waiting' | 'queued';
  /** 谁的一轮：老师跟 CoT 助教说的（ta）；整理助手的（keeper，助教派给它的后台活带 parentId） */
  agent?: 'ta' | 'keeper';
  parentId?: number | null;
  /** 助教办的事：能不能撤回、撤回了没有 */
  actions?: { id: number; kind: string; status: 'done' | 'undone'; undoable: boolean }[];
  /** 助教派给整理助手的后台活 */
  jobs?: Run[];
  request: string;
  task?: { label: string; detail: string } | null;
  reply: string | null;
  changeId: number | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  events: RunEvent[];
}

export const KEEPER = { key: 'keeper', name: '整理助手', color: '#6366f1' };
/** 老师只跟 CoT 助教说话（2026-11-16 起）；整理助手在后台接它交来的活 */
export const TA = { key: 'tutor', name: 'CoT 助教', color: '#14b8a6' };
/** 学生的 CoT 学伴（2026-11-16）：学生跟它说话，它看班级资料包，拿不准去问老师的助教 */
export const BUDDY = { key: 'question', name: 'CoT 学伴', color: '#8b5cf6' };

export const STATUS_TEXT: Record<ChangeStatus, string> = {
  pending: '待确认',
  applied: '已生效',
  rejected: '没要',
  conflict: '需要重新核对',
  reverted: '已撤回',
  canceled: '已停止',
};
export const STATUS_TONE: Record<ChangeStatus, 'brand' | 'ok' | 'gray' | 'warn'> = {
  pending: 'brand',
  applied: 'ok',
  rejected: 'gray',
  conflict: 'warn',
  reverted: 'gray',
  canceled: 'gray',
};

const courseQuery = (cid: number) =>
  queryOptions({
    queryKey: ['course', cid],
    queryFn: () =>
      get<{
        course: { id: number; name: string };
        knowledgeBase: KnowledgeBase;
        pending: number;
        activeRunId: number | null;
      }>(`/knowledge/${cid}`),
  });
export const useCourse = (cid: number) => useQuery(courseQuery(cid));
export interface KnowledgeBase {
  id: number;
  name: string;
  kind: 'teacher' | 'class';
  className: string | null;
  term: string | null;
  status: 'active' | 'archived';
  pending: number;
  archivedAt: number | null;
}
/** 学生没有知识库，左边栏那里不去取 */
export const useKnowledgeBases = (enabled = true) =>
  useQuery({
    queryKey: ['knowledge-bases'],
    queryFn: () => get<{ knowledgeBases: KnowledgeBase[] }>('/knowledge'),
    refetchInterval: 15000,
    enabled,
  });
export const treeQuery = (cid: number) =>
  queryOptions({
    queryKey: ['kb-tree', cid],
    queryFn: () => get<{ files: TreeFile[] }>(`/knowledge/${cid}/kb/tree`),
  });
export const useTree = (cid: number) => useQuery(treeQuery(cid));
const fileQuery = (cid: number, path: string | null) =>
  queryOptions({
    queryKey: ['kb-file', cid, path],
    queryFn: () => get<FileData>(`/knowledge/${cid}/kb/file?path=${encodeURIComponent(path!)}`),
    enabled: !!path,
  });
export const useFile = (cid: number, path: string | null) => useQuery(fileQuery(cid, path));
const runsQuery = (cid: number) =>
  queryOptions({
    queryKey: ['kb-runs', cid],
    queryFn: () => get<{ runs: Run[]; activeRunId: number | null }>(`/knowledge/${cid}/kb/runs`),
  });
export const useRuns = (cid: number) => useQuery(runsQuery(cid));
/**
 * 正在看 CoT 助教的哪段会话：current 是现在这段（最近开的），null 是以前（还没有会话时）那一段，数字是哪一段。
 * 助教页和知识库页右边那一栏看的是同一段。
 */
export type SessionView = 'current' | number | null;
export const useTaSession = create<{ view: SessionView; set: (v: SessionView) => void }>((set) => ({ view: 'current', set: (view) => set({ view }) }));
/** 老师和 CoT 助教的一段会话：每一轮、干了什么、卡片 */
export const keeperRunsQuery = (view: SessionView = 'current') =>
  queryOptions({
    queryKey: ['keeper-runs', view],
    queryFn: () =>
      get<{ runs: Run[]; activeRunId: number | null; session: number | null; waitingStudents?: number }>(
        `/keeper/runs${view === 'current' ? '' : view === null ? '?session=old' : `?session=${view}`}`,
      ),
  });
export const useKeeperRuns = () => useQuery(keeperRunsQuery(useTaSession((s) => s.view)));
/** 会话列表：说过话的，新的在前，第一句话当标题 */
export const useTaSessions = (enabled: boolean) =>
  useQuery({
    queryKey: ['ta-sessions'],
    queryFn: () => get<{ sessions: { id: number | null; title: string; createdAt: number; updatedAt: number }[]; current: number | null }>('/keeper/sessions'),
    enabled,
  });
const changesQuery = (cid: number, status?: 'pending') =>
  queryOptions({
    queryKey: ['kb-changes', cid, status || 'all'],
    queryFn: () => get<{ changes: Change[] }>(`/knowledge/${cid}/kb/changes${status ? '?status=pending' : ''}`),
  });
export const useChanges = (cid: number, status?: 'pending') => useQuery(changesQuery(cid, status));

let keeperAvatar: HTMLImageElement | null = null;
/**
 * 打开一个知识库头一眼要看的（名字、文件、整理助手的记录和头像）先在后台取好。
 * 服务器远，来回一次要零点几秒，等点了再取就要干等。
 */
export function prefetchKb(qc: QueryClient, cid: number) {
  keeperAvatar ??= Object.assign(new Image(), { src: '/agents/keeper.webp' });
  void qc.prefetchQuery(courseQuery(cid));
  void qc.prefetchQuery(keeperRunsQuery(useTaSession.getState().view));
  void qc.prefetchQuery(intakesQuery(cid));
  void qc.prefetchQuery(changesQuery(cid));
  void qc.prefetchQuery(changesQuery(cid, 'pending'));
  void qc.prefetchQuery(treeQuery(cid));
}
export function usePrefetchKb() {
  const qc = useQueryClient();
  return useCallback((cid: number) => prefetchKb(qc, cid), [qc]);
}
export const useChange = (cid: number, id: number | null) =>
  useQuery({
    queryKey: ['kb-change', cid, id],
    queryFn: () => get<{ change: Change; files: FileDiff[]; stale: string[] }>(`/knowledge/${cid}/kb/changes/${id}`),
    enabled: !!id,
  });

/**
 * 整理助手的实时消息（按老师推，在哪一页都一样）：每一步、说到一半的话、交资料的进度、交上来的改动。
 * 文件格的刷新还是靠各个知识库自己的推送（useKbStream）。
 */
export function useKeeperStream() {
  const qc = useQueryClient();
  const userId = useAuth((s) => s.user?.id);
  const [live, setLive] = useState<{ runId: number; text: string } | null>(null);
  useEffect(() => {
    setLive(null);
    const bases = () => {
      qc.invalidateQueries({ queryKey: ['knowledge-bases'] });
      qc.invalidateQueries({ queryKey: ['course'] });
      qc.invalidateQueries({ queryKey: ['kb-tree'] });
    };
    return subscribe('/keeper/stream', {
      run: (r: { id: number; status: string }) => {
        qc.invalidateQueries({ queryKey: ['keeper-runs'] });
        if (r.status !== 'running') {
          setLive(null);
          qc.invalidateQueries({ queryKey: ['knowledge-bases'] });
        }
      },
      event: (e: RunEvent & { runId: number }) => {
        // 助教派出去的后台活挂在派它的那一轮下面，它的每一步也接上
        const add = (r: Run): Run => (r.id === e.runId && !r.events.some((x) => x.id === e.id) ? { ...r, events: [...r.events, e] } : r);
        qc.setQueriesData<{ runs: Run[]; activeRunId: number | null }>({ queryKey: ['keeper-runs'] }, (old) =>
          old ? { ...old, runs: old.runs.map((r) => ({ ...add(r), ...(r.jobs ? { jobs: r.jobs.map(add) } : {}) })) } : old,
        );
        // 助教办成了一件事（建班、发作业、打分……）：班级、作业那几页跟着变
        if (e.type === 'action') {
          qc.invalidateQueries({ queryKey: ['classes'] });
          qc.invalidateQueries({ queryKey: ['class'] });
          qc.invalidateQueries({ queryKey: ['homework'] });
        }
        // 派了后台活、问了老师：这一轮的样子（后台活、等回答）重取一次
        if (e.type === 'job' || e.type === 'ask') qc.invalidateQueries({ queryKey: ['keeper-runs'] });
        setLive(null);
        if (e.type === 'change') {
          const kb = Number(e.data?.kbId) || null;
          qc.invalidateQueries({ queryKey: kb ? ['kb-changes', kb] : ['kb-changes'] });
          qc.invalidateQueries({ queryKey: kb ? ['kb-change', kb] : ['kb-change'] });
          qc.invalidateQueries({ queryKey: ['knowledge-bases'] });
          qc.invalidateQueries({ queryKey: ['kb-tree'] });
        }
        if (e.type === 'tool' && !e.data?.error && KB_LEVEL_TOOLS.has(String(e.data?.name))) bases();
      },
      delta: (d: { runId: number; text: string }) =>
        setLive((prev) => (prev && prev.runId === d.runId ? { runId: d.runId, text: prev.text + d.text } : { runId: d.runId, text: d.text })),
      intake: (intake: Intake) => {
        putIntake(qc, intake.kbId, intake);
        // 老师这句话带的文件：那句话下面的进度跟着走，读完了再取一次（它开始干活了）
        if (!intake.runId) return;
        const reading = intake.status === 'uploading' || intake.status === 'reading';
        const c = intake.counts;
        qc.setQueriesData<{ runs: Run[]; activeRunId: number | null }>({ queryKey: ['keeper-runs'] }, (old) =>
          old
            ? {
                ...old,
                runs: old.runs.map((r) =>
                  r.id === intake.runId
                    ? {
                        ...r,
                        receiving: reading ? { status: intake.status, done: c.done + c.same + c.failed + c.skipped, total: intake.total } : null,
                        attachments: r.attachments?.map((a) => {
                          const now = intake.items.find((i) => i.id === a.id);
                          return now ? { ...a, status: now.status, reason: now.reason } : a;
                        }),
                      }
                    : r,
                ),
              }
            : old,
        );
        if (!reading) qc.invalidateQueries({ queryKey: ['keeper-runs'] });
      },
      // 助教办的一件事撤回了：卡片上跟着变，班级、作业那边也重取
      action: () => {
        qc.invalidateQueries({ queryKey: ['keeper-runs'] });
        qc.invalidateQueries({ queryKey: ['classes'] });
        qc.invalidateQueries({ queryKey: ['class'] });
        qc.invalidateQueries({ queryKey: ['homework'] });
      },
    });
  }, [qc, userId]);
  return live;
}

/** 订阅这门课的实时消息：整理助手的每一步、改动和文件的变化 */
export type FileOperation = { path: string; from?: string; deleted: boolean };
const KB_LEVEL_TOOLS = new Set(['create_knowledge_base', 'rename_knowledge_base', 'move_to_knowledge_base', 'delete_knowledge_base']);
export function useKbStream(cid: number, onFilesChanged?: (operations: FileOperation[]) => void) {
  const qc = useQueryClient();
  const userId = useAuth((s) => s.user?.id);
  const onFilesChangedRef = useRef(onFilesChanged);
  onFilesChangedRef.current = onFilesChanged;
  const [live, setLive] = useState<{ runId: number; text: string } | null>(null);
  useEffect(() => {
    setLive(null);
    const refreshChanges = () => {
      qc.invalidateQueries({ queryKey: ['kb-changes', cid] });
      qc.invalidateQueries({ queryKey: ['kb-change', cid] });
      qc.invalidateQueries({ queryKey: ['course', cid] });
      qc.invalidateQueries({ queryKey: ['courses'] });
      qc.invalidateQueries({ queryKey: ['knowledge-bases'] });
    };
    return subscribe(`/knowledge/${cid}/kb/stream`, {
      archived: () => {
        setLive(null);
        qc.invalidateQueries({ queryKey: ['course', cid] });
        qc.invalidateQueries({ queryKey: ['knowledge-bases'] });
        qc.invalidateQueries({ queryKey: ['kb-changes', cid] });
      },
      run: (r: { id: number; status: string }) => {
        qc.invalidateQueries({ queryKey: ['kb-runs', cid] });
        qc.invalidateQueries({ queryKey: ['course', cid] });
        if (r.status !== 'running') setLive(null);
      },
      event: (e: RunEvent & { runId: number }) => {
        qc.setQueryData<{ runs: Run[]; activeRunId: number | null }>(['kb-runs', cid], (old) =>
          old
            ? {
                ...old,
                runs: old.runs.map((r) =>
                  r.id === e.runId && !r.events.some((x) => x.id === e.id) ? { ...r, events: [...r.events, e] } : r,
                ),
              }
            : old,
        );
        // 一步结束：这一步说的话已经记下来了，实时文字清空，等下一步
        setLive(null);
        if (e.type === 'change') refreshChanges();
        // 整理助手新建、改名、删了知识库或把文件挪去别的库：左边的列表和别的库的目录跟着变
        if (e.type === 'tool' && !e.data?.error && KB_LEVEL_TOOLS.has(String(e.data?.name))) {
          qc.invalidateQueries({ queryKey: ['knowledge-bases'] });
          qc.invalidateQueries({ queryKey: ['course'] });
          qc.invalidateQueries({ queryKey: ['kb-tree'] });
        }
      },
      delta: (d: { runId: number; text: string }) =>
        setLive((prev) =>
          prev && prev.runId === d.runId ? { runId: d.runId, text: prev.text + d.text } : { runId: d.runId, text: d.text },
        ),
      change: refreshChanges,
      // 交资料的进度：上传、读取、整理到第几批
      intake: (intake: Intake) => putIntake(qc, cid, intake),
      tree: (event: { operations?: FileOperation[] }) => {
        const operations = event.operations || [];
        const removed = new Set(operations.flatMap((op) => (op.from ? [op.from] : op.deleted ? [op.path] : [])));
        onFilesChangedRef.current?.(operations);
        qc.invalidateQueries({ queryKey: ['kb-tree', cid] });
        qc.invalidateQueries({
          queryKey: ['kb-file', cid],
          predicate: (q) => !removed.has(String(q.queryKey[2])),
        });
        qc.invalidateQueries({ queryKey: ['kb-history', cid] });
      },
    });
  }, [cid, qc, userId]);
  return live;
}
