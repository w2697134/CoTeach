import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Eye, EyeOff } from 'lucide-react';
import { ApiError, get, post } from '../../lib/api';
import { APP_NAME, APP_SHORT_NAME } from '../../lib/brand';
import { toast, useAuth, useTheme, type User } from '../../lib/store';
import { Logo } from '../../components/layout/AppShell';
import { Button, Input, PageLoading, Skeleton } from '../../components/ui';
import { normalCode, type ClassPeek } from './data';
import { themeBackground, themeOf } from './look';

/**
 * 扫码、点链接、输加课码打开的加入页，不用先登录（照课堂派、雨课堂的加入页，手机上用得多）。
 * 上面是这个班的彩色头（跟班级卡片一样，窄卡片上不放插图，免得字压在画上），下面没账号的填学号、姓名、设密码，注册加入一步做完；有账号的切到登录。
 * 已经登录的学生转到班级页的加入框，老师回班级。
 */
export function JoinLandingPage() {
  const { code: raw = '' } = useParams();
  const { user, ready } = useAuth();
  // 在这页上刚注册、登录的，由这页自己带去班级，不走下面的转向
  const [leaving, setLeaving] = useState(false);
  useTheme();
  if (!ready) return <PageLoading label="正在打开…" />;
  const code = normalCode(raw);
  if (user && !leaving) return <Navigate replace to={user.role === 'student' && code ? `/classes/join/${code}` : '/classes'} />;
  return (
    <div className="min-h-screen bg-bg">
      <header className="flex items-center gap-3 px-5 py-4 sm:px-8 sm:py-6">
        <Logo size={34} />
        <div className="leading-tight">
          <p className="text-[18px] font-bold tracking-tight text-ink">{APP_SHORT_NAME}</p>
          <p className="text-[13px] text-ink-3">{APP_NAME}</p>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[440px] px-5 pb-16 pt-2 sm:pt-8">
        <Landing code={code} onLeaving={() => setLeaving(true)} />
      </main>
    </div>
  );
}

function Landing({ code, onLeaving }: { code: string; onLeaving: () => void }) {
  const peek = useQuery({
    queryKey: ['class-join', 'open', code],
    queryFn: () => get<ClassPeek>(`/classes/join/${code}`),
    enabled: code.length === 6,
    retry: false,
  });
  if (code.length !== 6 || peek.error) return <CodeForm initial={code} error={peek.error ? (peek.error as Error).message : ''} />;
  if (!peek.data) return <Skeleton className="h-64 rounded-xl" />;
  return <JoinForm k={peek.data} code={code} onLeaving={onLeaving} />;
}

