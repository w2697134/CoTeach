import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, FileStack, Undo2, X } from 'lucide-react';
import { post } from '../../lib/api';
import { fromNow } from '../../lib/format';
import { toast } from '../../lib/store';
import { AgentAvatar, Alert, Avatar, Badge, Button, Empty, Skeleton, Spinner, Tabs, useConfirm } from '../../components/ui';
import { FileDiffView } from './DiffView';
import { KEEPER, STATUS_TEXT, STATUS_TONE, fileTitle, plainPath, plainText, useChange, useChanges, useCourse, type Change } from './data';

export function AuthorAvatar({ change, size = 32 }: { change: Pick<Change, 'author' | 'authorName'>; size?: number }) {
  return change.author === 'keeper' ? (
    <AgentAvatar agent={KEEPER} size={size} />
  ) : (
    <Avatar name={change.authorName} seed={change.authorName} size={size} />
  );
}

/** 改了哪几页：最多列三页的名字 */
export function changedPages(c: Pick<Change, 'files'>) {
  const names = [...new Set(c.files.map((f) => fileTitle(f.path)).filter(Boolean))];
  if (!names.length) return '';
  return names.length > 3 ? `${names.slice(0, 3).join('、')} 等 ${names.length} 篇` : names.join('、');
}

/** 确认、不要、撤回三个动作，整理助手那边的卡片和改动详情共用 */
export function useChangeActions(cid: number) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (c: Pick<Change, 'id' | 'title'>, action: 'apply' | 'reject' | 'revert') => {
    if (
      action === 'revert' &&
      !(await confirm({
        title: '撤回这次改动？',
        desc: `「${plainText(c.title)}」会被撤回，恢复改动前的内容。`,
        okText: '撤回',
      }))
    )
      return;
    setBusy(`${c.id}:${action}`);
    try {
      await post(`/knowledge/${cid}/kb/changes/${c.id}/${action}`, {});
      toast.success(action === 'apply' ? '已生效' : action === 'reject' ? '这次改动没要' : '已撤回');
    } catch (err) {
      toast.fromError(err);
    } finally {
      setBusy(null);
      qc.invalidateQueries({ queryKey: ['kb-changes', cid] });
      qc.invalidateQueries({ queryKey: ['kb-change', cid] });
      qc.invalidateQueries({ queryKey: ['kb-runs', cid] });
      qc.invalidateQueries({ queryKey: ['course', cid] });
      qc.invalidateQueries({ queryKey: ['courses'] });
    }
  };
  return { act, busy };
}

export function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[13.5px] text-ink-2 hover:bg-surface-3 hover:text-ink"
    >
      <ArrowLeft className="size-4" />
      {label}
    </button>
  );
}

function Back({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="flex h-12 shrink-0 items-center border-b border-line px-3 sm:px-4">
      <BackButton label={label} onClick={onClick} />
    </div>
  );
}

