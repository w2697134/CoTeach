import { useState } from 'react';
import { useNavigate, Navigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Plus, Users, Archive } from 'lucide-react';
import { get, post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Badge, Button, Card, Empty, ErrorState, Input, Modal, PageHeader, PageLoading } from '../../components/ui';
import { useKnowledgeBases } from './data';

export function LegacyCoursePage() {
  const id = Number(useParams().id),
    [params] = useSearchParams();
  const q = useQuery({
    queryKey: ['course-link', id],
    queryFn: () => get<{ kbId: number; legacyPrefix: string }>(`/courses/${id}`),
  });
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <PageLoading />;
  const target = new URLSearchParams(params);
  if (target.has('f')) target.set('f', q.data.legacyPrefix + target.get('f'));
  return <Navigate replace to={`/knowledge/${q.data.kbId}${target.size ? '?' + target.toString() : ''}`} />;
}
export function LibrariesPage() {
  const q = useKnowledgeBases(),
    qc = useQueryClient(),
    navigate = useNavigate();
  const [open, setOpen] = useState(false),
    [name, setName] = useState(''),
    [term, setTerm] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const create = async () => {
    if (!name.trim() || !term.trim()) return;
    setBusy(true);
    setError('');
    try {
      const r = await post<{ id: number }>('/knowledge/classes', {
        name,
        term,
      });
      await qc.invalidateQueries({ queryKey: ['knowledge-bases'] });
      setOpen(false);
      navigate(`/knowledge/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <PageLoading />;
  const personal = q.data.knowledgeBases.find((k) => k.kind === 'teacher'),
    classes = q.data.knowledgeBases.filter((k) => k.kind === 'class');
  return (
    <div className="space-y-7">
      <PageHeader title="我的知识库" />
      {personal && (
        <Card padded={false}>
          <button
            onClick={() => navigate(`/knowledge/${personal.id}`)}
            className="flex w-full items-center gap-4 p-6 text-left transition-colors hover:bg-surface-2"
          >
            <span className="flex size-12 items-center justify-center rounded-xl bg-brand-soft text-brand">
              <BookOpen />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[18px] font-semibold text-ink">长期知识库</span>
            </span>
            {personal.pending > 0 && <Badge tone="brand">{personal.pending} 待确认</Badge>}
          </button>
        </Card>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-semibold text-ink">班级与学期</h2>
        </div>
        {classes.length > 0 && (
          <Button
            icon={<Plus className="size-4" />}
            onClick={() => {
              setOpen(true);
              setError('');
            }}
          >
            新建班级
          </Button>
        )}
      </div>
      {!classes.length ? (
        <Card>
          <Empty
            icon={<Users />}
            title="还没有班级"
            action={
              <Button variant="primary" onClick={() => setOpen(true)}>
                新建班级
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {classes.map((k) => (
            <Card key={k.id} padded={false}>
              <button
                onClick={() => navigate(`/knowledge/${k.id}`)}
                className="flex w-full items-start gap-3 p-5 text-left transition-colors hover:bg-surface-2"
              >
                {k.status === 'archived' ? <Archive className="mt-1 size-5 text-ink-3" /> : <Users className="mt-1 size-5 text-brand" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[16px] font-semibold text-ink">{k.name}</span>
                  <span className="mt-1 block text-[14px] text-ink-3">{k.term}</span>
                </span>
                <Badge tone={k.status === 'archived' ? 'gray' : 'ok'}>{k.status === 'archived' ? '已封存' : '进行中'}</Badge>
              </button>
            </Card>
          ))}
        </div>
      )}
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="新建班级"
        footer={
          <>
            <Button disabled={busy} onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button variant="primary" loading={busy} disabled={!name.trim() || !term.trim()} onClick={create}>
              建好
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block text-[14px] text-ink">
            班级名称
            <Input autoFocus className="mt-1.5" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block text-[14px] text-ink">
            学期
            <Input className="mt-1.5" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="例如：2026—2027 学年第一学期" />
          </label>
          {error && (
            <p role="alert" className="text-[14px] text-bad">
              {error}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
