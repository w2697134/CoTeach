import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, useLocation } from 'react-router';
import { useAuth } from './lib/store';
import { AppShell } from './components/layout/AppShell';
import { Empty, PageLoading } from './components/ui';

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
const Register = page(() => import('./pages/Register'), 'RegisterPage');
const Admin = page(() => import('./pages/admin/Admin'), 'AdminPage');
const KnowledgeHome = page(() => import('./pages/kb/Home'), 'KnowledgeHomePage');
const KnowledgeBase = page(() => import('./pages/kb/KnowledgeBase'), 'KnowledgeBasePage');
const LegacyCourse = page(() => import('./pages/kb/LegacyCourse'), 'LegacyCoursePage');
const Classes = page(() => import('./pages/classes/Home'), 'ClassesPage');
const ClassDetail = page(() => import('./pages/classes/ClassPage'), 'ClassPage');
const JoinClass = page(() => import('./pages/classes/Home'), 'JoinPage');
const JoinLanding = page(() => import('./pages/classes/Landing'), 'JoinLandingPage');
const HomeworkDetail = page(() => import('./pages/classes/HomeworkPage'), 'HomeworkPage');
const HomeworkEdit = page(() => import('./pages/classes/HomeworkEdit'), 'HomeworkEditPage');
const Assistant = page(() => import('./pages/assistant/AssistantPage'), 'AssistantPage');
const Buddy = page(() => import('./pages/cot/BuddyPage'), 'BuddyPage');
const StudentChat = page(() => import('./pages/classes/StudentChat'), 'StudentChatPage');

function S({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageLoading />}>{children}</Suspense>;
}

/** 老师进来先到 CoT 助教（左边栏第一项），学生先到 CoT 学伴（2026-11-16）；知识库在左边栏最下面 */
function Start() {
  const role = useAuth((s) => s.user?.role);
  if (role !== 'teacher' && role !== 'admin' && role !== 'student') return <Empty title="这个账号没有可用的页面" />;
  return <Navigate replace to={role === 'student' ? '/cot' : '/assistant'} />;
}

/** 管理页只给管理员 */
function AdminOnly({ children }: { children: ReactNode }) {
  const role = useAuth((s) => s.user?.role);
  if (role !== 'admin') return <Navigate replace to="/classes" />;
  return <>{children}</>;
}

/** 学伴页只给学生；老师打开它的网址，带回 CoT 助教 */
function StudentOnly({ children }: { children: ReactNode }) {
  const role = useAuth((s) => s.user?.role);
  if (role !== 'student') return <Navigate replace to="/assistant" />;
  return <>{children}</>;
}

/** 知识库只给老师；学生打开知识库的网址，带回班级 */
function TeacherOnly({ children }: { children: ReactNode }) {
  const role = useAuth((s) => s.user?.role);
  if (role === 'student') return <Navigate replace to="/classes" />;
  return <>{children}</>;
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
    path: '/register',
    errorElement: <RouteError />,
    element: (
      <S>
        <Register />
      </S>
    ),
  },
  // 扫码、点加入链接打开的页面，不用先登录；没有加课码的先输码
  {
    path: '/join',
    errorElement: <RouteError />,
    element: (
      <S>
        <JoinLanding />
      </S>
    ),
  },
  {
    path: '/join/:code',
    errorElement: <RouteError />,
    element: (
      <S>
        <JoinLanding />
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
      { index: true, element: <Start /> },
      {
        path: 'assistant',
        element: (
          <S>
            <TeacherOnly><Assistant /></TeacherOnly>
          </S>
        ),
      },
      {
        path: 'cot',
        element: (
          <S>
            <StudentOnly><Buddy /></StudentOnly>
          </S>
        ),
      },
      {
        path: 'classes',
        element: (
          <S>
            <Classes />
          </S>
        ),
      },
      // 老师看一个学生跟 CoT 学伴说的
      {
        path: 'classes/:id/students/:sid/cot',
        element: (
          <S>
            <TeacherOnly><StudentChat /></TeacherOnly>
          </S>
        ),
      },
      {
        path: 'classes/:id',
        element: (
          <S>
            <ClassDetail />
          </S>
        ),
      },
      // 作业：布置、看、改（布置和改只有老师能进）
      {
        path: 'classes/:id/homework/new',
        element: (
          <S>
            <TeacherOnly><HomeworkEdit /></TeacherOnly>
          </S>
        ),
      },
      {
        path: 'classes/:id/homework/:hid',
        element: (
          <S>
            <HomeworkDetail />
          </S>
        ),
      },
      {
        path: 'classes/:id/homework/:hid/edit',
        element: (
          <S>
            <TeacherOnly><HomeworkEdit /></TeacherOnly>
          </S>
        ),
      },
      // 登录了的学生扫码、点链接：在班级页上打开加入框
      {
        path: 'classes/join/:code',
        element: (
          <S>
            <JoinClass />
          </S>
        ),
      },
      {
        path: 'c/:id',
        element: (
          <S>
            <TeacherOnly><LegacyCourse /></TeacherOnly>
          </S>
        ),
      },
      {
        path: 'admin',
        element: (
          <S>
            <AdminOnly><Admin /></AdminOnly>
          </S>
        ),
      },
      {
        path: 'knowledge',
        element: (
          <S>
            <TeacherOnly><KnowledgeHome /></TeacherOnly>
          </S>
        ),
      },
      {
        path: 'knowledge/:id',
        element: (
          <S>
            <TeacherOnly><KnowledgeBase /></TeacherOnly>
          </S>
        ),
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
