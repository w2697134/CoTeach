import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlarmClock,
  ArrowUp,
  Bell,
  CircleCheck,
  ClipboardCheck,
  Dices,
  FileText,
  Inbox,
  Megaphone,
  MessageCircleQuestion,
  MessageSquarePlus,
  Paperclip,
  Plus,
  Users,
} from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { get, post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { Avatar, Button, IconButton, Modal, Popover, Segmented, Skeleton, Textarea, cn } from '../../components/ui';
import { themeOf } from '../classes/look';
import { fileUrl, isImage, uploadFile } from '../classes/homework';
import { formatSize } from '../kb/FileCard';
import { AskCard } from '../assistant/cards';
import { CheckinCard, NoticeCard, PickCard } from './Cards';
import { chatTime, recallLine, useChat, useChatList, useInbox, type ChatItem, type ChatListData, type InboxItem, type Member, type Message } from './data';
import { NewNotice } from './NewNotice';

/**
 * 消息（2026-11-18，照微信、飞书的消息页）：左边一列会话，收件箱钉在最上面，下面是课程群和私聊；右边是打开的那一个。
 * 手机上先看列表，点进去看会话（顶栏写「← 消息」）。打开着的会话几秒刷一次，新消息自己出来。
 */
export function MessagesPage() {
  const { chat } = useParams();
  const navigate = useNavigate();
  const list = useChatList();
  const selected: 'inbox' | number | null = chat === 'inbox' ? 'inbox' : Number(chat) || null;
  const current = typeof selected === 'number' ? list.data?.chats.find((c) => c.id === selected) : undefined;
  useCrumbs(selected ? [{ label: '消息', to: '/messages' }, { label: selected === 'inbox' ? '收件箱' : current?.title || null }] : [{ label: '消息' }]);
  // 电脑上进来没选：先打开收件箱
  useEffect(() => {
    if (!selected && window.innerWidth >= 768) navigate('/messages/inbox', { replace: true });
  }, [selected, navigate]);
  return (
    // 手机上贴着屏幕边（外面的页面留的边抵掉），电脑上是一个圆角大框
    <div className="flex h-full min-h-0 overflow-hidden rounded-2xl border border-line bg-surface shadow-xs max-md:-m-3 max-md:h-[calc(100%+1.5rem)] sm:max-md:-mx-4 max-md:rounded-none max-md:border-0 max-md:shadow-none">
      <aside className={cn('flex w-full min-h-0 shrink-0 flex-col border-line md:w-[300px] md:border-r lg:w-[320px]', selected && 'max-md:hidden')}>
        <ChatList data={list.data} selected={selected} />
      </aside>
      <section className={cn('flex min-h-0 min-w-0 flex-1 flex-col bg-bg', !selected && 'max-md:hidden')}>
        {selected === 'inbox' ? <InboxPane /> : selected ? <ChatPane key={selected} id={selected} item={current} /> : null}
      </section>
    </div>
  );
}

/* ---------------- 会话列表 ---------------- */

/** 课程群的头像：这门课的颜色，写课程名的头两个字 */
function GroupAvatar({ classId, name, size = 44 }: { classId: number; name: string; size?: number }) {
  const t = themeOf(classId);
  const word = (name.match(/[一-鿿]/g) || []).slice(0, 2).join('') || name.slice(0, 2);
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[12px] font-semibold text-white"
      style={{ width: size, height: size, background: `linear-gradient(135deg, ${t.from}, ${t.to})`, fontSize: size >= 40 ? 15 : 13 }}
    >
      {word}
    </span>
  );
}
function InboxAvatar({ size = 44 }: { size?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-[12px] bg-brand text-white" style={{ width: size, height: size }}>
      <Inbox className="size-[22px]" />
    </span>
  );
}
const Dot = ({ n }: { n: number }) =>
  n > 0 ? (
    <span className="min-w-[20px] rounded-full bg-bad px-1.5 text-center text-[12px] font-semibold leading-5 text-white tabular-nums">{n > 99 ? '99+' : n}</span>
  ) : null;

