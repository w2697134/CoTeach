import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { ChevronRight, Plus, UserPlus, UserRound } from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { post } from '../../lib/api';
import { useAuth } from '../../lib/store';
import { Avatar, Button, Card, ErrorState, Input, Modal, Skeleton, cn } from '../../components/ui';
import { useClasses, type ClassItem } from './data';
import { JoinModal } from './Join';
import { EmptyArt, THEME_TEXT, inkVars, themeBackground, themeOf } from './look';
import { ClassTools } from './Tools';
import { CHIP, INK } from './tone';

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
/** 小头像只写一个字（姓），两个字挤 */
const surname = (name?: string | null) => (name || '').trim().slice(0, 1);

/**
 * 一个班一张卡片，照课堂派的课程卡片：
 * 上面彩色头写班名，左下角是加课码，右下角压一个「教 / 学」小圆标；中间老师看到前几个学生的头像；底栏是老师和人数。
 * 归档的班头变灰，左下角写「已归档」。
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
      <div
        className="relative h-[116px] shrink-0 px-4 pt-3.5 text-white"
        style={{ ...themeBackground(theme), ...(item.archived ? { filter: 'grayscale(.85)', opacity: 0.8 } : {}) }}
      >
        <div className="flex items-start gap-1">
          {/* 课程名只在空格处换行（「计科2501 Python / 程序设计」），一段放不下才从中间断 */}
          <h3 className="line-clamp-2 min-w-0 flex-1 break-keep pt-0.5 text-[18px] font-medium leading-[1.45] [overflow-wrap:anywhere]">{item.name}</h3>
          {!student && (
            // 菜单和改名框里的点击不能冒到卡片上（卡片一点就进班）
            <div className="-mr-1.5 shrink-0" onClick={stop} onKeyDown={stop}>
              <ClassTools item={item} onPicture />
            </div>
          )}
        </div>
        {(item.archived || (!student && item.code)) && (
          <p className="absolute bottom-3 left-4 text-[13px] text-white">
            {item.archived ? (
              '已归档'
            ) : item.joinOpen === false ? (
              '已停止加入'
            ) : (
              <>
                加课码 <span className="ml-0.5 font-mono text-[14px] font-semibold tracking-[0.08em] text-white">{item.code}</span>
              </>
            )}
          </p>
        )}
        <span
          className={cn('absolute -bottom-[18px] right-4 flex size-9 items-center justify-center rounded-full bg-surface text-[15px] font-semibold shadow-[0_2px_6px_rgba(15,23,42,.15)]', THEME_TEXT)}
          style={inkVars(theme)}
        >
          {student ? '学' : '教'}
        </span>
      </div>
      {/* 中间一块：老师看前几个学生的头像；没人的班直接给「邀请学生」；学生看还有几份没交 */}
      <div className="flex-1 px-4 pb-1 pt-5">
        {student ? (
          item.todo ? (
            <p className={cn('text-[14px] font-medium', INK.warn)}>{item.todo} 份作业还没交</p>
          ) : (
            <p className="text-[14px] text-ink-2">作业都交了</p>
          )
        ) : faces.length > 0 ? (
          <div className="flex -space-x-1.5">
            {faces.map((s) => (
              <Avatar key={s.id} name={surname(s.name)} seed={s.id} size={28} ring />
            ))}
            {count > faces.length && (
              <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-surface-3 px-1.5 text-[13px] font-medium text-ink-2 ring-2 ring-surface">
                +{count - faces.length}
              </span>
            )}
          </div>
        ) : item.archived ? (
          <p className="text-[14px] text-ink-2">没有学生</p>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/classes/${item.id}?tab=people`);
            }}
            className="inline-flex items-center gap-1.5 rounded-md text-[14px] font-medium text-brand-ink hover:underline"
          >
            <UserPlus className="size-4" />
            邀请学生
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 px-4 pb-3.5 pt-3">
        <Avatar name={surname(teacher)} size={26} />
        <span className="min-w-0 truncate text-[14px] text-ink">{teacher}</span>
        {!student && !!item.pending && <span className={cn('ml-auto shrink-0 rounded-full px-2 py-0.5 text-[13px] font-medium', CHIP.info)}>{item.pending} 份等你批</span>}
        <span className={cn('flex shrink-0 items-center gap-1 text-[14px] text-ink-2', !(!student && item.pending) && 'ml-auto')}>
          <UserRound className="size-4" />
          {count}
        </span>
      </div>
    </Card>
  );
}

/** 新建班级：照课堂派、Google Classroom，只起个名字；创建后进班级页，那里有加课码，学生自己加入 */
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
      title="新建课程"
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={create}>
            创建
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block text-[14px] text-ink">
          课程名称
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
  const active = list.filter((k) => !k.archived),
    archived = list.filter((k) => k.archived);
  const [creating, setCreating] = useState(false),
    [showArchived, setShowArchived] = useState(false);
  useCrumbs([{ label: '课程' }]);
  const grid = (items: ClassItem[]) => (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {items.map((k, i) => (
        <motion.div key={k.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
          <ClassCard item={k} student={student} />
        </motion.div>
      ))}
    </div>
  );
  // 扫码、点链接进来的直接打开加入框，加课码填好
  const [joining, setJoining] = useState(!!joinCode);
  const pill =
    'inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-4 text-[14px] text-ink-2 shadow-xs transition-colors hover:border-brand/50 hover:text-brand';
  return (
    <div>
      <div className="mb-5">
        <button type="button" onClick={() => (student ? setJoining(true) : setCreating(true))} className={pill}>
          <Plus className="size-4" />
          {student ? '加入课程' : '新建课程'}
        </button>
      </div>
      {classes.error ? (
        <ErrorState error={classes.error} onRetry={() => classes.refetch()} />
      ) : !classes.data ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <Skeleton className="h-60 rounded-lg" />
          <Skeleton className="h-60 rounded-lg" />
        </div>
      ) : !active.length ? (
        <Card padded={false}>
          <EmptyArt
            src="/illustrations/classes/empty-classes.webp"
            title={student ? '还没有加入课程' : '还没有课程'}
            action={
              student && (
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setJoining(true)}>
                  加入课程
                </Button>
              )
            }
          />
        </Card>
      ) : (
        grid(active)
      )}
      {archived.length > 0 && (
        <section className="mt-9">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
            className="mb-4 inline-flex items-center gap-1 text-[15px] text-ink-2 transition-colors hover:text-ink"
          >
            <ChevronRight className={cn('size-4 transition-transform', showArchived && 'rotate-90')} />
            已归档
            <span className="ml-1 text-ink-3">{archived.length}</span>
          </button>
          {showArchived && grid(archived)}
        </section>
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

/** 登录了的学生扫码、点链接（/join/加课码 转到 /classes/join/加课码）：打开加入框；老师打开就回班级 */
export function JoinPage() {
  const { code } = useParams();
  const role = useAuth((s) => s.user?.role);
  if (role !== 'student') return <Navigate replace to="/classes" />;
  return <ClassesPage joinCode={code} />;
}
