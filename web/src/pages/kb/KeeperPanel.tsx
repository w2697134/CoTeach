import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, BookOpen, Check, ChevronDown, ChevronRight, Clock, FilePenLine, FilePlus, FolderInput, FolderOpen, FolderSearch, MoveRight, OctagonX, Paperclip, PenLine, Search, Send, Trash2, Upload, X } from 'lucide-react';
import { get, post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { Markdown } from '../../components/Markdown';
import { AgentAvatar, Alert, Avatar, Badge, Button, IconButton, MenuItem, Popover, Skeleton, Textarea, cn } from '../../components/ui';
import { useChangeActions } from './Changes';
import { IntakeCard } from './IntakeCard';
import { pastedFiles, pickedFromDrop, pickedFromList, sendMessage, uploadingHere, useKeeperIntakes, type Intake, type Picked } from './intake';
import { FileCard, FileTypeIcon, formatSize, typeLabel } from './FileCard';
import { fileTitle, readableError, stepLines, type StepLine, when } from './presentation';
import { KEEPER, STATUS_TEXT, STATUS_TONE, plainText, useChanges, useKeeperRuns, useKeeperStream, useKnowledgeBases, type Run } from './data';

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
 * 定了的（已生效、没要）收成一张小卡：标题、状态、「看改动」，不再把改了哪几篇列一遍，往上翻历史不乱。
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
          <p className="line-clamp-2 text-[13.5px] leading-snug text-ink-2">{name}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          {status && <Badge tone={STATUS_TONE[status]}>{STATUS_TEXT[status]}</Badge>}
          {look}
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
                  <li key={a.id} className="flex items-start gap-2 text-[12.5px] leading-5">
                    <FileTypeIcon name={a.name} kind={a.kind} size={20} className="mt-px" />
                    <span className="min-w-0 flex-1">
                      <span className="block break-all text-ink-2">{a.name.slice(f.name.length + 1)}</span>
                      {unread(a.status) && <span className="block text-bad">{a.reason || '没读出来'}</span>}
                      {a.status === 'same' && <span className="block text-ink-3">{twinOf(a)}</span>}
                    </span>
                  </li>
                ))}
                {f.count > inside.length && <li className="pl-7 text-[12.5px] text-ink-3">还有 {f.count - inside.length} 份</li>}
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

