import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { BellRing, Check, CircleCheck, Copy, Dices, Download, Maximize2, Megaphone, Paperclip, PictureInPicture2, Undo2, X } from 'lucide-react';
import { post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { Badge, Button, Skeleton, cn } from '../../components/ui';
import { Qr, copyText } from '../classes/Invite';
import { themeBackground, themeOf } from '../classes/look';
import { fileUrl, isImage } from '../classes/homework';
import { chatTime, checkinLink, hhmm, mmss, recallLine, useCheckin, useLeft, useNotice, usePick, type CheckinData, type FileRef } from './data';
import { useCheckinFloat } from './CheckinFloat';

/**
 * 通知、签到、选人的卡片（照飞书、学习通的消息卡片：白底细边框，头上一行写是什么、哪门课）。
 * 群里、收件箱、CoT 助教的对话里摆的都是这几张，按编号去取，数字跟着变。
 */

const teacherOf = () => {
  const role = useAuth.getState().user?.role;
  return role === 'teacher' || role === 'admin';
};

function Shell({ icon, tone, title, aside, children, className }: { icon: React.ReactNode; tone: string; title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('w-full max-w-[420px] overflow-hidden rounded-xl border border-line bg-surface shadow-xs', className)}>
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md text-white [&>svg]:size-3.5', tone)}>{icon}</span>
        <p className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{title}</p>
        {aside}
      </div>
      <div className="px-3.5 pb-3.5 pt-3">{children}</div>
    </div>
  );
}

const Loading = () => <Skeleton className="h-28 w-full max-w-[420px] rounded-xl" />;

/** 带的附件：图片摆小图，别的是一行文件名 */
export function Files({ files }: { files: FileRef[] }) {
  if (!files.length) return null;
  return (
    <div className="mt-2.5 space-y-1.5">
      {files.map((f) =>
        isImage(f.name) ? (
          <a key={f.id} href={fileUrl(f, true)} target="_blank" rel="noopener" className="block w-fit">
            <img src={fileUrl(f, true)} alt={f.name} className="max-h-48 rounded-lg border border-line object-contain" />
          </a>
        ) : (
          <a key={f.id} href={fileUrl(f)} className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-2 text-[14px] text-ink hover:bg-surface-3">
            <Paperclip className="size-4 shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <Download className="size-4 shrink-0 text-ink-3" />
          </a>
        ),
      )}
    </div>
  );
}

/** 读了几个：一条细进度条 */
function Meter({ part, total, tone = 'bg-brand' }: { part: number; total: number; tone?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <div className={cn('h-full rounded-full transition-[width] duration-500', tone)} style={{ width: `${total ? Math.round((part / total) * 100) : 0}%` }} />
    </div>
  );
}

/** 一串名字：多了收起来，点开看全 */
function Names({ names, onPick }: { names: { key: string | number; name: string }[]; onPick?: (key: string | number) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? names : names.slice(0, 12);
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {shown.map((n) =>
        onPick ? (
          <button
            key={n.key}
            type="button"
            onClick={() => onPick(n.key)}
            title="补签"
            className="rounded-full border border-line px-2 py-0.5 text-[13px] text-ink-2 transition-colors hover:border-brand/50 hover:text-brand-ink"
          >
            {n.name}
          </button>
        ) : (
          <span key={n.key} className="rounded-full bg-surface-3 px-2 py-0.5 text-[13px] text-ink-2">
            {n.name}
          </span>
        ),
      )}
      {names.length > 12 && (
        <button type="button" onClick={() => setAll(!all)} className="px-1 text-[13px] text-brand-ink hover:underline">
          {all ? '收起' : `还有 ${names.length - 12} 人`}
        </button>
      )}
    </div>
  );
}

/* ---------------- 通知 ---------------- */

