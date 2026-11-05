import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, FileStack, Undo2, X } from 'lucide-react';
import { post } from '../../lib/api';
import { fromNow } from '../../lib/format';
import { toast } from '../../lib/store';
import { AgentAvatar, Alert, Avatar, Badge, Button, Drawer, Empty, Skeleton, Spinner, Tabs, cn, useConfirm } from '../../components/ui';
import { FileDiffView } from './DiffView';
import { KEEPER, STATUS_TEXT, STATUS_TONE, plainPath, plainText, useChange, useChanges, type Change } from './data';

export function AuthorAvatar({ change, size = 32 }: { change: Pick<Change, 'author' | 'authorName'>; size?: number }) {
  return change.author === 'keeper' ? <AgentAvatar agent={KEEPER} size={size} /> : <Avatar name={change.authorName} seed={change.authorName} size={size} />;
}

/** 确认、不要、撤回三个动作，改动卡片和改动详情共用 */
export function useChangeActions(cid: number) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (c: Pick<Change, 'id' | 'title'>, action: 'apply' | 'reject' | 'revert') => {
    if (action === 'revert' && !(await confirm({ title: '撤回这次改动？', desc: `「${plainText(c.title)}」会被撤回，知识库回到改之前的样子。撤回本身也会记一笔，之后还能再撤回。`, okText: '撤回' })))
      return;
    setBusy(`${c.id}:${action}`);
    try {
      await post(`/courses/${cid}/kb/changes/${c.id}/${action}`, {});
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

function ChangeDetail({ cid, id, onBack }: { cid: number; id: number; onBack?: () => void }) {
  const q = useChange(cid, id);
  const { act, busy } = useChangeActions(cid);
  if (!q.data) return <div className="p-6">{q.error ? <Alert tone="bad">{(q.error as Error).message}</Alert> : <Skeleton className="h-60" />}</div>;
  const { change: c, files, stale } = q.data;
  const open = c.status === 'pending' || c.status === 'conflict';
  return (
    <div className="space-y-4 p-5">
      {onBack && (
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-[14px] text-ink-3 hover:text-ink">
          <ArrowLeft className="size-4" />
          全部改动
        </button>
      )}
      <div className="flex items-start gap-3">
        <AuthorAvatar change={c} size={40} />
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-semibold leading-snug text-ink">{plainText(c.title)}</p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[13.5px] text-ink-3">
            <span>{c.authorName}</span>
            <span>·</span>
            <span>{fromNow(c.createdAt)}</span>
            <Badge tone={STATUS_TONE[c.status]}>{STATUS_TEXT[c.status]}</Badge>
          </p>
        </div>
      </div>
      {c.reason && (
        <div className="rounded-lg bg-surface-2 px-4 py-3 text-[14px] leading-relaxed text-ink-2">
          <span className="mr-1 font-medium text-ink">依据</span>
          {plainText(c.reason)}
        </div>
      )}
      {stale.length > 0 && (
        <Alert tone="warn">
          它改完之后，这些文件又被改过：{stale.map(plainPath).join('、')}。现在确认会失败，可以不要这次改动，让整理助手按现在的内容重改。
        </Alert>
      )}
      {c.error && c.status === 'conflict' && !stale.length && <Alert tone="warn">{c.error}</Alert>}
      {files.some(f => !f.binary && (f.status === 'modified' || f.status === 'renamed')) && (
        <p className="text-[13px] text-ink-3">
          <ins className="ct-ins">标绿的</ins>是新加的，<del className="ct-del">划掉的</del>是删掉的
        </p>
      )}
      <div className="space-y-3">
        {files.map((f, i) => (
          <FileDiffView key={f.path + i} diff={f} defaultOpen={files.length <= 3 || i < 2} />
        ))}
      </div>
      <div className="sticky bottom-0 -mx-5 flex justify-end gap-2 border-t border-line bg-surface px-5 py-3">
        {open && (
          <>
            <Button icon={<X className="size-4" />} loading={busy === `${c.id}:reject`} onClick={() => act(c, 'reject')}>
              不要
            </Button>
            <Button variant="primary" icon={<Check className="size-4" />} loading={busy === `${c.id}:apply`} disabled={stale.length > 0} onClick={() => act(c, 'apply')}>
              确认生效
            </Button>
          </>
        )}
        {c.status === 'applied' && c.kind !== 'revert' && (
          <Button icon={<Undo2 className="size-4" />} loading={busy === `${c.id}:revert`} onClick={() => act(c, 'revert')}>
            撤回
          </Button>
        )}
      </div>
    </div>
  );
}

function ChangeRow({ c, onOpen }: { c: Change; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 px-5 py-3.5 text-left transition-colors hover:bg-surface-2">
      <AuthorAvatar change={c} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14.5px] font-medium text-ink">{plainText(c.title)}</p>
        <p className="mt-0.5 text-[13px] text-ink-3">
          {c.authorName} · {fromNow(c.createdAt)} · {c.files.length} 个文件
        </p>
      </div>
      <Badge tone={STATUS_TONE[c.status]} className="mt-0.5 shrink-0">
        {STATUS_TEXT[c.status]}
      </Badge>
    </button>
  );
}

export function ChangesDrawer({ cid, open, onClose, focus, setFocus }: { cid: number; open: boolean; onClose: () => void; focus: number | null; setFocus: (id: number | null) => void }) {
  const [tab, setTab] = useState<'pending' | 'all'>('pending');
  const pending = useChanges(cid, 'pending');
  const all = useChanges(cid);
  const list = tab === 'pending' ? pending.data?.changes : all.data?.changes;
  return (
    <Drawer open={open} onClose={onClose} title="改动" width={860}>
      {focus ? (
        <ChangeDetail cid={cid} id={focus} onBack={() => setFocus(null)} />
      ) : (
        <div>
          <div className="px-5 pt-3">
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { value: 'pending', label: '待确认', count: pending.data?.changes.length ?? null },
                { value: 'all', label: '全部' },
              ]}
            />
          </div>
          {!list ? (
            <div className="p-5">
              <Spinner />
            </div>
          ) : !list.length ? (
            <Empty compact icon={<FileStack />} title={tab === 'pending' ? '没有要确认的改动' : '还没有改动'} />
          ) : (
            <div className={cn('divide-y divide-line')}>
              {list.map(c => (
                <ChangeRow key={c.id} c={c} onOpen={() => setFocus(c.id)} />
              ))}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
