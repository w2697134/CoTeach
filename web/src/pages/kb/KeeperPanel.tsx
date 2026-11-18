import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, BookOpen, Check, Users, ChevronDown, ChevronRight, FilePenLine, FilePlus, FolderInput, FolderOpen, FolderSearch, History, MoveRight, Paperclip, PenLine, Search, Send, Square, SquarePen, Trash2, Undo2, Upload, X } from 'lucide-react';
import { post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { Markdown } from '../../components/Markdown';
import { AgentAvatar, Alert, Badge, Button, IconButton, MenuItem, Popover, Skeleton, Textarea, cn } from '../../components/ui';
import { useChangeActions } from './Changes';
import { pastedFiles, pickedFromDrop, pickedFromList, sendMessage, type Picked } from './intake';
import { FileCard, FileTypeIcon, formatSize, typeLabel } from './FileCard';
import { fileTitle, readableError, stepLines, type StepLine, when } from './presentation';
import { STATUS_TEXT, STATUS_TONE, TA, plainText, useChanges, useKeeperRuns, useKeeperStream, useKnowledgeBases, useTaSession, useTaSessions, type Run } from './data';
import { ActionCard, AskCard, type ActionData, type AskData } from '../assistant/cards';
import { SpecialistsButton } from '../assistant/Specialists';
import { LiveCard } from '../messages/Cards';
import { useChatList } from '../messages/data';
import { motion } from 'motion/react';
import { HomeStage, greeting } from '../../components/HomeStage';
import { VoiceButton } from '../../components/VoiceButton';
import { useClasses } from '../classes/data';

const SHOWN = /\.(png|jpe?g|gif|webp)$/i;

const TOOL_ICON: Record<string, typeof BookOpen> = {
  list_files: FolderSearch,
  read_file: BookOpen,
  search: Search,
  write_file: PenLine,
  edit_file: PenLine,
  save_file: FolderInput,
  delete_file: Trash2,
  move_file: MoveRight,
  finish: Send,
  done: Check,
  list_knowledge_bases: FolderSearch,
  create_knowledge_base: FilePlus,
  rename_knowledge_base: PenLine,
  move_to_knowledge_base: MoveRight,
  delete_knowledge_base: Trash2,
  list_changes: History,
  revert_change: Undo2,
  ta_specialist: Users,
};

function ToolLine({ line }: { line: StepLine }) {
  const Icon = Object.hasOwn(TOOL_ICON, line.name) ? TOOL_ICON[line.name] : BookOpen;
  return (
    <div className="flex items-start gap-2 text-[13px] leading-5 text-ink-2">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
      <span className="line-clamp-2 min-w-0 break-all">
        <span className="font-medium text-ink">{line.label}</span> {line.text}
      </span>
    </div>
  );
}

/**
 * 整理助手交上来的一次改动。
 * 还没定的：图标块、标题、状态，底下「看改动」「不要」「确认生效」，描一圈主题色。
 * 不列改了哪几篇：好几个学生交的都叫「作业2」，列出来像重复，要看点「看改动」。
 * 定了的（已生效、没要）收成一张小卡：标题、状态、「看改动」，往上翻历史不乱；已生效的旁边有「撤回」。
 * 整理助手交的改动现在交了就生效（2026-11-12 起），等确认的只剩以前留下的和撞上老师同时改的。
 */
function ChangeCard({ cid, changeId, title, kbName, onOpen }: { cid: number; changeId: number; title?: string; kbName?: string; onOpen: (id: number) => void }) {
  const changes = useChanges(cid);
  const c = changes.data?.changes.find((x) => x.id === changeId);
  const { act, busy } = useChangeActions(cid);
  const status = c?.status;
  if (!c && changes.isPending) return <Skeleton className="h-[64px] rounded-xl" />;
  const name = plainText(c?.title || title || '');
  const look = (
    <button
      type="button"
      onClick={() => onOpen(changeId)}
      className="inline-flex items-center gap-0.5 rounded-md py-1 text-[13px] font-medium text-brand transition-colors hover:text-brand-hover"
    >
      看改动
      <ChevronRight className="size-3.5" />
    </button>
  );
  if (!c || (status !== 'pending' && status !== 'conflict'))
    return (
      <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 shadow-xs">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-surface-3 text-ink-3">
          <FilePenLine className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          {kbName && <p className="truncate text-[12px] text-ink-3">{kbName}</p>}
          <p className="line-clamp-2 text-[14px] leading-snug text-ink-2">{name}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          {status && <Badge tone={STATUS_TONE[status]}>{STATUS_TEXT[status]}</Badge>}
          <div className="flex items-center gap-3">
            {c && status === 'applied' && (
              <button
                type="button"
                disabled={busy === `${c.id}:revert`}
                onClick={() => act(c, 'revert')}
                className="rounded-md py-1 text-[13px] text-ink-3 transition-colors hover:text-ink disabled:opacity-50"
              >
                撤回
              </button>
            )}
            {look}
          </div>
        </div>
      </div>
    );
  return (
    <div className="overflow-hidden rounded-xl border border-brand/45 bg-surface shadow-xs ring-2 ring-brand/10">
      <div className="flex gap-3 px-3 pt-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-brand text-white">
          <FilePenLine className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          {kbName && <p className="truncate text-[12px] text-ink-3">{kbName}</p>}
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[14px] font-medium leading-snug text-ink">{name}</p>
            {status && <Badge tone={STATUS_TONE[status]}>{STATUS_TEXT[status]}</Badge>}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-line px-3 py-1.5">
        {look}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} loading={busy === `${c.id}:reject`} onClick={() => act(c, 'reject')}>
            不要
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Check className="size-3.5" />}
            loading={busy === `${c.id}:apply`}
            disabled={status === 'conflict'}
            onClick={() => act(c, 'apply')}
          >
            确认生效
          </Button>
        </div>
      </div>
    </div>
  );
}