function Row({ on, avatar, title, sub, at, unread, onClick }: { on: boolean; avatar: React.ReactNode; title: string; sub: string; at?: number; unread: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors', on ? 'bg-brand-soft/70' : 'hover:bg-surface-2')}
    >
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="min-w-0 flex-1 truncate text-[15px] font-medium text-ink">{title}</p>
          {at ? <span className="shrink-0 text-[12px] text-ink-3">{chatTime(at)}</span> : null}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-[13px] text-ink-3">{sub}</p>
          <Dot n={unread} />
        </div>
      </div>
    </button>
  );
}

function ChatList({ data, selected }: { data: ChatListData | undefined; selected: 'inbox' | number | null }) {
  const navigate = useNavigate();
  const role = useAuth((s) => s.user?.role);
  const teacher = role === 'teacher' || role === 'admin';
  const [notice, setNotice] = useState(false);
  const [dm, setDm] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(window.innerWidth < 1024 ? document.getElementById('top-actions') : null), []);
  const plus = (
        <Popover
          width={168}
          trigger={({ toggle }) => (
            <IconButton label="发起" onClick={toggle}>
              <Plus className="size-5" />
            </IconButton>
          )}
        >
          {(close) => (
            <div className="py-1">
              {teacher && (
                <button type="button" onClick={() => (close(), setNotice(true))} className="flex w-full items-center gap-2.5 px-3 py-2 text-[14px] text-ink hover:bg-surface-3">
                  <Megaphone className="size-4 text-ink-3" />
                  发通知
                </button>
              )}
              <button type="button" onClick={() => (close(), setDm(true))} className="flex w-full items-center gap-2.5 px-3 py-2 text-[14px] text-ink hover:bg-surface-3">
                <MessageSquarePlus className="size-4 text-ink-3" />
                发起私聊
              </button>
            </div>
          )}
        </Popover>
  );
  return (
    <>
      {slot && !selected && createPortal(plus, slot)}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4 max-lg:hidden">
        <p className="min-w-0 flex-1 text-[17px] font-semibold text-ink">消息</p>
        {plus}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Row
          on={selected === 'inbox'}
          avatar={<InboxAvatar />}
          title="收件箱"
          sub={data?.inbox.last?.text || '提醒都在这里'}
          at={data?.inbox.last?.at}
          unread={data?.inbox.unread ?? 0}
          onClick={() => navigate('/messages/inbox')}
        />
        {!data ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : (
          data.chats.map((c) => (
            <Row
              key={c.id}
              on={selected === c.id}
              avatar={c.kind === 'class' ? <GroupAvatar classId={c.classId!} name={c.title} /> : <Avatar name={c.title} seed={c.title} size={44} />}
              title={c.title}
              sub={c.last ? `${c.last.mine && !c.last.recalled ? '我：' : ''}${c.last.text}` : c.kind === 'class' ? '课程群' : '私聊'}
              at={c.last?.at}
              unread={c.unread}
              onClick={() => navigate(`/messages/${c.id}`)}
            />
          ))
        )}
        {data && !data.chats.length && <p className="px-4 py-8 text-center text-[14px] text-ink-3">{teacher ? '建了课程、学生加进来，就有课程群' : '加入课程以后，这里有课程群'}</p>}
      </div>
      {teacher && <NewNotice open={notice} onClose={() => setNotice(false)} />}
      <NewDm open={dm} onClose={() => setDm(false)} groups={(data?.chats || []).filter((c) => c.kind === 'class')} />
    </>
  );
}