/** 通知卡：正文、附件；老师那边下面写读了几个、谁没读，能提醒没读的、撤回。classId：群里的卡只算这门课的人 */
export function NoticeCard({ id, classId, className, bare }: { id: number; classId?: number | null; className?: string; bare?: boolean }) {
  const q = useNotice(id, classId);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'remind' | 'recall' | null>(null);
  const n = q.data;
  if (q.isError) return <p className="text-[13px] text-ink-3">这条通知不在了</p>;
  if (!n) return <Loading />;
  // 撤回了：群里、学生那边只剩一行灰字；老师在助教对话里看到的卡片收成灰的，写着已撤回
  if (n.recalled) {
    const mine = teacherOf();
    if (bare || !mine) return <p className="text-[13px] text-ink-3">{recallLine(mine)}</p>;
    return (
      <Shell
        className={className}
        icon={<Undo2 />}
        tone="bg-surface-3 text-ink-3"
        title={`通知 · ${n.classes.map((k) => k.name).join('、')}`}
        aside={<Badge tone="gray">已撤回</Badge>}
      >
        <p className="line-clamp-2 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink-3 line-through">{n.text}</p>
      </Shell>
    );
  }
  const teacher = n.total !== undefined;
  const remind = async () => {
    setBusy('remind');
    try {
      const r = await post<{ reminded: number }>(`/messages/notices/${id}/remind`, {});
      toast.success(`提醒了 ${r.reminded} 人`);
      qc.invalidateQueries({ queryKey: ['notice', id] });
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(null);
    }
  };
  // 撤回：这张卡（群里的、助教对话里的）跟着换成撤回了的样子；已经撤回过的报一句，也刷新成撤回了的样子
  const recall = async () => {
    setBusy('recall');
    try {
      await post(`/messages/notices/${id}/recall`, {});
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(null);
      qc.invalidateQueries({ queryKey: ['notice', id] });
      qc.invalidateQueries({ queryKey: ['chat'] });
      qc.invalidateQueries({ queryKey: ['messages'] });
    }
  };
  return (
    <Shell
      className={className}
      icon={<Megaphone />}
      tone="bg-[#f59e0b]"
      title={bare ? '通知' : `通知 · ${n.classes.map((k) => k.name).join('、')}`}
      aside={<span className="shrink-0 text-[13px] text-ink-3">{chatTime(n.at, true)}</span>}
    >
      <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink">{n.text}</p>
      <Files files={n.files} />
      {teacher ? (
        <div className="mt-3 border-t border-line pt-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[14px] text-ink-2">
              已读 <b className="text-[18px] font-semibold tabular-nums text-ink">{n.read}</b>
              <span className="tabular-nums"> / {n.total}</span>
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              {!!n.unread?.length && (
                <Button size="xs" variant="soft" icon={<BellRing className="size-3.5" />} loading={busy === 'remind'} disabled={!!busy} onClick={remind}>
                  提醒没读的
                </Button>
              )}
              <Button size="xs" variant="soft" icon={<Undo2 className="size-3.5" />} loading={busy === 'recall'} disabled={!!busy} onClick={recall}>
                撤回
              </Button>
            </div>
          </div>
          <div className="mt-2">
            <Meter part={n.read!} total={n.total!} tone="bg-ok" />
          </div>
          {n.unread?.length ? (
            <>
              <p className="mt-2.5 text-[13px] text-ink-3">没读的 {n.unread.length} 人</p>
              <Names names={n.unread.map((x, i) => ({ key: i, name: x }))} />
            </>
          ) : (
            n.total! > 0 && <p className="mt-2 text-[13px] text-ok">都读了</p>
          )}
        </div>
      ) : null}
    </Shell>
  );
}

/* ---------------- 签到 ---------------- */


/**
 * 签到卡。老师：二维码（点一下全屏投到大屏上）、链接、倒计时、签了几个、谁没签（点名字补签）、提前结束；
 * 学生：点「签到」就签上，签了写几点签的。
 */