/** 输入框上方摆着的文件按最外面那层文件夹归拢：文件夹名、里面每份的键（叉掉时一起去掉） */
function pickedFolders(list: { key: string; picked: Picked }[]) {
  const folders = new Map<string, string[]>();
  for (const a of list) {
    const cut = a.picked.path.indexOf('/');
    if (cut <= 0) continue;
    const name = a.picked.path.slice(0, cut);
    folders.set(name, [...(folders.get(name) || []), a.key]);
  }
  return [...folders].map(([name, keys]) => ({ name, keys }));
}

/** 一次带了好几份零散的文件：先摆这么多，其余点「还有 N 份」再摆出来 */
const LOOSE_SHOWN = 6;
const unread = (status: string) => status === 'failed' || status === 'skipped';
/** 和库里一模一样、没再存的那份：说和哪一份一样 */
const twinOf = (a: { path: string | null }) => (a.path ? `和「${fileTitle(a.path)}」一样，只存了一份` : '和库里的一样，只存了一份');

/**
 * 老师那句话带的文件：图片显示小图，点开看大图；别的显示文件名；没读出来的写原因。
 * 拖进来的整个文件夹只占一格（文件夹名、几份、几份没读出来），点开看里面有哪些。
 */
function Sent({ run }: { run: Run }) {
  const items = run.attachments || [];
  const folders = run.attachmentFolders || [];
  const [open, setOpen] = useState<string | null>(null);
  const [everything, setEverything] = useState(false);
  const loose = items.filter((a) => !folders.some((f) => a.name.startsWith(f.name + '/')));
  // 服务器只给前 60 份；零散的一共几份按总数减去文件夹里的算
  const looseTotal = items.length + (run.moreAttachments || 0) - folders.reduce((n, f) => n + f.count, 0);
  const shown = everything ? loose : loose.slice(0, LOOSE_SHOWN);
  const hidden = Math.max(0, looseTotal - shown.length);
  return (
    <div className="flex flex-col items-end gap-2">
      {folders.map((f) => {
        const inside = items.filter((a) => a.name.startsWith(f.name + '/'));
        const expanded = open === f.name;
        return (
          <FileCard
            key={f.name}
            folder
            name={f.name}
            meta={
              <>
                {f.count} 份{!!f.same && ` · ${f.same} 份重复`}
                {f.failed > 0 && <span className="text-bad"> · {f.failed} 份没读出来</span>}
              </>
            }
            onClick={() => setOpen(expanded ? null : f.name)}
            after={<ChevronDown className={cn('size-4 shrink-0 text-ink-3 transition-transform', !expanded && '-rotate-90')} />}
          >
            {expanded && (
              <ul className="max-h-72 space-y-1.5 overflow-y-auto border-t border-line px-3 py-2.5">
                {inside.map((a) => (
                  <li key={a.id} className="flex items-start gap-2 text-[13px] leading-5">
                    <FileTypeIcon name={a.name} kind={a.kind} size={20} className="mt-px" />
                    <span className="min-w-0 flex-1">
                      <span className="block break-all text-ink-2">{a.name.slice(f.name.length + 1)}</span>
                      {unread(a.status) && <span className="block text-bad">{a.reason || '没读出来'}</span>}
                      {a.status === 'same' && <span className="block text-ink-3">{twinOf(a)}</span>}
                    </span>
                  </li>
                ))}
                {f.count > inside.length && <li className="pl-7 text-[13px] text-ink-3">还有 {f.count - inside.length} 份</li>}
              </ul>
            )}
          </FileCard>
        );
      })}
      {shown.map((a) => {
        const raw = `/api/knowledge/${a.kbId}/intakes/${a.intakeId}/items/${a.id}/raw`;
        const name = a.name.split('/').pop() || a.name;
        if (a.kind === 'image' && SHOWN.test(a.name) && a.status !== 'uploading')
          return (
            <a key={a.id} href={`${raw}?inline=1`} target="_blank" rel="noreferrer" title={name} className="block">
              <img src={`${raw}?inline=1`} alt={name} className="max-h-44 max-w-[248px] rounded-xl border border-line object-cover shadow-xs" />
            </a>
          );
        const meta =
          a.status === 'uploading'
            ? '上传中'
            : unread(a.status)
              ? a.reason || '没读出来'
              : a.status === 'same'
                ? twinOf(a)
                : [typeLabel(a.name, a.kind), formatSize(a.size)].filter(Boolean).join(' · ');
        return <FileCard key={a.id} name={name} kind={a.kind} meta={meta} bad={unread(a.status)} />;
      })}
      {hidden > 0 &&
        (everything || loose.length <= shown.length ? (
          <span className="self-center text-[12px] text-ink-3">还有 {hidden} 份</span>
        ) : (
          <button type="button" onClick={() => setEverything(true)} className="self-center text-[12px] text-ink-3 hover:text-ink">
            还有 {hidden} 份
          </button>
        ))}
    </div>
  );
}

