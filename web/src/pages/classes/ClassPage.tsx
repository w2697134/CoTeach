import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Trash2, UserPlus } from 'lucide-react';
import { api, post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { Avatar, Button, Card, Empty, ErrorState, IconButton, Modal, SearchInput, Skeleton, useConfirm } from '../../components/ui';
import { useClass, type ClassDetail, type ClassStudent } from './data';
import { EmptyArt, ThemeBanner, themeOf, type Theme } from './look';
import { RosterInput } from './RosterInput';
import { ClassTools } from './Tools';

/** 往名单里补人：已经在的不动；学号一样名字不一样的不改，留在框里告诉老师 */
function AddStudents({ id, open, onClose }: { id: number; open: boolean; onClose: () => void }) {
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
      const r = await post<{ added: number; conflicts: { studentNo: string; name: string; existingName: string }[]; students: ClassStudent[] }>(
        `/classes/${id}/students`,
        { roster: text },
      );
      qc.setQueryData<ClassDetail>(['class', id], (old) => (old ? { ...old, students: r.students } : old));
      qc.invalidateQueries({ queryKey: ['classes'] });
      if (r.added) toast.success(`加了 ${r.added} 人`);
      if (r.conflicts.length) {
        setText(r.conflicts.map((s) => `${s.studentNo} ${s.name}`).join('\n'));
        setError(r.conflicts.map((s) => `学号 ${s.studentNo} 在名单里是「${s.existingName}」，没有改成「${s.name}」`).join('；'));
        return;
      }
      if (!r.added) toast.info('都已经在名单里了');
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
      title="加学生"
      icon={<UserPlus />}
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={add}>
            加进去
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

/** 成员（照 Google Classroom 的「成员」页）：老师一栏，学生一栏，标题和分隔线用这个班的颜色；学生能搜、能加、悬停一行能移出 */
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
        <span className="text-[14px] text-ink-3">{k ? `找到 ${shown.length} 人` : `${students.length} 人`}</span>
        <div className="ml-auto flex min-w-0 items-center gap-2 max-sm:w-full">
          {students.length > 0 && <SearchInput value={kw} onChange={setKw} placeholder="搜索姓名或学号" className="min-w-0 flex-1 sm:w-52 sm:flex-none" />}
          <IconButton label="加学生" onClick={onAdd} className="hover:bg-surface-3" style={{ color: theme.ink }}>
            <UserPlus className="size-[18px]" />
          </IconButton>
        </div>
      </div>
      {!students.length ? (
        <EmptyArt
          src="/illustrations/classes/empty-roster.webp"
          title="名单是空的"
          action={
            <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={onAdd}>
              加学生
            </Button>
          }
        />
      ) : !shown.length ? (
        <Empty compact title="没有找到" />
      ) : (
        <ul>
          {shown.map((s) => (
            <li key={s.id} className="group flex items-center gap-3 border-b border-line px-5 py-2.5 last:border-0 hover:bg-surface-2 sm:px-6">
              <Avatar name={s.name} seed={s.id} size={34} />
              <span className="min-w-0 truncate text-[14.5px] font-medium text-ink">{s.name}</span>
              <span className="shrink-0 text-[13px] tabular-nums text-ink-3">{s.studentNo}</span>
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

/** 一个班：顶上是这个班的封面，班名白字写在上面；老师下面看成员，学生只看到班名和老师 */
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
          <ThemeBanner theme={themeOf(q.data.id)} className="h-44 rounded-xl sm:h-52">
            <div className="flex h-full flex-col justify-end p-6 pr-16 sm:p-8">
              <h1 className="break-words text-[28px] font-semibold leading-tight tracking-tight sm:text-[32px]">{q.data.name}</h1>
              <p className="mt-1.5 text-[14.5px] text-white/90">{student ? q.data.teacher : `${students.length} 名学生`}</p>
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
      {!student && <AddStudents id={id} open={adding} onClose={() => setAdding(false)} />}
    </div>
  );
}
