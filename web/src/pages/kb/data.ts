import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, subscribe } from '../../lib/api';

export interface TreeFile {
  path: string;
  size: number;
  text: boolean;
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
  path: string;
  text: string | null;
  hash: string | null;
  size: number;
  last: CommitInfo | null;
}

export type ChangeStatus = 'pending' | 'applied' | 'rejected' | 'conflict' | 'reverted';

export interface Change {
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
  path: string;
  from?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary?: boolean;
  before: string | null;
  after: string | null;
  truncated?: boolean;
}

/* 老师看到的文件名不带 .md：笔记都是 .md 文件，扩展名对老师没用 */
export const fileTitle = (path: string) => path.split('/').pop()!.replace(/\.md$/i, '');
export const fileDir = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const plainPath = (path: string) => path.replace(/\.md$/i, '');
/** 整理助手的话里提到文件名时也去掉 .md */
export const plainText = (s: string) => s.replace(/([^\s.,，。、；;：:（）()「」『』《》"'“”‘’]+)\.md(?![A-Za-z0-9])/gi, '$1');

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
  kind: 'materials' | 'chat';
  status: 'running' | 'done' | 'error' | 'canceled';
  request: string;
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
  conflict: '内容过期',
  reverted: '已撤回',
};
export const STATUS_TONE: Record<ChangeStatus, 'brand' | 'ok' | 'gray' | 'warn'> = {
  pending: 'brand',
  applied: 'ok',
  rejected: 'gray',
  conflict: 'warn',
  reverted: 'gray',
};

export const useCourse = (cid: number) =>
  useQuery({ queryKey: ['course', cid], queryFn: () => get<{ course: { id: number; name: string }; pending: number; activeRunId: number | null }>(`/courses/${cid}`) });
export const useTree = (cid: number) => useQuery({ queryKey: ['kb-tree', cid], queryFn: () => get<{ files: TreeFile[] }>(`/courses/${cid}/kb/tree`) });
export const useFile = (cid: number, path: string | null) =>
  useQuery({
    queryKey: ['kb-file', cid, path],
    queryFn: () => get<FileData>(`/courses/${cid}/kb/file?path=${encodeURIComponent(path!)}`),
    enabled: !!path,
  });
export const useRuns = (cid: number) => useQuery({ queryKey: ['kb-runs', cid], queryFn: () => get<{ runs: Run[]; activeRunId: number | null }>(`/courses/${cid}/kb/runs`) });
export const useChanges = (cid: number, status?: 'pending') =>
  useQuery({ queryKey: ['kb-changes', cid, status || 'all'], queryFn: () => get<{ changes: Change[] }>(`/courses/${cid}/kb/changes${status ? '?status=pending' : ''}`) });
export const useChange = (cid: number, id: number | null) =>
  useQuery({
    queryKey: ['kb-change', cid, id],
    queryFn: () => get<{ change: Change; files: FileDiff[]; stale: string[] }>(`/courses/${cid}/kb/changes/${id}`),
    enabled: !!id,
  });

/** 订阅这门课的实时消息：整理助手的每一步、改动和文件的变化 */
export function useKbStream(cid: number) {
  const qc = useQueryClient();
  const [live, setLive] = useState<{ runId: number; text: string } | null>(null);
  useEffect(() => {
    const refreshChanges = () => {
      qc.invalidateQueries({ queryKey: ['kb-changes', cid] });
      qc.invalidateQueries({ queryKey: ['kb-change', cid] });
      qc.invalidateQueries({ queryKey: ['course', cid] });
      qc.invalidateQueries({ queryKey: ['courses'] });
    };
    return subscribe(`/courses/${cid}/kb/stream`, {
      run: (r: { id: number; status: string }) => {
        qc.invalidateQueries({ queryKey: ['kb-runs', cid] });
        qc.invalidateQueries({ queryKey: ['course', cid] });
        if (r.status !== 'running') setLive(null);
      },
      event: (e: RunEvent & { runId: number }) => {
        qc.setQueryData<{ runs: Run[]; activeRunId: number | null }>(['kb-runs', cid], old =>
          old
            ? { ...old, runs: old.runs.map(r => (r.id === e.runId && !r.events.some(x => x.id === e.id) ? { ...r, events: [...r.events, e] } : r)) }
            : old,
        );
        // 一步结束：这一步说的话已经记下来了，实时文字清空，等下一步
        setLive(null);
        if (e.type === 'change') refreshChanges();
      },
      delta: (d: { runId: number; text: string }) => setLive(prev => (prev && prev.runId === d.runId ? { runId: d.runId, text: prev.text + d.text } : { runId: d.runId, text: d.text })),
      change: refreshChanges,
      tree: () => {
        qc.invalidateQueries({ queryKey: ['kb-tree', cid] });
        qc.invalidateQueries({ queryKey: ['kb-file', cid] });
        qc.invalidateQueries({ queryKey: ['kb-history', cid] });
      },
    });
  }, [cid, qc]);
  return live;
}
