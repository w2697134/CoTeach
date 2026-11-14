import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ArrowRight, Eye, EyeOff, Lock, User as UserIcon, Users2 } from 'lucide-react';
import { get } from '../lib/api';
import { APP_NAME, APP_SHORT_NAME, HOST_ART, HOST_NAME } from '../lib/brand';
import { toast, useAuth, useTheme } from '../lib/store';
import { Logo } from '../components/layout/AppShell';
import { AgentAvatar, Button, Input, cn } from '../components/ui';

interface PublicConfig {
  demoMode: boolean;
  demoAccounts: { role: 'teacher' | 'student'; username: string; label: string; name: string }[];
}

export function LoginPage() {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const { login, demo } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  useTheme();

  useEffect(() => {
    get<PublicConfig>('/auth/config')
      .then(setCfg)
      .catch(() => {});
  }, []);

  const go = () => {
    const next = params.get('next');
    navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username || !password) return toast.warning('请输入账号和密码');
    setLoading('form');
    try {
      await login(username.trim(), password);
      go();
    } catch (err) {
      toast.fromError(err, '登录失败');
    } finally {
      setLoading(null);
    }
  };

  const quick = async (role: 'teacher' | 'student') => {
    setLoading(role);
    try {
      await demo(role);
      go();
    } catch (err) {
      toast.fromError(err);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-bg lg:grid lg:grid-cols-[1.15fr_1fr]">
      <section className="relative hidden overflow-hidden lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col">
        <div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_10%_0%,#e0e7ff_0%,transparent_60%),radial-gradient(900px_500px_at_100%_100%,#ccfbf1_0%,transparent_55%),linear-gradient(160deg,#f5f3ff,#eef2ff_45%,#ecfeff)] dark:bg-[radial-gradient(1000px_600px_at_10%_0%,rgba(99,102,241,.22)_0%,transparent_60%),radial-gradient(900px_500px_at_100%_100%,rgba(13,148,136,.18)_0%,transparent_55%),linear-gradient(160deg,#0d1020,#0b1120)]" />
        <div className="bg-dots absolute inset-0 opacity-50" />
        <div className="relative z-10 flex items-center gap-3 px-12 pt-10">
          <Logo size={40} />
          <div className="leading-tight">
            <p className="text-[20px] font-bold tracking-tight text-ink">{APP_SHORT_NAME}</p>
            <p className="text-[13px] text-ink-3">{APP_NAME}</p>
          </div>
        </div>
        <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-10 pb-12 pt-8">
          <img
            src="/illustrations/login-hero.webp"
            alt="AI 智能体与师生协同教学插画"
            className="h-full max-h-[560px] w-auto rounded-[28px] object-contain shadow-[0_30px_80px_-30px_rgba(79,70,229,.45)] ring-1 ring-white/60 dark:ring-white/10"
            draggable={false}
          />
        </div>
      </section>

      <section className="flex min-h-screen flex-col px-6 py-8 sm:px-10">
        <div className="flex items-center gap-3 lg:hidden">
          <Logo size={36} />
          <div className="leading-tight">
            <p className="text-[18px] font-bold tracking-tight text-ink">{APP_SHORT_NAME}</p>
            <p className="text-[12.5px] text-ink-3">{APP_NAME}</p>
          </div>
        </div>
        <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center py-10">
          <div className="flex items-center gap-4">
            <img src={HOST_ART} alt="" className="h-24 w-auto motion-safe:animate-float" draggable={false} />
            <div>
              <h2 className="text-[26px] font-bold tracking-tight text-ink">你好，我是 {HOST_NAME}</h2>
              <p className="mt-1 text-[15px] text-ink-2">登录后我带你开始。</p>
            </div>
          </div>
          <form onSubmit={submit} className="mt-7 space-y-3.5">
            <Input sizeVariant="lg" icon={<UserIcon />} placeholder="账号" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" />
            <Input
              sizeVariant="lg"
              icon={<Lock />}
              type={show ? 'text' : 'password'}
              placeholder="密码"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              suffix={
                <button type="button" className="rounded p-1 hover:bg-surface-3" onClick={() => setShow(!show)} aria-label={show ? '隐藏密码' : '显示密码'}>
                  {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              }
            />
            <Button type="submit" variant="primary" size="lg" block loading={loading === 'form'} iconRight={<ArrowRight className="size-4" />}>
              登录
            </Button>
          </form>

          {cfg?.demoMode && cfg.demoAccounts.length > 0 && (
            <div className="mt-9">
              <div className="mb-3 flex items-center gap-3 text-[13px] text-ink-3">
                <div className="h-px flex-1 bg-line" />
                <span>演示账号</span>
                <div className="h-px flex-1 bg-line" />
              </div>
              {cfg.demoAccounts.map(d => (
                <button
                  key={d.role}
                  onClick={() => quick(d.role)}
                  disabled={!!loading}
                  className={cn(
                    'group mt-2.5 flex w-full items-center gap-3.5 rounded-xl border border-line bg-surface px-4 py-3 text-left shadow-xs transition-all first-of-type:mt-0 hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md disabled:opacity-60',
                    loading === d.role && 'border-brand/50',
                  )}
                >
                  <AgentAvatar agent={{ key: 'orchestrator' }} size={40} status={loading === d.role ? 'running' : null} />
                  <p className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-ink">
                    <Users2 className="size-4 text-ink-3" />
                    {d.label} · {d.name}
                  </p>
                  <ArrowRight className="size-4 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-brand" />
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
