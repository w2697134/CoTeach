import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { ArrowRight, Eye, EyeOff, Lock, Phone, User as UserIcon } from 'lucide-react';
import { ApiError, post } from '../lib/api';
import { toast, useAuth, type User } from '../lib/store';
import { Button, Input, PageLoading, cn } from '../components/ui';
import { normalCode } from './classes/data';
import { AuthShell, usePublicConfig } from './Login';

/**
 * 注册（照课堂派）：先选「我是老师」还是「我是学生」。
 * 老师填手机号、姓名、密码，注册完直接进去；学生输老师给的加课码，到加入页上填学号、姓名、密码，注册和进班一起做完。
 */
export function RegisterPage() {
  const { user, ready, adopt } = useAuth();
  const cfg = usePublicConfig();
  const navigate = useNavigate();
  const [who, setWho] = useState<'teacher' | 'student'>('teacher');
  const [phone, setPhone] = useState(''),
    [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [show, setShow] = useState(false),
    [code, setCode] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [done, setDone] = useState(false);
  if (!ready) return <PageLoading label="正在打开…" />;
  // 刚在这里注册好的自己带去班级；别的已经登录的回首页
  if (user && !done) return <Navigate replace to="/" />;
  const c = normalCode(code);
  const ok = !!phone.trim() && !!name.trim() && !!password;
  const signUp = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !ok) return;
    setBusy(true);
    setError('');
    try {
      const r = await post<{ user: User }>('/auth/register', { phone, name, password });
      setDone(true);
      await adopt(r.user);
      toast.success('注册好了，以后用手机号登录');
      navigate('/classes', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'registered' ? '这个手机号已经注册过了，直接登录就行' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const next = (e: FormEvent) => {
    e.preventDefault();
    if (c.length === 6) navigate(`/join/${c}`);
  };
  const closed = cfg && !cfg.teacherSignup;
  return (
    <AuthShell>
      <h2 className="text-[26px] font-bold tracking-tight text-ink">注册</h2>
      <div className="mt-6 flex rounded-xl bg-surface-3 p-1 text-[15px]">
        {(
          [
            ['teacher', '我是老师'],
            ['student', '我是学生'],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => (setWho(v), setError(''))}
            className={cn('h-10 flex-1 rounded-lg transition-colors', who === v ? 'bg-surface font-medium text-ink shadow-xs' : 'text-ink-3 hover:text-ink-2')}
          >
            {label}
          </button>
        ))}
      </div>
      {who === 'teacher' ? (
        closed ? (
          <p className="mt-6 rounded-xl border border-line bg-surface px-4 py-5 text-center text-[15px] text-ink-2">老师注册暂未开放</p>
        ) : (
          <form onSubmit={signUp} className="mt-6 space-y-3.5">
            <Input
              sizeVariant="lg"
              icon={<Phone />}
              placeholder="手机号"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              maxLength={20}
              onChange={(e) => setPhone(e.target.value)}
            />
            <Input sizeVariant="lg" icon={<UserIcon />} placeholder="姓名" autoComplete="name" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} />
            <Input
              sizeVariant="lg"
              icon={<Lock />}
              type={show ? 'text' : 'password'}
              placeholder="密码，至少 6 位"
              autoComplete="new-password"
              value={password}
              maxLength={128}
              onChange={(e) => setPassword(e.target.value)}
              suffix={
                <button type="button" className="rounded p-1 hover:bg-surface-3" onClick={() => setShow(!show)} aria-label={show ? '隐藏密码' : '显示密码'}>
                  {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              }
            />
            {error && (
              <p role="alert" className="text-[14px] text-bad">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!ok} iconRight={<ArrowRight className="size-4" />}>
              注册
            </Button>
          </form>
        )
      ) : (
        <form onSubmit={next} className="mt-6 space-y-3.5">
          <Input
            sizeVariant="lg"
            placeholder="老师给的加课码"
            className="font-mono uppercase tracking-[0.2em] placeholder:font-sans placeholder:tracking-normal placeholder:normal-case"
            autoComplete="off"
            value={code}
            maxLength={8}
            onChange={(e) => setCode(e.target.value)}
          />
          <Button type="submit" variant="primary" size="lg" block disabled={c.length !== 6} iconRight={<ArrowRight className="size-4" />}>
            下一步
          </Button>
        </form>
      )}
      <p className="mt-6 text-center text-[14px] text-ink-3">
        已有账号？
        <Link to="/login" className="text-brand hover:underline">
          登录
        </Link>
      </p>
    </AuthShell>
  );
}
