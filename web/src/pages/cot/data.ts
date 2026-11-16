import { useEffect, useState } from 'react';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { get, subscribe } from '../../lib/api';
import { useAuth } from '../../lib/store';

export interface StuEvent {
  id: number;
  /** tool：查看、问助教；say：干活时说的一句；file：发给学生的文件；notice：老师那边来的消息；error */
  type: string;
  data: Record<string, any>;
  createdAt: number;
}
/** 学生跟学伴的一轮（chat），或者老师那边送进来的一条消息（notice：回复、通知） */
export interface StuRun {
  id: number;
  kind: 'chat' | 'notice';
  status: 'running' | 'done' | 'error' | 'canceled';
  request: string;
  reply: string | null;
  error: string | null;
  classIds: number[];
  createdAt: number;
  finishedAt: number | null;
  events: StuEvent[];
}

/** 正在看哪段会话：current 是现在这段（最近开的），数字是翻出来的以前那段 */
export type StuView = 'current' | number;
export const useStuSession = create<{ view: StuView; set: (v: StuView) => void }>((set) => ({ view: 'current', set: (view) => set({ view }) }));

export const stuRunsQuery = (view: StuView = 'current') =>
  queryOptions({
    queryKey: ['stu-runs', view],
    queryFn: () => get<{ runs: StuRun[]; activeRunId: number | null; session: number }>(`/cot/runs${view === 'current' ? '' : `?session=${view}`}`),
  });
export const useStuRuns = () => useQuery(stuRunsQuery(useStuSession((s) => s.view)));
export const useStuSessions = (enabled: boolean) =>
  useQuery({
    queryKey: ['stu-sessions'],
    queryFn: () => get<{ sessions: { id: number; title: string; createdAt: number; updatedAt: number }[]; current: number }>('/cot/sessions'),
    enabled,
  });

/** 学伴的实时消息：每一步、说到一半的话、老师那边送来的消息 */
export function useStuStream() {
  const qc = useQueryClient();
  const userId = useAuth((s) => s.user?.id);
  const [live, setLive] = useState<{ runId: number; text: string } | null>(null);
  useEffect(() => {
    setLive(null);
    return subscribe('/cot/stream', {
      run: (r: { id: number; status: string }) => {
        qc.invalidateQueries({ queryKey: ['stu-runs'] });
        if (r.status !== 'running') {
          setLive(null);
          qc.invalidateQueries({ queryKey: ['stu-sessions'] });
        }
      },
      event: (e: StuEvent & { runId: number }) => {
        qc.setQueriesData<{ runs: StuRun[] }>({ queryKey: ['stu-runs'] }, (old) =>
          old ? { ...old, runs: old.runs.map((r) => (r.id === e.runId && !r.events.some((x) => x.id === e.id) ? { ...r, events: [...r.events, e] } : r)) } : old,
        );
        setLive(null);
      },
      delta: (d: { runId: number; text: string }) =>
        setLive((prev) => (prev && prev.runId === d.runId ? { runId: d.runId, text: prev.text + d.text } : { runId: d.runId, text: d.text })),
    });
  }, [qc, userId]);
  return live;
}

/** 「王建国」→「王建国老师」；名字本来就带「老师」的不再加 */
export const teacherTitle = (name: string) => (/老师$/.test(name) ? name : `${name}老师`);
