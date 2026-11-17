import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, CircleSlash, LoaderCircle, Minus, RotateCcw, X } from 'lucide-react';
import { get } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { Avatar, Badge, Button, Progress, cn, useConfirm } from '../../components/ui';
import { readableError, when } from './presentation';
import { FileTypeIcon, formatSize } from './FileCard';
import { fileTitle, plainPath, plainText } from './data';
import {
  KIND_LABEL,
  cancelIntake,
  finishIntake,
  moveToClass,
  putIntake,
  resumeIntake,
  uploadingHere,
  type Intake,
  type IntakeItem,
} from './intake';

const STATUS: Record<Intake['status'], { text: string; tone: 'brand' | 'ok' | 'warn' | 'bad' | 'gray' }> = {
  uploading: { text: '上传中', tone: 'brand' },
  reading: { text: '读取中', tone: 'brand' },
  digesting: { text: '整理中', tone: 'brand' },
  paused: { text: '已停下', tone: 'warn' },
  done: { text: '完成', tone: 'ok' },
  failed: { text: '没完成', tone: 'bad' },
  canceled: { text: '已取消', tone: 'gray' },
};

const ITEM_TEXT: Record<IntakeItem['status'], string> = {
  uploading: '上传中',
  waiting: '等待读取',
  reading: '正在读',
  done: '读好了',
  same: '和以前交的一样',
  failed: '没读成',
  skipped: '没有读',
};

/** 资料名：只显示名字，所在文件夹另起一行，都不带扩展名和斜杠 */
function ItemName({ item }: { item: IntakeItem }) {
  const dir = item.name.includes('/') ? item.name.slice(0, item.name.lastIndexOf('/')) : '';
  return (
    <span className="min-w-0">
      <span className="break-all text-ink">{fileTitle(item.name) || '资料'}</span>
      {dir && <span className="block break-all text-[12px] text-ink-3">{plainPath(dir)}</span>}
    </span>
  );
}

function ItemRow({ item }: { item: IntakeItem }) {
  const archive = item.method === 'archive' || item.kind === 'archive';
  const icon =
    item.status === 'done' || item.status === 'same' ? (
      <Check className="size-3.5 text-ok" />
    ) : item.status === 'failed' ? (
      <X className="size-3.5 text-bad" />
    ) : item.status === 'skipped' ? (
      <Minus className="size-3.5 text-ink-3" />
    ) : item.status === 'reading' || item.status === 'uploading' ? (
      <LoaderCircle className="size-3.5 animate-spin text-brand" />
    ) : (
      <CircleSlash className="size-3.5 text-ink-3" />
    );
  const state =
    archive && item.status === 'done'
      ? '已解开'
      : item.status === 'reading' && item.progress
        ? `正在读 ${item.progress.done}/${item.progress.total}`
        : item.status === 'uploading' && item.size
          ? `上传中 ${Math.floor((item.received / item.size) * 100)}%`
          : ITEM_TEXT[item.status];
  return (
    <li className="flex items-start gap-2 py-1.5 text-[13px] leading-5">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <ItemName item={item} />
          <span className="ml-auto shrink-0 text-[12px] text-ink-3">
            {KIND_LABEL[item.kind] ? `${KIND_LABEL[item.kind]} · ` : ''}
            {state}
          </span>
        </div>
        {(item.reason || item.advice) && (
          <p className={cn('mt-0.5', item.status === 'failed' ? 'text-bad' : 'text-ink-3')}>
            {[item.reason, item.advice].filter(Boolean).map((s) => plainText(s)).join('，')}
          </p>
        )}
        {item.notes.map((n, i) => (
          <p key={i} className="mt-0.5 text-ink-3">
            {plainText(n)}
          </p>
        ))}
      </div>
    </li>
  );
}