/** 只知道加课码（老师念的、写在黑板上的）：先输码 */
function CodeForm({ initial, error }: { initial: string; error: string }) {
  const navigate = useNavigate();
  const [code, setCode] = useState(initial);
  const c = normalCode(code);
  const next = (e: FormEvent) => {
    e.preventDefault();
    if (c.length === 6) navigate(`/join/${c}`, { replace: true });
  };
  return (
    <form onSubmit={next} className="rounded-xl border border-line bg-surface p-6 shadow-xs sm:p-8">
      <h1 className="text-[24px] font-semibold tracking-tight text-ink">加入班级</h1>
      <label className="mt-6 block text-[14px] text-ink">
        加课码
        <Input
          autoFocus
          sizeVariant="lg"
          className="mt-1.5 font-mono text-[18px] uppercase tracking-[0.3em]"
          value={code}
          maxLength={8}
          autoComplete="off"
          onChange={(e) => setCode(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="mt-3 text-[14px] text-bad">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" block className="mt-6" disabled={c.length !== 6} iconRight={<ArrowRight className="size-4" />}>
        下一步
      </Button>
      <p className="mt-5 text-center text-[14px] text-ink-3">
        <Link to="/login" className="text-brand hover:underline">
          登录
        </Link>
      </p>
    </form>
  );
}

/** 看到是哪个班以后：第一次来的注册加入，有账号的登录加入 */
function JoinForm({ k, code, onLeaving }: { k: ClassPeek; code: string; onLeaving: () => void }) {
  const navigate = useNavigate();
  const { login, adopt } = useAuth();
  const [mode, setMode] = useState<'new' | 'login'>('new');
  const [no, setNo] = useState(''),
    [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [show, setShow] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const fresh = mode === 'new';
  const ready = !!no.trim() && !!password && (!fresh || !!name.trim());
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError('');
    try {
      if (fresh) {
        const r = await post<{ id: number; name: string; user: User }>('/classes/join/register', { code, studentNo: no.trim(), name, password });
        onLeaving();
        await adopt(r.user);
        toast.success(`已加入「${r.name}」`);
        navigate(`/classes/${r.id}`, { replace: true });
        return;
      }
      onLeaving();
      const u = await login(no.trim(), password);
      if (u.role !== 'student') return navigate('/classes', { replace: true });
      // 账号上有学号的直接加入；对不上名单之类的，到班级页的加入框里补
      try {
        if (!u.studentNo) throw new Error();
        const r = await post<{ id: number; name: string }>('/classes/join', { code, studentNo: u.studentNo, name: u.name });
        toast.success(`已加入「${r.name}」`);
        navigate(`/classes/${r.id}`, { replace: true });
      } catch {
        navigate(`/classes/join/${code}`, { replace: true });
      }
    } catch (err) {
      // 学号注册过了：换到登录，学号留着
      if (err instanceof ApiError && err.code === 'registered') {
        setMode('login');
        setPassword('');
      }
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const swap = () => {
    setMode(fresh ? 'login' : 'new');
    setError('');
    setPassword('');
  };
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
      <div className="flex min-h-36 flex-col justify-end px-6 pb-5 pt-8 text-white" style={themeBackground(themeOf(k.id))}>
        <h1 className="break-words text-[24px] font-semibold leading-tight tracking-tight">{k.name}</h1>
        <p className="mt-1 text-[15px] text-white/90">{k.teacher}</p>
      </div>
      {!k.open ? (
        <div className="px-6 py-8 text-center">
          <p className="text-[15px] text-ink-2">{k.archived ? '这个班已经归档了，不能再加入' : '这个班已经停止加入了，问问老师'}</p>
          <p className="mt-5 text-[14px]">
            <Link to="/login" className="text-brand hover:underline">
              登录
            </Link>
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4 px-6 pb-6 pt-5">
          <label className="block text-[14px] text-ink">
            学号
            <Input sizeVariant="lg" className="mt-1.5" value={no} maxLength={40} autoComplete="username" onChange={(e) => setNo(e.target.value)} />
          </label>
          {fresh && (
            <label className="block text-[14px] text-ink">
              姓名
              <Input sizeVariant="lg" className="mt-1.5" value={name} maxLength={40} autoComplete="name" onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          <label className="block text-[14px] text-ink">
            {fresh ? '设置密码' : '密码'}
            <Input
              sizeVariant="lg"
              className="mt-1.5"
              type={show ? 'text' : 'password'}
              value={password}
              maxLength={128}
              placeholder={fresh ? '至少 6 位' : undefined}
              autoComplete={fresh ? 'new-password' : 'current-password'}
              onChange={(e) => setPassword(e.target.value)}
              suffix={
                <button type="button" className="rounded p-1 hover:bg-surface-3" onClick={() => setShow(!show)} aria-label={show ? '隐藏密码' : '显示密码'}>
                  {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              }
            />
          </label>
          {error && (
            <p role="alert" className="text-[14px] text-bad">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!ready}>
            {fresh ? '加入班级' : '登录并加入'}
          </Button>
          <p className="text-center text-[14px] text-ink-3">
            {fresh ? '已经有账号？' : '第一次来？'}
            <button type="button" onClick={swap} className="text-brand hover:underline">
              {fresh ? '登录' : '注册并加入'}
            </button>
          </p>
        </form>
      )}
    </div>
  );
}
