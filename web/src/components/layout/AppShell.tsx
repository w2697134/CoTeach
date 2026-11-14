import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { BookOpen, KeyRound, LogOut, Menu, Monitor, Moon, ShieldCheck, Smartphone, Sun, Users } from 'lucide-react';
import { APP_NAME, APP_SHORT_NAME } from '../../lib/brand';
import { post } from '../../lib/api';
import { toast, useAuth, useTheme, useUi } from '../../lib/store';
import { Avatar, Button, IconButton, Input, MenuItem, MenuLabel, Modal, Popover, cn } from '../ui';
import { useKnowledgeBases } from '../../pages/kb/data';

/** 现在打开的是哪个知识库（不在某个知识库里时为 null） */
const openKb = (pathname: string) => Number(pathname.match(/^\/knowledge\/(\d+)/)?.[1]) || null;

export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <img
      src="/logo.svg"
      alt=""
      width={size}
      height={size}
      className={cn('shrink-0 rounded-[10px] shadow-sm', className)}
      draggable={false}
    />
  );
}

/** 左边栏：上面是「班级」（往后的作业等也放上面）；老师的「知识库」固定在最下面。学生只有「班级」 */
function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const role = useAuth((s) => s.user?.role);
  const student = role === 'student',
    admin = role === 'admin';
  const bases = useKnowledgeBases(!student).data?.knowledgeBases || [];
  const pending = bases.reduce((n, k) => n + k.pending, 0);
  const item = (active: boolean) =>
    cn(
      'group relative flex h-9 items-center gap-3 rounded-md px-3 text-[14.5px] font-medium transition-colors',
      active ? 'bg-brand-soft text-brand-ink' : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
    );
  const mark = <motion.span layoutId="nav-indicator" className="absolute -left-3 top-1.5 h-6 w-[3px] rounded-r-full bg-brand" />;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center gap-3 px-4">
        <Logo size={34} />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-[17px] font-semibold tracking-tight text-ink" title={APP_NAME}>
            {APP_SHORT_NAME}
          </p>
          <p className="mt-0.5 text-[12.5px] text-ink-3">{student ? '学生' : '教师工作台'}</p>
        </div>
      </div>
      <nav className="no-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-4 pt-2">
        <NavLink to="/classes" onClick={onNavigate} className={({ isActive }) => item(isActive)}>
          {({ isActive }) => (
            <>
              {isActive && mark}
              <Users className={cn('size-[18px] shrink-0', isActive ? 'text-brand' : 'text-ink-3')} />
              <span className="min-w-0 flex-1">班级</span>
            </>
          )}
        </NavLink>
        {admin && (
          <NavLink to="/admin" onClick={onNavigate} className={({ isActive }) => item(isActive)}>
            {({ isActive }) => (
              <>
                {isActive && mark}
                <ShieldCheck className={cn('size-[18px] shrink-0', isActive ? 'text-brand' : 'text-ink-3')} />
                <span className="min-w-0 flex-1">管理</span>
              </>
            )}
          </NavLink>
        )}
      </nav>
      {!student && (
        <div className="shrink-0 border-t border-line px-3 py-3">
          <NavLink to="/knowledge" onClick={onNavigate} className={({ isActive }) => item(isActive)}>
            {({ isActive }) => (
              <>
                {isActive && mark}
                <BookOpen className={cn('size-[18px] shrink-0', isActive ? 'text-brand' : 'text-ink-3')} />
                <span className="min-w-0 flex-1">知识库</span>
                {pending > 0 && <span className="rounded-full bg-brand px-1.5 text-[11.5px] font-semibold text-white">{pending}</span>}
              </>
            )}
          </NavLink>
        </div>
      )}
    </div>
  );
}

function ThemeMenu() {
  const { pref, setPref, dark } = useTheme();
  return (
    <Popover
      trigger={({ toggle }) => (
        <IconButton label="外观" onClick={toggle}>
          {dark ? <Moon className="size-[18px]" /> : <Sun className="size-[18px]" />}
        </IconButton>
      )}
      width={168}
    >
      {(close) => (
        <>
          <MenuLabel>外观</MenuLabel>
          <MenuItem icon={<Sun />} active={pref === 'light'} onClick={() => (setPref('light'), close())}>
            浅色
          </MenuItem>
          <MenuItem icon={<Moon />} active={pref === 'dark'} onClick={() => (setPref('dark'), close())}>
            深色
          </MenuItem>
          <MenuItem icon={<Monitor />} active={pref === 'system'} onClick={() => (setPref('system'), close())}>
            跟随系统
          </MenuItem>
        </>
      )}
    </Popover>
  );
}

