import { useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Download, KeyRound, LogOut, MessageCircle, MoreHorizontal, MoreVertical, Plus, Upload, UserMinus, UserPlus } from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { api, post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { Avatar, Button, Card, Empty, ErrorState, IconButton, MenuItem, Modal, Popover, SearchInput, Skeleton, Tabs, cn, useConfirm } from '../../components/ui';
import { useClass, type ClassDetail, type ClassStudent } from './data';
import { GradesTab } from './GradesTab';
import { HomeworkList } from './HomeworkList';
import { InsightsAction, InsightsTab } from './InsightsTab';
import { CodeLine, InviteModal, InvitePanel, Projector, copyText } from './Invite';
import { EmptyArt, THEME_TEXT, ThemeBanner, inkVars, themeOf, type Theme } from './look';
import { RosterInput } from './RosterInput';
import { ClassTools } from './Tools';
import { CHIP } from './tone';
import { teacherTitle } from '../cot/data';

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
      <h2 className={cn('text-[18px] font-semibold tracking-tight', THEME_TEXT)} style={inkVars(theme)}>
        {title}
      </h2>
      {note && <span className="text-[14px] text-ink-3">{note}</span>}
      {actions && <div className="ml-auto flex min-w-0 items-center gap-1.5 max-sm:w-full">{actions}</div>}
    </div>
  );
}

function TeacherRow({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-3 px-5 py-3.5 sm:px-6">
      <Avatar name={name} size={40} />
      <span className="text-[16px] font-medium text-ink">{name}</span>
    </div>
  );
}

/** 成员一格：头像、名字、学号；老师点了看他跟学伴说的。一排三四个，比一人一行的长表好找 */
function PersonTile({
  s,
  me,
  tag,
  onOpen,
  menu,
}: {
  s: { id: number; name: string; studentNo?: string; joined?: boolean };
  me?: boolean;
  tag?: ReactNode;
  onOpen?: () => void;
  menu?: ReactNode;
}) {
  const faded = s.joined === false;
  const body = (
    <>
      <Avatar name={s.name} seed={s.id} size={36} className={cn('shrink-0', faded && 'opacity-45')} />
      <span className="min-w-0 flex-1">
        <span className={cn('flex items-center gap-1.5 text-[15px] font-medium', faded ? 'text-ink-2' : 'text-ink')}>
          <span className="truncate">{s.name}</span>
          {me && <span className="shrink-0 rounded-full bg-brand-soft px-2 text-[13px] font-normal text-brand-ink">我</span>}
        </span>
        {(s.studentNo || tag) && (
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-[13px] text-ink-3">
            {s.studentNo && <span className="truncate tabular-nums">{s.studentNo}</span>}
            {tag}
          </span>
        )}
      </span>
    </>
  );
  const box = 'flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5 text-left sm:gap-3 sm:px-3.5 sm:py-3';
  return (
    <li className="group relative">
      {onOpen ? (
        <button type="button" onClick={onOpen} className={cn(box, 'pr-9 transition-colors hover:border-line-strong hover:bg-surface-2 sm:pr-10')}>
          {body}
        </button>
      ) : (
        <div className={cn(box, menu && 'pr-9 sm:pr-10')}>{body}</div>
      )}
      {menu && (
        <div className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
          {menu}
        </div>
      )}
    </li>
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
  const navigate = useNavigate();
  // 点学生看他跟 CoT 学伴说的（2026-11-16，照 Khanmigo、MagicSchool：老师看得到自己班学生跟 AI 的对话）
  const openChat = (s: ClassStudent) => navigate(`/classes/${k.id}/students/${s.id}/cot`);
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
                className={cn('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[14px] font-medium transition-colors hover:bg-surface-3', THEME_TEXT)}
                style={inkVars(theme)}
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
        <ul className="grid grid-cols-2 gap-2 p-3 sm:gap-2.5 sm:p-5 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map((s) => (
            <PersonTile
              key={s.id}
              s={s}
              onOpen={s.joined ? () => openChat(s) : undefined}
              tag={
                !s.joined ? (
                  <span className={cn('rounded-full px-2 text-[13px]', CHIP.gray)}>还没加入</span>
                ) : !s.inRoster && roster > 0 ? (
                  <span className={cn('rounded-full px-2 text-[13px]', CHIP.warn)}>不在名单里</span>
                ) : undefined
              }
              menu={
                (live || s.joined) && (
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
                        {s.joined && (
                          <MenuItem icon={<MessageCircle />} onClick={() => openChat(s)}>
                            学伴对话
                          </MenuItem>
                        )}
                        {live && s.canReset && (
                          <MenuItem icon={<KeyRound />} onClick={() => onReset(s)}>
                            重置密码
                          </MenuItem>
                        )}
                        {live && (
                          <MenuItem icon={<UserMinus />} danger onClick={() => onRemove(s)}>
                            移出班级
                          </MenuItem>
                        )}
                      </div>
                    )}
                  </Popover>
                )
              }
            />
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
        <ul className="grid grid-cols-2 gap-2 p-3 sm:gap-2.5 sm:p-5 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map((s) => (
            <PersonTile key={s.id} s={s} me={s.me} />
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

