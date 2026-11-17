import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, MoreHorizontal, UserCheck, UserX } from 'lucide-react';
import { api, get, post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Avatar, Button, Card, Empty, ErrorState, IconButton, MenuItem, Modal, Popover, SearchInput, Skeleton, Tabs, cn, useConfirm } from '../../components/ui';
import { copyText, Switch } from '../classes/Invite';
import { when } from '../classes/homework';

interface Account {
  id: number;
  username: string;
  name: string;
  role: 'admin' | 'teacher' | 'student';
  demo: boolean;
  super: boolean;
  active: boolean;
  createdAt: number;
  lastActiveAt: number | null;
  callsToday: number;
  classes: number;
  joined: number;
}
type Role = '' | 'teacher' | 'student';
const ROLE: Record<Account['role'], string> = { admin: '管理员', teacher: '老师', student: '学生' };

/** 「允许老师注册」开关 */
function Signup() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => get<{ teacherSignup: boolean }>('/admin/settings') });
  const [busy, setBusy] = useState(false);
  const set = async (v: boolean) => {
    setBusy(true);
    try {
      await api('/admin/settings', { method: 'PUT', body: { teacherSignup: v } });
      qc.setQueryData(['admin', 'settings'], { teacherSignup: v });
      toast.success(v ? '老师可以注册了' : '老师注册关了');
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="flex items-center gap-4 py-4">
      <span className="flex-1 text-[15px] font-medium text-ink">允许老师注册</span>
      {q.data && <Switch checked={q.data.teacherSignup} disabled={busy} onChange={set} label="允许老师注册" />}
    </Card>
  );
}

/**
 * 管理页（只有管理员）：所有账号，搜索、按身份分开看；每个账号能重置密码、停用或恢复；老师还看得到今天调了几次模型。
 * 没有短信和邮箱，老师忘了密码就在这里重置。
 */
export function AdminPage() {
  const qc = useQueryClient(),
    confirm = useConfirm();
  const [kw, setKw] = useState(''),
    [role, setRole] = useState<Role>(''),
    [secret, setSecret] = useState<{ name: string; password: string } | null>(null);
  const q = useQuery({
    queryKey: ['admin', 'users', kw.trim(), role],
    queryFn: () => get<{ users: Account[]; counts: Record<string, number> }>(`/admin/users?q=${encodeURIComponent(kw.trim())}&role=${role}`),
    placeholderData: (prev) => prev,
  });
  const counts = q.data?.counts || {};
  const reset = async (u: Account) => {
    if (!(await confirm({ title: `重置「${u.name}」的密码？`, desc: '原来的密码不能再用，在别处登着的也会退出。', okText: '重置', danger: true }))) return;
    try {
      const r = await post<{ password: string }>(`/admin/users/${u.id}/password`);
      setSecret({ name: u.name, password: r.password });
    } catch (e) {
      toast.fromError(e);
    }
  };
  const toggle = async (u: Account) => {
    if (u.active && !(await confirm({ title: `停用「${u.name}」？`, desc: '停用后登不进来，登着的马上退出，随时能恢复。', okText: '停用', danger: true }))) return;
    try {
      await post(`/admin/users/${u.id}/status`, { active: !u.active });
      await qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast.success(u.active ? '已停用' : '已恢复');
    } catch (e) {
      toast.fromError(e);
    }
  };
  const list = q.data?.users || [];
  return (
    <div className="space-y-5">
      <h1 className="text-[24px] font-semibold tracking-tight text-ink">管理</h1>
      <Signup />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4 sm:px-6">
          <Tabs
            variant="pill"
            value={role}
            onChange={setRole}
            items={[
              { value: '', label: '全部', count: (counts.teacher || 0) + (counts.student || 0) + (counts.admin || 0) },
              { value: 'teacher', label: '老师', count: counts.teacher || 0 },
              { value: 'student', label: '学生', count: counts.student || 0 },
            ]}
          />
          <SearchInput value={kw} onChange={setKw} placeholder="搜索姓名、手机号、学号" className="min-w-0 flex-1 max-sm:basis-full sm:ml-auto sm:w-64 sm:flex-none" />
        </div>
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data ? (
          <Skeleton className="m-5 h-40" />
        ) : !list.length ? (
          <Empty compact title="没有找到" />
        ) : (
          <ul>
            {list.map((u) => (
              <li key={u.id} className="group flex items-center gap-3 border-b border-line px-5 py-3 last:border-0 hover:bg-surface-2 sm:px-6">
                <Avatar name={u.name} seed={u.id} size={36} className={cn(!u.active && 'opacity-45')} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={cn('truncate text-[15px] font-medium', u.active ? 'text-ink' : 'text-ink-3')}>{u.name}</span>
                    <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[12px] text-ink-2">{ROLE[u.role]}</span>
                    {u.demo && <span className="rounded-full bg-info-soft px-2 py-0.5 text-[12px] text-info">演示</span>}
                    {!u.active && <span className="rounded-full bg-bad-soft px-2 py-0.5 text-[12px] text-bad">已停用</span>}
                  </p>
                  <p className="mt-0.5 truncate text-[13px] tabular-nums text-ink-3">
                    {[
                      u.username,
                      u.role === 'teacher' && `${u.classes} 个班`,
                      u.role === 'student' && `加入 ${u.joined} 个班`,
                      u.lastActiveAt ? `最近 ${when(u.lastActiveAt)}` : '还没用过',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                {u.role !== 'student' && u.callsToday > 0 && (
                  <span className="hidden shrink-0 text-[13px] text-ink-3 sm:inline">
                    今天调模型 <span className="font-medium tabular-nums text-ink">{u.callsToday}</span> 次
                  </span>
                )}
                {!u.super && (
                  <Popover
                    width={150}
                    trigger={({ toggle: open }) => (
                      <IconButton size="sm" label={`${u.name}：更多`} onClick={open} className="text-ink-3">
                        <MoreHorizontal className="size-4" />
                      </IconButton>
                    )}
                  >
                    {(close) => (
                      <div onClick={close}>
                        <MenuItem icon={<KeyRound />} onClick={() => reset(u)}>
                          重置密码
                        </MenuItem>
                        {u.active ? (
                          <MenuItem icon={<UserX />} danger onClick={() => toggle(u)}>
                            停用
                          </MenuItem>
                        ) : (
                          <MenuItem icon={<UserCheck />} onClick={() => toggle(u)}>
                            恢复
                          </MenuItem>
                        )}
                      </div>
                    )}
                  </Popover>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Modal
        open={!!secret}
        onClose={() => setSecret(null)}
        title={secret ? `${secret.name}的新密码` : ''}
        width={400}
        footer={
          <Button variant="primary" onClick={() => setSecret(null)}>
            好了
          </Button>
        }
      >
        <div className="flex items-center justify-center gap-2 py-4">
          <span className="font-mono text-[38px] font-semibold tracking-[0.18em] text-ink">{secret?.password}</span>
          <IconButton label="复制密码" onClick={() => secret && copyText(secret.password, '密码')}>
            <Copy className="size-4" />
          </IconButton>
        </div>
      </Modal>
    </div>
  );
}