export function CheckinCard({ id, className, bare }: { id: number; className?: string; bare?: boolean }) {
  const q = useCheckin(id);
  const qc = useQueryClient();
  const c = q.data;
  const left = useLeft(c);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = !!c?.open && left > 0;
  // 倒计时到了：再取一次，换成结束的样子
  useEffect(() => {
    if (c?.open && left <= 0) void q.refetch();
  }, [c?.open, left, q]);
  if (q.isError) return <p className="text-[13px] text-ink-3">这次签到不在了</p>;
  if (!c) return <Loading />;
  const refresh = () => qc.invalidateQueries({ queryKey: ['checkin', id] });
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
      await refresh();
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  const status = open ? (
    <span className="shrink-0 rounded-full bg-ok-soft px-2 py-0.5 text-[13px] font-medium tabular-nums text-ok">还剩 {mmss(left)}</span>
  ) : (
    <span className="shrink-0 text-[13px] text-ink-3">已结束</span>
  );
  if (c.people === undefined) {
    // 学生
    return (
      <Shell className={className} icon={<CircleCheck />} tone="bg-ok" title={bare ? '签到' : `签到 · ${c.className}`} aside={status}>
        {c.mine ? (
          <p className="flex items-center gap-2 text-[15px] font-medium text-ok">
            <Check className="size-5" />
            已签到 <span className="font-normal text-ink-3">{chatTime(c.mine, true)}</span>
          </p>
        ) : open ? (
          <Button size="lg" variant="primary" block loading={busy} icon={<CircleCheck className="size-5" />} onClick={() => act(() => post(`/messages/checkins/${id}/sign`, {}), '签到了')}>
            签到
          </Button>
        ) : (
          <p className="text-[15px] text-ink-2">签到结束了，没签上</p>
        )}
      </Shell>
    );
  }
  const unsigned = c.people.filter((p) => !p.at);
  const mark = (uid: number, name: string) => act(() => post(`/messages/checkins/${id}/mark`, { userId: uid }), `给${name}补签了`);
  return (
    <Shell className={className} icon={<CircleCheck />} tone="bg-ok" title={bare ? '签到' : `签到 · ${c.className}`} aside={status}>
      <div className="flex gap-3.5">
        {open && c.token && (
          <button type="button" onClick={() => setFull(true)} title="全屏，投到大屏上" className="group relative shrink-0 rounded-lg ring-1 ring-line">
            <Qr text={checkinLink(c.token)} size={156} />
            <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/0 text-white opacity-0 transition-all group-hover:bg-black/35 group-hover:opacity-100">
              <Maximize2 className="size-6" />
            </span>
          </button>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[14px] text-ink-2">
            签了 <b className="text-[26px] font-semibold leading-none tabular-nums text-ink">{c.signed}</b>
            <span className="tabular-nums"> / {c.total}</span>
          </p>
          <div className="mt-2">
            <Meter part={c.signed!} total={c.total!} tone="bg-ok" />
          </div>
          {open && c.token && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Button size="xs" variant="secondary" icon={<Maximize2 className="size-3.5" />} onClick={() => setFull(true)}>
                全屏
              </Button>
              <Button size="xs" variant="secondary" icon={<PictureInPicture2 className="size-3.5" />} onClick={() => useCheckinFloat.getState().open(id)}>
                分屏
              </Button>
              <Button size="xs" variant="secondary" icon={<Copy className="size-3.5" />} onClick={() => copyText(checkinLink(c.token!), '签到链接')}>
                复制链接
              </Button>
              <Button size="xs" variant="ghost" className="text-ink-3" loading={busy} onClick={() => act(() => post(`/messages/checkins/${id}/end`, {}))}>
                结束
              </Button>
            </div>
          )}
          {open && c.token && <p className="mt-2 select-all truncate text-[13px] text-ink-3">{checkinLink(c.token).replace(/^https?:\/\//, '')}</p>}
        </div>
      </div>
      {unsigned.length > 0 ? (
        <div className="mt-3 border-t border-line pt-2.5">
          <p className="text-[13px] text-ink-3">没签的 {unsigned.length} 人，点名字补签</p>
          <Names names={unsigned.map((p) => ({ key: p.id, name: p.name }))} onPick={(uid) => mark(Number(uid), unsigned.find((p) => p.id === uid)!.name)} />
        </div>
      ) : (
        c.total! > 0 && <p className="mt-3 border-t border-line pt-2.5 text-[13px] text-ok">都签了</p>
      )}
      {full && c.token && (
        <CheckinScreen
          c={c}
          left={left}
          onClose={() => setFull(false)}
          onMark={mark}
          onEnd={() => act(() => post(`/messages/checkins/${id}/end`, {}))}
          // 先开小窗（要在这一下点击里开），再退出全屏
          onFloat={() => (useCheckinFloat.getState().open(id), setFull(false))}
        />
      )}
    </Shell>
  );
}

/** 存一下老师上次用的样子（只是本机的小方便，存不了也照常用） */
const keep = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 存不了就算了 */
    }
  },
};
const clampRatio = (v: number) => Math.min(0.75, Math.max(0.28, v));

/** 横屏（投影、电脑）左右分；竖屏（手机）上下分 */
function useLandscape() {
  const get = () => window.innerWidth >= window.innerHeight;
  const [wide, setWide] = useState(get);
  useEffect(() => {
    const on = () => setWide(get());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return wide;
}

/**
 * 签到全屏：投到教室大屏上，学生拿手机扫。
 * 一边大二维码，一边名单（没签的、签了的按钮切，点没签的名字补签），中间那根条拖着改两边多宽，记住上次的宽度。底色用这门课的颜色。
 * 右上角「分屏」：收成一个浮在最上面的小窗，只剩二维码、倒计时、签了几个，老师在旁边接着放 PPT（见 CheckinFloat）。
 */
function CheckinScreen({
  c,
  left,
  onClose,
  onMark,
  onEnd,
  onFloat,
}: {
  c: CheckinData;
  left: number;
  onClose: () => void;
  onMark: (uid: number, name: string) => void;
  onEnd: () => void;
  onFloat: () => void;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    let entered = false;
    document.documentElement
      .requestFullscreen?.()
      .then(() => (entered = true))
      .catch(() => {});
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    const onChange = () => !document.fullscreenElement && entered && close.current();
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
  }, []);
  const theme = themeOf(c.classId);
  const link = checkinLink(c.token!);
  const open = c.open && left > 0;
  const wide = useLandscape();
  const [ratio, setRatio] = useState(() => {
    const v = Number(keep.get('ct-checkin-split'));
    return v ? clampRatio(v) : 0.5;
  });
  const latest = useRef(ratio);
  const [tab, setTab] = useState<'un' | 'in'>('un');
  const [ending, setEnding] = useState(false);
  useEffect(() => {
    if (!ending) return;
    const t = window.setTimeout(() => setEnding(false), 3000);
    return () => clearTimeout(t);
  }, [ending]);
  const box = useRef<HTMLDivElement>(null);
  const setSplit = (v: number) => {
    latest.current = clampRatio(v);
    setRatio(latest.current);
  };
  // 拖中间那根条：按住拖，松手记住
  const drag = (e: React.PointerEvent) => {
    const el = box.current;
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => setSplit(wide ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.removeProperty('cursor');
      keep.set('ct-checkin-split', String(latest.current));
    };
    document.body.style.cursor = wide ? 'col-resize' : 'row-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const people = c.people || [];
  const unsigned = people.filter((p) => !p.at);
  const signed = people.filter((p) => p.at).sort((a, b) => b.at! - a.at!);
  const pill = 'rounded-full px-[1.8vmin] py-[0.9vmin] text-[clamp(13px,2vmin,22px)] transition-colors';

  const qrBlock = (
    <div className="relative flex h-full w-full items-center justify-center">
      {/* 二维码按这一格的长宽取小的那个，拖窄了跟着变小 */}
      <div className="relative aspect-square" style={{ width: 'min(100cqw, 100cqh)' }}>
        <Qr text={link} fill className={cn('rounded-[1.5vmin] transition-opacity', !open && 'opacity-15')} />
        {!open && <p className="absolute inset-0 flex items-center justify-center text-[clamp(20px,4.5vmin,52px)] font-semibold text-[#334155]">签到结束了</p>}
      </div>
    </div>
  );

  const roster = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-end justify-between gap-[2vmin]">
        <p className="text-[clamp(16px,2.6vmin,30px)] text-[#475569]">
          签了 <b className="text-[clamp(30px,6.5vmin,80px)] font-bold leading-none tabular-nums text-[#0f172a]">{c.signed}</b>
          <span className="tabular-nums"> / {c.total}</span>
        </p>
        <div className="flex shrink-0 rounded-full bg-[#f1f5f9] p-[0.5vmin] text-[clamp(14px,2.2vmin,26px)] text-[#475569]">
          <button type="button" onClick={() => setTab('un')} className={cn('rounded-full px-[2vmin] py-[0.6vmin] transition-colors', tab === 'un' ? 'bg-white font-medium text-[#0f172a] shadow-sm' : 'hover:text-[#0f172a]')}>
            没签 <span className="tabular-nums">{unsigned.length}</span>
          </button>
          <button type="button" onClick={() => setTab('in')} className={cn('rounded-full px-[2vmin] py-[0.6vmin] transition-colors', tab === 'in' ? 'bg-white font-medium text-[#0f172a] shadow-sm' : 'hover:text-[#0f172a]')}>
            签了 <span className="tabular-nums">{signed.length}</span>
          </button>
        </div>
      </div>
      <div className="mt-[1.6vmin] h-[1vmin] min-h-1.5 overflow-hidden rounded-full bg-[#e2e8f0]">
        <div className="h-full rounded-full bg-[#16a34a] transition-[width] duration-500" style={{ width: `${c.total ? Math.round((c.signed! / c.total) * 100) : 0}%` }} />
      </div>
      <div className="mt-[2.4vmin] min-h-0 flex-1 overflow-y-auto pr-1">
        {(tab === 'un' ? unsigned : signed).length === 0 ? (
          <p className="flex h-full items-center justify-center gap-[1vmin] text-[clamp(18px,3.2vmin,38px)] text-[#64748b]">
            {tab === 'un' ? (
              <>
                <Check className="size-[1.2em] text-[#16a34a]" />
                都签了
              </>
            ) : (
              '还没人签'
            )}
          </p>
        ) : (
          <div className="grid gap-[1.2vmin]" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(110px, 16vmin, 220px), 1fr))' }}>
            {tab === 'un'
              ? unsigned.map((p) => (
                  <motion.button
                    key={p.id}
                    layout
                    type="button"
                    title="点一下补签"
                    onClick={() => onMark(p.id, p.name)}
                    className="truncate rounded-[1.2vmin] bg-[#f1f5f9] px-[1.4vmin] py-[1.1vmin] text-left text-[clamp(15px,2.4vmin,28px)] text-[#1e293b] ring-[#16a34a]/50 transition-shadow hover:ring-2"
                  >
                    {p.name}
                  </motion.button>
                ))
              : signed.map((p) => (
                  <motion.div
                    key={p.id}
                    layout
                    initial={{ scale: 0.85, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 380, damping: 26 }}
                    className="flex items-baseline justify-between gap-[1vmin] rounded-[1.2vmin] bg-[#dcfce7] px-[1.4vmin] py-[1.1vmin] text-[clamp(15px,2.4vmin,28px)] text-[#14532d]"
                  >
                    <span className="truncate">{p.name}</span>
                    <span className="shrink-0 text-[0.62em] tabular-nums text-[#15803d]">{p.by === 'teacher' ? '补签' : hhmm(p.at!)}</span>
                  </motion.div>
                ))}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="签到" className="fixed inset-0 z-[95] flex flex-col text-[#0f172a]" style={themeBackground(theme)}>
      {/* 顶上一行：哪门课、还剩多久；右边分屏、结束、关 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-[2.4vmin] gap-y-2 px-[3vmin] pb-[1.6vmin] pt-[2.4vmin] text-white">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[clamp(18px,3.4vmin,40px)] font-semibold leading-tight">{c.className}</p>
          <p className="mt-[0.4vmin] text-[clamp(13px,2vmin,22px)] text-white/80">手机扫码签到</p>
        </div>
        <p className="rounded-full bg-white/15 px-[2.2vmin] py-[0.7vmin] font-mono text-[clamp(22px,4.4vmin,52px)] font-bold leading-none tabular-nums">{open ? mmss(left) : '已结束'}</p>
        {open && (
          <button type="button" onClick={onFloat} className={cn(pill, 'inline-flex items-center gap-[0.8vmin] bg-white/15 text-white hover:bg-white/25')}>
            <PictureInPicture2 className="size-[1.2em]" />
            分屏
          </button>
        )}
        {open && (
          <button
            type="button"
            onClick={() => (ending ? (setEnding(false), onEnd()) : setEnding(true))}
            className={cn(pill, ending ? 'bg-white text-[#b91c1c]' : 'text-white/85 hover:bg-white/15 hover:text-white')}
          >
            {ending ? '再点一下结束' : '结束签到'}
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="退出全屏" title="退出全屏（Esc）" className="rounded-full bg-white/15 p-[1vmin] text-white transition-colors hover:bg-white/25">
          <X className="size-[clamp(18px,3vmin,32px)]" />
        </button>
      </div>

      <div className="min-h-0 flex-1 px-[3vmin] pb-[3vmin] pt-[1vmin]">
          <div ref={box} className={cn('flex h-full min-h-0', wide ? 'flex-row' : 'flex-col')}>
            <div className="flex min-h-0 min-w-0 flex-col rounded-[2.4vmin] bg-white p-[2.4vmin] shadow-[0_24px_60px_-24px_rgba(15,23,42,.45)]" style={{ flexBasis: `${ratio * 100}%` }}>
              <div className="min-h-0 flex-1 [container-type:size]">{qrBlock}</div>
              <p className="mt-[1.2vmin] shrink-0 truncate text-center text-[clamp(12px,1.8vmin,20px)] text-[#64748b]">{link.replace(/^https?:\/\//, '')}</p>
            </div>
            {/* 中间那根条：拖着改两边多宽；也能用方向键 */}
            <div
              role="separator"
              aria-orientation={wide ? 'vertical' : 'horizontal'}
              aria-label="拖动调整两边大小"
              tabIndex={0}
              onPointerDown={drag}
              onDoubleClick={() => (setSplit(0.5), keep.set('ct-checkin-split', '0.5'))}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -0.03 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 0.03 : 0;
                if (!step) return;
                e.preventDefault();
                setSplit(latest.current + step);
                keep.set('ct-checkin-split', String(latest.current));
              }}
              className={cn(
                'group flex shrink-0 touch-none items-center justify-center outline-none',
                wide ? 'w-[2.6vmin] min-w-4 cursor-col-resize' : 'h-[2.6vmin] min-h-4 cursor-row-resize',
              )}
            >
              <span className={cn('rounded-full bg-white/45 transition-colors group-hover:bg-white group-focus-visible:bg-white', wide ? 'h-[9vmin] w-[0.7vmin] min-w-1' : 'h-[0.7vmin] min-h-1 w-[9vmin]')} />
            </div>
            <div className="min-h-0 min-w-0 flex-1 rounded-[2.4vmin] bg-white p-[2.8vmin] shadow-[0_24px_60px_-24px_rgba(15,23,42,.45)]">{roster}</div>
          </div>
      </div>
    </div>,
    document.body,
  );
}

