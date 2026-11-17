import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { BellRing, Check, CircleCheck, Copy, Dices, Download, Maximize2, Megaphone, Paperclip, Undo2, X } from 'lucide-react';
import { post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { Badge, Button, Skeleton, cn } from '../../components/ui';
import { Qr, copyText } from '../classes/Invite';
import { themeBackground, themeOf } from '../classes/look';
import { fileUrl, isImage } from '../classes/homework';
import { chatTime, checkinLink, recallLine, useCheckin, useNotice, usePick, type CheckinData, type FileRef } from './data';

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

/** 还剩多久：照服务器的时间往下数 */
function useLeft(c: CheckinData | undefined) {
  const [, tick] = useState(0);
  const skew = useRef(0);
  useEffect(() => {
    if (c) skew.current = c.now - Date.now();
  }, [c]);
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!c) return 0;
  return Math.max(0, c.endsAt - (Date.now() + skew.current));
}
const pad = (n: number) => String(n).padStart(2, '0');
const mmss = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};

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
      {full && c.token && <CheckinScreen c={c} left={left} onClose={() => setFull(false)} />}
    </Shell>
  );
}

/** 签到全屏：投到教室大屏上，学生拿手机扫。底色用这门课的颜色，中间白卡片上是大二维码、倒计时、签了几个 */
function CheckinScreen({ c, left, onClose }: { c: CheckinData; left: number; onClose: () => void }) {
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
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="签到二维码" className="fixed inset-0 z-[95] flex items-center justify-center p-[3vmin]" style={themeBackground(theme)}>
      <button type="button" onClick={onClose} aria-label="关闭" className="absolute right-[2vmin] top-[2vmin] rounded-full bg-white/20 p-2.5 text-white transition-colors hover:bg-white/30">
        <X className="size-6" />
      </button>
      <div className="flex max-h-full max-w-full flex-col items-center gap-[3vmin] rounded-[3vmin] bg-white px-[6vmin] py-[5vmin] text-center shadow-[0_30px_80px_-20px_rgba(15,23,42,.45)] landscape:flex-row landscape:gap-[6vmin] landscape:text-left">
        <div className="size-[min(62vh,80vw)] landscape:size-[min(66vh,44vw)]">
          <Qr text={link} fill />
        </div>
        <div className="min-w-0">
          <p className="max-w-[40vw] break-words text-[clamp(22px,4.2vmin,44px)] font-semibold leading-tight text-[#0f172a] portrait:max-w-[80vw]">{c.className}</p>
          <p className="mt-[1vmin] text-[clamp(16px,2.8vmin,28px)] text-[#64748b]">扫码签到</p>
          <p className="mt-[4vmin] font-mono text-[clamp(48px,12vmin,140px)] font-bold leading-none tabular-nums" style={{ color: left > 0 ? theme.ink : '#94a3b8' }}>
            {left > 0 ? mmss(left) : '已结束'}
          </p>
          <p className="mt-[3vmin] text-[clamp(18px,3.4vmin,34px)] text-[#334155]">
            签了 <b className="tabular-nums">{c.signed}</b> / {c.total}
          </p>
          <p className="mt-[2vmin] text-[clamp(13px,2vmin,20px)] text-[#64748b]">{link.replace(/^https?:\/\//, '')}</p>
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
