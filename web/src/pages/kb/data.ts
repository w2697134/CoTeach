import { useEffect, useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, subscribe } from '../../lib/api';
import { useAuth } from '../../lib/store';
import { putIntake, type Intake } from './intake';

export interface TreeFile {
  id: string;
  protected?: boolean;
  studentId?: number;
  path: string;
  size: number;
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
  type: 'say' | 'tool' | 'change' | 'error';
  data: Record<string, any>;
  createdAt: number;
}

export interface Run {
  id: number;
  kind: 'materials' | 'chat' | 'summary' | 'observation';
  status: 'running' | 'done' | 'error' | 'canceled';
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

export const useCourse = (cid: number) =>
  useQuery({
    queryKey: ['course', cid],
    queryFn: () =>
      get<{
        course: { id: number; name: string };
        knowledgeBase: KnowledgeBase;
        pending: number;
        activeRunId: number | null;
      }>(`/knowledge/${cid}`),
  });
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
export const useKnowledgeBases = () =>
  useQuery({
    queryKey: ['knowledge-bases'],
    queryFn: () => get<{ knowledgeBases: KnowledgeBase[] }>('/knowledge'),
    refetchInterval: 15000,
  });
export const useTree = (cid: number) =>
  useQuery({
    queryKey: ['kb-tree', cid],
    queryFn: () => get<{ files: TreeFile[] }>(`/knowledge/${cid}/kb/tree`),
  });
export const useFile = (cid: number, path: string | null) =>
  useQuery({
    queryKey: ['kb-file', cid, path],
    queryFn: () => get<FileData>(`/knowledge/${cid}/kb/file?path=${encodeURIComponent(path!)}`),
    enabled: !!path,
  });
export const useRuns = (cid: number) =>
  useQuery({
    queryKey: ['kb-runs', cid],
    queryFn: () => get<{ runs: Run[]; activeRunId: number | null }>(`/knowledge/${cid}/kb/runs`),
  });
export const useChanges = (cid: number, status?: 'pending') =>
  useQuery({
    queryKey: ['kb-changes', cid, status || 'all'],
    queryFn: () => get<{ changes: Change[] }>(`/knowledge/${cid}/kb/changes${status ? '?status=pending' : ''}`),
  });
export const useChange = (cid: number, id: number | null) =>
  useQuery({
    queryKey: ['kb-change', cid, id],
    queryFn: () => get<{ change: Change; files: FileDiff[]; stale: string[] }>(`/knowledge/${cid}/kb/changes/${id}`),
    enabled: !!id,
  });

/** 订阅这门课的实时消息：整理助手的每一步、改动和文件的变化 */
export type FileOperation = { path: string; from?: string; deleted: boolean };
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
