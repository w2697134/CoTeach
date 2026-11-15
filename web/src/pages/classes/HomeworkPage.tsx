import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, MoreHorizontal, PenLine, Trash2, Undo2 } from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { api, get, post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { Avatar, Button, Card, Drawer, Empty, ErrorState, IconButton, Input, MenuItem, Popover, Skeleton, Tabs, Textarea, cn, useConfirm } from '../../components/ui';
import { StudentMark } from './HomeworkList';
import { FileList, FilePicker, openFile } from './HwFiles';
import { STATUS, isImage, fileUrl, num, useHomework, when, type HomeworkDetail, type HwFile, type StudentWork, type Submission } from './homework';
import { themeOf } from './look';

/** 一份作业的抬头：标题、满分、截止、截止后收不收、什么时候发，下面要求和附件 */
function Brief({ h, menu, mark }: { h: HomeworkDetail; menu?: React.ReactNode; mark?: React.ReactNode }) {
  const theme = themeOf(h.classId);
  const facts = [`满分 ${num(h.points)}`, h.dueAt ? `截止 ${when(h.dueAt)}` : '不设截止', h.dueAt && (h.allowLate ? '截止后还能交' : '截止后不收')].filter(Boolean);
  return (
    <Card className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="break-words text-[24px] font-semibold leading-tight tracking-tight" style={{ color: theme.ink }}>
            {h.title}
          </h1>
          <p className="mt-1.5 text-[14px] text-ink-3">
            {facts.join(' · ')}
            {h.publishAt > Date.now() && <span className="ml-2 rounded-full bg-surface-3 px-2 py-0.5 text-[12.5px] text-ink-2">{when(h.publishAt)} 发布</span>}
          </p>
        </div>
        {mark}
        {menu}
      </div>
      {(h.body.trim() || h.files.length > 0) && (
        <div className="space-y-4 border-t border-line pt-4">
          {h.body.trim() && <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink">{h.body}</p>}
          <FileList files={h.files} />
        </div>
      )}
    </Card>
  );
}

/** 交上来的东西：文字、附件（图片直接显示） */
function Work({ s }: { s: Submission }) {
  const pics = s.files.filter((f) => isImage(f.name)),
    rest = s.files.filter((f) => !isImage(f.name));
  return (
    <div className="space-y-3">
      {s.text.trim() && <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink">{s.text}</p>}
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
/** 老师批改：右边抽屉里看一个学生交的，打分、写评语、退回重交；上一个、下一个 */
function Grader({
  h,
  sid,
  order,
  onPick,
  onClose,
}: {
  h: HomeworkDetail;
  sid: number | null;
  order: number[];
  onPick: (id: number) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['homework', h.id, 'student', sid], queryFn: () => get<StudentWork>(`/homework/${h.id}/students/${sid}`), enabled: !!sid });
  const w = q.data;
  const [score, setScore] = useState(''),
    [comment, setComment] = useState(''),
    [busy, setBusy] = useState<'grade' | 'return' | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    setScore(w?.submission?.score !== null && w?.submission?.score !== undefined ? num(w.submission.score) : '');
    setComment(w?.submission?.comment || '');
    setError('');
  }, [w]);
  const at = sid ? order.indexOf(sid) : -1;
  // 作业详情、列表、成绩表、这个学生的都跟着变
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['homework'] });
    qc.invalidateQueries({ queryKey: ['classes'] });
  };
  const grade = async () => {
    const v = score.trim() === '' ? null : Number(score);
    if (v !== null && (!Number.isFinite(v) || v < 0 || v > h.points)) return setError(`分数填 0 到 ${num(h.points)}`);
    setBusy('grade');
    setError('');
    try {
      await post(`/homework/${h.id}/students/${sid}/grade`, { score: v, comment });
      await done();
      toast.success(v === null ? '评语存好了' : `${w?.name} ${num(v)} 分`);
      // 批完自动跳到下一个还没批的
      const next = order.slice(at + 1).find((id) => {
        const s = h.students?.find((x) => x.id === id);
        return s && (s.status === 'submitted' || s.status === 'late');
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
  const s = w?.submission;
  const locked = h.archived || !s;
  return (
    <Drawer
      open={!!sid}
      onClose={onClose}
      width={560}
      title={w ? w.name : ' '}
      desc={w && `${w.studentNo}${s ? ` · ${when(s.submittedAt)} 交的${s.late ? '（迟交）' : ''}` : ''}`}
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
            <Button icon={<Undo2 className="size-4" />} loading={busy === 'return'} disabled={!!busy} onClick={giveBack}>
              退回重交
            </Button>
            <Button variant="primary" loading={busy === 'grade'} disabled={!!busy} onClick={grade}>
              保存
            </Button>
          </>
        )
      }
    >
      <div className="space-y-6 px-6 pb-6 pt-1">
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !w ? (
          <Skeleton className="h-40" />
        ) : !w.joined ? (
          <Empty compact title="还没加入这个班" />
        ) : !s ? (
          <Empty compact title={w.status === 'missing' ? '过了截止还没交' : '还没交'} />
        ) : (
          <>
            {w.status === 'returned' && <p className="rounded-lg bg-warn-soft px-3.5 py-2.5 text-[14px] text-warn">已退回，等学生重交</p>}
            <Work s={s} />
            {!h.archived && (
              <div className="space-y-4 border-t border-line pt-5">
                <label className="block text-[14px] font-medium text-ink">
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
                    <span className="text-[14px] font-normal text-ink-3">/ {num(h.points)}</span>
                  </span>
                </label>
                <label className="block text-[14px] font-medium text-ink">
                  评语
                  <Textarea autoGrow maxRows={10} className="mt-1.5 min-h-24 font-normal" value={comment} maxLength={5000} onChange={(e) => setComment(e.target.value)} />
                </label>
                {error && (
                  <p role="alert" className="text-[14px] text-bad">
                    {error}
                  </p>
                )}
              </div>
            )}
            {h.archived && s.score !== null && (
              <p className="text-[15px] text-ink">
                得分 <span className="font-semibold">{num(s.score)}</span> / {num(h.points)}
                {s.comment && <span className="mt-2 block whitespace-pre-wrap text-ink-2">{s.comment}</span>}
              </p>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}

function TeacherView({ h }: { h: HomeworkDetail }) {
  const navigate = useNavigate();
  const qc = useQueryClient(),
    confirm = useConfirm();
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<number | null>(null);
  const all = h.students || [];
  const joined = all.filter((s) => s.joined);
  const isIn = (s: (typeof all)[number]) => !!s.status && s.status !== 'todo' && s.status !== 'missing';
  const waiting = (s: (typeof all)[number]) => s.status === 'submitted' || s.status === 'late';
  const counts = { all: all.length, in: joined.filter(isIn).length, out: all.filter((s) => !isIn(s)).length, wait: joined.filter(waiting).length };
  const shown = all.filter((s) => (filter === 'in' ? isIn(s) : filter === 'out' ? !isIn(s) : filter === 'wait' ? waiting(s) : true));
  const order = useMemo(() => shown.filter((s) => s.joined).map((s) => s.id), [shown]);
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
      <Brief h={h} menu={menu} />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4 sm:px-6">
          <h2 className="text-[17px] font-semibold text-ink">学生作业</h2>
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
        {!all.length ? (
          <Empty compact title="班里还没有学生" />
        ) : !shown.length ? (
          <Empty compact title="没有" />
        ) : (
          <ul>
            {shown.map((s) => {
              const st = s.status ? STATUS[s.status] : null;
              return (
                <li key={s.id} className="border-b border-line last:border-0">
                  <button
                    type="button"
                    disabled={!s.joined}
                    onClick={() => setOpen(s.id)}
                    className="flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent sm:px-6"
                  >
                    <Avatar name={s.name} seed={s.id} size={34} className={cn(!s.joined && 'opacity-45')} />
                    <span className={cn('min-w-0 truncate text-[14.5px] font-medium', s.joined ? 'text-ink' : 'text-ink-3')}>{s.name}</span>
                    <span className="hidden shrink-0 text-[13px] tabular-nums text-ink-3 sm:inline">{s.studentNo}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-3">
                      {s.submittedAt && <span className="hidden text-[13px] text-ink-3 md:inline">{when(s.submittedAt)}</span>}
                      {!s.joined ? (
                        <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[12px] text-ink-3">还没加入</span>
                      ) : s.status === 'graded' && s.score !== null ? (
                        <span className="text-[14px] tabular-nums text-ink-3">
                          <span className="text-[15px] font-semibold text-ok">{num(s.score)}</span>/{num(h.points)}
                        </span>
                      ) : (
                        st && <span className={cn('rounded-full px-2.5 py-0.5 text-[12.5px]', st.tone)}>{st.label}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Grader h={h} sid={open} order={order} onPick={setOpen} onClose={() => setOpen(null)} />
    </>
  );
}

/* ---------------- 学生 ---------------- */

function StudentView({ h }: { h: HomeworkDetail }) {
  const qc = useQueryClient();
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
  return (
    <>
      <Brief h={h} mark={<StudentMark h={h} />} />
      <Card className="space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="text-[17px] font-semibold text-ink">我的作业</h2>
          {mine && !editing && (
            <span className="text-[13px] text-ink-3">
              {when(mine.submittedAt)} 交的{mine.late ? '（迟交）' : ''}
            </span>
          )}
          {mine && !editing && !h.lock && (
            <Button size="sm" className="ml-auto" icon={<PenLine className="size-4" />} onClick={() => setEditing(true)}>
              修改
            </Button>
          )}
        </div>
        {graded && (
          <div className="rounded-lg bg-ok-soft px-4 py-3">
            <p className="text-[15px] text-ink">
              得分 <span className="text-[20px] font-semibold text-ok">{num(mine!.score!)}</span> / {num(h.points)}
            </p>
            {mine!.comment && <p className="mt-1.5 whitespace-pre-wrap text-[14.5px] leading-relaxed text-ink-2">{mine!.comment}</p>}
          </div>
        )}
        {h.status === 'returned' && (
          <div className="rounded-lg bg-warn-soft px-4 py-3 text-[14.5px] text-warn">
            老师退回了，改好再交一次
            {mine?.comment && <p className="mt-1.5 whitespace-pre-wrap leading-relaxed text-ink-2">{mine.comment}</p>}
          </div>
        )}
        {editing && !h.lock ? (
          <div className="space-y-4">
            <Textarea autoGrow maxRows={20} className="min-h-32" value={text} maxLength={20000} onChange={(e) => setText(e.target.value)} />
            <FilePicker files={files} onChange={setFiles} disabled={busy} />
            {error && (
              <p role="alert" className="text-[14px] text-bad">
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
          <Work s={mine} />
        ) : (
          <p className="text-[14.5px] text-ink-3">{h.lock}</p>
        )}
      </Card>
    </>
  );
}

/** 一份作业：老师看谁交了、批改；学生看要求、交作业、看分数 */
export function HomeworkPage() {
  const params = useParams();
  const classId = Number(params.id),
    id = Number(params.hid);
  const student = useAuth((s) => s.user?.role) === 'student';
  const q = useHomework(id);
  useCrumbs([{ label: '班级', to: '/classes' }, { label: q.data?.className, to: `/classes/${classId}` }, { label: q.data?.title }]);
  return (
    <div className="space-y-5">
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="h-60 rounded-xl" />
      ) : student ? (
        <StudentView h={q.data} />
      ) : (
        <TeacherView h={q.data} />
      )}
    </div>
  );
}
