import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, useLocation } from 'react-router';
import { useAuth } from './lib/store';
import { AppShell } from './components/layout/AppShell';
import { PageLoading } from './components/ui';

export function RouteError() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface p-6 text-ink">
      <p role="alert">页面暂时无法显示</p>
      <div className="flex gap-4">
        <button onClick={() => window.location.reload()}>重新打开</button>
        <a href="/knowledge">返回知识库</a>
      </div>
    </main>
  );
}

const loaders: (() => Promise<unknown>)[] = [];
const page = <P extends object = {}>(loader: () => Promise<any>, name: string) => {
  // 同一页的代码只下载一次，没下成的下回再下
  let loading: Promise<any> | null = null;
  const load = () =>
    (loading ??= loader().catch((err) => {
      loading = null;
      throw err;
    }));
  loaders.push(load);
  return lazy<ComponentType<P>>(() => load().then((m) => ({ default: m[name] })));
};
/** 各页的代码先在后台下载好，点过去不用再等 */
export const preloadPages = () => loaders.forEach((load) => load().catch(() => {}));

const Login = page(() => import('./pages/Login'), 'LoginPage');
const Courses = page(() => import('./pages/Courses'), 'CoursesPage');
const KnowledgeBase = page(() => import('./pages/kb/KnowledgeBase'), 'KnowledgeBasePage');
const Libraries = page(() => import('./pages/kb/Libraries'), 'LibrariesPage');
const LegacyCourse = page(() => import('./pages/kb/Libraries'), 'LegacyCoursePage');

function S({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageLoading />}>{children}</Suspense>;
}

function RequireUser({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <PageLoading label="正在进入…" />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  return <>{children}</>;
}

export const router = createBrowserRouter([
  {
    path: '/login',
    errorElement: <RouteError />,
    element: (
      <S>
        <Login />
      </S>
    ),
  },
  {
    path: '/',
    errorElement: <RouteError />,
    element: (
      <RequireUser>
        <AppShell />
      </RequireUser>
    ),
    children: [
      {
        index: true,
        element: (
          <S>
            <Courses />
          </S>
        ),
      },
      {
        path: 'c/:id',
        element: (
          <S>
            <LegacyCourse />
          </S>
        ),
      },
      {
        path: 'knowledge',
        element: (
          <S>
            <Libraries />
          </S>
        ),
      },
      {
        path: 'knowledge/:id',
        element: (
          <S>
            <KnowledgeBase />
          </S>
        ),
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
