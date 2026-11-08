import { create } from 'zustand';
import { get, post, setUnauthorizedHandler } from './api';

export type Role = 'admin' | 'teacher' | 'student';

export interface User {
  id: number;
  username: string;
  name: string;
  role: Role;
  avatar: string | null;
  gender: string | null;
  email: string | null;
  phone: string | null;
  studentNo: string | null;
  title: string | null;
  bio: string | null;
  isDemo: boolean;
  isSuper: boolean;
  settings: Record<string, any>;
  /** 登录后先打开的知识库（老师最早的那个） */
  kbId?: number | null;
}

interface AuthState {
  user: User | null;
  ready: boolean;
  load: () => Promise<void>;
  login: (username: string, password: string) => Promise<User>;
  demo: (role: Role) => Promise<User>;
  logout: () => Promise<void>;
}

let authLoadVersion = 0;
export const useAuth = create<AuthState>((set, getState) => ({
  user: null,
  ready: false,
  async load() {
    const version = ++authLoadVersion;
    try {
      const r = await get<{ user: User | null }>('/auth/me');
      if (version === authLoadVersion) set({ user: r.user, ready: true });
    } catch {
      if (version === authLoadVersion) set({ user: null, ready: true });
    }
  },
  async login(username, password) {
    authLoadVersion++;
    const r = await post<{ user: User }>('/auth/login', { username, password });
    set({ user: r.user });
    await getState().load();
    return r.user;
  },
  async demo(role) {
    authLoadVersion++;
    const r = await post<{ user: User }>('/auth/demo', { role });
    set({ user: r.user });
    await getState().load();
    return r.user;
  },
  async logout() {
    authLoadVersion++;
    await post('/auth/logout').catch(() => {});
    set({ user: null });
  },
}));

setUnauthorizedHandler(() => {
  const s = useAuth.getState();
  if (s.user) {
    useAuth.setState({ user: null });
    toast.info('登录已过期，请重新登录');
  }
});

/* ---------------- 主题 ---------------- */
type ThemePref = 'light' | 'dark' | 'system';
interface ThemeState {
  pref: ThemePref;
  dark: boolean;
  setPref: (p: ThemePref) => void;
}
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function resolveDark(p: ThemePref) {
  return p === 'dark' || (p === 'system' && !!media?.matches);
}
function readPref(): ThemePref {
  try {
    return (localStorage.getItem('ct-theme') as ThemePref) || 'light';
  } catch {
    return 'light';
  }
}
export const useTheme = create<ThemeState>((set) => ({
  pref: readPref(),
  dark: resolveDark(readPref()),
  setPref(p) {
    try {
      localStorage.setItem('ct-theme', p);
    } catch {
      /* 隐私模式 */
    }
    const dark = resolveDark(p);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    set({ pref: p, dark });
  },
}));
media?.addEventListener('change', () => {
  const s = useTheme.getState();
  if (s.pref === 'system') s.setPref('system');
});

/* ---------------- 提示消息 ---------------- */
export interface ToastItem {
  id: number;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  desc?: string;
  action?: { label: string; onClick: () => void };
}
interface ToastState {
  items: ToastItem[];
  push: (t: Omit<ToastItem, 'id'>, ms?: number) => number;
  dismiss: (id: number) => void;
}
let tid = 0;
export const useToasts = create<ToastState>((set, getState) => ({
  items: [],
  push(t, ms = 3800) {
    const id = ++tid;
    set((s) => ({ items: [...s.items.slice(-4), { ...t, id }] }));
    if (ms > 0) setTimeout(() => getState().dismiss(id), ms);
    return id;
  },
  dismiss(id) {
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },
}));

export const toast = {
  success: (title: string, desc?: string) => useToasts.getState().push({ type: 'success', title, desc }),
  error: (title: string, desc?: string) => useToasts.getState().push({ type: 'error', title, desc }, 5200),
  info: (title: string, desc?: string) => useToasts.getState().push({ type: 'info', title, desc }),
  warning: (title: string, desc?: string) => useToasts.getState().push({ type: 'warning', title, desc }, 5000),
  fromError: (err: unknown, fallback = '操作失败') =>
    (err as Error)?.name === 'AbortError' ? undefined : useToasts.getState().push({ type: 'error', title: (err as Error)?.message || fallback }, 5200),
};

/* ---------------- 界面偏好 ---------------- */
interface UiState {
  collapsed: boolean;
  toggle: () => void;
  mobileNav: boolean;
  setMobileNav: (v: boolean) => void;
}
export const useUi = create<UiState>((set) => ({
  collapsed: (() => {
    try {
      return localStorage.getItem('ct-collapsed') === '1';
    } catch {
      return false;
    }
  })(),
  toggle: () =>
    set((s) => {
      try {
        localStorage.setItem('ct-collapsed', s.collapsed ? '0' : '1');
      } catch {
        /* ignore */
      }
      return { collapsed: !s.collapsed };
    }),
  mobileNav: false,
  setMobileNav: (v) => set({ mobileNav: v }),
}));