function RunBlock({
  run,
  live,
  here,
  names,
  onOpenChange,
}: {
  run: Run;
  live: string | null;
  /** 老师现在在看的知识库（在最外层为空） */
  here: number | null;
  /** 知识库编号 → 名字；只有一个知识库时为空，卡片上不写库名 */
  names: Map<number, string> | null;
  onOpenChange: (kbId: number, id: number) => void;
}) {
  const user = useAuth((s) => s.user);
  const running = run.status === 'running';
  const [expanded, setExpanded] = useState(false);
  const lines = stepLines(run.events);
  const done = run.events.filter((e) => e.type === 'tool' && !e.data?.error).length;
  const latest = lines[lines.length - 1];
  // 交上来的改动：新的一轮服务器直接给；以前的从工作记录里找
  const changeEvents = run.events.filter((e) => e.type === 'change');
  const changes = run.changes?.length
    ? run.changes.map((c) => ({ id: c.id, kbId: c.kbId, title: c.title }))
    : changeEvents.length
      ? changeEvents.map((e) => ({ id: Number(e.data.changeId), kbId: Number(e.data.kbId) || run.kbId || here || 0, title: String(e.data.title || '') }))
      : run.changeId
        ? [{ id: run.changeId, kbId: run.kbId || here || 0, title: '' }]
        : [];
  // 以前交了改动时回话就是改动的标题，卡片上已经有了
  const echo = changes.length > 0 && !!run.reply && changes.some((c) => !!c.title && run.reply!.startsWith(c.title));
  const errorEvent = run.events.find((e) => e.type === 'error');
  return (
    <div className="space-y-3">
      {run.kind === 'chat' ? (
        <div className="flex justify-end gap-2">
          <div className="flex min-w-0 max-w-[85%] flex-col items-end gap-1.5">
            {!!run.attachments?.length && <Sent run={run} />}
            {run.request && (
              <div className="whitespace-pre-wrap rounded-2xl rounded-tr-md bg-brand px-3.5 py-2 text-[14px] leading-relaxed text-white">{plainText(run.request)}</div>
            )}
            {run.receiving && (
              <p className="text-[12px] text-ink-3">
                {run.receiving.status === 'uploading' ? '正在收文件' : `正在读文件 ${Math.min(run.receiving.done + 1, run.receiving.total)}/${run.receiving.total}`}
              </p>
            )}
          </div>
          <Avatar name={user?.name} seed={user?.id} size={28} className="mt-0.5" />
        </div>
      ) : (
        // 不是老师说话起的一轮（整理交来的资料、学期提炼）：像聊天软件里的时间那样，一行灰字夹在两道细线中间
        <div className="text-[12px] leading-5 text-ink-3">
          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-line" />
            <span className="shrink-0">
              {run.task?.label || (run.kind === 'summary' ? '学期提炼' : run.kind === 'observation' ? '其他助手提交的记录' : '整理交来的资料')} · {when(run.createdAt)}
            </span>
            <span className="h-px flex-1 bg-line" />
          </div>
          {/* 整理交来的资料时，交了什么上面那张卡片已经写了 */}
          {run.task?.detail && run.kind !== 'materials' && <p className="mx-auto mt-1 max-w-[90%] text-center text-[12.5px] text-ink-2">{plainText(run.task.detail)}</p>}
        </div>
      )}
      <div className="flex gap-2.5">
        <AgentAvatar agent={KEEPER} size={28} active={running} className="mt-0.5" />
        <div className="min-w-0 flex-1 space-y-2.5">
          {/* 工作记录照 ChatGPT、Claude 的做法：干活时也收着，就一行灰字；展开是左边一道细线串起来的一步步 */}
          {done > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="inline-flex items-center gap-1 py-0.5 text-[12.5px] text-ink-3 transition-colors hover:text-ink-2"
              >
                <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
                工作记录 · {done} 步
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
          {/* 干活时只摆一行：它正在说的话，没在说就是最近做的那件事 */}
          {running && (
            <div className="flex items-start gap-2 text-[13px] text-ink-3">
              <span className="mt-1.5 flex gap-1">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="size-1.5 animate-bounce rounded-full bg-brand/60" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </span>
              {/* 没有中文的是它自言自语（偶尔冒一句英文），不摆出来；工作记录里也不记 */}
              {live && /[㐀-鿿]/.test(live) ? (
                <span className="min-w-0 whitespace-pre-wrap">{plainText(live)}</span>
              ) : (
                latest && !expanded && <span className="min-w-0 truncate">{latest.label ? `${latest.label} ${latest.text}` : latest.text}</span>
              )}
            </div>
          )}
          {!running && run.reply && !echo && (
            <div className="rounded-2xl rounded-tl-md bg-surface-2 px-3.5 py-2.5">
              <Markdown compact>{plainText(run.reply)}</Markdown>
            </div>
          )}
          {changes
            .filter((c) => c.kbId)
            .map((c) => (
              <ChangeCard
                key={c.id}
                cid={c.kbId}
                changeId={c.id}
                title={c.title}
                kbName={names && c.kbId !== here ? names.get(c.kbId) : undefined}
                onOpen={(id) => onOpenChange(c.kbId, id)}
              />
            ))}
          {run.status === 'done' && !changes.length && !run.reply && <p className="text-[13px] text-ink-3">这次没有改知识库</p>}
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

/** 整理助手现在在干什么，一句话 */
function statusLine(intakes: Intake[], run: Run | undefined, pending: number, archived: boolean) {
  if (archived) return '已封存';
  const busy = [...intakes].reverse().find((i) => i.status === 'uploading' || i.status === 'reading' || i.status === 'digesting');
  if (busy?.status === 'uploading' && uploadingHere(busy.id))
    return `正在上传 ${busy.upload.size ? Math.floor((busy.upload.received / busy.upload.size) * 100) : 0}%`;
  if (busy?.status === 'reading') {
    const c = busy.counts;
    return `正在读第 ${Math.min(c.done + c.same + c.failed + c.skipped + 1, busy.total)}/${busy.total} 份`;
  }
  if (busy?.status === 'digesting') return busy.batches > 1 ? `正在整理第 ${Math.min(busy.batch + 1, busy.batches)}/${busy.batches} 批` : '正在整理';
  if (run?.receiving) return run.receiving.status === 'uploading' ? '正在收文件' : '正在读文件';
  if (run) return run.kind === 'chat' ? '正在处理' : '正在整理';
  if (pending) return `有 ${pending} 处改动等你确认`;
  return '';
}

export interface KeeperHandle {
  /** 拖到页面上的资料也从这里交，输入框里写了话就一起带上 */
  handIn: (files: Picked[]) => void;
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
  }
>(function KeeperPanel({ kbId, file, onOpenChange, onOpenChanges }, ref) {
  const q = useKeeperRuns();
  const live = useKeeperStream();
  const list = useKnowledgeBases().data?.knowledgeBases || [];
  const current = kbId === null ? null : list.find((k) => k.id === kbId);
  const archived = current?.status === 'archived';
  const pending = kbId === null ? list.reduce((n, k) => n + k.pending, 0) : (current?.pending ?? 0);
  const names = list.length > 1 ? new Map(list.map((k) => [k.id, k.name])) : null;
  const inbox = useQuery({
    queryKey: ['keeper-inbox'],
    queryFn: () =>
      get<{
        items: { id: number; kb_id: number; status: string; error: string | null; content: string; task?: { label: string; detail: string } }[];
      }>('/keeper/inbox'),
    refetchInterval: 5000,
  });
  const qc = useQueryClient();
  const intakes = useKeeperIntakes();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const runs = q.data?.runs || [];
  const intakeList = intakes.data?.intakes || [];
  // 交资料和整理记录按时间排在一起
  const timeline = [
    ...runs.map((run) => ({ at: run.createdAt, key: `r${run.id}`, run })),
    ...intakeList.filter((intake) => !intake.runId).map((intake) => ({ at: intake.createdAt, key: `i${intake.id}`, intake })),
  ].sort((a, b) => a.at - b.at);
  const activeId = q.data?.activeRunId ?? null;
  const activeRun = runs.find((r) => r.status === 'running');
  const busy = !!activeId || !!activeRun;
  const status = statusLine(intakeList, activeRun, pending, !!archived);

  // 停在最新的一条：内容变长（新的一步、卡片加载出来）时跟着到底；老师往上翻着看的时候不打扰
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
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
  const detach = (key: string) =>
    setAttached((prev) => {
      const a = prev.find((x) => x.key === key);
      if (a?.url) URL.revokeObjectURL(a.url);
      return prev.filter((x) => x.key !== key);
    });
  useImperativeHandle(ref, () => ({ handIn: attach }));

  const send = async () => {
    const msg = text.trim();
    if ((!msg && !attached.length) || archived || busy || sending) return;
    setSending(true);
    // 发了话就回到最新的一条，看得到自己说的和它的回答
    stick.current = true;
    try {
      // 很长的一段（教案、讲稿）服务器会当一份文件交给它
      await sendMessage(
        msg,
        kbId,
        file ?? null,
        attached.map((a) => a.picked),
      );
      setText('');
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[60px] shrink-0 items-center gap-3 border-b border-line bg-gradient-to-r from-brand-soft/80 via-brand-soft/30 to-transparent px-4">
        <AgentAvatar agent={KEEPER} size={38} status={busy ? 'running' : null} />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-[15px] font-semibold text-ink">{KEEPER.name}</p>
          {status && (
            <p className={cn('mt-0.5 truncate text-[12.5px]', !busy && pending && !archived ? 'text-brand-ink' : 'text-ink-3')}>{status}</p>
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
        {busy && activeId && (
          <IconButton label="让它停下" onClick={stop} className="shrink-0">
            <OctagonX className="size-[18px]" />
          </IconButton>
        )}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div ref={content} className="space-y-6">
          {inbox.data?.items
            .filter((item) => item.status !== 'running')
            .map((item) => (
              <div key={item.id} className="flex gap-2.5 rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] leading-relaxed">
                <Clock className={cn('mt-0.5 size-4 shrink-0', item.status === 'error' ? 'text-bad' : 'text-ink-3')} />
                <div className="min-w-0 flex-1">
                <p className="text-ink-2">
                  {item.task?.label || '整理任务'} · {item.status === 'error' ? '未完成' : '排队中'}
                </p>
                {item.task?.detail && <p className="mt-1 text-ink-2">{plainText(item.task.detail)}</p>}
                {item.error && <p className="mt-1 text-bad">{readableError(item.error)}</p>}
                {!archived && item.status === 'error' && (
                  <Button
                    size="sm"
                    className="mt-2"
                    onClick={async () => {
                      try {
                        await post(`/knowledge/${item.kb_id}/inbox/${item.id}/process`, {});
                        await inbox.refetch();
                        qc.invalidateQueries({ queryKey: ['keeper-runs'] });
                      } catch (e) {
                        toast.fromError(e);
                      }
                    }}
                  >
                    重试
                  </Button>
                )}
                </div>
              </div>
            ))}
          {q.error && (
            <Alert tone="bad">
              工作记录加载失败。
              <Button size="sm" onClick={() => q.refetch()}>
                重试
              </Button>
            </Alert>
          )}
          {!q.data && !q.error && <Skeleton className="h-32" />}
          {timeline.map((t) =>
            'run' in t && t.run ? (
              <RunBlock
                key={t.key}
                run={t.run}
                live={live && live.runId === t.run.id ? live.text : null}
                here={kbId}
                names={names}
                onOpenChange={onOpenChange}
              />
            ) : 'intake' in t && t.intake ? (
              <IntakeCard key={t.key} cid={t.intake.kbId} intake={t.intake} />
            ) : null,
          )}
        </div>
      </div>
      <div
        className="shrink-0 p-3"
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
        <div ref={composer} className="rounded-2xl border border-line bg-surface shadow-xs transition-colors focus-within:border-brand/50">
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
            rows={2}
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
            placeholder={archived ? '学期已封存，只能查阅' : busy ? '整理助手正在忙…' : '跟整理助手说'}
            disabled={busy || archived}
            className="min-h-0 resize-none border-0 bg-transparent px-3.5 pb-1 pt-3 shadow-none! focus:ring-0"
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            {archived ? <span /> : <HandInButton clip onPick={attach} disabled={busy} />}
            <button
              type="button"
              onClick={send}
              disabled={(!text.trim() && !attached.length) || busy || sending || archived}
              aria-label="发送"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition-colors hover:bg-brand-hover disabled:opacity-40"
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