/** 一次改动：像 Word 修订那样看每一页改了什么，底下确认或不要 */
export function ChangeDetail({ cid, id, onBack, backLabel }: { cid: number; id: number; onBack: () => void; backLabel: string }) {
  const archived = useCourse(cid).data?.knowledgeBase.status === 'archived';
  const q = useChange(cid, id);
  const { act, busy } = useChangeActions(cid);
  const body = !q.data ? (
    <div className="mx-auto w-full max-w-[820px] p-6">{q.error ? <Alert tone="bad">{(q.error as Error).message}</Alert> : <Skeleton className="h-60" />}</div>
  ) : (
    (() => {
      const { change: c, files, stale } = q.data;
      const open = c.status === 'pending' || c.status === 'conflict';
      return (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[820px] space-y-4 px-5 pb-8 pt-6 sm:px-8">
              <div className="flex items-start gap-3">
                <AuthorAvatar change={c} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="text-[18px] font-semibold leading-snug text-ink">{plainText(c.title)}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-[13.5px] text-ink-3">
                    <span>{c.authorName}</span>
                    <span>·</span>
                    <span>{fromNow(c.createdAt)}</span>
                    <Badge tone={STATUS_TONE[c.status]}>{STATUS_TEXT[c.status]}</Badge>
                  </p>
                </div>
              </div>
              {c.reason && (
                <div className="rounded-xl bg-surface-2 px-4 py-3 text-[14px] leading-relaxed text-ink-2">
                  {/* 整理助手自己写了「依据……」就不再加一个 */}
                  {!/^\s*依据/.test(c.reason) && <span className="mr-1 font-medium text-ink">依据</span>}
                  {plainText(c.reason).replace(/^\s*依据[:：]\s*/, '')}
                </div>
              )}
              {c.source && (
                <Link className="inline-flex text-[14px] text-brand-ink underline underline-offset-4" to={`/knowledge/${c.source.kbId}`}>
                  {c.source.name} · {c.source.term}
                </Link>
              )}
              {stale.length > 0 && <Alert tone="warn">{stale.map(plainPath).join('、')}已有更新，请让整理助手重新核对。</Alert>}
              {c.error && c.status === 'conflict' && !stale.length && <Alert tone="warn">{c.error}</Alert>}
              <div className="space-y-3">
                {files.map((f, i) => (
                  <FileDiffView key={f.path + i} diff={f} defaultOpen={files.length <= 3 || i < 2} />
                ))}
              </div>
            </div>
          </div>
          {((open && !archived) || (c.status === 'applied' && !archived)) && (
            <div className="flex shrink-0 justify-end gap-2 border-t border-line bg-surface px-5 py-3">
              {open && (
                <>
                  <Button icon={<X className="size-4" />} loading={busy === `${c.id}:reject`} onClick={() => act(c, 'reject')}>
                    不要
                  </Button>
                  <Button
                    variant="primary"
                    icon={<Check className="size-4" />}
                    loading={busy === `${c.id}:apply`}
                    disabled={stale.length > 0}
                    onClick={() => act(c, 'apply')}
                  >
                    确认生效
                  </Button>
                </>
              )}
              {c.status === 'applied' && (
                <Button icon={<Undo2 className="size-4" />} loading={busy === `${c.id}:revert`} onClick={() => act(c, 'revert')}>
                  撤回
                </Button>
              )}
            </div>
          )}
        </>
      );
    })()
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Back label={backLabel} onClick={onBack} />
      {body}
    </div>
  );
}

/** 全部改动：等你确认的在前，也能翻以前的 */
export function ChangesList({ cid, onOpen, onBack }: { cid: number; onOpen: (id: number) => void; onBack: () => void }) {
  const pending = useChanges(cid, 'pending');
  const all = useChanges(cid);
  // 没有等确认的就直接看全部
  const [picked, setTab] = useState<'pending' | 'all' | null>(null);
  const tab = picked ?? (pending.data && !pending.data.changes.length ? 'all' : 'pending');
  const q = tab === 'pending' ? pending : all;
  const list = q.data?.changes;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Back label="返回" onClick={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[820px] px-3 pb-8 pt-4 sm:px-6">
          <div className="px-2">
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { value: 'pending', label: '等你确认', count: pending.data?.changes.length ?? null },
                { value: 'all', label: '全部改动' },
              ]}
            />
          </div>
          {q.error ? (
            <Alert tone="bad" className="m-2 mt-4">
              改动加载失败。
              <Button size="sm" onClick={() => q.refetch()}>
                重试
              </Button>
            </Alert>
          ) : !list ? (
            <div className="p-5">
              <Spinner />
            </div>
          ) : !list.length ? (
            <Empty compact icon={<FileStack />} title={tab === 'pending' ? '没有要确认的改动' : '还没有改动'} />
          ) : (
            <div className="mt-2 divide-y divide-line">
              {list.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onOpen(c.id)}
                  className="flex w-full items-start gap-3 rounded-lg px-3 py-3.5 text-left transition-colors hover:bg-surface-2"
                >
                  <AuthorAvatar change={c} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14.5px] font-medium leading-snug text-ink">{plainText(c.title)}</p>
                    <p className="mt-1 truncate text-[13px] text-ink-3">
                      {c.authorName} · {fromNow(c.createdAt)}
                      {changedPages(c) && ` · ${changedPages(c)}`}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[c.status]} className="mt-0.5 shrink-0">
                    {STATUS_TEXT[c.status]}
                  </Badge>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
