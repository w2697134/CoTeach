import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Trash2, UserPlus } from 'lucide-react';
import { api, post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { Avatar, Button, Card, Empty, ErrorState, IconButton, Modal, SearchInput, Skeleton, cn, useConfirm } from '../../components/ui';
import { useClass, type ClassDetail, type ClassStudent } from './data';
import { JoinCode } from './Join';
import { EmptyArt, ThemeBanner, themeOf, type Theme } from './look';
import { RosterInput } from './RosterInput';
import { ClassTools } from './Tools';

/** 导入名单：拿来对一对谁还没加入。按学号对，已经在的不动；学号一样名字不一样的不改，留在框里告诉老师 */
function ImportRoster({ id, open, onClose }: { id: number; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const close = () => {
    if (busy) return;
    setText('');
    setError('');
    onClose();
  };
  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await post<{ added: number; matched: number; conflicts: { studentNo: string; name: string; existingName: string }[]; students: ClassStudent[] }>(
        `/classes/${id}/students`,
        { roster: text },
      );
      qc.setQueryData<ClassDetail>(['class', id], (old) => (old ? { ...old, students: r.students } : old));
      qc.invalidateQueries({ queryKey: ['classes'] });
      if (r.added || r.matched) toast.success([r.added && `导入 ${r.added} 人`, r.matched && `${r.matched} 人已经加入`].filter(Boolean).join('，'));
      if (r.conflicts.length) {
        setText(r.conflicts.map((s) => `${s.studentNo} ${s.name}`).join('\n'));
        setError(r.conflicts.map((s) => `学号 ${s.studentNo} 在班里是「${s.existingName}」，没有改成「${s.name}」`).join('；'));
        return;
      }
      if (!r.added && !r.matched) toast.info('都已经在名单里了');
      setText('');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title="导入名单"
      icon={<UserPlus />}
      width={600}
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={add}>
            导入
          </Button>
        </>
      }
    >
      <RosterInput value={text} onChange={setText} autoFocus />
      {error && (
        <p role="alert" className="mt-3 text-[14px] text-bad">
          {error}
        </p>
      )}
    </Modal>
  );
}

/**
 * 成员（照 Google Classroom 的「成员」页）：老师一栏，学生一栏，标题和分隔线用这个班的颜色。
 * 学生自己加入的在前；导了名单的，名单上还没加入的排在后面、标「还没加入」，加入了但名单上没有的标「不在名单里」。
 */
