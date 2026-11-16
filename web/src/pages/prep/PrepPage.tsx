import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Loader2, Plus } from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { Markdown } from '../../components/Markdown';
import { get, post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, Card, ErrorState, Input, Modal, Skeleton, Tabs, cn } from '../../components/ui';
import { useClasses } from '../classes/data';
import { EmptyArt, themeOf } from '../classes/look';
import { when } from '../classes/homework';

interface PlanStep {
  name: string;
  minutes: number | null;
  content: string;
}
interface PlanWrite {
  title: string;
  goals: string[];
  focus: string;
  hard: string;
  review: string;
  steps: PlanStep[];
  practice: string;
  homework: string;
  sources: string[];
}
interface Plan {
  id: number;
  classId: number;
  className: string;
  topic: string | null;
  status: 'writing' | 'ready' | 'error';
  write: PlanWrite | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const usePlans = (classId: number | null) =>
  useQuery({
    queryKey: ['prep', classId],
    enabled: !!classId,
    queryFn: () => get<{ plans: Plan[] }>(`/prep?class=${classId}`),
    refetchInterval: (q) => (q.state.data?.plans.some((p) => p.status === 'writing') ? 4000 : false),
  });

/**
 * 备课（2026-11-16，老师左侧栏）：上面挑班，「备下节课」（可以说这节讲什么）；助教照知识库里的教案、课件和这个班的学情写一份教案。
 * 最新的一份整篇摆出来，像一页教案；以前备的列在下面，点开看；能下载 Word。
 */
export function PrepPage() {
  useCrumbs([{ label: '备课' }]);
  const qc = useQueryClient();
  const classes = (useClasses().data?.classes || []).filter((k) => !k.archived);
  const [params, setParams] = useSearchParams();
  const classId = Number(params.get('class')) || classes[0]?.id || null;
  const plans = usePlans(classId);
  const list = plans.data?.plans || [];
  const shownId = Number(params.get('plan')) || list.find((p) => p.status !== 'error')?.id || list[0]?.id;
  const shown = list.find((p) => p.id === shownId);
  const [asking, setAsking] = useState(false);
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setTopic(''), [asking]);
  const start = async () => {
    if (!classId) return;
    setBusy(true);
    try {
      const r = await post<{ id: number }>('/prep', { classId, topic: topic.trim() || null });
      setAsking(false);
      setParams({ class: String(classId), plan: String(r.id) }, { replace: true });
      await qc.invalidateQueries({ queryKey: ['prep', classId] });
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  if (!classes.length)
    return (
      <Card padded={false}>
        <EmptyArt src="/illustrations/classes/empty-classes.webp" title="还没有班级" />
      </Card>
    );
  const theme = themeOf(classId || 0);
  return (
    <div className="space-y-5">
      <Tabs
        variant="page"
        value={String(classId)}
        onChange={(v) => setParams({ class: v }, { replace: true })}
        items={classes.map((k) => ({ value: String(k.id), label: k.name }))}
        end={
          <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setAsking(true)}>
            备下节课
          </Button>
        }
      />
      {plans.error ? (
        <ErrorState error={plans.error} onRetry={() => plans.refetch()} />
      ) : !plans.data ? (
        <Skeleton className="h-72 rounded-lg" />
      ) : !list.length ? (
        <Card padded={false}>
          <EmptyArt
            src="/illustrations/entry-homework-v1.webp"
            title="这个班还没备过课"
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAsking(true)}>
                备下节课
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {shown && <PlanView p={shown} ink={theme.ink} />}
          {list.length > 1 && (
            <Card padded={false}>
              <ul>
                {list.map((p) => (
                  <li key={p.id} className="border-b border-line last:border-0">
                    <button
                      type="button"
                      onClick={() => setParams({ class: String(p.classId), plan: String(p.id) }, { replace: true })}
                      className={cn('flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-surface-2 sm:px-6', p.id === shown?.id && 'bg-surface-2')}
                    >
                      <span className="min-w-0 flex-1 truncate text-[15px] text-ink">
                        {p.write?.title || p.topic || (p.status === 'writing' ? '在备' : '没备成')}
                      </span>
                      <span className="shrink-0 text-[13px] text-ink-3">{when(p.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
      <Modal
        open={asking}
        onClose={() => !busy && setAsking(false)}
        title="备下节课"
        footer={
          <>
            <Button disabled={busy} onClick={() => setAsking(false)}>
              取消
            </Button>
            <Button variant="primary" loading={busy} onClick={start}>
              开始
            </Button>
          </>
        }
      >
        <label className="block text-[14px] text-ink">
          这节课讲什么
          <Input
            autoFocus
            className="mt-1.5"
            value={topic}
            maxLength={200}
            placeholder="可以不填，照授课计划和进度备下一节"
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && start()}
          />
        </label>
      </Modal>
    </div>
  );
}

function Section({ title, ink, children }: { title: string; ink: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="mb-2 flex items-center gap-2 text-[15.5px] font-semibold text-ink">
        <span className="h-4 w-1 rounded-full" style={{ backgroundColor: ink }} />
        {title}
      </h3>
      {children}
    </section>
  );
}

/** 教案里的字：它写了加粗、代码这类记号就照样显示出来（不露出 ** 和 ` 这些符号），一行一段 */
const lines = (s: string) => (
  <div className="break-words text-[14.5px] leading-relaxed text-ink-2 [&_p+p]:mt-1 [&_p]:my-0">
    <Markdown compact>{s.replace(/\n/g, '\n\n')}</Markdown>
  </div>
);

/** 一份教案摆成一页：课题、目标、重点难点、开头补讲（学情）、教学过程、练习、作业、用到的资料 */
function PlanView({ p, ink }: { p: Plan; ink: string }) {
  if (p.status === 'writing')
    return (
      <Card className="flex items-center justify-center gap-2.5 py-16 text-[15px] text-ink-2">
        <Loader2 className="size-5 animate-spin" style={{ color: ink }} />
        助教在备课{p.topic ? `：${p.topic}` : ''}
      </Card>
    );
  if (p.status === 'error' || !p.write)
    return (
      <Card className="py-10 text-center text-[15px] text-ink-2">
        没备成{p.error ? `：${p.error}` : ''}
      </Card>
    );
  const w = p.write;
  const download = () => {
    const a = document.createElement('a');
    a.href = `/api/prep/${p.id}/docx`;
    a.click();
  };
  return (
    <Card padded={false} className="px-6 py-6 sm:px-10 sm:py-8">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-[22px] font-semibold leading-snug text-ink">{w.title}</h2>
          <p className="mt-1 text-[13.5px] text-ink-3">
            {p.className} · {when(p.createdAt)}
          </p>
        </div>
        <Button size="sm" icon={<Download className="size-4" />} onClick={download}>
          下载 Word
        </Button>
      </div>
      {w.goals.length > 0 && (
        <Section title="教学目标" ink={ink}>
          <ol className="list-decimal space-y-1 pl-5 text-[14.5px] leading-relaxed text-ink-2">
            {w.goals.map((g, i) => (
              <li key={i} className="break-words [&_p]:my-0">
                <Markdown compact>{g}</Markdown>
              </li>
            ))}
          </ol>
        </Section>
      )}
      {(w.focus || w.hard) && (
        <div className="grid gap-x-8 sm:grid-cols-2">
          {w.focus && (
            <Section title="重点" ink={ink}>
              {lines(w.focus)}
            </Section>
          )}
          {w.hard && (
            <Section title="难点" ink={ink}>
              {lines(w.hard)}
            </Section>
          )}
        </div>
      )}
      {w.review && (
        <Section title="开头补讲" ink={ink}>
          <div className="rounded-lg px-4 py-3" style={{ backgroundColor: `${ink}12` }}>
            {lines(w.review)}
          </div>
        </Section>
      )}
      {w.steps.length > 0 && (
        <Section title="教学过程" ink={ink}>
          <ol className="space-y-0">
            {w.steps.map((s, i) => (
              <li key={i} className="relative border-l-2 border-line pb-4 pl-5 last:pb-0">
                <span className="absolute -left-[7px] top-1.5 size-3 rounded-full border-2 bg-surface" style={{ borderColor: ink }} />
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[15px] font-medium text-ink">{s.name}</span>
                  {s.minutes && <span className="text-[13px] text-ink-3">{s.minutes} 分钟</span>}
                </p>
                <div className="mt-1">{lines(s.content)}</div>
              </li>
            ))}
          </ol>
        </Section>
      )}
      {w.practice && (
        <Section title="课堂练习" ink={ink}>
          {lines(w.practice)}
        </Section>
      )}
      {w.homework && (
        <Section title="课后作业" ink={ink}>
          {lines(w.homework)}
        </Section>
      )}
      {w.sources.length > 0 && (
        <Section title="用到的资料" ink={ink}>
          <div className="flex flex-wrap gap-1.5">
            {w.sources.map((s) => (
              <span key={s} className="rounded-full bg-surface-3 px-2.5 py-0.5 text-[12.5px] text-ink-3">
                {s.replace(/\.md$/i, '')}
              </span>
            ))}
          </div>
        </Section>
      )}
    </Card>
  );
}