/* ---------------- 选人 ---------------- */

/** 选人卡：大字写点到谁；老师能「再点一个」（换成新点到的那个，群里也再出一张） */
export function PickCard({ id, className, bare }: { id: number; className?: string; bare?: boolean }) {
  const [current, setCurrent] = useState(id);
  const q = usePick(current);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const p = q.data;
  if (q.isError) return <p className="text-[13px] text-ink-3">不在了</p>;
  if (!p) return <Loading />;
  const again = async () => {
    setBusy(true);
    try {
      const r = await post<{ id: number }>('/messages/picks', { classId: p.classId });
      // 群里会再出一张新卡，这一张不变；助教对话里的这一张换成新点到的
      if (!bare) setCurrent(r.id);
      qc.invalidateQueries({ queryKey: ['chat'] });
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell className={className} icon={<Dices />} tone="bg-brand" title={bare ? '选人' : `选人 · ${p.className}`} aside={<span className="shrink-0 text-[13px] text-ink-3">{chatTime(p.at, true)}</span>}>
      <div className="flex flex-col items-center py-1.5">
        <motion.p key={p.id} initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 18 }} className="text-[34px] font-bold leading-tight tracking-wide text-ink">
          {p.name}
        </motion.p>
        <p className="mt-1 text-[13px] text-ink-3">
          第 {p.round} 轮 · {p.left ? `还有 ${p.left} 人没点过` : '这一轮都点过了'}
        </p>
        {teacherOf() && (
          <Button size="sm" variant="soft" className="mt-3" icon={<Dices className="size-4" />} loading={busy} onClick={again}>
            再点一个
          </Button>
        )}
      </div>
    </Shell>
  );
}

/** 按种类摆卡片 */
export function LiveCard({ type, id, classId, className }: { type: 'notice' | 'checkin' | 'pick'; id: number; classId?: number | null; className?: string }) {
  if (type === 'notice') return <NoticeCard id={id} classId={classId} className={className} />;
  if (type === 'checkin') return <CheckinCard id={id} className={className} />;
  return <PickCard id={id} className={className} />;
}
