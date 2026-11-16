import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useCrumbs } from '../../components/layout/Crumbs';
import { api, post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, Card, ErrorState, Input, Skeleton, Textarea, cn } from '../../components/ui';
import { useClass, useClasses } from './data';
import { FilePicker } from './HwFiles';
import { AI_MODES, fromLocalInput, toLocalInput, useHomework, when, type AiMode, type HwFile } from './homework';
import { Switch } from './Invite';

/** 默认截止：一周后的晚上 23:59 */
const weekLater = () => {
  const d = new Date(Date.now() + 7 * 86_400_000);
  d.setHours(23, 59, 0, 0);
  return d.getTime();
};
/** 定时发布默认：明天早上 8 点 */
const tomorrowMorning = () => {
  const d = new Date(Date.now() + 86_400_000);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
};

function Row({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      <p className="text-[14px] font-medium text-ink">{label}</p>
      {children}
    </div>
  );
}

/**
 * 布置作业、改作业（照 Google Classroom）：左边标题、要求、附件；右边发给哪几个班、满分、截止、截止后还收不收、什么时候发。
 * 一次发给几个班时每个班一份，以后各改各的。
 */
export function HomeworkEditPage() {
  const params = useParams();
  const classId = Number(params.id),
    editing = Number(params.hid) || 0;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const k = useClass(classId);
  const classes = useClasses();
  const existing = useHomework(editing);
  const [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [files, setFiles] = useState<HwFile[]>([]),
    [points, setPoints] = useState('100'),
    [hasDue, setHasDue] = useState(true),
    [due, setDue] = useState(toLocalInput(weekLater())),
    [allowLate, setAllowLate] = useState(true),
    [later, setLater] = useState(false),
    [publish, setPublish] = useState(toLocalInput(tomorrowMorning())),
    [to, setTo] = useState<number[]>([classId]),
    [aiMode, setAiMode] = useState<AiMode>('release'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(!editing);
  useEffect(() => {
    const h = existing.data;
    if (!editing || !h || loaded) return;
    setTitle(h.title);
    setBody(h.body);
    setFiles(h.files);
    setPoints(String(h.points));
    setHasDue(!!h.dueAt);
    if (h.dueAt) setDue(toLocalInput(h.dueAt));
    setAllowLate(h.allowLate);
    setLater(h.publishAt > Date.now());
    if (h.publishAt > Date.now()) setPublish(toLocalInput(h.publishAt));
    if (h.aiMode) setAiMode(h.aiMode);
    setLoaded(true);
  }, [editing, existing.data, loaded]);
  const published = !!existing.data && existing.data.publishAt <= Date.now();
  const others = (classes.data?.classes || []).filter((c) => !c.archived);
  const back = editing ? `/classes/${classId}/homework/${editing}` : `/classes/${classId}`;
  const save = async () => {
    const p = Number(points);
    if (!title.trim()) return setError('写个标题');
    if (!Number.isFinite(p) || p < 1 || p > 1000) return setError('满分填 1 到 1000 之间的数');
    if (hasDue && !due) return setError('选一下截止时间');
    if (later && !published && !publish) return setError('选一下发布时间');
    if (!editing && !to.length) return setError('至少发给一个班');
    setBusy(true);
    setError('');
    const fields = {
      title,
      body,
      points: p,
      dueAt: hasDue ? fromLocalInput(due) : null,
      allowLate,
      publishAt: later && !published ? fromLocalInput(publish) : null,
      fileIds: files.map((f) => f.id),
      aiMode,
    };
    try {
      if (editing) {
        await api(`/homework/${editing}`, { method: 'PATCH', body: fields });
        toast.success('作业改好了');
      } else {
        await post('/homework', { ...fields, classIds: to });
        toast.success(fields.publishAt ? `作业会在${when(fields.publishAt)} 发布` : to.length > 1 ? `作业发给了 ${to.length} 个班` : '作业布置好了');
      }
      await qc.invalidateQueries({ queryKey: ['homework'] });
      qc.invalidateQueries({ queryKey: ['classes'] });
      navigate(back, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useCrumbs([
    { label: '班级', to: '/classes' },
    { label: k.data?.name, to: `/classes/${classId}` },
    ...(editing ? [{ label: existing.data?.title, to: back }] : []),
    { label: editing ? '改作业' : '布置作业' },
  ]);
  if (k.error || existing.error) return <ErrorState error={k.error || existing.error} onRetry={() => (k.refetch(), existing.refetch())} />;
  if (!k.data || !loaded) return <Skeleton className="h-96 rounded-xl" />;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[24px] font-semibold tracking-tight text-ink">{editing ? '改作业' : '布置作业'}</h1>
        <div className="ml-auto flex gap-2">
          <Button disabled={busy} onClick={() => navigate(back)}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {editing ? '保存' : later ? '定时布置' : '布置'}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-bad-soft px-4 py-2.5 text-[14px] text-bad">
          {error}
        </p>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="space-y-5">
          <Row label="标题">
            <Input sizeVariant="lg" autoFocus={!editing} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          </Row>
          <Row label="要求">
            <Textarea autoGrow maxRows={24} className="min-h-40" value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} />
          </Row>
          <Row label="附件">
            <FilePicker files={files} onChange={setFiles} disabled={busy} />
          </Row>
        </Card>
        <Card className="space-y-6">
          {!editing && (
            <Row label="发给">
              <div className="space-y-1.5">
                {others.map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-1 py-1 text-[14.5px] text-ink hover:bg-surface-2">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--c-primary)]"
                      checked={to.includes(c.id)}
                      onChange={(e) => setTo(e.target.checked ? [...to, c.id] : to.filter((x) => x !== c.id))}
                    />
                    <span className="min-w-0 truncate">{c.name}</span>
                  </label>
                ))}
              </div>
            </Row>
          )}
          <Row label="满分">
            <Input type="number" inputMode="decimal" min={1} max={1000} className="w-32" value={points} onChange={(e) => setPoints(e.target.value)} />
          </Row>
          <Row label="截止时间">
            <label className="flex items-center justify-between gap-3 text-[14px] text-ink-2">
              设截止时间
              <Switch checked={hasDue} onChange={setHasDue} label="设截止时间" />
            </label>
            {hasDue && (
              <>
                <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
                <label className="flex items-center justify-between gap-3 pt-1 text-[14px] text-ink-2">
                  截止后还能交（标迟交）
                  <Switch checked={allowLate} onChange={setAllowLate} label="截止后还能交" />
                </label>
              </>
            )}
          </Row>
          <Row label="批改">
            <div className="space-y-1">
              {AI_MODES.map((m) => (
                <label key={m.value} className="flex cursor-pointer items-center gap-2.5 rounded-md px-1 py-1 text-[14.5px] text-ink hover:bg-surface-2">
                  <input type="radio" name="ai-mode" className="size-4 accent-[var(--c-primary)]" checked={aiMode === m.value} onChange={() => setAiMode(m.value)} />
                  {m.label}
                </label>
              ))}
            </div>
          </Row>
          {!published && (
            <Row label="发布">
              <div className="flex rounded-lg bg-surface-3 p-1 text-[14px]">
                {[
                  [false, '现在发'],
                  [true, '定时发'],
                ].map(([v, label]) => (
                  <button
                    key={String(v)}
                    type="button"
                    onClick={() => setLater(v as boolean)}
                    className={cn('h-8 flex-1 rounded-md transition-colors', later === v ? 'bg-surface font-medium text-ink shadow-xs' : 'text-ink-3 hover:text-ink-2')}
                  >
                    {label as string}
                  </button>
                ))}
              </div>
              {later && <Input type="datetime-local" value={publish} onChange={(e) => setPublish(e.target.value)} />}
            </Row>
          )}
        </Card>
      </div>
    </div>
  );
}
