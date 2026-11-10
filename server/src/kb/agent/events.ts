/**
 * 整理助手的工作记录：每一步记一条，推给老师。
 * 整理助手只有一个，记录按老师推（keeper:老师）；老师正在看的那个知识库也推一份（kb:知识库），文件格跟着刷新。
 */
import { db, now } from '../../db/index.js';
import { bus } from '../../lib/bus.js';

export interface RunRef {
  teacherId: number;
  runId: number;
  /** 这一轮挂在哪个知识库上（老师在最外层说的话为 null） */
  kbId: number | null;
}

export const keeperTopic = (teacherId: number) => `keeper:${teacherId}`;

export function publish(ref: RunRef, event: string, data: unknown) {
  bus.publish(keeperTopic(ref.teacherId), event, data);
  if (ref.kbId) bus.publish(`kb:${ref.kbId}`, event, data);
}

export function record(ref: RunRef, type: string, data: Record<string, unknown>) {
  const t = now(),
    id = db.insert('kb_events', { run_id: ref.runId, type, data, created_at: t });
  publish(ref, 'event', { runId: ref.runId, id, type, data, createdAt: t });
}
