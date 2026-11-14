import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, Download, KeyRound, LogOut, MoreHorizontal, MoreVertical, Upload, UserMinus, UserPlus } from 'lucide-react';
import { api, post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { Avatar, Button, Card, Empty, ErrorState, IconButton, MenuItem, Modal, Popover, SearchInput, Skeleton, cn, useConfirm } from '../../components/ui';
import { useClass, type ClassDetail, type ClassStudent } from './data';
import { CodeLine, InviteModal, InvitePanel, Projector, copyText } from './Invite';
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

/** 成员页的一栏标题：用这个班的颜色写字、画分隔线（照 Google Classroom） */
function SectionHead({ theme, title, note, actions, className }: { theme: Theme; title: string; note?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-3 border-b px-5 pb-3 pt-5 sm:px-6', className)} style={{ borderColor: `${theme.ink}66` }}>
      <h2 className="text-[19px] font-semibold tracking-tight" style={{ color: theme.ink }}>
        {title}
      </h2>
      {note && <span className="text-[14px] text-ink-3">{note}</span>}
      {actions && <div className="ml-auto flex min-w-0 items-center gap-1.5 max-sm:w-full">{actions}</div>}
    </div>
  );
}

function TeacherRow({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-3 px-5 py-3 sm:px-6">
      <Avatar name={name} size={34} />
      <span className="text-[14.5px] font-medium text-ink">{name}</span>
    </div>
  );
}

/**
 * 老师看的成员（照 Google Classroom 的「成员」页）：老师一栏，学生一栏。
 * 学生自己加入的在前；导了名单的，名单上还没加入的排在后面、标「还没加入」，加入了但名单上没有的标「不在名单里」。
 * 还没有人加入时，学生栏里直接摆二维码和加课码。归档的班只能看。
 */
function TeacherPeople({
  k,
  theme,
  teacher,
  onImport,
  onInvite,
  onProject,
  onRemove,
  onReset,
}: {
  k: ClassDetail;
  theme: Theme;
  teacher: string;
  onImport: () => void;
  onInvite: () => void;
  onProject: () => void;
  onRemove: (s: ClassStudent) => void;
  onReset: (s: ClassStudent) => void;
}) {
  const students = k.students || [];
  const [kw, setKw] = useState('');
  const q = kw.trim();
  const shown = q ? students.filter((s) => s.name.includes(q) || s.studentNo.includes(q)) : students;
  const joined = students.filter((s) => s.joined).length,
    roster = students.filter((s) => s.inRoster).length;
  const live = !k.archived;
  const inviting = live && k.joinOpen !== false && !!k.code && joined === 0;
  const exportList = () => {
    const a = document.createElement('a');
    a.href = `/api/classes/${k.id}/export`;
    a.click();
  };
  return (
    <Card padded={false}>
      <SectionHead theme={theme} title="老师" />
      <TeacherRow name={teacher} />
      <SectionHead
        theme={theme}
        title="学生"
        className="mt-3"
        note={q ? `找到 ${shown.length} 人` : roster ? `已加入 ${joined} 人 · 名单 ${roster} 人` : `${joined} 人`}
        actions={
          <>
            {students.length > 0 && <SearchInput value={kw} onChange={setKw} placeholder="搜索姓名或学号" className="min-w-0 flex-1 sm:w-52 sm:flex-none" />}
            {live && (
              <button
                type="button"
                onClick={onInvite}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[14px] font-medium transition-colors hover:bg-surface-3"
                style={{ color: theme.ink }}
              >
                <UserPlus className="size-4" />
                邀请学生
              </button>
            )}
            <Popover
              width={150}
              trigger={({ toggle }) => (
                <IconButton label="名单" onClick={toggle} className="text-ink-3">
                  <MoreHorizontal className="size-[18px]" />
                </IconButton>
              )}
            >
              {(close) => (
                <div onClick={close}>
                  {live && (
                    <MenuItem icon={<Upload />} onClick={onImport}>
                      导入名单
                    </MenuItem>
                  )}
                  <MenuItem icon={<Download />} disabled={!students.length} onClick={exportList}>
                    导出名单
                  </MenuItem>
                </div>
              )}
            </Popover>
          </>
        }
      />
      {inviting && (
        <div className={cn('px-5 py-9 sm:px-6', students.length > 0 && 'border-b border-line')}>
          <InvitePanel k={{ id: k.id, name: k.name, code: k.code! }} onProject={onProject} />
        </div>
      )}
      {!students.length ? (
        !inviting && (
          <EmptyArt
            src="/illustrations/classes/empty-roster.webp"
            title="还没有学生"
            action={
              live && (
                <Button icon={<UserPlus className="size-4" />} onClick={onInvite}>
                  邀请学生
                </Button>
              )
            }
          />
        )
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
              {live && (
                <div className="ml-auto opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
                  <Popover
                    width={150}
                    trigger={({ toggle }) => (
                      <IconButton size="sm" label={`${s.name}：更多`} onClick={toggle} className="text-ink-3">
                        <MoreHorizontal className="size-4" />
                      </IconButton>
                    )}
                  >
                    {(close) => (
                      <div onClick={close}>
                        {s.canReset && (
                          <MenuItem icon={<KeyRound />} onClick={() => onReset(s)}>
                            重置密码
                          </MenuItem>
                        )}
                        <MenuItem icon={<UserMinus />} danger onClick={() => onRemove(s)}>
                          移出班级
                        </MenuItem>
                      </div>
                    )}
                  </Popover>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** 学生看的成员：老师和已经加入的同学，只有名字；自己标「我」 */
function StudentPeople({ theme, teacher, classmates }: { theme: Theme; teacher: string; classmates: { id: number; name: string; me: boolean }[] }) {
  const [kw, setKw] = useState('');
  const q = kw.trim();
  const shown = q ? classmates.filter((s) => s.name.includes(q)) : classmates;
  return (
    <Card padded={false}>
      <SectionHead theme={theme} title="老师" />
      <TeacherRow name={teacher} />
      <SectionHead
        theme={theme}
        title="同学"
        className="mt-3"
        note={q ? `找到 ${shown.length} 人` : `${classmates.length} 人`}
        actions={classmates.length > 8 && <SearchInput value={kw} onChange={setKw} placeholder="搜索姓名" className="min-w-0 flex-1 sm:w-52 sm:flex-none" />}
      />
      {!shown.length ? (
        <Empty compact title="没有找到" />
      ) : (
        <ul>
          {shown.map((s) => (
            <li key={s.id} className="flex items-center gap-3 border-b border-line px-5 py-2.5 last:border-0 sm:px-6">
              <Avatar name={s.name} seed={s.id} size={34} />
              <span className="min-w-0 truncate text-[14.5px] font-medium text-ink">{s.name}</span>
              {s.me && <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[12px] text-brand-ink">我</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** 老师给学生重置的新密码：只在这里出现一次 */
function NewPassword({ shown, onClose }: { shown: { name: string; password: string } | null; onClose: () => void }) {
  return (
    <Modal
      open={!!shown}
      onClose={onClose}
      title={shown ? `${shown.name}的新密码` : ''}
      width={400}
      footer={
        <Button variant="primary" onClick={onClose}>
          好了
        </Button>
      }
    >
      <div className="flex items-center justify-center gap-2 py-4">
        <span className="font-mono text-[38px] font-semibold tracking-[0.18em] text-ink">{shown?.password}</span>
        <IconButton label="复制密码" onClick={() => shown && copyText(shown.password, '密码')}>
          <Copy className="size-4" />
        </IconButton>
      </div>
    </Modal>
  );
}

/** 一个班：顶上是这个班的封面，班名白字写在上面，老师还看到加课码；下面是成员 */
export function ClassPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient(),
    confirm = useConfirm();
  const me = useAuth((s) => s.user);
  const student = me?.role === 'student';
  const q = useClass(id);
  const [importing, setImporting] = useState(false),
    [inviting, setInviting] = useState(false),
    [projecting, setProjecting] = useState(false),
    [secret, setSecret] = useState<{ name: string; password: string } | null>(null);
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
  const reset = async (s: ClassStudent) => {
    if (!(await confirm({ title: `重置「${s.name}」的密码？`, desc: '原来的密码不能再用，在别处登着的也会退出。', okText: '重置', danger: true }))) return;
    try {
      const r = await post<{ password: string }>(`/classes/${id}/students/${s.id}/password`);
      setSecret({ name: s.name, password: r.password });
    } catch (e) {
      toast.fromError(e);
    }
  };
  const leave = async () => {
    if (!q.data || !(await confirm({ title: `退出「${q.data.name}」？`, desc: '退出后要用加课码才能再加入。', okText: '退出', danger: true }))) return;
    try {
      await post(`/classes/${id}/leave`);
      await qc.invalidateQueries({ queryKey: ['classes'] });
      toast.success('已退出');
      navigate('/classes', { replace: true });
    } catch (e) {
      toast.fromError(e);
    }
  };
  const k = q.data;
  const theme = themeOf(id);
  const joined = (k?.students || []).filter((s) => s.joined).length;
  return (
    <div className="space-y-5">
      <Link to="/classes" className="inline-flex items-center gap-1 text-[14px] text-ink-3 hover:text-ink">
        <ArrowLeft className="size-4" />
        班级
      </Link>
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !k ? (
        <Skeleton className="h-52 rounded-2xl" />
      ) : (
        <>
          <ThemeBanner theme={theme} className="h-auto min-h-44 rounded-xl sm:min-h-52">
            <div className="flex min-h-44 flex-col justify-end p-6 pr-16 sm:min-h-52 sm:p-8">
              <h1 className="break-words text-[28px] font-semibold leading-tight tracking-tight sm:text-[32px]">{k.name}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[14.5px] text-white/90">
                <span>{student ? k.teacher : `${joined} 名学生`}</span>
                {k.archived ? (
                  <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-[13px] text-white">已归档</span>
                ) : (
                  !student &&
                  k.code && (
                    <>
                      <span className="h-3.5 w-px bg-white/40" />
                      <CodeLine code={k.code} open={k.joinOpen !== false} onInvite={() => setInviting(true)} />
                    </>
                  )
                )}
              </div>
            </div>
            <div className="absolute right-3 top-3">
              {student ? (
                <Popover
                  width={150}
                  trigger={({ toggle }) => (
                    <IconButton label="更多" size="sm" onClick={toggle} className="rounded-full bg-white/85 text-[#334155] shadow-xs hover:bg-white">
                      <MoreVertical className="size-4" />
                    </IconButton>
                  )}
                >
                  {(close) => (
                    <div onClick={close}>
                      <MenuItem icon={<LogOut />} danger onClick={leave}>
                        退出班级
                      </MenuItem>
                    </div>
                  )}
                </Popover>
              ) : (
                <ClassTools item={k} onImage onDeleted={() => navigate('/classes', { replace: true })} />
              )}
            </div>
          </ThemeBanner>
          {student ? (
            <StudentPeople theme={theme} teacher={k.teacher || ''} classmates={k.classmates || []} />
          ) : (
            <TeacherPeople
              k={k}
              theme={theme}
              teacher={me?.name || ''}
              onImport={() => setImporting(true)}
              onInvite={() => setInviting(true)}
              onProject={() => setProjecting(true)}
              onRemove={remove}
              onReset={reset}
            />
          )}
        </>
      )}
      {!student && k?.code && (
        <>
          <ImportRoster id={id} open={importing} onClose={() => setImporting(false)} />
          <InviteModal
            k={{ id, name: k.name, code: k.code, joinOpen: k.joinOpen }}
            open={inviting}
            onClose={() => setInviting(false)}
            onProject={() => {
              setInviting(false);
              setProjecting(true);
            }}
          />
          <Projector k={{ id, name: k.name, code: k.code }} open={projecting} onClose={() => setProjecting(false)} />
          <NewPassword shown={secret} onClose={() => setSecret(null)} />
        </>
      )}
    </div>
  );
}
