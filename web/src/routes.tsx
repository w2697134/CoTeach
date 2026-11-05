import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, useLocation } from 'react-router';
import { useAuth } from './lib/store';
import { AppShell } from './components/layout/AppShell';
import { PageLoading } from './components/ui';

const page = <P extends object = {}>(loader: () => Promise<any>, name: string) => lazy<ComponentType<P>>(() => loader().then(m => ({ default: m[name] })));

const Login = page(() => import('./pages/Login'), 'LoginPage');
const Courses = page(() => import('./pages/Courses'), 'CoursesPage');
const KnowledgeBase = page(() => import('./pages/kb/KnowledgeBase'), 'KnowledgeBasePage');

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
    element: (
      <S>
        <Login />
      </S>
    ),
  },
  {
    path: '/',
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
            <KnowledgeBase />
          </S>
        ),
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