export function IntakeCard({ cid, intake }: { cid: number; intake: Intake }) {
  const user = useAuth((s) => s.user);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // 资料很多时推送只带一部分，展开时取全部
  const full = useQuery({
    queryKey: ['kb-intake', cid, intake.id, intake.updatedAt],
    queryFn: () => get<{ intake: Intake }>(`/knowledge/${cid}/intakes/${intake.id}`),
    enabled: open && !intake.complete,
    staleTime: Infinity,
  });
  const items = (open && !intake.complete && full.data?.intake.items) || intake.items;
  const c = intake.counts;
  const handled = c.done + c.same + c.failed + c.skipped;
  const stalled = intake.status === 'uploading' && !uploadingHere(intake.id);
  const status = stalled ? { text: '上传中断', tone: 'warn' as const } : STATUS[intake.status];
  // 只交了一份（选的一个文件或贴的一段）：写出它的名字，不用再展开清单
  const single = intake.total === 1 && intake.items.length === 1;

  const act = async (key: string, fn: () => Promise<{ intake: Intake }>) => {
    setBusy(key);
    try {
      putIntake(qc, cid, (await fn()).intake);
      qc.invalidateQueries({ queryKey: ['kb-runs', cid] });
      qc.invalidateQueries({ queryKey: ['kb-intakes', cid] });
      qc.invalidateQueries({ queryKey: ['keeper-runs'] });
      qc.invalidateQueries({ queryKey: ['keeper-intakes'] });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setBusy(null);
    }
  };
  const cancel = async () => {
    if (intake.status !== 'digesting') {
      const ok = await confirm({
        title: '取消这次交资料？',
        desc: '还没读完的资料不会放进知识库。',
        okText: '取消交资料',
        cancelText: '继续',
        danger: true,
      });
      if (!ok) return;
    }
    await act('cancel', () => cancelIntake(cid, intake.id));
  };

  const summary = [
    c.done ? `读好 ${c.done}` : '',
    c.same ? `和以前一样 ${c.same}` : '',
    c.failed ? `没读成 ${c.failed}` : '',
    c.skipped ? `没有读 ${c.skipped}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const retryable = items.some((i) => i.status === 'failed' && i.retryable);

  // 老师交的资料：跟老师说的话一样靠右放，样子跟对话里带的文件一样（图标块、名字、下面一行灰字）
  const first = intake.items[0];
  return (
    <div className="flex justify-end gap-2">
      <div className="flex min-w-0 max-w-[85%] flex-col items-end gap-1.5">
      {intake.message && (
          <div className="max-w-full whitespace-pre-wrap rounded-2xl rounded-tr-md bg-brand px-3.5 py-2 text-[14px] leading-relaxed text-white">
            {plainText(intake.message)}
          </div>
      )}
      <div className="w-[264px] max-w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-left shadow-xs">
        <div className="flex items-center gap-3">
          <FileTypeIcon name={single && first ? first.name : ''} kind={single && first ? first.kind : null} folder={!single} />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 break-all text-[14px] font-medium leading-[1.35] text-ink">
              {single && first ? fileTitle(first.name) : `${intake.total} 份资料`}
            </p>
            <p className="mt-0.5 truncate text-[12px] leading-4 text-ink-3">
              {single && first && first.size ? `${formatSize(first.size)} · ` : ''}
              {when(intake.createdAt)}
            </p>
          </div>
          <Badge tone={status.tone}>{status.text}</Badge>
        </div>

        {intake.status === 'uploading' && !stalled && (
          <div className="mt-2 space-y-1">
            <Progress value={intake.upload.size ? intake.upload.received / intake.upload.size : 0} />
            <p className="text-[13px] text-ink-3">
              已上传 {intake.upload.size ? Math.floor((intake.upload.received / intake.upload.size) * 100) : 0}%
            </p>
          </div>
        )}
        {intake.status === 'reading' && (
          <div className="mt-2 space-y-1">
            <Progress value={intake.total ? handled / intake.total : 0} />
            <p className="break-all text-[13px] text-ink-3">
              已读 {handled}/{intake.total} 份
              {intake.current &&
                ` · 正在读「${fileTitle(intake.current.name)}」${intake.current.progress ? ` ${intake.current.progress.done}/${intake.current.progress.total}` : ''}`}
            </p>
          </div>
        )}
        {intake.status === 'digesting' && intake.batches > 1 && (
          <div className="mt-2 space-y-1">
            <Progress value={intake.batch / intake.batches} />
            <p className="text-[13px] text-ink-3">
              正在整理第 {Math.min(intake.batch + 1, intake.batches)}/{intake.batches} 批
            </p>
          </div>
        )}
        {/* 停下了能接着来，用普通颜色；真没完成才用红字 */}
        {intake.status === 'paused' && intake.error && <p className="mt-2 text-[13px] text-ink-2">{readableError(intake.error)}</p>}
        {intake.status === 'failed' && intake.error && (
          <p role="alert" className="mt-2 text-[13px] text-bad">
            {readableError(intake.error)}
          </p>
        )}
        {intake.status === 'done' && !intake.changeId && c.same > 0 && !c.done && (
          <p className="mt-2 text-[13px] text-ink-3">都和以前交的一样，知识库没有变</p>
        )}
        {/* 长期库不留学生身份：只有一个班的学生、整理完了，就能一键改交到那个班 */}
        {intake.students?.map((s) => {
          const target = s.classes.length === 1 && s.classes[0].active ? s.classes[0] : null;
          const settled = intake.status === 'done' || intake.status === 'failed' || intake.status === 'canceled';
          return (
            <div key={s.itemId} className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-ink-2">
              <span className="min-w-0 break-all">
                「{fileTitle(s.name)}」里有{s.classes.map((k) => `${k.name} ${k.count} 名`).join('、')}学生的信息
              </span>
              {target && settled && (
                <Button
                  size="sm"
                  loading={busy === `move:${s.itemId}`}
                  onClick={() =>
                    act(`move:${s.itemId}`, async () => {
                      const r = await moveToClass(cid, intake.id, s.itemId, target.kbId);
                      toast.success(`已改交到${target.name}`);
                      return r;
                    })
                  }
                >
                  改交到这门课
                </Button>
              )}
            </div>
          );
        })}

        {!single && intake.total > 0 && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="mt-2 flex w-full items-center gap-1.5 text-left text-[13px] font-medium text-ink-2 hover:text-ink"
          >
            <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', !open && '-rotate-90')} />
            <span className="min-w-0 flex-1">{summary || `${intake.total} 份资料`}</span>
          </button>
        )}
        {open && (
          <ul className="mt-1 divide-y divide-line/60">
            {items.map((item) => (
              <ItemRow key={item.id} item={item} />
            ))}
            {!intake.complete && full.isLoading && <li className="py-1.5 text-[13px] text-ink-3">加载中…</li>}
          </ul>
        )}
        {single && (['failed', 'skipped'].includes(intake.items[0].status) || intake.items[0].notes.length > 0) && <ItemRow item={intake.items[0]} />}

        <div className="mt-2.5 flex flex-wrap gap-2 empty:hidden">
          {intake.status === 'paused' && (
            <Button size="sm" variant="primary" loading={busy === 'resume'} onClick={() => act('resume', () => resumeIntake(cid, intake.id))}>
              接着整理
            </Button>
          )}
          {intake.status === 'paused' && intake.batch > 0 && (
            <Button size="sm" loading={busy === 'finish'} onClick={() => act('finish', () => finishIntake(cid, intake.id))}>
              就整理到这里
            </Button>
          )}
          {(intake.status === 'done' || intake.status === 'failed') && retryable && (
            <Button size="sm" icon={<RotateCcw className="size-3.5" />} loading={busy === 'resume'} onClick={() => act('resume', () => resumeIntake(cid, intake.id))}>
              接着读
            </Button>
          )}
          {(intake.status === 'uploading' || intake.status === 'reading') && (
            <Button size="sm" variant="ghost" loading={busy === 'cancel'} onClick={cancel}>
              取消
            </Button>
          )}
          {intake.status === 'digesting' && (
            <Button size="sm" variant="ghost" loading={busy === 'cancel'} onClick={cancel}>
              停下
            </Button>
          )}
        </div>
      </div>
      </div>
      <Avatar name={user?.name} seed={user?.id} size={28} className="mt-0.5" />
    </div>
  );
}