function People({
  theme,
  teacher,
  students,
  onAdd,
  onRemove,
}: {
  theme: Theme;
  teacher: string;
  students: ClassStudent[];
  onAdd: () => void;
  onRemove: (s: ClassStudent) => void;
}) {
  const [kw, setKw] = useState('');
  const k = kw.trim();
  const shown = k ? students.filter((s) => s.name.includes(k) || s.studentNo.includes(k)) : students;
  const joined = students.filter((s) => s.joined).length,
    roster = students.filter((s) => s.inRoster).length;
  const head = 'flex flex-wrap items-center gap-3 border-b px-5 pb-3 pt-5 sm:px-6';
  const line = { borderColor: `${theme.ink}66` };
  return (
    <Card padded={false}>
      <div className={head} style={line}>
        <h2 className="text-[19px] font-semibold tracking-tight" style={{ color: theme.ink }}>
          老师
        </h2>
      </div>
      <div className="flex items-center gap-3 px-5 py-3 sm:px-6">
        <Avatar name={teacher} size={34} />
        <span className="text-[14.5px] font-medium text-ink">{teacher}</span>
      </div>
      <div className={`${head} mt-3`} style={line}>
        <h2 className="text-[19px] font-semibold tracking-tight" style={{ color: theme.ink }}>
          学生
        </h2>
        <span className="text-[14px] text-ink-3">
          {k ? `找到 ${shown.length} 人` : roster ? `已加入 ${joined} 人 · 名单 ${roster} 人` : `${joined} 人`}
        </span>
        <div className="ml-auto flex min-w-0 items-center gap-2 max-sm:w-full">
          {students.length > 0 && <SearchInput value={kw} onChange={setKw} placeholder="搜索姓名或学号" className="min-w-0 flex-1 sm:w-52 sm:flex-none" />}
          <IconButton label="导入名单" onClick={onAdd} className="hover:bg-surface-3" style={{ color: theme.ink }}>
            <UserPlus className="size-[18px]" />
          </IconButton>
        </div>
      </div>
      {!students.length ? (
        <EmptyArt
          src="/illustrations/classes/empty-roster.webp"
          title="还没有学生"
          action={
            <Button icon={<UserPlus className="size-4" />} onClick={onAdd}>
              导入名单
            </Button>
          }
        />
      ) : !shown.length ? (
        <Empty compact title="没有找到" />
      ) : (
        <ul>
          {shown.map((s) => (
            <li key={s.id} className="group flex items-center gap-3 border-b border-line px-5 py-2.5 last:border-0 hover:bg-surface-2 sm:px-6">
              <Avatar name={s.name} seed={s.id} size={34} className={cn(!s.joined && 'opacity-45')} />
              <span className={cn('min-w-0 truncate text-[14.5px] font-medium', s.joined ? 'text-ink' : 'text-ink-3')}>{s.name}</span>
              <span className="shrink-0 text-[13px] tabular-nums text-ink-3">{s.studentNo}</span>
              {!s.joined && <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-[12px] text-ink-3">还没加入</span>}
              {s.joined && !s.inRoster && roster > 0 && <span className="shrink-0 rounded-full bg-warn-soft px-2 py-0.5 text-[12px] text-warn">不在名单里</span>}
              <button
                type="button"
                title="移出"
                aria-label={`把${s.name}移出这个班`}
                className="ml-auto rounded p-1.5 text-ink-3 opacity-0 transition-opacity hover:bg-bad-soft hover:text-bad focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
                onClick={() => onRemove(s)}
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** 一个班：顶上是这个班的封面，班名白字写在上面，老师还看到加课码；老师下面看成员，学生只看到班名和老师 */
export function ClassPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient(),
    confirm = useConfirm();
  const me = useAuth((s) => s.user);
  const student = me?.role === 'student';
  const q = useClass(id);
  const [adding, setAdding] = useState(false);
  const remove = async (s: ClassStudent) => {
    if (!(await confirm({ title: `把「${s.name}」移出这个班？`, desc: `学号 ${s.studentNo}`, okText: '移出', danger: true }))) return;
    try {
      const r = await api<{ students: ClassStudent[] }>(`/classes/${id}/students/${s.id}`, { method: 'DELETE' });
      qc.setQueryData<ClassDetail>(['class', id], (old) => (old ? { ...old, students: r.students } : old));
      qc.invalidateQueries({ queryKey: ['classes'] });
    } catch (e) {
      toast.fromError(e);
    }
  };
  const students = q.data?.students || [];
  return (
    <div className="space-y-5">
      <Link to="/classes" className="inline-flex items-center gap-1 text-[14px] text-ink-3 hover:text-ink">
        <ArrowLeft className="size-4" />
        班级
      </Link>
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="h-52 rounded-2xl" />
      ) : (
        <>
          <ThemeBanner theme={themeOf(q.data.id)} className="h-auto min-h-44 rounded-xl sm:min-h-52">
            <div className="flex min-h-44 flex-col justify-end gap-4 p-6 pr-16 sm:min-h-52 sm:flex-row sm:items-end sm:p-8">
              <div className="min-w-0 flex-1">
                <h1 className="break-words text-[28px] font-semibold leading-tight tracking-tight sm:text-[32px]">{q.data.name}</h1>
                <p className="mt-1.5 text-[14.5px] text-white/90">{student ? q.data.teacher : `${students.filter((s) => s.joined).length} 名学生`}</p>
              </div>
              {!student && q.data.code && <JoinCode code={q.data.code} />}
            </div>
            {!student && (
              <div className="absolute right-3 top-3">
                <ClassTools item={q.data} onImage onDeleted={() => navigate('/classes', { replace: true })} />
              </div>
            )}
          </ThemeBanner>
          {!student && (
            <People theme={themeOf(q.data.id)} teacher={me?.name || ''} students={students} onAdd={() => setAdding(true)} onRemove={remove} />
          )}
        </>
      )}
      {!student && <ImportRoster id={id} open={adding} onClose={() => setAdding(false)} />}
    </div>
  );
}
