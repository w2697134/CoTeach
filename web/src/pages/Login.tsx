import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ArrowRight, Eye, EyeOff, KeyRound, Lock, User as UserIcon, Users2 } from 'lucide-react';
import { get } from '../lib/api';
import { APP_NAME, APP_SHORT_NAME, HOST_ART, HOST_NAME } from '../lib/brand';
import { toast, useAuth, useTheme } from '../lib/store';
import { Logo } from '../components/layout/AppShell';
import { AgentAvatar, Button, Input, Modal, Tabs, cn } from '../components/ui';

export interface PublicConfig {
  demoMode: boolean;
  demoAccounts: { role: 'teacher' | 'student'; username: string; label: string; name: string }[];
  teacherSignup: boolean;
  /** 只开放给指定账号（比赛期间）：不显示注册 */
  loginOnly?: boolean;
  /** 有号发了登录密钥：登录页上多一个「登录密钥」 */
  keyLogin?: boolean;
  /** 账号密码登录开着没有（关了就只能用密钥，比赛期间） */
  passwordLogin?: boolean;
}

/** 上次用的是账号密码还是密钥，下回打开还是那个；没用过就先密钥 */
type Mode = 'password' | 'key';
const MODE = 'ct-login-mode';
function savedMode(): Mode {
  try {
    return localStorage.getItem(MODE) === 'password' ? 'password' : 'key';
  } catch {
    return 'key';
  }
}
export const usePublicConfig = () => {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  useEffect(() => {
    get<PublicConfig>('/auth/config')
      .then(setCfg)
      .catch(() => {});
  }, []);
  return cfg;
};

/** 登录、注册共用的外框：左边插图，右边窄窄一栏 */
export function AuthShell({ children }: { children: ReactNode }) {
  useTheme();
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
            <p className="text-[13px] text-ink-3">{APP_NAME}</p>
          </div>
        </div>
        <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center py-10">{children}</div>
      </section>
    </div>
  );
}

/** 忘记密码：没有短信和邮箱，学生找老师、老师找管理员重置 */
function Forgot({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="忘记密码"
      width={400}
      footer={
        <Button variant="primary" onClick={onClose}>
          知道了
        </Button>
      }
    >
      <ul className="space-y-2.5 text-[15px] leading-relaxed text-ink-2">
        <li>
          <span className="font-medium text-ink">学生：</span>找任课老师，在课程的「成员」里帮你重置
        </li>
        <li>
          <span className="font-medium text-ink">老师：</span>找管理员重置
        </li>
      </ul>
    </Modal>
  );
}

/**
 * 登录：手机号（老师）或学号（学生）加密码。下面「忘记密码」「注册账号」。
 * 有号发了登录密钥时，上面分两栏，「登录密钥」在前、默认先开它：贴上密钥就进对应的号，不用输账号密码。
 * 账号密码登录关了的时候，「账号密码」那一栏只写暂未开放，不显示注册。
 * 演示账号不在登录页上露出来，网址带 ?demo 才显示（给自己演示、把演示老师设成正式账号用）。
 */
export function LoginPage() {
  const cfg = usePublicConfig();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(savedMode);
  const [key, setKey] = useState('');
  const { login, demo, keyLogin } = useAuth();
  /** 账号密码登录关了（比赛期间）：只留密钥，「账号密码」那一栏显示暂未开放 */
  const pwOff = cfg?.passwordLogin === false;
  const tabs = !!cfg?.keyLogin || pwOff;
  // 关了账号密码时一直先在密钥这一栏，点了「账号密码」才看那一栏
  const [peek, setPeek] = useState(false);
  const view: Mode = pwOff ? (peek ? 'password' : 'key') : tabs ? mode : 'password';
  const pick = (m: Mode) => {
    if (pwOff) return setPeek(m === 'password');
    setMode(m);
    try {
      localStorage.setItem(MODE, m);
    } catch {
      /* 存不了就算了，下回默认先密钥 */
    }
  };
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const go = () => {
    const next = params.get('next');
    navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username || !password) return toast.warning('账号和密码都要填');
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

  const submitKey = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return toast.warning('先把密钥贴进来');
    setLoading('key');
    try {
      await keyLogin(key.trim());
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
  const demos = params.has('demo') && cfg?.demoMode ? cfg.demoAccounts : [];

  return (
    <AuthShell>
      <div className="flex items-center gap-4">
        <img src={HOST_ART} alt="" className="h-24 w-auto motion-safe:animate-float" draggable={false} />
        <div>
          <h2 className="text-[26px] font-bold tracking-tight text-ink">你好，我是 {HOST_NAME}</h2>
          <p className="mt-1 text-[15px] text-ink-2">登录后我带你开始。</p>
        </div>
      </div>
      {tabs && (
        <Tabs
          className="mt-7"
          value={view}
          onChange={pick}
          items={[
            { value: 'key', label: '登录密钥' },
            { value: 'password', label: '账号密码' },
          ]}
        />
      )}
      {view === 'key' ? (
        <form onSubmit={submitKey} className="mt-5 space-y-3.5">
          <Input
            sizeVariant="lg"
            icon={<KeyRound />}
            placeholder="贴上拿到的密钥"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="characters"
          />
          <Button type="submit" variant="primary" size="lg" block loading={loading === 'key'} iconRight={<ArrowRight className="size-4" />}>
            登录
          </Button>
        </form>
      ) : pwOff ? (
        <p className="mt-5 rounded-xl bg-surface-2 px-5 py-8 text-center text-[16px] text-ink-2">账号密码登录暂未开放</p>
      ) : (
      <form onSubmit={submit} className={cn(tabs ? 'mt-5' : 'mt-7', 'space-y-3.5')}>
        <Input sizeVariant="lg" icon={<UserIcon />} placeholder="手机号、学号或账号" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        <Input
          sizeVariant="lg"
          icon={<Lock />}
          type={show ? 'text' : 'password'}
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
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
      )}
      {view === 'password' && !pwOff && (
        <div className="mt-4 flex items-center justify-between text-[14px]">
          <button type="button" onClick={() => setForgot(true)} className="text-ink-3 hover:text-ink">
            忘记密码
          </button>
          {!cfg?.loginOnly && (
            <Link to="/register" className="text-brand hover:underline">
              注册账号
            </Link>
          )}
        </div>
      )}

      {demos.length > 0 && (
        <div className="mt-9">
          <div className="mb-3 flex items-center gap-3 text-[13px] text-ink-3">
            <div className="h-px flex-1 bg-line" />
            <span>演示账号</span>
            <div className="h-px flex-1 bg-line" />
          </div>
          {demos.map((d) => (
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
      <Forgot open={forgot} onClose={() => setForgot(false)} />
    </AuthShell>
  );
}