/** 发起私聊：先挑课程，再挑人（老师挑学生，学生挑老师） */
function NewDm({ open, onClose, groups }: { open: boolean; onClose: () => void; groups: ChatItem[] }) {
  const navigate = useNavigate();
  const me = useAuth((s) => s.user);
  const [group, setGroup] = useState(0);
  const [members, setMembers] = useState<Member[] | null>(null);
  useEffect(() => {
    if (open && !group && groups[0]) setGroup(groups[0].id);
  }, [open, group, groups]);
  useEffect(() => {
    if (!open || !group) return;
    setMembers(null);
    get<{ members: Member[] }>(`/messages/chats/${group}`).then((r) => setMembers(r.members), toast.fromError);
  }, [open, group]);
  const teacher = me?.role === 'teacher' || me?.role === 'admin';
  const people = (members || []).filter((m) => m.id !== me?.id && m.teacher !== teacher);
  const start = async (m: Member) => {
    try {
      const r = await post<{ id: number }>('/messages/dm', { userId: m.id });
      onClose();
      navigate(`/messages/${r.id}`);
    } catch (e) {
      toast.fromError(e);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="发起私聊" width={440}>
      {!groups.length ? (
        <p className="py-6 text-center text-[14px] text-ink-3">还没有课程</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => setGroup(g.id)}
                className={cn(
                  'rounded-full border px-3 py-1 text-[14px] transition-colors',
                  g.id === group ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line text-ink-2 hover:border-line-strong',
                )}
              >
                {g.title}
              </button>
            ))}
          </div>
          <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-line">
            {!members ? (
              <Skeleton className="m-3 h-10" />
            ) : !people.length ? (
              <p className="px-4 py-6 text-center text-[14px] text-ink-3">这门课里还没有人</p>
            ) : (
              people.map((m) => (
                <button key={m.id} type="button" onClick={() => start(m)} className="flex w-full items-center gap-3 border-b border-line px-3.5 py-2.5 text-left last:border-0 hover:bg-surface-2">
                  <Avatar name={m.name} seed={m.name} size={34} />
                  <span className="text-[15px] text-ink">{m.name}</span>
                  {m.teacher && <span className="rounded bg-brand-soft px-1.5 text-[12px] text-brand-ink">老师</span>}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ---------------- 收件箱 ---------------- */

const KIND_ICON: Record<string, { icon: React.ReactNode; tone: string }> = {
  ask: { icon: <MessageCircleQuestion />, tone: 'bg-[#6366f1]' },
  graded: { icon: <ClipboardCheck />, tone: 'bg-ok' },
  due: { icon: <AlarmClock />, tone: 'bg-[#f97316]' },
  notice: { icon: <Megaphone />, tone: 'bg-[#f59e0b]' },
  checkin: { icon: <CircleCheck />, tone: 'bg-ok' },
};

/**
 * 收件箱：自动来的提醒都在这里（学生来问要拍板的、作业批完、快截止了还有谁没交、通知、签到），新的在前。
 * 点一条展开，在这里就能办；办完划掉。学生来问的卡片答了就算办完。
 */
function InboxPane() {
  const q = useInbox();
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const items = q.data?.items || [];
  const unread = items.filter((x) => !x.read).length;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['inbox'] });
    qc.invalidateQueries({ queryKey: ['messages'] });
  };
  const mark = async (it: InboxItem, done = false) => {
    if (it.read && (!done || it.done)) return;
    await post(`/messages/inbox/${it.id}`, done ? { done: true } : {}).catch(toast.fromError);
    refresh();
  };
  const readAll = async () => {
    await post('/messages/inbox/read', {}).catch(toast.fromError);
    refresh();
  };
  return (
    <>
      <PaneHead title="收件箱">
        {unread > 0 && (
          <Button size="sm" variant="ghost" onClick={readAll}>
            全部已读
          </Button>
        )}
      </PaneHead>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        <div className="mx-auto max-w-[720px] space-y-2.5">
          {!q.data ? (
            [0, 1, 2].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)
          ) : !items.length ? (
            <div className="flex flex-col items-center py-20 text-center">
              <span className="flex size-14 items-center justify-center rounded-2xl bg-surface-3 text-ink-3">
                <Bell className="size-6" />
              </span>
              <p className="mt-3 text-[15px] text-ink-2">没有新的提醒</p>
            </div>
          ) : (
            items.map((it) => (
              <InboxRow
                key={it.id}
                it={it}
                open={open === it.id}
                onToggle={() => {
                  setOpen(open === it.id ? null : it.id);
                  void mark(it);
                }}
                onDone={() => mark(it, true)}
              />
            ))
          )}
        </div>
      </div>
    </>
  );
}

function InboxRow({ it, open, onToggle, onDone }: { it: InboxItem; open: boolean; onToggle: () => void; onDone: () => void }) {
  const navigate = useNavigate();
  const look = KIND_ICON[it.kind] || { icon: <Bell />, tone: 'bg-ink-3' };
  // 要老师拍板的卡片：还没答就直接摊开摆卡片（卡片上写着谁、哪门课），答了收成一行
  if (it.kind === 'ask' && it.live && it.card)
    return (
      <div onClickCapture={() => !it.read && onToggle()}>
        <AskCard runId={it.ref} data={it.card} live />
      </div>
    );
  const expanded = open;
  return (
    <div className={cn('rounded-xl border bg-surface shadow-xs transition-colors', !it.read ? 'border-brand/30' : 'border-line')}>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 px-3.5 py-3 text-left">
        <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-white [&>svg]:size-4', it.done ? 'bg-surface-3 !text-ink-3' : look.tone)}>
          {look.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className={cn('min-w-0 flex-1 truncate text-[15px]', it.done ? 'text-ink-3 line-through' : it.read ? 'text-ink' : 'font-semibold text-ink')}>{it.title}</p>
            <span className="shrink-0 text-[12px] text-ink-3">{chatTime(it.at, true)}</span>
            {!it.read && <span className="size-2 shrink-0 self-center rounded-full bg-bad" />}
          </div>
          {it.body && !expanded && <p className={cn('mt-0.5 line-clamp-2 text-[14px] leading-relaxed', it.done ? 'text-ink-3' : 'text-ink-2')}>{it.body}</p>}
        </div>
      </button>
      {expanded && (
        <div className="px-3.5 pb-3.5 pl-[58px]">
          {it.kind === 'ask' && it.card ? (
            <div className="space-y-2">
              <AskCard runId={it.ref} data={it.card} live={!!it.live} />
              {it.followup && (it.followup.reply || it.followup.status === 'running') && (
                <p className="text-[14px] leading-relaxed text-ink-2">{it.followup.status === 'running' ? 'CoT 助教在办…' : it.followup.reply}</p>
              )}
            </div>
          ) : it.kind === 'notice' ? (
            <NoticeCard id={it.ref} />
          ) : it.kind === 'checkin' ? (
            <CheckinCard id={it.ref} />
          ) : (
            <>
              {it.body && <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink-2">{it.body}</p>}
              <div className="mt-2.5 flex gap-2">
                {it.link && (
                  <Button size="sm" variant="secondary" onClick={() => (onDone(), navigate(it.link!))}>
                    去看
                  </Button>
                )}
                {!it.done && (
                  <Button size="sm" variant="ghost" onClick={onDone}>
                    划掉
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PaneHead({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-4">
      <p className="min-w-0 flex-1 truncate text-[16px] font-semibold text-ink">{title}</p>
      {children}
    </div>
  );
}

/* ---------------- 会话 ---------------- */

/** 两条消息隔了五分钟以上，中间写一下时间（照微信） */
const GAP = 5 * 60_000;

function ChatPane({ id, item }: { id: number; item: ChatItem | undefined }) {
  const q = useChat(id);
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const teacher = me?.role === 'teacher' || me?.role === 'admin';
  const d = q.data;
  const group = d?.chat.kind === 'class';
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const last = d?.messages[d.messages.length - 1]?.id;
  // 停在最新的一条：新消息来了、卡片加载出来变高了都跟着到底；往上翻着看的时候不打扰
  useEffect(() => {
    const el = scroller.current,
      box = content.current;
    if (!el || !box) return;
    el.scrollTop = el.scrollHeight;
    const follow = new ResizeObserver(() => stick.current && (el.scrollTop = el.scrollHeight));
    follow.observe(box);
    return () => follow.disconnect();
  }, [!!d?.messages.length]);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [last]);
  useEffect(() => {
    if (last) qc.invalidateQueries({ queryKey: ['messages'] });
  }, [last, qc]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  const refresh = async () => {
    stick.current = true;
    await qc.invalidateQueries({ queryKey: ['chat', id] });
    qc.invalidateQueries({ queryKey: ['messages'] });
  };
  if (q.isError) return <p className="p-8 text-center text-[14px] text-ink-3">这个会话打不开了</p>;
  const title = item?.title || '';
  const students = d?.members?.filter((m) => !m.teacher).length ?? 0;
  return (
    <>
      <PaneHead title={group ? `${title}${d?.members ? `（${d.members.length}）` : ''}` : title}>
        {group && d?.members && <MembersButton members={d.members} />}
      </PaneHead>
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        {!d ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-1/2 rounded-xl" />
            <Skeleton className="ml-auto h-10 w-1/3 rounded-xl" />
          </div>
        ) : !d.messages.length ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            {group ? <GroupAvatar classId={d.chat.classId!} name={title} size={56} /> : <Avatar name={title} seed={title} size={56} />}
            <p className="mt-3 text-[15px] text-ink-2">{group ? `${title}的课程群，${students} 个学生和老师在里面` : `跟${title}的私聊`}</p>
          </div>
        ) : (
          <div ref={content} className="mx-auto max-w-[860px] space-y-4">
            {d.messages.map((m, i) => {
              const prev = d.messages[i - 1];
              return (
                <div key={m.id}>
                  {(!prev || m.at - prev.at > GAP) && <p className="mb-3 text-center text-[12px] text-ink-3">{chatTime(m.at, true)}</p>}
                  <Bubble m={m} group={group} classId={d.chat.classId} />
                </div>
              );
            })}
          </div>
        )}
      </div>
      {d && (d.chat.archived ? <p className="border-t border-line bg-surface px-4 py-3 text-center text-[14px] text-ink-3">这门课已经归档了</p> : <Composer chatId={id} classId={group && teacher ? d.chat.classId : null} onSent={refresh} />)}
    </>
  );
}

/** 群里的人：点名字私聊（老师和学生之间） */
function MembersButton({ members }: { members: Member[] }) {
  const navigate = useNavigate();
  const me = useAuth((s) => s.user);
  const teacher = me?.role === 'teacher' || me?.role === 'admin';
  const talk = async (m: Member) => {
    try {
      const r = await post<{ id: number }>('/messages/dm', { userId: m.id });
      navigate(`/messages/${r.id}`);
    } catch (e) {
      toast.fromError(e);
    }
  };
  return (
    <Popover
      width={260}
      trigger={({ toggle }) => (
        <Button size="sm" variant="ghost" icon={<Users className="size-4" />} onClick={toggle}>
          成员
        </Button>
      )}
    >
      {(close) => (
        <div className="max-h-[60vh] overflow-y-auto py-1">
          {members.map((m) => {
            const can = m.id !== me?.id && m.teacher !== teacher;
            return (
              <div key={m.id} className="flex items-center gap-2.5 px-3 py-1.5">
                <Avatar name={m.name} seed={m.name} size={28} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{m.name}</span>
                {m.teacher && <span className="rounded bg-brand-soft px-1.5 text-[12px] text-brand-ink">老师</span>}
                {can && (
                  <button type="button" onClick={() => (close(), talk(m))} className="text-[13px] text-brand-ink hover:underline">
                    私聊
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Popover>
  );
}

/** 一条消息：别人的在左边（群里头上写名字，老师标「老师」），自己的在右边；通知、签到、选人摆成卡片 */
function Bubble({ m, group, classId }: { m: Message; group: boolean; classId: number | null }) {
  // 撤回了的通知：中间一行灰字，不带头像（照微信）
  if (m.recalled) return <p className="text-center text-[13px] text-ink-3">{recallLine(m.mine)}</p>;
  const card =
    m.kind === 'notice' ? (
      <NoticeCard id={m.ref!} classId={classId} bare={group} />
    ) : m.kind === 'checkin' ? (
      <CheckinCard id={m.ref!} bare={group} />
    ) : m.kind === 'pick' ? (
      <PickCard id={m.ref!} bare={group} />
    ) : null;
  const body =
    card ??
    (m.kind === 'file' && m.file ? (
      isImage(m.file.name) ? (
        <a href={fileUrl(m.file, true)} target="_blank" rel="noopener" className="block">
          <img src={fileUrl(m.file, true)} alt={m.file.name} className="max-h-60 max-w-[240px] rounded-xl border border-line object-contain sm:max-w-[300px]" />
        </a>
      ) : (
        <a href={fileUrl(m.file)} className="flex w-[260px] max-w-full items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 shadow-xs hover:border-line-strong">
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 break-all text-[14px] text-ink">{m.file.name}</span>
            <span className="mt-0.5 block text-[12px] text-ink-3">{formatSize(m.file.size)}</span>
          </span>
          <FileText className="size-8 shrink-0 text-brand/70" />
        </a>
      )
    ) : (
      <div
        className={cn(
          'w-fit max-w-full whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[15px] leading-relaxed',
          m.mine ? 'rounded-tr-md bg-brand text-white' : 'rounded-tl-md bg-surface text-ink shadow-xs ring-1 ring-line',
        )}
      >
        {m.text}
      </div>
    ));
  return (
    <div className={cn('flex items-start gap-2.5', m.mine && 'flex-row-reverse')}>
      <Avatar name={m.from.name} seed={m.from.name} size={36} />
      <div className={cn('flex min-w-0 max-w-[min(560px,80%)] flex-col gap-1', m.mine ? 'items-end' : 'items-start', card && 'w-[420px]')}>
        {group && !m.mine && (
          <p className="flex items-center gap-1.5 px-0.5 text-[12px] text-ink-3">
            {m.from.name}
            {m.from.teacher && <span className="rounded bg-brand-soft px-1 text-[11px] text-brand-ink">老师</span>}
          </p>
        )}
        {body}
      </div>
    </div>
  );
}

/** 输入框：Enter 发出去，Shift+Enter 换行；能发文件、图片。老师在课程群里还有发通知、签到、选人 */
function Composer({ chatId, classId, onSent }: { chatId: number; classId: number | null; onSent: () => void }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState(false);
  const [minutes, setMinutes] = useState(5);
  const fileInput = useRef<HTMLInputElement>(null);
  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await post(`/messages/chats/${chatId}`, { text: t });
      setText('');
      onSent();
    } catch (e) {
      toast.fromError(e);
    } finally {
      setSending(false);
    }
  };
  const sendFiles = async (files: FileList | null) => {
    for (const f of Array.from(files || [])) {
      try {
        const up = await uploadFile(f);
        await post(`/messages/chats/${chatId}`, { fileId: up.id });
        onSent();
      } catch (e) {
        toast.fromError(e);
      }
    }
    if (fileInput.current) fileInput.current.value = '';
  };
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onSent();
    } catch (e) {
      toast.fromError(e);
    }
  };
  const tool = 'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[14px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink';
  return (
    <div className="shrink-0 border-t border-line bg-surface px-3 pb-3 pt-2 sm:px-4">
      <div className="mb-1.5 flex flex-wrap items-center gap-0.5">
        <button type="button" className={tool} onClick={() => fileInput.current?.click()}>
          <Paperclip className="size-4" />
          文件
        </button>
        {classId && (
          <>
            <button type="button" className={tool} onClick={() => setNotice(true)}>
              <Megaphone className="size-4" />
              通知
            </button>
            <Popover
              width={260}
              trigger={({ toggle }) => (
                <button type="button" className={tool} onClick={toggle}>
                  <CircleCheck className="size-4" />
                  签到
                </button>
              )}
            >
              {(close) => (
                <div className="space-y-3 p-3">
                  <p className="text-[14px] font-medium text-ink">签到开多久</p>
                  <Segmented<number> size="sm" value={minutes} onChange={setMinutes} options={[3, 5, 10, 15].map((v) => ({ value: v, label: `${v} 分钟` }))} />
                  <Button block variant="primary" onClick={() => (close(), run(() => post('/messages/checkins', { classId, minutes })))}>
                    发起签到
                  </Button>
                </div>
              )}
            </Popover>
            <button type="button" className={tool} onClick={() => run(() => post('/messages/picks', { classId }))}>
              <Dices className="size-4" />
              选人
            </button>
          </>
        )}
      </div>
      <div className="flex items-end gap-2">
        <Textarea
          autoGrow
          rows={1}
          maxRows={6}
          value={text}
          placeholder="发消息"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (e.preventDefault(), send())}
          className="min-h-[40px] flex-1 resize-none"
        />
        <Button variant="primary" className="size-10 shrink-0 rounded-full p-0" loading={sending} disabled={!text.trim()} onClick={send} aria-label="发送">
          {!sending && <ArrowUp className="size-4" />}
        </Button>
      </div>
      <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => sendFiles(e.target.files)} />
      {classId && <NewNotice open={notice} onClose={() => setNotice(false)} classId={classId} onSent={onSent} />}
    </div>
  );
}
