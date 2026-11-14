import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Plus, UserRound, Users } from 'lucide-react';
import { post } from '../../lib/api';
import { useAuth } from '../../lib/store';
import { Avatar, Button, Card, ErrorState, Input, Modal, Skeleton } from '../../components/ui';
import { useClasses, type ClassItem } from './data';
import { JoinModal } from './Join';
import { EmptyArt, themeBackground, themeOf } from './look';
import { ClassTools } from './Tools';

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
/** 小头像只写一个字（姓），两个字挤 */
const surname = (name?: string | null) => (name || '').trim().slice(0, 1);

/**
 * 一个班一张卡片，照课堂派的课程卡片：
 * 上面彩色头写班名，右下角压一个「教 / 学」小圆标；中间老师看到前几个学生的头像；底栏是老师和人数。
 */
function ClassCard({ item, student }: { item: ClassItem; student: boolean }) {
  const navigate = useNavigate();
  const theme = themeOf(item.id);
  const open = () => navigate(`/classes/${item.id}`);
  const count = item.count ?? 0,
    faces = item.preview || [];
  const me = useAuth((s) => s.user?.name);
  const teacher = student ? item.teacher : me;
  return (
    <Card
      hover
      padded={false}
      role="link"
      tabIndex={0}
      className="flex h-full cursor-pointer flex-col overflow-hidden rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
    >
      <div className="relative h-[116px] shrink-0 px-4 pt-3.5 text-white" style={themeBackground(theme)}>
        <div className="flex items-start gap-1">
          <h3 className="line-clamp-2 min-w-0 flex-1 break-words pt-0.5 text-[19px] font-medium leading-[1.4]">{item.name}</h3>
          {!student && (
            // 菜单和改名框里的点击不能冒到卡片上（卡片一点就进班）
            <div className="-mr-1.5 shrink-0" onClick={stop} onKeyDown={stop}>
              <ClassTools item={item} onPicture />
            </div>
          )}
        </div>
        <span
          className="absolute -bottom-[18px] right-4 flex size-9 items-center justify-center rounded-full bg-surface text-[15px] font-semibold shadow-[0_2px_6px_rgba(15,23,42,.15)]"
          style={{ color: theme.ink }}
        >
          {student ? '学' : '教'}
        </span>
      </div>
      {!student && (
        <div className="flex-1 px-4 pb-1 pt-4">
          <p className="text-[12.5px] text-ink-3">学生</p>
          {faces.length > 0 ? (
            <div className="mt-2 flex -space-x-1.5">
              {faces.map((s) => (
                <Avatar key={s.id} name={surname(s.name)} seed={s.id} size={26} ring />
              ))}
            </div>
          ) : (
            <p className="mt-1.5 text-[13px] text-ink-3">还没有学生</p>
          )}
        </div>
      )}
      <div className={`flex items-center gap-2 px-4 pb-3.5 ${student ? 'pt-6' : 'pt-3'}`}>
        <Avatar name={surname(teacher)} size={26} />
        <span className="min-w-0 truncate text-[13.5px] text-ink">{teacher}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[13px] text-ink-3">
          <UserRound className="size-3.5" />
          {count}
        </span>
      </div>
    </Card>
  );
}

/** 新建班级：照课堂派、Google Classroom，只起个名字；建好进班级页，那里有加课码，学生自己加入 */
function NewClassModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setName('');
    setError('');
  }, [open]);
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await post<{ id: number }>('/classes', { name });
      await qc.invalidateQueries({ queryKey: ['classes'] });
      onCreated(r.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="新建班级"
      icon={<Users />}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={create}>
            建好
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block text-[14px] text-ink">
          班级名称
          <Input
            autoFocus
            className="mt-1.5"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
        </label>
        {error && (
          <p role="alert" className="text-[14px] text-bad">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** 班级：老师左上角「新建班级」，学生左上角「加入班级」；下面一排四张卡片，学生只看到自己加入了的班 */
export function ClassesPage({ joinCode }: { joinCode?: string }) {
  const navigate = useNavigate();
  const student = useAuth((s) => s.user?.role) === 'student';
  const classes = useClasses();
  const list = classes.data?.classes || [];
  const [creating, setCreating] = useState(false);
  // 扫码、点链接进来的直接打开加入框，加课码填好
  const [joining, setJoining] = useState(!!joinCode);
  const pill =
    'inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-4 text-[14px] text-ink-2 shadow-xs transition-colors hover:border-brand/50 hover:text-brand';
  return (
    <div>
      <div className="mb-5">
        <button type="button" onClick={() => (student ? setJoining(true) : setCreating(true))} className={pill}>
          <Plus className="size-4" />
          {student ? '加入班级' : '新建班级'}
        </button>
      </div>
      {classes.error ? (
        <ErrorState error={classes.error} onRetry={() => classes.refetch()} />
      ) : !classes.data ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <Skeleton className="h-60 rounded-lg" />
          <Skeleton className="h-60 rounded-lg" />
        </div>
      ) : !list.length ? (
        <Card padded={false}>
          <EmptyArt
            src="/illustrations/classes/empty-classes.webp"
            title={student ? '还没有加入班级' : '还没有班级'}
            action={
              student && (
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setJoining(true)}>
                  加入班级
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {list.map((k, i) => (
            <motion.div key={k.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
              <ClassCard item={k} student={student} />
            </motion.div>
          ))}
        </div>
      )}
      {!student && (
        <NewClassModal
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            navigate(`/classes/${id}`);
          }}
        />
      )}
      {student && (
        <JoinModal
          open={joining}
          initialCode={joinCode}
          onClose={() => {
            setJoining(false);
            if (joinCode) navigate('/classes', { replace: true });
          }}
        />
      )}
    </div>
  );
}

/** 加入链接 /join/加课码（二维码扫出来的就是它）：学生打开加入框；老师打开就回班级 */
export function JoinPage() {
  const { code } = useParams();
  const role = useAuth((s) => s.user?.role);
  if (role !== 'student') return <Navigate replace to="/classes" />;
  return <ClassesPage joinCode={code} />;
}