/** 老师说的那句话：右边一个气泡，带的文件摆在上面 */
function Said({ run }: { run: Run }) {
  // 不摆头像：顶上已经写着是跟 CoT 助教说话，右边紫色的就是老师自己
  return (
    <div className="flex justify-end">
      <div className="flex min-w-0 max-w-[85%] flex-col items-end gap-1.5">
        {!!run.attachments?.length && <Sent run={run} />}
        {run.request && (
          <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-brand px-3.5 py-2 text-[14px] leading-relaxed text-white">
            {plainText(run.request)}
          </div>
        )}
        {run.receiving && (
          <p className="text-[12px] text-ink-3">
            {run.receiving.status === 'uploading' ? '正在收文件' : `正在读文件 ${Math.min(run.receiving.done + 1, run.receiving.total)}/${run.receiving.total}`}
          </p>
        )}
      </div>
    </div>
  );
}

const JOB_WORD: Record<string, string> = { queued: '排着队', running: '在整理', done: '整理好了', error: '没做完', canceled: '停下了' };

/** CoT 助教交给后台整理助手的一件活：谁在做、做到哪了，做完的改动卡片；工作记录点开看 */
function JobCard({ job, here, names, onOpenChange }: { job: Run; here: number | null; names: Map<number, string> | null; onOpenChange: (kbId: number, id: number) => void }) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const lines = stepLines(job.events);
  const latest = lines[lines.length - 1];
  const going = job.status === 'queued' || job.status === 'running';
  const changes = (job.changes || []).map((c) => ({ id: c.id, kbId: c.kbId, title: c.title }));
  // 整理助手的回话常常带着路径、记录编号，卡片上只摆第一句，整段收在工作记录里
  const first = plainText(job.reply || '')
    .split(/\r?\n/)
    .map((x) => x.replace(/[*#`>-]/g, '').trim())
    .find(Boolean)
    ?.split(/(?<=[。！？])/)[0];
  const stop = async () => {
    setStopping(true);
    await post(`/keeper/runs/${job.id}/cancel`, {}).catch((err) => toast.fromError(err));
    setStopping(false);
  };
  return (
    <div className="space-y-2.5 rounded-xl border border-line bg-surface px-3.5 py-3 shadow-xs">
      <div className="flex items-center gap-2.5">
        {/* 后台的活看着是一件事，不再摆另一个机器人头像 */}
        <span
          className={cn(
            'flex size-[26px] shrink-0 items-center justify-center rounded-lg',
            job.status === 'running' ? 'bg-brand-soft text-brand' : job.status === 'done' ? 'bg-ok-soft text-ok' : 'bg-surface-3 text-ink-3',
          )}
        >
          <FolderInput className={cn('size-4', job.status === 'running' && 'animate-pulse')} />
        </span>
        <div className="min-w-0 flex-1 leading-snug">
          <p className="text-[14px] font-medium text-ink">整理资料 · {JOB_WORD[job.status] || '整理'}</p>
          <p className="truncate text-[13px] text-ink-3">{plainText(job.request).split('\n')[0]}</p>
        </div>
        {going && (
          <Button size="xs" variant="ghost" loading={stopping} onClick={stop} className="shrink-0 text-ink-3">
            停下
          </Button>
        )}
      </div>
      {job.status === 'running' && latest && !open && (
        <p className="truncate pl-[36px] text-[13px] text-ink-3">{latest.label ? `${latest.label} ${latest.text}` : latest.text}</p>
      )}
      {lines.length > 0 && (
        <div className="pl-[36px]">
          <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-[13px] text-ink-3 transition-colors hover:text-ink-2">
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
            看我是怎么整理的 · {lines.filter((l) => l.kind === 'tool').length} 步
          </button>
          {open && (
            <div className="ml-[6px] mt-1.5 space-y-1.5 border-l-2 border-line pl-3">
              {lines.map((l) =>
                l.kind === 'say' ? (
                  <p key={l.id} className="text-[13px] leading-5 text-ink-3">
                    {l.text}
                  </p>
                ) : (
                  <ToolLine key={l.id} line={l} />
                ),
              )}
              {job.status === 'done' && job.reply && (
                <div className="pt-1 text-[13px] leading-relaxed text-ink-3">
                  <Markdown compact>{plainText(job.reply)}</Markdown>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {job.status === 'done' && first && <p className="pl-[36px] text-[13px] leading-relaxed text-ink-2">{first}</p>}
      {changes
        .filter((c) => c.kbId)
        .map((c) => (
          <ChangeCard key={c.id} cid={c.kbId} changeId={c.id} title={c.title} kbName={names && c.kbId !== here ? names.get(c.kbId) : undefined} onOpen={(id) => onOpenChange(c.kbId, id)} />
        ))}
      {job.status === 'error' && <p className="pl-[36px] text-[13px] text-bad">{readableError(job.error)}</p>}
    </div>
  );
}

/**
 * 跟 CoT 助教说的一轮：老师的话在右边；左边是助教——干活时一行灰字（点开是工作记录），说完的话，
 * 然后按发生的先后摆卡片：办成了的事、交给整理助手的后台活、问老师的问题。
 */
/** 11-16 早上那一版在卡片上答问题时还没记「已回答」：上一轮问的、答的话正好是这一轮说的，也算在卡片上答的 */
function answeredOnCard(prev: Run | undefined, run: Run) {
  const ask = prev?.events.filter((e) => e.type === 'ask').pop();
  const said = ask?.data?.answered as { a: string }[] | undefined;
  return !!said?.length && said.map((s) => s.a || '（没选）').join('；') === run.request;
}

function TaRunBlock({
  run,
  prev,
  live,
  here,
  names,
  onOpenChange,
}: {
  run: Run;
  /** 这段会话里的上一轮 */
  prev?: Run;
  live: string | null;
  here: number | null;
  names: Map<number, string> | null;
  onOpenChange: (kbId: number, id: number) => void;
}) {
  const running = run.status === 'running';
  const [expanded, setExpanded] = useState(false);
  const lines = stepLines(run.events);
  const done = run.events.filter((e) => e.type === 'tool' && !e.data?.error).length;
  const latest = lines[lines.length - 1];
  const status = new Map((run.actions || []).map((a) => [a.id, a.status]));
  const jobs = new Map((run.jobs || []).map((j) => [j.id, j]));
  const cards = run.events.filter((e) => e.type === 'action' || e.type === 'job' || e.type === 'ask');
  const errorEvent = run.events.find((e) => e.type === 'error');
  // 在问题卡片上答的那一轮：不摆老师的气泡（卡片收起来那一行写着答了什么）
  const answered = run.events.some((e) => e.type === 'answer') || answeredOnCard(prev, run);
  return (
    <div className="space-y-3">
      {!answered && <Said run={run} />}
      {/* 助教这边不摆头像：顶上那一条已经写着 CoT 助教。整页很宽时对话铺满，卡片和回话不拉得过长（照飞书的消息卡片） */}
      <div>
        <div className="min-w-0 space-y-2.5 [&>*]:max-w-4xl">
          {done > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="inline-flex items-center gap-1 py-0.5 text-[13px] text-ink-3 transition-colors hover:text-ink-2"
              >
                <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
                看我是怎么办的 · {done} 步
              </button>
              {expanded && (
                <div className="ml-[6px] mt-1.5 space-y-1.5 border-l-2 border-line pl-3">
                  {lines.map((l) =>
                    l.kind === 'say' ? (
                      <p key={l.id} className="text-[13px] leading-5 text-ink-3">
                        {l.text}
                      </p>
                    ) : (
                      <ToolLine key={l.id} line={l} />
                    ),
                  )}
                </div>
              )}
            </div>
          )}
          {running && (
            <div className="flex items-start gap-2 text-[13px] text-ink-3">
              <span className="mt-1.5 flex gap-1">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="size-1.5 animate-bounce rounded-full bg-brand/60" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </span>
              {live && /[㐀-鿿]/.test(live) ? (
                <span className="min-w-0 whitespace-pre-wrap">{plainText(live)}</span>
              ) : (
                latest && !expanded && <span className="min-w-0 truncate">{latest.label ? `${latest.label} ${latest.text}` : latest.text}</span>
              )}
            </div>
          )}
          {/* 助教说的话不套气泡，跟 ChatGPT、Claude 一样直接是字；只有要老师处理的卡片带框 */}
          {!running && run.reply && (
            <div className="max-w-full text-[15px] leading-relaxed text-ink">
              <Markdown compact className="md-chat">{plainText(run.reply)}</Markdown>
            </div>
          )}
          {cards.map((e) => {
            // 通知、签到、选人：把办成的那样东西摆在对话里，数字跟着变（2026-11-18）
            if (e.type === 'action' && e.data.live) {
              const live = e.data.live as { type: 'notice' | 'checkin' | 'pick'; id: number };
              return (
                <div key={e.id}>
                  <LiveCard type={live.type} id={live.id} />
                </div>
              );
            }
            if (e.type === 'action') return <ActionCard key={e.id} data={e.data as unknown as ActionData} status={status.get(Number(e.data.actionId))} />;
            if (e.type === 'ask') return <AskCard key={e.id} runId={run.id} data={e.data as unknown as AskData} live={run.status === 'waiting'} />;
            const job = jobs.get(Number(e.data.jobRunId));
            return job ? <JobCard key={e.id} job={job} here={here} names={names} onOpenChange={onOpenChange} /> : null;
          })}
          {(errorEvent || run.error) && run.status !== 'canceled' && (
            <p role="alert" className="text-[13px] text-bad">
              {readableError(run.error || errorEvent?.data.message)}
            </p>
          )}
          {run.status === 'canceled' && <p className="text-[13px] text-ink-3">已停止</p>}
        </div>
      </div>
    </div>
  );
}

/** 交资料的按钮：选文件或者选整个文件夹 */
export function HandInButton({
  onPick,
  disabled,
  size = 'sm',
  variant = 'ghost',
  compact = false,
  clip = false,
}: {
  onPick: (files: Picked[]) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'primary' | 'secondary';
  /** 手机上只留图标，给旁边的路径腾地方 */
  compact?: boolean;
  /** 输入框里那个：只显示回形针 */
  clip?: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const pick = (list: FileList | null, el: HTMLInputElement | null) => {
    const files = pickedFromList(list || []);
    if (el) el.value = '';
    if (files.length) onPick(files);
  };
  return (
    <>
      <Popover
        align="start"
        width={160}
        trigger={({ toggle }) =>
          clip ? (
            <IconButton label="加文件" onClick={toggle} disabled={disabled}>
              <Paperclip className="size-[18px]" />
            </IconButton>
          ) : (
            <Button size={size} variant={variant} icon={<Upload className="size-4" />} disabled={disabled} onClick={toggle} title="交资料">
              <span className={compact ? 'max-sm:sr-only' : undefined}>交资料</span>
            </Button>
          )
        }
      >
        {(close) => (
          <div onClick={close}>
            <MenuItem icon={<FilePlus />} onClick={() => fileInput.current?.click()}>
              选文件
            </MenuItem>
            <MenuItem icon={<FolderOpen />} onClick={() => folderInput.current?.click()}>
              选文件夹
            </MenuItem>
          </div>
        )}
      </Popover>
      <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => pick(e.target.files, e.target)} />
      <input
        ref={(el) => {
          // 选整个文件夹：React 不认识这个属性，直接设到元素上
          folderInput.current = el;
          el?.setAttribute('webkitdirectory', '');
        }}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => pick(e.target.files, e.target)}
      />
    </>
  );
}

/** CoT 助教现在在干什么，一句话 */
function statusLine(run: Run | undefined, pending: number, archived: boolean) {
  if (archived) return '已封存';
  if (run?.receiving) return run.receiving.status === 'uploading' ? '正在收文件' : '正在读文件';
  if (run) return '正在回复';
  if (pending) return `有 ${pending} 处改动等你确认`;
  return '';
}
/** 助教交给整理助手的后台活：在整理、排着队的有几件 */
function jobsLine(runs: Run[]) {
  const jobs = runs.flatMap((r) => r.jobs || []);
  const running = jobs.filter((j) => j.status === 'running').length,
    queued = jobs.filter((j) => j.status === 'queued').length;
  if (running) return queued ? `后台在整理资料，还有 ${queued} 件排着` : '后台在整理资料';
  if (queued) return `后台有 ${queued} 件资料排着整理`;
  return '';
}

/** 开启新会话、翻以前的会话（照 DeepSeek、豆包：新会话就是从头聊，以前的还能点开接着说） */
function SessionButtons({ compact, disabled }: { compact: boolean; disabled: boolean }) {
  const qc = useQueryClient();
  const view = useTaSession((s) => s.view);
  const setView = useTaSession((s) => s.set);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = useTaSessions(open);
  const shown = view === 'current' ? list.data?.current : view;
  const startNew = async () => {
    setBusy(true);
    try {
      const r = await post<{ id: number }>('/keeper/sessions', {});
      setView(r.id);
      qc.invalidateQueries({ queryKey: ['ta-sessions'] });
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {compact ? (
        <IconButton label="开启新会话" onClick={startNew} disabled={disabled || busy}>
          <SquarePen className="size-[18px]" />
        </IconButton>
      ) : (
        <Button size="sm" variant="ghost" icon={<SquarePen className="size-4" />} loading={busy} disabled={disabled} onClick={startNew}>
          开启新会话
        </Button>
      )}
      <Popover
        width={300}
        onOpenChange={setOpen}
        trigger={({ toggle }) => (
          <IconButton label="历史会话" onClick={toggle}>
            <History className="size-[18px]" />
          </IconButton>
        )}
      >
        {(close) => (
          <div className="max-h-[60vh] overflow-y-auto py-1">
            <p className="px-3 pb-1.5 pt-1 text-[13px] text-ink-3">历史会话</p>
            {!list.data ? (
              <Skeleton className="mx-3 my-2 h-16" />
            ) : !list.data.sessions.length ? (
              <p className="px-3 py-3 text-[14px] text-ink-3">还没有</p>
            ) : (
              list.data.sessions.map((s) => (
                <button
                  key={s.id ?? 'old'}
                  type="button"
                  onClick={() => {
                    setView(s.id === list.data!.current ? 'current' : s.id);
                    close();
                  }}
                  className={cn(
                    'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors hover:bg-surface-3',
                    s.id === shown && 'bg-brand-soft/60',
                  )}
                >
                  <span className="line-clamp-1 w-full text-[14px] text-ink">{s.title || '（只发了文件）'}</span>
                  <span className="text-[12px] text-ink-3">{when(s.updatedAt)}</span>
                </button>
              ))
            )}
          </div>
        )}
      </Popover>
    </div>
  );
}

export interface KeeperHandle {
  /** 拖到页面上的资料也从这里交，输入框里写了话就一起带上 */
  handIn: (files: Picked[]) => void;
  /** 知识库页的交资料框：马上发出去（输入框里写了话、摆了文件的一起带上）；助教正忙就先摆在输入框上方，返回 false */
  handInNow?: (files: Picked[]) => boolean;
}

/**
 * 整理助手只有一个，管老师所有的知识库：在哪一页右边都是它、同一段对话。
 * kbId 是老师现在在看的知识库（在最外层为空）：说的话带上它，在这里交的资料放进这个库，在最外层交的由整理助手决定放哪。
 */
export const KeeperPanel = forwardRef<
  KeeperHandle,
  {
    kbId: number | null;
    /** 老师正翻开的那一页（说「这一页」时它知道是哪页） */
    file?: string | null;
    onOpenChange: (kbId: number, id: number) => void;
    /** 在某个知识库里时：看这个库的全部改动 */
    onOpenChanges?: () => void;
    /** page：CoT 助教页上占满整页，对话摆在中间一栏；panel：知识库页右边那一栏 */
    variant?: 'panel' | 'page';
    /** 知识库页右边还没说过话时摆的几句话，点一下就发 */
    suggestions?: string[];
  }
>(function KeeperPanel({ kbId, file, onOpenChange, onOpenChanges, variant = 'panel', suggestions }, ref) {
  const page = variant === 'page';
  const navigate = useNavigate();
  // 知识库页右边那一栏只摆在知识库页说的事（学生来问、布置作业这些只在助教页）
  const place = page ? undefined : ('kb' as const);
  const me = useAuth((s) => s.user);
  const q = useKeeperRuns(place);
  const live = useKeeperStream();
  const list = useKnowledgeBases().data?.knowledgeBases || [];
  const current = kbId === null ? null : list.find((k) => k.id === kbId);
  const archived = current?.status === 'archived';
  const pending = kbId === null ? list.reduce((n, k) => n + k.pending, 0) : (current?.pending ?? 0);
  const names = list.length > 1 ? new Map(list.map((k) => [k.id, k.name])) : null;
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  // 只有跟 CoT 助教的这段会话（服务器只给这些）；助教派的后台整理挂在派它的那一轮下面
  const runs = q.data?.runs || [];
  const activeId = q.data?.activeRunId ?? null;
  const activeRun = runs.find((r) => r.status === 'running');
  const busy = !!activeId || !!activeRun;
  // 学生通过学伴来问、在等老师回的：卡片可能在以前的会话里，顶上提一句（只在助教页）
  const students = page ? q.data?.waitingStudents || 0 : 0;
  const status =
    statusLine(activeRun, pending, !!archived) ||
    (students ? `${students} 个学生在等你回` : '') ||
    (runs.some((r) => r.status === 'waiting') ? '在等你回答' : '') ||
    jobsLine(runs);
  // 首页：
  // 助教页进来先看到问候和大输入框，发出去就是接着这段会话聊；正在回的、开了新会话还没说话的照这个来
  const [home, setHome] = useState(page);
  // 正在回、上一句它问了老师还在等回答：直接看对话
  const asked = runs[runs.length - 1]?.status === 'waiting';
  useEffect(() => {
    if (busy || asked) setHome(false);
  }, [busy, asked]);
  useEffect(() => {
    if (page && q.data && !q.data.runs.length) setHome(true);
  }, [page, q.data?.session]); // eslint-disable-line react-hooks/exhaustive-deps
  // 手机上顶栏只有菜单和「CoT 助教」，开新会话、翻以前的放到顶栏右边（照 ChatGPT 手机版）
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(page ? document.getElementById('top-actions') : null), [page]);

  // 停在最新的一条：内容变长（新的一步、卡片加载出来）时跟着到底；老师往上翻着看的时候不打扰
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // 换了一段会话：回到最底下
  const shownSession = q.data?.session;
  useEffect(() => {
    stick.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shownSession]);
  useEffect(() => {
    const el = scroller.current,
      box = content.current;
    if (!el || !box) return;
    const onScroll = () => (stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    const follow = new ResizeObserver(() => stick.current && (el.scrollTop = el.scrollHeight));
    el.addEventListener('scroll', onScroll, { passive: true });
    follow.observe(box);
    return () => {
      el.removeEventListener('scroll', onScroll);
      follow.disconnect();
    };
  }, []);

  // 发东西就是发消息带附件：选的、拖进来的、粘贴的文件先摆在输入框上方，写不写话都行，一起发出去
  const [attached, setAttached] = useState<{ key: string; picked: Picked; url: string | null }[]>([]);
  const composer = useRef<HTMLDivElement>(null);
  const attachedRef = useRef(attached);
  attachedRef.current = attached;
  useEffect(() => () => attachedRef.current.forEach((a) => a.url && URL.revokeObjectURL(a.url)), []);
  const attach = (files: Picked[]) => {
    if (!files.length || archived) return;
    setAttached((prev) => {
      const seen = new Set(prev.map((a) => a.key));
      const add = files
        .filter((p) => !seen.has(`${p.path}:${p.file.size}`))
        .map((p) => ({ key: `${p.path}:${p.file.size}`, picked: p, url: p.file.type.startsWith('image/') ? URL.createObjectURL(p.file) : null }));
      return [...prev, ...add];
    });
    requestAnimationFrame(() => composer.current?.querySelector('textarea')?.focus());
  };
  // 点一句建议：放进输入框，老师改改再发（演示账号几个人一起用，点一下就开工容易误动资料）
  const fill = (s: string) => {
    setText(s);
    requestAnimationFrame(() => {
      const box = composer.current?.querySelector('textarea');
      box?.focus();
      box?.setSelectionRange(s.length, s.length);
    });
  };
  const classes = useClasses().data?.classes.filter((c) => !c.archived) || [];
  // 首页那几句：照老师自己的课程（群里最近有动静的那门）、在等他回的学生出，点了填进输入框
  const active = useChatList(false).data?.chats.find((c) => c.kind === 'class' && c.last);
  const cls = active?.title || classes[0]?.name;
  const starters = [
    students > 0 && `${students} 个学生在等我回，帮我理一理`,
    ...(cls ? [`给「${cls}」发个通知`, `给「${cls}」发起签到，5 分钟`, `给「${cls}」备下一节课`, `「${cls}」最近那份作业交了几个人`] : ['帮我建一门课，叫计科2501 Python 程序设计']),
  ]
    .filter((x): x is string => !!x)
    .slice(0, 3);
  const detach = (key: string) =>
    setAttached((prev) => {
      const a = prev.find((x) => x.key === key);
      if (a?.url) URL.revokeObjectURL(a.url);
      return prev.filter((x) => x.key !== key);
    });
  useImperativeHandle(ref, () => ({
    handIn: attach,
    handInNow: (files: Picked[]) => {
      if (busy || sending || archived) {
        attach(files);
        return false;
      }
      void send(files);
      return true;
    },
  }));

  /** extra：知识库页交资料框里刚交的文件；said：点的那句现成的话（输入框里写的留着） */
  const send = async (extra: Picked[] = [], said?: string) => {
    const msg = (said ?? text).trim();
    const files = [...attached.map((a) => a.picked), ...extra];
    if ((!msg && !files.length) || archived || busy || sending) return;
    setSending(true);
    setHome(false);
    // 发了话就回到最新的一条，看得到自己说的和它的回答
    stick.current = true;
    try {
      // 很长的一段（教案、讲稿）服务器会当一份文件交给它；说给正看着的这段会话（翻出来的以前那段也能接着说）
      await sendMessage(msg, kbId, file ?? null, files, q.data ? q.data.session : undefined, place);
      if (said === undefined) setText('');
      attached.forEach((a) => a.url && URL.revokeObjectURL(a.url));
      setAttached([]);
      qc.invalidateQueries({ queryKey: ['keeper-runs'] });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!activeId) return;
    await post(`/keeper/runs/${activeId}/cancel`, {}).catch((err) => toast.fromError(err));
  };

  // 输入框：首页摆在中间，聊着的时候在底下
  const composerArea = (
    <div
      className={page ? (home ? 'w-full' : 'w-full shrink-0 px-3 pb-1 pt-3 lg:px-6') : 'shrink-0 p-3'}
      onDragOver={(e) => {
        if (archived || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
      }}
      onDrop={(e) => {
        if (archived || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        void pickedFromDrop(e.dataTransfer).then(attach);
      }}
    >
      <motion.div
        layoutId={page ? 'ta-composer' : undefined}
        transition={{ type: 'spring', stiffness: 260, damping: 32 }}
        ref={composer}
        className={cn('border border-line bg-surface transition-colors focus-within:border-brand/50', home ? 'rounded-[28px] shadow-lg' : 'rounded-2xl shadow-xs')}
      >
        {attached.length > 0 && (
          // 照 ChatGPT：带的文件在输入框上方横着排一行，多了左右滑，输入框不会被顶高
          <div className="flex items-center gap-2 overflow-x-auto px-3 pb-1 pt-3 [&>*]:shrink-0">
            {/* 拖进来、选进来的整个文件夹只占一格，叉掉就是整个文件夹不发了 */}
            {pickedFolders(attached).map((f) => (
              <FileCard key={f.name} compact folder name={f.name} meta={`${f.keys.length} 份`} onRemove={() => f.keys.forEach(detach)} />
            ))}
            {attached
              .filter((a) => !a.picked.path.includes('/'))
              .slice(0, 12)
              .map((a) => {
                const name = a.picked.path.split('/').pop() || a.picked.path;
                return a.url ? (
                  <div key={a.key} className="relative">
                    <img src={a.url} alt="" className="size-[50px] rounded-xl border border-line object-cover shadow-xs" />
                    <button
                      type="button"
                      aria-label="去掉"
                      onClick={() => detach(a.key)}
                      className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-ink/70 text-white shadow-sm hover:bg-ink"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ) : (
                  <FileCard
                    key={a.key}
                    compact
                    name={name}
                    meta={[typeLabel(name), formatSize(a.picked.file.size)].filter(Boolean).join(' · ')}
                    onRemove={() => detach(a.key)}
                  />
                );
              })}
            {attached.filter((a) => !a.picked.path.includes('/')).length > 12 && (
              <span className="self-center text-[12px] text-ink-3">还有 {attached.filter((a) => !a.picked.path.includes('/')).length - 12} 份</span>
            )}
          </div>
        )}
        <Textarea
          autoGrow
          maxRows={8}
          rows={home ? 3 : 2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            // 截图、复制的文件直接粘贴进来，摆在输入框上方，跟这句话一起发
            if (archived || !e.clipboardData.files.length) return;
            e.preventDefault();
            attach(pastedFiles(e.clipboardData.files));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={archived ? '学期已封存，只能查阅' : busy ? 'CoT 助教正在回复…' : home ? '想让我办点什么？' : '跟 CoT 助教说'}
          disabled={busy || archived}
          className={cn('min-h-0 resize-none border-0 bg-transparent shadow-none! focus:ring-0', home ? 'px-5 pb-1 pt-4 text-[16px]' : 'px-3.5 pb-1 pt-3')}
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          {archived ? <span /> : <HandInButton clip onPick={attach} disabled={busy} />}
          <span className="flex items-center gap-1">
          {!archived && <VoiceButton disabled={busy} onText={(t) => setText((x) => x + t)} />}
          {/* 照 ChatGPT：助教在回的时候发送键变成停下键（手机上也按得到） */}
          {busy && activeId ? (
            <button
              type="button"
              onClick={stop}
              aria-label="让它停下"
              title="让它停下"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink text-surface transition-colors hover:bg-ink/85"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => send()}
              disabled={(!text.trim() && !attached.length) || busy || sending || archived}
              aria-label="发送"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition-colors hover:bg-brand-hover disabled:opacity-40"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
          </span>
        </div>
      </motion.div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={
          page
            ? // 手机上顶栏已经写着「CoT 助教」，这里不再摆一遍；首页只留右边那几个按钮
              cn('hidden w-full shrink-0 items-center gap-3 px-3 pb-3 pt-1 lg:flex', !home && 'border-b border-line')
            : 'flex h-[60px] shrink-0 items-center gap-3 border-b border-line bg-gradient-to-r from-brand-soft/80 via-brand-soft/30 to-transparent px-4'
        }
      >
        <AgentAvatar agent={TA} size={38} status={busy ? 'running' : null} className={cn(home && 'invisible')} />
        <div className={cn('min-w-0 flex-1 leading-tight', home && 'invisible')}>
          <p className="truncate text-[15px] font-semibold text-ink">{TA.name}</p>
          {/* 学生在等老师回的卡片在收件箱里（2026-11-18）：这一行点了去收件箱 */}
          {status && students > 0 && status.startsWith(`${students} 个学生`) ? (
            <button type="button" onClick={() => navigate('/messages/inbox')} className="mt-0.5 block max-w-full truncate text-[13px] text-brand-ink hover:underline">
              {status}，去收件箱回
            </button>
          ) : (
            status && <p className={cn('mt-0.5 truncate text-[13px]', !busy && (pending || students) && !archived ? 'text-brand-ink' : 'text-ink-3')}>{status}</p>
          )}
        </div>
        {onOpenChanges && (
          <Button size="sm" variant="ghost" onClick={onOpenChanges} className="shrink-0">
            改动
            {pending > 0 && (
              <Badge tone="brand" className="ml-1">
                {pending}
              </Badge>
            )}
          </Button>
        )}
        {page && <SpecialistsButton compact={false} />}
        <SessionButtons compact={!page} disabled={busy} />
      </div>
      {slot &&
        createPortal(
          <div className="flex items-center">
            <SpecialistsButton compact />
            <SessionButtons compact disabled={busy} />
          </div>,
          slot,
        )}
      {/* 首页：中间一行问候、大输入框、几句话；发出去就接着这段会话聊（输入框落到底下） */}
      {page && home && (
        <HomeStage
          agent={TA}
          hello={greeting(me?.name ? `${me.name}老师` : '')}
          composer={composerArea}
          chips={archived ? [] : starters}
          onPick={fill}
          onHistory={runs.length ? () => setHome(false) : undefined}
        />
      )}
      <div ref={scroller} className={cn('min-h-0 flex-1 overflow-y-auto py-5', page ? 'px-3 lg:px-6' : 'px-4', page && home && 'hidden')}>
        <div ref={content} className="space-y-6">
          {/* 知识库页右边还没说过话：几句老师会说的话（从这个库现在的样子算出来的），点一下放进输入框，改改再发 */}
          {!page && q.data && !runs.length && (
            <div className="flex flex-col items-center gap-3 pt-[6vh] text-center">
              <AgentAvatar agent={TA} size={56} />
              <p className="text-[15px] leading-6 text-ink-2">{me?.name ? `${me.name}老师，` : ''}资料想怎么理，说一声就行</p>
              {!!suggestions?.length && !archived && (
                <div className="mt-2 flex w-full flex-col gap-2">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={busy || sending}
                      onClick={() => fill(s)}
                      className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-left text-[14px] leading-[22px] text-ink shadow-xs transition-colors hover:border-brand/40 hover:bg-brand-soft/40 disabled:opacity-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {q.error && (
            <Alert tone="bad">
              对话没打开，网络可能断了一下。
              <Button size="sm" onClick={() => q.refetch()}>
                重试
              </Button>
            </Alert>
          )}
          {!q.data && !q.error && <Skeleton className="h-32" />}
          {runs.map((run, i) => (
            <TaRunBlock
              key={run.id}
              run={run}
              prev={runs[i - 1]}
              live={live && live.runId === run.id ? live.text : null}
              here={kbId}
              names={names}
              onOpenChange={onOpenChange}
            />
          ))}
        </div>
      </div>
      {!(page && home) && composerArea}
    </div>
  );
});