type Tab = 'homework' | 'insights' | 'grades' | 'people';
const download = (href: string) => {
  const a = document.createElement('a');
  a.href = href;
  a.click();
};
/** 一个班：顶上是这个班的封面，班名白字写在上面，老师还看到加课码；下面分栏：作业、成绩、成员（照 Google Classroom） */
export function ClassPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient(),
    confirm = useConfirm();
  const me = useAuth((s) => s.user);
  const student = me?.role === 'student';
  const q = useClass(id);
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab: Tab = asked === 'people' || asked === 'grades' || (asked === 'insights' && !student) ? asked : 'homework';
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
  useCrumbs([{ label: '班级', to: '/classes' }, { label: k?.name }]);
  return (
    <div className="space-y-5">
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !k ? (
        <Skeleton className="h-52 rounded-2xl" />
      ) : (
        <>
          <ThemeBanner theme={theme} className="h-auto min-h-36 rounded-xl sm:min-h-40">
            <div className="flex min-h-36 flex-col justify-end p-6 pr-16 sm:min-h-40 sm:px-8 sm:py-7">
              <h1 className="text-balance break-words text-[24px] font-semibold leading-tight tracking-tight [text-shadow:0_1px_2px_rgba(15,23,42,.18)]">{k.name}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[15px] text-white">
                <span>{student ? `${teacherTitle(k.teacher || '')} · ${(k.classmates || []).length} 名学生` : `${joined} 名学生`}</span>
                {k.archived ? (
                  <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-[13px] text-white">已归档</span>
                ) : (
                  !student &&
                  k.code && (
                    <>
                      <span className="hidden h-3.5 w-px bg-white/40 sm:block" />
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
          {/* 分栏那一行右边摆这一栏要做的事（布置作业、导出 Excel），不另起一行 */}
          <Tabs
            variant="page"
            className="pt-1"
            value={tab}
            onChange={(v) => setParams(v === 'homework' ? {} : { tab: v }, { replace: true })}
            items={[
              { value: 'homework', label: '作业' },
              ...(student ? [] : [{ value: 'insights' as const, label: '学情' }]),
              { value: 'grades', label: '成绩' },
              { value: 'people', label: '成员' },
            ]}
            end={
              student ? undefined : tab === 'homework' && !k.archived ? (
                <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate(`/classes/${id}/homework/new`)}>
                  布置作业
                </Button>
              ) : tab === 'insights' ? (
                <InsightsAction classId={id} />
              ) : tab === 'grades' ? (
                <Button size="sm" icon={<Download className="size-4" />} onClick={() => download(`/api/homework/class/${id}/grades/export`)}>
                  导出 Excel
                </Button>
              ) : undefined
            }
          />
          {tab === 'homework' ? (
            <HomeworkList classId={id} theme={theme} student={student} archived={!!k.archived} createAbove={false} />
          ) : tab === 'insights' ? (
            <InsightsTab classId={id} theme={theme} />
          ) : tab === 'grades' ? (
            <GradesTab classId={id} theme={theme} student={student} exportAbove={false} />
          ) : student ? (
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
