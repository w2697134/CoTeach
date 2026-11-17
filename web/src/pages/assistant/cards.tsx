/**
 * CoT 助教在对话里的卡片（照飞书机器人消息卡片的样子，素净，不加装饰）：
 * 办成了的事（结果、去页面看、撤回），问老师的问题（选项点一下就答），
 * 后台整理助手的活在 KeeperPanel 里（要用那边的工作记录和改动卡片）。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, QrCode, Undo2, Users } from 'lucide-react';
import { Markdown } from '../../components/Markdown';
import { post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Avatar, Badge, Button, IconButton, Input, Modal, cn } from '../../components/ui';
import { joinLink } from '../classes/data';
import { Qr, copyText, downloadQr } from '../classes/Invite';

export interface ActionData {
  actionId: number;
  kind: string;
  undoable: boolean;
  title: string;
  lines?: string[];
  links?: { label: string; to?: string; href?: string }[];
  code?: string;
  classId?: number;
  className?: string;
  secret?: string;
}

/** 办成了的一件事：标题、几行说明，加课码或新密码摆大字，下面「看作业」「下载 Excel」这类按钮和「撤回」 */
export function ActionCard({ data, status }: { data: ActionData; status?: 'done' | 'undone' }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState(false);
  const undone = status === 'undone';
  const undo = async () => {
    setBusy(true);
    try {
      await post(`/keeper/actions/${data.actionId}/undo`, {});
      await qc.invalidateQueries({ queryKey: ['keeper-runs'] });
      qc.invalidateQueries({ queryKey: ['classes'] });
      qc.invalidateQueries({ queryKey: ['class'] });
      qc.invalidateQueries({ queryKey: ['homework'] });
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  const download = (href: string) => {
    const a = document.createElement('a');
    a.href = href;
    a.click();
  };
  const links = undone ? [] : data.links || [];
  const name = data.className || data.title.match(/「(.+?)」/)?.[1] || '';
  return (
    <div className="rounded-xl border border-line bg-surface px-3.5 py-3 shadow-xs">
      <div className="flex items-start gap-2.5">
        <span
          className={cn('mt-px flex size-6 shrink-0 items-center justify-center rounded-full', undone ? 'bg-surface-3 text-ink-3' : 'bg-ok-soft text-ok')}
        >
          {undone ? <Undo2 className="size-3.5" /> : <Check className="size-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn('break-words text-[14px] font-medium leading-snug', undone ? 'text-ink-3 line-through' : 'text-ink')}>{data.title}</p>
          {!undone && (data.lines || []).filter(Boolean).map((l, i) => <CardLine key={i} text={l} />)}
        </div>
        {undone && <Badge tone="gray">已撤回</Badge>}
      </div>
      {!undone && data.code && (
        <div className="ml-[34px] mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-surface-2 px-3 py-2">
          <span className="text-[13px] text-ink-3">加课码</span>
          <span className="font-mono text-[20px] font-semibold tracking-[0.14em] text-ink">{data.code}</span>
          <IconButton size="sm" label="复制加课码" onClick={() => copyText(data.code!, '加课码')}>
            <Copy className="size-4" />
          </IconButton>
          <Button size="xs" variant="ghost" icon={<QrCode className="size-3.5" />} onClick={() => setQr(true)} className="ml-auto">
            二维码
          </Button>
        </div>
      )}
      {data.secret && (
        <div className="ml-[34px] mt-2.5 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
          <span className="text-[13px] text-ink-3">新密码</span>
          <span className="font-mono text-[20px] font-semibold tracking-[0.14em] text-ink">{data.secret}</span>
          <IconButton size="sm" label="复制密码" onClick={() => copyText(data.secret!, '密码')}>
            <Copy className="size-4" />
          </IconButton>
        </div>
      )}
      {(links.length > 0 || (data.undoable && !undone)) && (
        <div className="ml-[34px] mt-2.5 flex flex-wrap items-center gap-1.5">
          {links.map((l) =>
            l.href ? (
              <Button key={l.label} size="xs" variant="secondary" icon={<Download className="size-3.5" />} onClick={() => download(l.href!)}>
                {l.label}
              </Button>
            ) : (
              <Button key={l.label} size="xs" variant="secondary" onClick={() => l.to && navigate(l.to)}>
                {l.label}
              </Button>
            ),
          )}
          {data.undoable && !undone && (
            <Button size="xs" variant="ghost" loading={busy} onClick={undo} className="text-ink-3">
              撤回
            </Button>
          )}
        </div>
      )}
      {data.code && (
        <Modal open={qr} onClose={() => setQr(false)} title={name ? `加入「${name}」` : '加入班级'} width={400}>
          <div className="flex flex-col items-center gap-4 pb-2 pt-1">
            <Qr text={joinLink(data.code)} size={208} className="ring-1 ring-line" />
            <p className="font-mono text-[28px] font-semibold tracking-[0.14em] text-ink">{data.code}</p>
            <div className="flex gap-2">
              <Button size="sm" icon={<Copy className="size-4" />} onClick={() => copyText(joinLink(data.code!), '链接')}>
                复制链接
              </Button>
              <Button size="sm" icon={<Download className="size-4" />} onClick={() => downloadQr(data.code!, name || '班级')}>
                下载二维码
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** 卡片上的一行：短的照写；长的（资料包里写的一整段说明）收成两行，去掉 Markdown 记号，点「展开」再看全文 */
function CardLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 90 || text.includes('\n');
  if (!long) return <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-3">{text}</p>;
  if (open)
    return (
      <div className="mt-1 rounded-lg bg-surface-2 px-3 py-2 text-[13.5px] leading-relaxed text-ink-2">
        <Markdown compact>{text}</Markdown>
        <button type="button" className="mt-1 text-[12.5px] text-brand-ink hover:underline" onClick={() => setOpen(false)}>
          收起
        </button>
      </div>
    );
  const plain = text
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s*\n\s*/g, ' ');
  return (
    <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3">
      <span className="line-clamp-2 break-words">{plain}</span>
      <button type="button" className="text-[12.5px] text-brand-ink hover:underline" onClick={() => setOpen(true)}>
        展开
      </button>
    </p>
  );
}

/** 卡片上问老师的话：长的先摆三行，点「展开」看全；学生来问的字大一号 */
function Question({ text, big }: { text: string; big: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 80;
  return (
    <div className={cn('break-words text-ink', big ? 'text-[15px] leading-relaxed' : 'text-[14px] font-medium leading-snug')}>
      <p className={cn('whitespace-pre-wrap', long && !open && 'line-clamp-3')}>{text}</p>
      {long && (
        <button type="button" className="text-[12.5px] font-normal text-brand-ink hover:underline" onClick={() => setOpen(!open)}>
          {open ? '收起' : '展开'}
        </button>
      )}
    </div>
  );
}

export interface AskData {
  toolCallId: string;
  questions: { question: string; options: string[]; multiple?: boolean }[];
  answered?: { q: string; a: string }[] | null;
  skipped?: boolean;
  /** 学生通过学伴来问、助教要老师拍板的（2026-11-16）：谁、哪个班；classId、sid（班里名单那一行）用来点开他跟学伴的对话 */
  from?: { student: string; className: string; draft?: string; classId?: number; sid?: number; asked?: string };
  /** 助教自己提议分一个专门助手（2026-11-17）：提议的名字、管什么 */
  suggest?: { id: number; name: string; duty: string };
}

/**
 * 助教问老师：一个问题配几个选项，点一下就答（只有一个问题、单选的，点了直接发出去）；几个问题的点「好了」。
 * 没有选项的问题给一个小输入框。都不对就在下面输入框里直接说，说了就算答过了。答完收成一行。
 */
export function AskCard({ runId, data, live }: { runId: number; data: AskData; live: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const qs = data.questions || [];
  const [picks, setPicks] = useState<string[][]>(() => qs.map(() => []));
  const [texts, setTexts] = useState<string[]>(() => qs.map(() => ''));
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const from = data.from;
  const suggest = data.suggest;
  // 答过的收成一行，只写答了什么（问的什么鼠标停上去看）
  if (data.answered?.length) {
    const said = data.answered.filter((x) => x.a && x.a !== '（没选）');
    if (!said.length) return null;
    return (
      <div className="space-y-0.5 text-[13px] leading-relaxed text-ink-3">
        {said.map((x, i) => (
          <p key={i} className="flex items-start gap-1.5" title={x.q}>
            <Check className="mt-[3px] size-3.5 shrink-0 text-ok" />
            <span className="line-clamp-2 min-w-0">
              {from ? `已回${from.student}：` : '你答：'}
              <span className="text-ink-2">{x.a}</span>
            </span>
          </p>
        ))}
      </div>
    );
  }
  // 没答就过去了的（老师接着说了别的）：不再摆
  if (!live) return null;
  const send = async (p: string[][], t: string[]) => {
    setBusy(true);
    try {
      await post(`/keeper/runs/${runId}/answer`, { answers: qs.map((_, i) => ({ picks: p[i], text: t[i] })) });
      await qc.invalidateQueries({ queryKey: ['keeper-runs'] });
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  const quick = qs.length === 1 && !qs[0].multiple && qs[0].options.length > 0;
  const choose = (i: number, o: string, multiple?: boolean) => {
    const next = picks.map((p, j) => (j !== i ? p : multiple ? (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]) : [o]));
    setPicks(next);
    if (quick) void send(next, texts);
  };
  const ready = qs.every((q, i) => picks[i].length > 0 || texts[i].trim());
  return (
    <div className={cn('rounded-xl border border-brand/40 bg-surface shadow-xs ring-2 ring-brand/10', from ? 'px-4 py-3.5' : 'px-3.5 py-3')}>
      {/* 学生来问的：最上面是谁、哪个班，能点开他跟学伴的对话；下面一句问的事，选项点一下就答，也能自己回一句。
          助教拟的回复不摆：老师定了以后助教照老师的意思写给学生 */}
      {from && (
        <div className="mb-2 flex items-center gap-2.5">
          <Avatar name={from.student} seed={from.sid ?? from.student} size={30} />
          <p className="min-w-0 flex-1 truncate leading-tight">
            <span className="text-[14.5px] font-medium text-ink">{from.student}</span>
            <span className="ml-2 text-[13px] text-ink-3">{from.className}</span>
          </p>
          {!!from.classId && !!from.sid && (
            <Button size="xs" variant="ghost" className="shrink-0 text-ink-3" onClick={() => navigate(`/classes/${from.classId}/students/${from.sid}/cot`)}>
              看对话
            </Button>
          )}
        </div>
      )}
      {/* 学生自己的原话：下面的问题只写要老师定什么 */}
      {from?.asked && <p className="mb-2 line-clamp-3 border-l-2 border-line-strong pl-2.5 text-[13.5px] leading-relaxed text-ink-3">{from.asked}</p>}
      {/* 助教自己提议分专门助手的：上面一行说是助教的提议，问题下面一行小字写提议的名字和管什么 */}
      {suggest && (
        <p className="mb-1.5 flex items-center gap-1.5 text-[12.5px] text-ink-3">
          <Users className="size-3.5 shrink-0" />
          助教的提议
        </p>
      )}
      {qs.map((q, i) => (
        <div key={i} className={i ? 'mt-3.5' : ''}>
          <Question text={q.question} big={!!from} />
          {suggest && i === 0 && (
            <p className="mt-1 break-words text-[13px] leading-relaxed text-ink-3">
              <span className="text-ink-2">{suggest.name}</span> · {suggest.duty}
            </p>
          )}
          {q.options.length ? (
            // 选项短的一排小圆角；有长的（一整句话）就一行一个排成单子，不挤成好几排
            q.options.some((o) => o.length > 12) ? (
              <div className="mt-2.5 overflow-hidden rounded-lg border border-line">
                {q.options.map((o, k) => {
                  const on = picks[i].includes(o);
                  return (
                    <button
                      key={o}
                      type="button"
                      disabled={busy}
                      onClick={() => choose(i, o, q.multiple)}
                      className={cn(
                        'flex w-full items-start gap-2.5 px-3 py-2 text-left text-[13.5px] leading-snug transition-colors disabled:opacity-60',
                        k > 0 && 'border-t border-line',
                        on ? 'bg-brand-soft text-brand-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                      )}
                    >
                      <span className={cn('mt-[3px] size-3.5 shrink-0 rounded-full border', on ? 'border-[4px] border-brand' : 'border-line-strong')} />
                      <span className="line-clamp-2 min-w-0 flex-1">{o}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {q.options.map((o) => {
                  const on = picks[i].includes(o);
                  return (
                    <button
                      key={o}
                      type="button"
                      disabled={busy}
                      onClick={() => choose(i, o, q.multiple)}
                      className={cn(
                        'rounded-full border px-3 py-1 text-left text-[13px] leading-snug transition-colors disabled:opacity-60',
                        on ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line-strong text-ink-2 hover:border-brand/50 hover:text-ink',
                      )}
                    >
                      {o}
                    </button>
                  );
                })}
              </div>
            )
          ) : (
            <Input
              className="mt-2"
              value={texts[i]}
              maxLength={2000}
              onChange={(e) => setTexts(texts.map((t, j) => (j === i ? e.target.value : t)))}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && ready && !busy && send(picks, texts)}
            />
          )}
          {/* 自己回一句：平时收着，点「自己回复」才展开（输入框一直摆着显得乱） */}
          {from && q.options.length > 0 && i === 0 &&
            (typing ? (
              <div className="mt-2.5 flex items-center gap-1.5">
                <Input
                  autoFocus
                  className="min-w-0 flex-1"
                  value={texts[0]}
                  maxLength={2000}
                  placeholder="自己回一句"
                  onChange={(e) => setTexts(texts.map((t, j) => (j === 0 ? e.target.value : t)))}
                  onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && texts[0].trim() && !busy && send(qs.map(() => []), texts)}
                />
                <Button size="sm" variant="primary" loading={busy} disabled={!texts[0].trim()} onClick={() => send(qs.map(() => []), texts)}>
                  回复
                </Button>
              </div>
            ) : (
              <button type="button" className="mt-2 text-[13px] text-ink-3 hover:text-brand-ink" onClick={() => setTyping(true)}>
                自己回复
              </button>
            ))}
        </div>
      ))}
      {!quick && (
        <div className="mt-3 flex justify-end">
          <Button size="sm" variant="primary" loading={busy} disabled={!ready} onClick={() => send(picks, texts)}>
            好了
          </Button>
        </div>
      )}
    </div>
  );
}
