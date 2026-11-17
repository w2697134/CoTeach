import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, Copy, Loader2, MessageCircle, MoreHorizontal, PenLine, RefreshCw, Trash2, Undo2 } from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { api, get, post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { AgentAvatar, Avatar, Button, Card, Drawer, Empty, ErrorState, IconButton, Input, MenuItem, Popover, Skeleton, Tabs, Textarea, cn, useConfirm } from '../../components/ui';
import { BUDDY, TA } from '../kb/data';
import { FileList, FilePicker, openFile } from './HwFiles';
import { dueWords } from './HomeworkList';
import { isImage, fileUrl, num, useHomework, when, type GradeItem, type HomeworkDetail, type HwFile, type StudentWork, type Submission } from './homework';
import { AiBar, AiCell, GradedBy, ItemBars, ItemEditor, MarkList, MarkedText, RubricCard, SameDialog, sumItems, type SameAsk } from './Grading';
import { THEME_TEXT, inkVars, themeOf } from './look';
import { CHIP, INK, scoreInk } from './tone';

/** 一份作业的抬头：标题、满分、截止、截止后收不收、什么时候发，下面要求（一行四十几个字）和附件 */
function Brief({ h, menu, mark, note }: { h: HomeworkDetail; menu?: React.ReactNode; mark?: React.ReactNode; note?: React.ReactNode }) {
  const theme = themeOf(h.classId);
  const due = h.dueAt ? `${when(h.dueAt)} 截止` : '不设截止';
  const left = h.dueAt && h.dueAt > Date.now() ? dueWords(h.dueAt) : null;
  // 快到期时右边的紫色小签就是截止时间，前面不再写一遍
  const facts = [`满分 ${num(h.points)}`, left !== due && due, h.dueAt && (h.allowLate ? '截止后还能交' : '截止后不收')].filter(Boolean);
  return (
    <Card className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className={cn('text-balance break-words text-[24px] font-semibold leading-tight tracking-tight', THEME_TEXT)} style={inkVars(theme)}>
            {h.title}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-ink-2">
            {facts.join(' · ')}
            {left && left !== '已截止' && <span className={cn('rounded-full px-2 py-0.5 text-[13px]', CHIP.brand)}>{left}</span>}
            {h.publishAt > Date.now() && <span className={cn('rounded-full px-2 py-0.5 text-[13px]', CHIP.gray)}>{when(h.publishAt)} 发给学生</span>}
          </p>
          {note && <div className="mt-2.5">{note}</div>}
        </div>
        {mark}
        {menu}
      </div>
      {(h.body.trim() || h.files.length > 0) && (
        <div className="space-y-4 border-t border-line pt-4">
          {h.body.trim() && <p className="max-w-[44em] whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink">{h.body}</p>}
          <FileList files={h.files} />
        </div>
      )}
    </Card>
  );
}

/** 交上来的东西：文字、附件（图片直接显示）；filesOnly 只列附件（文字在批改稿里） */
function Work({ s, filesOnly }: { s: Submission; filesOnly?: boolean }) {
  const pics = s.files.filter((f) => isImage(f.name)),
    rest = s.files.filter((f) => !isImage(f.name));
  if (filesOnly && !s.files.length) return null;
  return (
    <div className="space-y-3">
      {!filesOnly && s.text.trim() && (
        <p className="whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2/60 px-4 py-3.5 text-[15px] leading-relaxed text-ink">{s.text}</p>
      )}
      {pics.length > 0 && (
        <div className="flex flex-wrap gap-2.5">
          {pics.map((f) => (
            <button key={f.id} type="button" onClick={() => openFile(f)} title={f.name} className="overflow-hidden rounded-lg border border-line">
              <img src={fileUrl(f, true)} alt={f.name} className="h-32 w-auto max-w-[240px] object-cover" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      <FileList files={rest} />
    </div>
  );
}

/* ---------------- 老师 ---------------- */

type Filter = 'all' | 'in' | 'out' | 'wait';

/** 批改稿和批注：点划线的地方和下面的批注互相对上 */
function Marked({ text, marks }: { text: string; marks: NonNullable<Submission['marks']> }) {
  const [active, setActive] = useState<number | null>(null);
  return (
    <div className="space-y-3">
      <MarkedText text={text} marks={marks} active={active} onPick={setActive} />
      <MarkList marks={marks} active={active} onPick={setActive} />
    </div>
  );
}

/**
 * 老师批改：右边抽屉，左边是学生交的（批改稿上划着批注），右边是每项分数和评语，助教都拟好了，老师改了哪项就保存；
 * 改了某一项，同一项助教给了一样分的其他学生会列出来，问要不要一起改。上一个、下一个。
 */
function Grader({
  h,
  sid,
  order,
  onPick,
  onClose,
  onSame,
}: {
  h: HomeworkDetail;
  sid: number | null;
  order: number[];
  onPick: (id: number) => void;
  onClose: () => void;
  onSame: (ask: SameAsk) => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['homework', h.id, 'student', sid],
    queryFn: () => get<StudentWork>(`/homework/${h.id}/students/${sid}`),
    enabled: !!sid,
    refetchInterval: (x) => (x.state.data?.ai && (x.state.data.ai.status === 'queued' || x.state.data.ai.status === 'running') ? 2500 : false),
  });
  const similar = useQuery({
    queryKey: ['homework', h.id, 'similar', sid],
    queryFn: () => get<{ similar: { sid: number | null; name: string; ratio: number }[] }>(`/homework/${h.id}/students/${sid}/similar`),
    enabled: !!sid && !!q.data?.submission,
    staleTime: 60_000,
  });
  const w = q.data;
  const s = w?.submission;
  const ai = w?.ai;
  const graded = !!s && s.score !== null && w?.status === 'graded';
  const aiDone = ai?.status === 'done';
  const [score, setScore] = useState(''),
    [items, setItems] = useState<GradeItem[] | null>(null),
    [comment, setComment] = useState(''),
    [busy, setBusy] = useState<'grade' | 'return' | 'redo' | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    const base = graded ? (s!.items?.length ? s!.items : null) : aiDone ? ai!.items : null;
    setItems(base?.length ? base.map((x) => ({ ...x })) : null);
    setScore(graded ? num(s!.score!) : aiDone && ai!.score !== null ? num(ai!.score) : '');
    setComment((graded ? s!.comment : aiDone ? ai!.comment : s?.comment) || '');
    setError('');
  }, [w]);
  const at = sid ? order.indexOf(sid) : -1;
  // 作业详情、列表、成绩表、这个学生的都跟着变
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['homework'] });
    qc.invalidateQueries({ queryKey: ['classes'] });
  };
  /** 改了的那一项：同一项助教给了一样分的其他学生 */
  const sameIssue = async (saved: GradeItem[]) => {
    if (!aiDone || !ai!.items.length) return;
    for (let i = 0; i < saved.length; i++) {
      const was = ai!.items[i];
      if (!was || Math.abs(was.got - saved[i].got) < 0.01) continue;
      const r = await get<{ students: SameAsk['students'] }>(`/homework/${h.id}/same?sid=${sid}&item=${i}&from=${was.got}`);
      if (r.students.length) {
        onSame({ item: i, title: saved[i].title, from: was.got, to: saved[i].got, max: saved[i].max, students: r.students });
        return;
      }
    }
  };
  const grade = async () => {
    let v: number | null = null;
    if (!items) {
      v = score.trim() === '' ? null : Number(score);
      if (v !== null && (!Number.isFinite(v) || v < 0 || v > h.points)) return setError(`分数填 0 到 ${num(h.points)}`);
    }
    setBusy('grade');
    setError('');
    try {
      const r = await post<{ score: number | null }>(`/homework/${h.id}/students/${sid}/grade`, {
        score: v,
        comment,
        ...(items ? { items, aiGradeId: ai?.id ?? s?.aiGradeId ?? null } : {}),
      });
      await done();
      toast.success(r.score === null ? '评语存好了' : `${w?.name} ${num(r.score)} 分，发给他了`);
      if (items) await sameIssue(items);
      // 批完自动跳到下一个还没批的
      const next = order.slice(at + 1).find((id) => {
        const x = h.students?.find((y) => y.id === id);
        return x && (x.status === 'submitted' || x.status === 'late');
      });
      if (next) onPick(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const giveBack = async () => {
    setBusy('return');
    setError('');
    try {
      await post(`/homework/${h.id}/students/${sid}/return`, { comment });
      await done();
      toast.success(`退回给了${w?.name}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const redo = async () => {
    setBusy('redo');
    try {
      await post(`/homework/${h.id}/ai-grade`, { sid });
      await done();
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(null);
    }
  };
  const locked = h.archived || !s;
  const working = ai && (ai.status === 'queued' || ai.status === 'running');
  const text = aiDone || graded ? ai?.workText : null;
  const total = items ? sumItems(items) : null;
  const note = (tone: string, children: React.ReactNode) => <div className={cn('flex gap-2.5 rounded-lg px-3.5 py-3 text-[15px] leading-relaxed', tone)}>{children}</div>;
  return (
    <Drawer
      open={!!sid}
      onClose={onClose}
      width={1080}
      title={w ? w.name : ' '}
      desc={
        w && (
          <>
            {w.studentNo}
            {s && ` · ${when(s.submittedAt)} 交的`}
            {s?.late && <span className={cn('ml-1.5', INK.warn)}>迟交</span>}
            {at >= 0 && <span className="ml-2 text-ink-3">第 {at + 1} / {order.length} 个</span>}
          </>
        )
      }
      actions={
        <div className="flex items-center gap-0.5">
          <IconButton size="sm" label="上一个" disabled={at <= 0} onClick={() => onPick(order[at - 1])}>
            <ChevronLeft className="size-[18px]" />
          </IconButton>
          <IconButton size="sm" label="下一个" disabled={at < 0 || at >= order.length - 1} onClick={() => onPick(order[at + 1])}>
            <ChevronRight className="size-[18px]" />
          </IconButton>
        </div>
      }
      footer={
        !locked && (
          <>
            {h.aiMode !== 'off' && !working && (
              <Button variant="ghost" className="mr-auto" icon={<RefreshCw className="size-4" />} loading={busy === 'redo'} disabled={!!busy} onClick={redo}>
                让助教重批
              </Button>
            )}
            <Button icon={<Undo2 className="size-4" />} loading={busy === 'return'} disabled={!!busy} onClick={giveBack}>
              退回重交
            </Button>
            <Button variant="primary" loading={busy === 'grade'} disabled={!!busy} onClick={grade}>
              {graded ? '保存' : '发给学生'}
            </Button>
          </>
        )
      }
    >
      <div className="px-6 pb-6 pt-1">
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !w ? (
          <Skeleton className="h-40" />
        ) : !w.joined ? (
          <Empty compact title="还没加入这门课" />
        ) : !s ? (
          <Empty compact title={w.status === 'missing' ? '过了截止还没交' : '还没交'} />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="min-w-0 space-y-4">
              {w.status === 'returned' && note(CHIP.warn, '退回了，等他改好重交')}
              {working &&
                note(
                  CHIP.brand,
                  <>
                    <Loader2 className="mt-1 size-4 shrink-0 animate-spin" />
                    助教正在批这一份，批完分数和批注会出现在这里
                  </>,
                )}
              {ai?.status === 'error' && !graded && note(CHIP.bad, `助教没批成：${ai.error || '再试一次'}`)}
              {aiDone &&
                ai!.flag &&
                note(
                  CHIP.warn,
                  <>
                    <AlertTriangle className="mt-1 size-4 shrink-0" />
                    <span>
                      <b className="font-semibold">助教留了句话：</b>
                      {ai!.flag}
                    </span>
                  </>,
                )}
              {!!similar.data?.similar.length &&
                note(
                  CHIP.info,
                  <>
                    <Copy className="mt-1 size-4 shrink-0" />
                    <span>
                      跟
                      {similar.data.similar.map((x, i) => (
                        <span key={x.name}>
                          {i > 0 && '、'}
                          <button type="button" disabled={!x.sid} onClick={() => x.sid && onPick(x.sid)} className="mx-0.5 font-semibold underline-offset-2 hover:underline">
                            {x.name}
                          </button>
                          （{x.ratio}%）
                        </span>
                      ))}
                      的作业很像
                    </span>
                  </>,
                )}
              {text ? (
                <>
                  <Work s={s} filesOnly />
                  <Marked text={text} marks={ai?.marks || []} />
                </>
              ) : (
                <Work s={s} />
              )}
            </div>
            <div className="space-y-4 lg:sticky lg:top-0 lg:self-start">
              {!h.archived ? (
                <>
                  {items ? (
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className={cn('text-[24px] font-semibold tabular-nums', scoreInk(total!, h.points))}>{num(total!)}</span>
                        <span className="text-[15px] text-ink-2">/ {num(h.points)}</span>
                        {graded ? <GradedBy by={s.gradedBy} /> : aiDone && <span className={cn('rounded-full px-2.5 py-0.5 text-[13px]', CHIP.brand)}>助教拟的，还没发</span>}
                      </div>
                      <ItemEditor items={items} base={aiDone ? ai!.items : undefined} onChange={setItems} />
                    </div>
                  ) : (
                    <label className="block text-[15px] font-medium text-ink">
                      分数
                      <span className="mt-1.5 flex items-center gap-2">
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          max={h.points}
                          step="0.5"
                          className="w-28"
                          value={score}
                          onChange={(e) => setScore(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && grade()}
                        />
                        <span className="text-[15px] font-normal text-ink-2">/ {num(h.points)}</span>
                      </span>
                    </label>
                  )}
                  <label className="block text-[15px] font-medium text-ink">
                    评语
                    <Textarea autoGrow maxRows={10} className="mt-1.5 min-h-24 text-[15px] font-normal" value={comment} maxLength={5000} onChange={(e) => setComment(e.target.value)} />
                  </label>
                  {error && (
                    <p role="alert" className={cn('text-[14px]', INK.bad)}>
                      {error}
                    </p>
                  )}
                </>
              ) : (
                s.score !== null && (
                  <div className="text-[15px] text-ink">
                    <p>
                      <span className={cn('text-[24px] font-semibold', scoreInk(s.score, h.points))}>{num(s.score)}</span> / {num(h.points)}
                    </p>
                    {s.comment && <p className="mt-2 whitespace-pre-wrap text-ink-2">{s.comment}</p>}
                  </div>
                )
              )}
            </div>
          </div>
        )}
      </div>
    </Drawer>
  );
}

type Student = NonNullable<HomeworkDetail['students']>[number];
const handedIn = (s: Student) => s.status === 'submitted' || s.status === 'late';

/** 一个学生一格：头像、名字、什么时候交的；右边分数（不到六成红的）或者现在的状态 */
function StudentCell({ s, points, onOpen }: { s: Student; points: number; onOpen: () => void }) {
  const away = !s.joined || s.status === 'missing' || s.status === 'todo';
  return (
    <li>
      <button
        type="button"
        disabled={!s.joined}
        onClick={onOpen}
        className={cn(
          'flex h-full w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-[border-color,box-shadow,background-color] sm:gap-3 sm:px-3.5 sm:py-3',
          away ? 'border-dashed border-line-strong bg-surface-2/60' : 'border-line bg-surface hover:border-line-strong hover:shadow-sm',
          s.ai?.flag && handedIn(s) && s.score === null && 'border-[#f59e0b]/60 bg-warn-soft/40',
          'disabled:cursor-default disabled:hover:shadow-none',
        )}
      >
        <Avatar name={s.name} seed={s.id} size={36} className={cn('max-sm:hidden', away && 'opacity-50')} />
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-[15px] font-medium', away ? 'text-ink-2' : 'text-ink')}>{s.name}</span>
          <span className="mt-0.5 block truncate text-[13px] text-ink-3 max-sm:hidden">
            {!s.joined ? '还没加入' : s.submittedAt ? `${when(s.submittedAt)} 交的` : s.studentNo}
            {s.late && <span className={cn('ml-1', INK.warn)}>迟交</span>}
          </span>
        </span>
        {s.joined && <AiCell s={s} points={points} />}
      </button>
    </li>
  );
}

function TeacherView({ h, initial }: { h: HomeworkDetail; initial: number | null }) {
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const qc = useQueryClient(),
    confirm = useConfirm();
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<number | null>(initial);
  const [same, setSame] = useState<SameAsk | null>(null);
  const all = h.students || [];
  const joined = all.filter((s) => s.joined);
  const isIn = (s: Student) => !!s.status && s.status !== 'todo' && s.status !== 'missing';
  const waiting = (s: Student) => handedIn(s);
  const counts = { all: all.length, in: joined.filter(isIn).length, out: all.filter((s) => !isIn(s)).length, wait: joined.filter(waiting).length };
  const shown = all.filter((s) => (filter === 'in' ? isIn(s) : filter === 'out' ? !isIn(s) : filter === 'wait' ? waiting(s) : true));
  const order = useMemo(() => shown.filter((s) => s.joined).map((s) => s.id), [shown]);
  // 助教拿不准、留给老师的：带着它的原话摆在最上面
  const held = joined.filter((s) => handedIn(s) && s.score === null && s.ai?.status === 'done' && !!s.ai.flag);
  const pick = (id: number | null) => {
    setOpen(id);
    // 网址上的 ?s= 只管第一次打开哪一个，关了就去掉
    if (id === null) setParams({}, { replace: true });
  };
  const remove = async () => {
    if (!(await confirm({ title: `删除「${h.title}」？`, desc: '学生交的也一起看不到了。', okText: '删除', danger: true }))) return;
    try {
      await api(`/homework/${h.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['homework'] });
      qc.invalidateQueries({ queryKey: ['classes'] });
      toast.success('已删除');
      navigate(`/classes/${h.classId}`, { replace: true });
    } catch (e) {
      toast.fromError(e);
    }
  };
  const menu = !h.archived && (
    <Popover
      width={140}
      trigger={({ toggle }) => (
        <IconButton label="更多" onClick={toggle} className="text-ink-3">
          <MoreHorizontal className="size-[18px]" />
        </IconButton>
      )}
    >
      {(close) => (
        <div onClick={close}>
          <MenuItem icon={<PenLine />} onClick={() => navigate(`/classes/${h.classId}/homework/${h.id}/edit`)}>
            编辑
          </MenuItem>
          <MenuItem icon={<Trash2 />} danger onClick={remove}>
            删除
          </MenuItem>
        </div>
      )}
    </Popover>
  );
  return (
    <>
      <Brief
        h={h}
        menu={menu}
        note={
          h.specialist ? (
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-brand-soft py-1 pl-1 pr-3 text-[14px] text-brand-ink" title="助教分出来的专门助手">
              <img src={h.specialist.avatar} alt="" className="size-6 shrink-0 rounded-full" />
              <span className="truncate">由「{h.specialist.name}」批</span>
            </span>
          ) : undefined
        }
      />
      <RubricCard h={h} />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4 sm:px-6">
          <h2 className="text-[18px] font-semibold text-ink">学生交的</h2>
          <Tabs
            variant="pill"
            value={filter}
            onChange={setFilter}
            className="ml-auto"
            items={[
              { value: 'all', label: '全部', count: counts.all },
              { value: 'in', label: '已交', count: counts.in },
              { value: 'out', label: '没交', count: counts.out },
              { value: 'wait', label: '待批', count: counts.wait },
            ]}
          />
        </div>
        <AiBar h={h} onReview={() => navigate(`/classes/${h.classId}/homework/${h.id}/review`)} />
        {held.length > 0 && filter !== 'out' && (
          <div className="space-y-2.5 border-b border-line px-5 py-4 sm:px-6">
            <p className={cn('text-[15px] font-semibold', INK.warn)}>
              {held.length === 1 ? '这一份' : `这 ${held.length} 份`}助教拿不准，等你看一眼
            </p>
            <ul className="grid gap-2.5 lg:grid-cols-2">
              {held.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => pick(s.id)}
                    className="flex h-full w-full items-start gap-3 rounded-lg border border-[#f59e0b]/50 bg-warn-soft/50 px-4 py-3 text-left transition-colors hover:border-[#f59e0b]"
                  >
                    <Avatar name={s.name} seed={s.id} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[15px] font-semibold text-ink">{s.name}</span>
                        {s.ai?.score !== null && s.ai?.score !== undefined && <span className="text-[14px] text-ink-2">助教拟 {num(s.ai.score)} 分</span>}
                      </span>
                      <span className="mt-1 line-clamp-3 block max-w-[44em] text-[14px] leading-relaxed text-ink">{s.ai?.flag}</span>
                    </span>
                    <ChevronRight className="mt-2 size-4 shrink-0 text-ink-3" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!all.length ? (
          <Empty compact title="这门课还没有学生" />
        ) : !shown.length ? (
          <Empty compact title={filter === 'wait' ? '没有等着批的' : filter === 'out' ? '都交了' : '没有'} />
        ) : (
          <ul className="grid grid-cols-2 gap-2 p-3 sm:gap-2.5 sm:p-5 lg:grid-cols-3 xl:grid-cols-4">
            {shown.map((s) => (
              <StudentCell key={s.id} s={s} points={h.points} onOpen={() => pick(s.id)} />
            ))}
          </ul>
        )}
      </Card>
      <Grader h={h} sid={open} order={order} onPick={pick} onClose={() => pick(null)} onSame={setSame} />
      <SameDialog hwId={h.id} ask={same} onClose={() => setSame(null)} />
    </>
  );
}

/* ---------------- 学生 ---------------- */

/** 学生看批改：总分、谁批的、每项得分、评语；有疑问去问学伴 */
function Result({ h }: { h: HomeworkDetail }) {
  const navigate = useNavigate();
  const mine = h.mine!;
  return (
    <Card className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-baseline gap-1.5">
          <span className={cn('text-[24px] font-semibold leading-none tabular-nums', scoreInk(mine.score!, h.points))}>{num(mine.score!)}</span>
          <span className="text-[15px] text-ink-2">/ {num(h.points)}</span>
        </div>
        <GradedBy by={mine.gradedBy} />
      </div>
      {mine.comment && (
        <div className="flex gap-3">
          {mine.gradedBy === 'ai' && <AgentAvatar agent={TA} size={32} />}
          <p className="min-w-0 whitespace-pre-wrap rounded-2xl rounded-tl-md bg-surface-2 px-4 py-3 text-[15px] leading-relaxed text-ink">{mine.comment}</p>
        </div>
      )}
      {!!mine.items?.length && <ItemBars items={mine.items} />}
      <Button
        variant="soft"
        block
        icon={<MessageCircle className="size-4" />}
        onClick={() => navigate(`/cot?ask=${encodeURIComponent(`我的作业「${h.title}」哪里没做好？`)}`)}
      >
        有不明白的，问 {BUDDY.name}
      </Button>
    </Card>
  );
}

/** 老师发了的讲评（不带名字）：大家错得多的几类问题 */
function ReviewForStudents({ h }: { h: HomeworkDetail }) {
  const r = h.studentReview;
  if (!r) return null;
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[18px] font-semibold text-ink">老师的讲评</h2>
        {r.avg !== null && r.points !== null && (
          <span className="text-[14px] text-ink-2">
            全班平均 {num(r.avg)} / {num(r.points)}
          </span>
        )}
      </div>
      {r.summary && <p className="max-w-[44em] text-[15px] leading-relaxed text-ink">{r.summary}</p>}
      <ol className="grid gap-3 lg:grid-cols-2">
        {r.errors.map((e, i) => (
          <li key={i} className="rounded-lg bg-surface-2 px-4 py-3">
            <p className="text-[15px] font-medium text-ink">
              {i + 1}. {e.title}
              <span className="ml-2 text-[14px] font-normal text-ink-2">{e.n} 人</span>
            </p>
            {e.why && <p className="mt-1 text-[14px] leading-relaxed text-ink-2">{e.why}</p>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

function StudentView({ h }: { h: HomeworkDetail }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const mine = h.mine;
  const [editing, setEditing] = useState(!mine);
  const [text, setText] = useState(mine?.text || ''),
    [files, setFiles] = useState<HwFile[]>(mine?.files || []),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    setEditing(!h.mine || h.status === 'returned');
    setText(h.mine?.text || '');
    setFiles(h.mine?.files || []);
  }, [h.mine, h.status]);
  const submit = async () => {
    if (!text.trim() && !files.length) return setError('写点内容或者加个附件再交');
    setBusy(true);
    setError('');
    try {
      await post(`/homework/${h.id}/submit`, { text, fileIds: files.map((f) => f.id) });
      await qc.invalidateQueries({ queryKey: ['homework'] });
      qc.invalidateQueries({ queryKey: ['classes'] });
      toast.success(mine ? '重新交好了' : '交好了');
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const graded = mine && mine.score !== null && h.status === 'graded';
  const mineCard = (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-[18px] font-semibold text-ink">我交的</h2>
        {mine && !editing && (
          <span className="text-[14px] text-ink-2">
            {when(mine.submittedAt)} 交的
            {mine.late && <span className={cn('ml-1', INK.warn)}>（迟交）</span>}
          </span>
        )}
        {mine && !editing && !h.lock && (
          <Button size="sm" className="ml-auto" icon={<PenLine className="size-4" />} onClick={() => setEditing(true)}>
            修改
          </Button>
        )}
        {!mine && !h.lock && (
          <Button
            size="sm"
            variant="soft"
            className="ml-auto"
            icon={<MessageCircle className="size-4" />}
            onClick={() => navigate(`/cot?ask=${encodeURIComponent(`「${h.title}」从哪儿下手？先别告诉我答案`)}`)}
          >
            卡住了，问 {BUDDY.name}
          </Button>
        )}
      </div>
      {h.status === 'returned' && (
        <div className={cn('rounded-lg px-4 py-3 text-[15px]', CHIP.warn)}>
          老师退回了，改好再交一次
          {mine?.comment && <p className="mt-1.5 whitespace-pre-wrap leading-relaxed text-ink">{mine.comment}</p>}
        </div>
      )}
      {editing && !h.lock ? (
        <div className="space-y-4">
          <Textarea autoGrow maxRows={20} className="min-h-40 text-[15px]" value={text} maxLength={20000} onChange={(e) => setText(e.target.value)} />
          <FilePicker files={files} onChange={setFiles} disabled={busy} />
          {error && (
            <p role="alert" className={cn('text-[14px]', INK.bad)}>
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            {mine && h.status !== 'returned' && (
              <Button disabled={busy} onClick={() => (setEditing(false), setText(mine.text), setFiles(mine.files))}>
                取消
              </Button>
            )}
            <Button variant="primary" loading={busy} onClick={submit}>
              {mine ? '重新交' : '交作业'}
            </Button>
          </div>
        </div>
      ) : mine ? (
        graded && mine.workText ? (
          <>
            <Work s={mine} filesOnly />
            <Marked text={mine.workText} marks={mine.marks || []} />
          </>
        ) : (
          <Work s={mine} />
        )
      ) : (
        <p className="text-[15px] text-ink-2">{h.lock}</p>
      )}
    </Card>
  );
  return (
    <>
      <Brief h={h} />
      {mine?.grading && !editing && (
        <Card className="flex items-center gap-3 bg-brand-soft/40">
          <AgentAvatar agent={TA} size={40} status="running" />
          <p className="flex min-w-0 items-center gap-1.5 text-[15px] font-medium text-ink">
            CoT 助教在批你这份，半分钟左右
            <Loader2 className="size-4 animate-spin text-brand" />
          </p>
        </Card>
      )}
      {graded ? (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="min-w-0 space-y-5">
            {mineCard}
            <ReviewForStudents h={h} />
          </div>
          <div className="lg:sticky lg:top-20">
            <Result h={h} />
          </div>
        </div>
      ) : (
        <>
          {mineCard}
          <ReviewForStudents h={h} />
        </>
      )}
    </>
  );
}

/** 一份作业：老师看谁交了、批改；学生看要求、交作业、看分数。网址带 ?s=学生 的直接打开那个人的 */
export function HomeworkPage() {
  const params = useParams();
  const [search] = useSearchParams();
  const classId = Number(params.id),
    id = Number(params.hid);
  const student = useAuth((s) => s.user?.role) === 'student';
  const q = useHomework(id);
  useCrumbs([{ label: '课程', to: '/classes' }, { label: q.data?.className, to: `/classes/${classId}` }, { label: q.data?.title }]);
  const initial = Number(search.get('s')) || null;
  return (
    <div className="space-y-5">
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="h-60 rounded-xl" />
      ) : student ? (
        <StudentView h={q.data} />
      ) : (
        <TeacherView h={q.data} initial={initial} />
      )}
    </div>
  );
}
