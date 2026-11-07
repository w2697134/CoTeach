import { useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, LayoutGrid, LogOut, Menu, Monitor, Moon, Sun } from 'lucide-react';
import { get } from '../../lib/api';
import { APP_NAME, APP_SHORT_NAME } from '../../lib/brand';
import { useAuth, useTheme, useUi } from '../../lib/store';
import { Avatar, IconButton, MenuItem, MenuLabel, Popover, cn } from '../ui';
import { useKnowledgeBases, usePrefetchKb } from '../../pages/kb/data';
import { whenIdle } from '../../lib/idle';

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

export interface CourseItem {
  id: number;
  name: string;
  description: string | null;
  kbId: number;
  pending: number;
}

export const useCourses = () =>
  useQuery({
    queryKey: ['courses'],
    queryFn: () => get<{ courses: CourseItem[] }>('/courses'),
  });

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const courses = (useKnowledgeBases().data?.knowledgeBases || []).filter((k) => k.kind === 'class');
  const prefetch = usePrefetchKb();
  const item = (active: boolean) =>
    cn(
      'group relative flex h-9 items-center gap-3 rounded-md px-3 text-[14.5px] font-medium transition-colors',
      active ? 'bg-brand-soft text-brand-ink' : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
    );
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center gap-3 px-4">
        <Logo size={34} />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-[17px] font-semibold tracking-tight text-ink" title={APP_NAME}>
            {APP_SHORT_NAME}
          </p>
          <p className="mt-0.5 text-[12.5px] text-ink-3">教师工作台</p>
        </div>
      </div>
      <nav className="no-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4 pt-2">
        <NavLink to="/" end onClick={onNavigate} className={({ isActive }) => item(isActive)}>
          <LayoutGrid className="size-[18px] shrink-0 text-ink-3" />
          我的课程
        </NavLink>
        <NavLink to="/knowledge" end onClick={onNavigate} className={({ isActive }) => item(isActive)}>
          <BookOpen className="size-[18px] shrink-0 text-ink-3" />
          我的知识库
        </NavLink>
        {courses.length > 0 && (
          <div>
            <p className="mb-1.5 px-3 text-[12.5px] font-medium tracking-wider text-ink-3">班级</p>
            <div className="space-y-0.5">
              {courses.map((c) => (
                <NavLink
                  key={c.id}
                  to={`/knowledge/${c.id}`}
                  onClick={onNavigate}
                  onPointerEnter={() => prefetch(c.id)}
                  onFocus={() => prefetch(c.id)}
                  className={({ isActive }) => cn(item(isActive), 'h-auto min-h-12 py-2')}
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <motion.span layoutId="nav-indicator" className="absolute -left-3 top-1.5 h-6 w-[3px] rounded-r-full bg-brand" />
                      )}
                      <BookOpen className={cn('size-[18px] shrink-0', isActive ? 'text-brand' : 'text-ink-3')} />
                      <span className="min-w-0 flex-1 break-words">
                        <span className="block">{c.name}</span>
                        <span className="mt-0.5 block text-[12px] font-normal text-ink-3">{c.term}</span>
                      </span>
                      {c.pending > 0 && (
                        <span className="rounded-full bg-brand px-1.5 text-[11.5px] font-semibold text-white">{c.pending}</span>
                      )}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        )}
      </nav>
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

function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  return (
    <Popover
      width={220}
      trigger={({ toggle }) => (
        <button onClick={toggle} className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2.5 transition-colors hover:bg-surface-3">
          <Avatar name={user.name} seed={user.id} size={30} />
          <span className="hidden text-left leading-tight md:block">
            <span className="block text-[14px] font-medium text-ink">{user.name}</span>
            <span className="block text-[12.5px] text-ink-3">{user.title || '教师'}</span>
          </span>
        </button>
      )}
    >
      {(close) => (
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
      )}
    </Popover>
  );
}

export function AppShell() {
  const { mobileNav, setMobileNav } = useUi();
  const location = useLocation();
  useEffect(() => setMobileNav(false), [location.pathname, setMobileNav]);
  // 长期知识库最常去：这页画好后，在后台把它头一眼要看的取好
  const teacherKb = useKnowledgeBases().data?.knowledgeBases.find((k) => k.kind === 'teacher')?.id;
  const prefetchKb = usePrefetchKb();
  useEffect(() => (teacherKb ? whenIdle(() => prefetchKb(teacherKb)) : undefined), [teacherKb, prefetchKb]);
  // 知识库页面要占满整屏高度，自己管滚动
  const full = location.pathname.startsWith('/c/') || /^\/knowledge\/\d+/.test(location.pathname);
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