/** 改密码：原密码、新密码；改完别处登着的会退出 */
function PasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [old, setOld] = useState(''),
    [fresh, setFresh] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const close = () => {
    if (busy) return;
    setOld('');
    setFresh('');
    setError('');
    onClose();
  };
  const save = async () => {
    if (!old || !fresh || busy) return;
    setBusy(true);
    setError('');
    try {
      await post('/auth/password', { old, password: fresh });
      toast.success('密码改好了');
      setBusy(false);
      setOld('');
      setFresh('');
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title="修改密码"
      width={400}
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!old || !fresh} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block text-[14px] text-ink">
          原密码
          <Input autoFocus type="password" className="mt-1.5" value={old} autoComplete="current-password" onChange={(e) => setOld(e.target.value)} />
        </label>
        <label className="block text-[14px] text-ink">
          新密码
          <Input
            type="password"
            className="mt-1.5"
            value={fresh}
            placeholder="至少 6 位"
            autoComplete="new-password"
            onChange={(e) => setFresh(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
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

/** 演示老师设成自己的正式账号：手机号、姓名、密码；设好以后用手机号登录，里面的东西都还在 */
function ClaimModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, adopt } = useAuth();
  const [phone, setPhone] = useState(''),
    [name, setName] = useState(user?.name || ''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const save = async () => {
    if (!phone.trim() || !name.trim() || !password || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await post<{ user: NonNullable<typeof user> }>('/auth/claim', { phone, name, password });
      await adopt(r.user);
      toast.success('设好了，以后用手机号登录');
      setBusy(false);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="设置手机号和密码"
      width={420}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!phone.trim() || !name.trim() || !password} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block text-[14px] text-ink">
          手机号
          <Input autoFocus className="mt-1.5" inputMode="tel" value={phone} maxLength={20} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label className="block text-[14px] text-ink">
          姓名
          <Input className="mt-1.5" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block text-[14px] text-ink">
          密码
          <Input type="password" className="mt-1.5" value={password} placeholder="至少 6 位" autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
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

function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [changing, setChanging] = useState(false),
    [claiming, setClaiming] = useState(false);
  if (!user) return null;
  return (
    <>
    <Popover
      width={220}
      trigger={({ toggle }) => (
        <button onClick={toggle} className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2.5 transition-colors hover:bg-surface-3">
          <Avatar name={user.name} seed={user.id} size={30} />
          <span className="hidden text-left leading-tight md:block">
            <span className="block text-[14px] font-medium text-ink">{user.name}</span>
            <span className="block text-[12.5px] text-ink-3">{user.role === 'student' ? '学生' : user.role === 'admin' ? '管理员' : user.title || '教师'}</span>
          </span>
        </button>
      )}
    >
      {(close) => (
        <>
          {!user.isDemo && (
            <MenuItem
              icon={<KeyRound />}
              onClick={() => {
                close();
                setChanging(true);
              }}
            >
              修改密码
            </MenuItem>
          )}
          {user.isDemo && user.role === 'teacher' && (
            <MenuItem
              icon={<Smartphone />}
              onClick={() => {
                close();
                setClaiming(true);
              }}
            >
              设置手机号和密码
            </MenuItem>
          )}
          <MenuItem
            icon={<LogOut />}
            danger
            onClick={async () => {
              close();
              await logout();
              navigate('/login');
            }}
          >
            退出登录
          </MenuItem>
        </>
      )}
    </Popover>
    <PasswordModal open={changing} onClose={() => setChanging(false)} />
    {user.isDemo && <ClaimModal open={claiming} onClose={() => setClaiming(false)} />}
    </>
  );
}

export function AppShell() {
  const { mobileNav, setMobileNav } = useUi();
  const location = useLocation();
  // 手机上左边栏收起来了，现在在哪写在最上面：某个知识库里写它的名字，最外层写「知识库」；班级那边写「班级」
  const student = useAuth((s) => s.user?.role) === 'student';
  const kbId = openKb(location.pathname);
  const kbName = useKnowledgeBases(!student).data?.knowledgeBases.find((k) => k.id === kbId)?.name;
  const title = kbId ? kbName : /^\/knowledge\/?$/.test(location.pathname) ? '知识库' : /^\/classes(\/|$)/.test(location.pathname) ? '班级' : undefined;
  useEffect(() => setMobileNav(false), [location.pathname, setMobileNav]);
  // 知识库页面占满整屏高度，自己管滚动；班级页面是普通页面
  const full = location.pathname.startsWith('/c/') || /^\/knowledge(\/|$)/.test(location.pathname);
  return (
    <div className="min-h-screen bg-bg">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] border-r border-line bg-surface lg:block">
        <Sidebar />
      </aside>
      <AnimatePresence>
        {mobileNav && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <motion.div
              className="absolute inset-0 bg-[var(--c-overlay)]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileNav(false)}
            />
            <motion.aside
              className="absolute inset-y-0 left-0 w-[264px] border-r border-line bg-surface shadow-lg"
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: 'spring', stiffness: 380, damping: 36 }}
            >
              <Sidebar onNavigate={() => setMobileNav(false)} />
            </motion.aside>
          </div>
        )}
      </AnimatePresence>
      <div className="lg:pl-[248px]">
        <header className="glass sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line px-4 sm:px-6">
          <IconButton className="shrink-0 lg:hidden" label="菜单" onClick={() => setMobileNav(true)}>
            <Menu className="size-5" />
          </IconButton>
          {title && <p className="min-w-0 truncate text-[16px] font-semibold tracking-tight text-ink lg:hidden">{title}</p>}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <ThemeMenu />
            <UserMenu />
          </div>
        </header>
        <main
          className={cn(
            'mx-auto w-full',
            full ? 'h-[calc(100dvh-4rem)] max-w-[1680px] px-3 py-3 sm:px-4' : 'max-w-[1200px] px-4 py-6 sm:px-6 lg:px-10 lg:py-8',
          )}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
