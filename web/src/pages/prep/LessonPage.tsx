import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpenCheck, ChevronDown, ClipboardList, Download, FileText, MessageSquareText, MoreHorizontal, Play, Presentation, RotateCcw, Send, Sparkles, Trash2, Users } from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { del, download, post, put } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, Checkbox, Drawer, ErrorState, IconButton, Input, MenuItem, Modal, PageLoading, Popover, Tabs, cn, useConfirm } from '../../components/ui';
import { when } from '../classes/homework';
import { AskRail, type Focus } from './AskRail';
import { DeckPane, Present } from './DeckPane';
import { Lanes } from './Lanes';
import { PlanView } from './PlanView';
import { QuestionsView } from './QuestionsView';
import { LANES, doingNow, useLesson, type Brief, type LaneKey, type Lesson, type Part, type Plan, type Question } from './data';

type Tab = 'deck' | 'plan' | 'practice' | 'homework' | 'brief';

/**
 * 一节课（2026-11-17）：上面课题、哪个班、多长，右边放映、导出、发作业；下面五份分页：课件、教案、课堂练习、课后作业、学情。
 * 右边一栏跟助教说着改（手机上点按钮弹出来）。还在备的时候顶上一排写着几手各做到哪，做好一份就能看一份。
 */
export function LessonPage() {
  const id = Number(useParams().id);
  const q = useLesson(id);
  const l = q.data?.lesson;
  useCrumbs([{ label: '备课', to: '/prep' }, { label: l ? l.title || '下一节课' : null }]);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!l) return <PageLoading />;
  return <Workspace l={l} />;
}

function Workspace({ l }: { l: Lesson }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const making = l.making || l.status === 'making';
  const [tab, setTab] = useState<Tab>(() => (l.deck ? 'deck' : 'plan'));
  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<{ practice: number | null; homework: number | null }>({ practice: null, homework: null });
  const [focusOff, setFocusOff] = useState(false);
  const [showLanes, setShowLanes] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [rail, setRail] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['lesson', l.id] });

  const save = (part: Part) => async (data: unknown) => {
    try {
      await put(`/prep/${l.id}/${part}`, { data });
      await refresh();
    } catch (e) {
      toast.fromError(e);
      throw e;
    }
  };
  const undo = async (part: Part) => {
    try {
      await post(`/prep/${l.id}/undo`, { part });
      await refresh();
    } catch (e) {
      toast.fromError(e);
    }
  };
  const redo = async () => {
    if (!(await confirm({ title: '重新备这节课？', desc: '教案、课件和题目都重新做，现在这一版能撤回。', okText: '重新备' }))) return;
    try {
      await post(`/prep/${l.id}/redo`, { lanes: ['brief', 'plan', 'deck', 'questions', 'check'] });
      await refresh();
      setShowLanes(true);
    } catch (e) {
      toast.fromError(e);
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: `删掉「${l.title || '这节课'}」？`, okText: '删掉', danger: true }))) return;
    try {
      await del(`/prep/${l.id}`);
      qc.invalidateQueries({ queryKey: ['lessons'] });
      navigate('/prep');
    } catch (e) {
      toast.fromError(e);
    }
  };
  const fill = async (lanes: string[]) => {
    try {
      await post(`/prep/${l.id}/redo`, { lanes });
      await refresh();
    } catch (e) {
      toast.fromError(e);
    }
  };

  const focus: Focus | null = focusOff
    ? null
    : tab === 'deck' && l.deck
      ? { part: 'deck', page: page + 1 }
      : tab === 'practice' && picked.practice !== null
        ? { part: 'practice', number: picked.practice + 1 }
        : tab === 'homework' && picked.homework !== null
          ? { part: 'homework', number: picked.homework + 1 }
          : tab === 'plan' || tab === 'practice' || tab === 'homework'
            ? { part: tab }
            : null;
  const switchTab = (t: Tab) => {
    setTab(t);
    setFocusOff(false);
  };
  const failed = LANES.map((x) => x.key).filter((k) => l.lanes[k]?.status === 'error');
  const note = failed.length ? l.lanes[failed[0]]?.note || '' : '';
  const reason = note && /[一-鿿]/.test(note) && !/HTTP|[A-Za-z]{12,}|服务中断/.test(note) ? note : '';
  const lanesShown = making || showLanes || failed.length > 0;
  const meta = [l.className, l.minutes ? `${l.minutes} 分钟` : '', when(l.updatedAt)].filter(Boolean).join(' · ');
  const missing = !making && l.plan && (!l.deck || !l.practice);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6">
      {/* 课题和要做的事 */}
      {/* 手机上按钮放到课题下面一行（并排会把课题挤成一个字一行） */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-semibold leading-snug text-ink sm:text-[24px]">{l.title || l.request || '下一节课'}</h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            {meta}
            {!making && (
              <button type="button" className="ml-3 text-brand-ink hover:underline" onClick={() => setShowLanes(!showLanes)}>
                {showLanes ? '收起备课过程' : '备课过程'}
              </button>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={<Play className="size-4" />} disabled={!l.deck} onClick={() => setPresenting(true)}>
            放映
          </Button>
          <Popover
            width={200}
            trigger={({ toggle }) => (
              <Button variant="secondary" iconRight={<ChevronDown className="size-4" />} icon={<Download className="size-4" />} onClick={toggle}>
                导出
              </Button>
            )}
          >
            {(close) => (
              <div className="py-1">
                <MenuItem icon={<FileText className="size-4" />} disabled={!l.plan} onClick={() => (close(), download(`/api/prep/${l.id}/docx`))}>
                  教案（Word）
                </MenuItem>
              </div>
            )}
          </Popover>
          {l.homework?.length ? (
            l.assignmentId ? (
              <Button variant="secondary" icon={<ClipboardList className="size-4" />} onClick={() => navigate(`/classes/${l.classId}/homework/${l.assignmentId}`)}>
                看作业
              </Button>
            ) : (
              <Button variant="secondary" icon={<Send className="size-4" />} disabled={making} onClick={() => setPublishing(true)}>
                发作业
              </Button>
            )
          ) : null}
          <Popover
            width={180}
            trigger={({ toggle }) => (
              <IconButton label="更多" onClick={toggle}>
                <MoreHorizontal className="size-5" />
              </IconButton>
            )}
          >
            {(close) => (
              <div className="py-1">
                <MenuItem icon={<RotateCcw className="size-4" />} disabled={making} onClick={() => (close(), redo())}>
                  重新备
                </MenuItem>
                <MenuItem icon={<Trash2 className="size-4" />} danger onClick={() => (close(), remove())}>
                  删掉
                </MenuItem>
              </div>
            )}
          </Popover>
        </div>
      </div>

      {lanesShown && <Lanes lanes={l.lanes} className="mt-4" />}
      {!making && failed.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-bad/25 bg-bad/5 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-[14px] text-ink">{failed.map((k) => `「${LANES.find((x) => x.key === k)!.name}」`).join('、')}没做成</p>
            {/* 助教说了为什么（缺资料、不知道讲哪节）就摆出来；报错原文（英文、HTTP）不摆 */}
            {reason && <p className="mt-0.5 text-[13px] leading-relaxed text-ink-2">{reason}</p>}
          </div>
          <Button size="sm" variant="secondary" icon={<RotateCcw className="size-4" />} onClick={() => fill(retryLanes(failed))}>
            重来
          </Button>
        </div>
      )}
      {missing && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3">
          <p className="text-[14px] text-ink-2">这节课还没有{[!l.deck && '课件', !l.practice && '题目'].filter(Boolean).join('和')}</p>
          <Button size="sm" variant="primary" icon={<Sparkles className="size-4" />} onClick={() => fill(['deck', 'questions', 'check'])}>
            补上
          </Button>
        </div>
      )}

      <div className="mt-5 flex gap-6">
        <div className="min-w-0 flex-1">
          <Tabs<Tab>
            variant="page"
            value={tab}
            onChange={switchTab}
            items={[
              { value: 'deck', label: '课件', icon: <Presentation />, count: l.counts.slides || null },
              { value: 'plan', label: '教案', icon: <BookOpenCheck /> },
              { value: 'practice', label: '课堂练习', icon: <MessageSquareText />, count: l.counts.practice || null },
              { value: 'homework', label: '课后作业', icon: <ClipboardList />, count: l.counts.homework || null },
              { value: 'brief', label: '学情', icon: <Users /> },
            ]}
          />
          <div className="pt-5">
            {tab === 'deck' &&
              (l.deck ? (
                <DeckPane deck={l.deck} page={Math.min(page, l.deck.slides.length - 1)} onPage={setPage} onChange={save('deck')} />
              ) : (
                <Waiting making={making} what="课件" lane={doingNow(l.lanes)} />
              ))}
            {tab === 'plan' &&
              (l.plan ? (
                <>
                  <PartBar canUndo={(l.versions.plan?.count ?? 0) > 1} onUndo={() => undo('plan')} />
                  <PlanView plan={l.plan} meta={meta} onSave={(p: Plan) => save('plan')(p)} />
                </>
              ) : (
                <Waiting making={making} what="教案" lane={doingNow(l.lanes)} />
              ))}
            {(tab === 'practice' || tab === 'homework') &&
              (l[tab] ? (
                <QuestionsView
                  key={tab}
                  list={l[tab] as Question[]}
                  homework={tab === 'homework'}
                  selected={picked[tab]}
                  onSelect={(i) => (setPicked({ ...picked, [tab]: i }), setFocusOff(false))}
                  onSave={(next) => save(tab)(next)}
                  head={(l.versions[tab]?.count ?? 0) > 1 ? <UndoButton onUndo={() => undo(tab)} /> : null}
                />
              ) : (
                <Waiting making={making} what={tab === 'practice' ? '课堂练习' : '课后作业'} lane={doingNow(l.lanes)} />
              ))}
            {tab === 'brief' && <BriefView brief={l.brief} />}
          </div>
        </div>
        <AskRail
          lesson={l}
          focus={focus}
          onClearFocus={() => setFocusOff(true)}
          className="sticky top-4 hidden h-[calc(100vh-120px)] w-[340px] shrink-0 xl:flex"
        />
      </div>

      {/* 屏幕窄的时候：右下角一个按钮，点开跟助教说 */}
      <Button variant="primary" className="fixed bottom-5 right-5 z-30 rounded-full shadow-lg xl:hidden" icon={<Sparkles className="size-4" />} onClick={() => setRail(true)}>
        跟助教说
      </Button>
      <Drawer open={rail} onClose={() => setRail(false)} title="CoT 助教" width={420}>
        <AskRail lesson={l} focus={focus} onClearFocus={() => setFocusOff(true)} className="h-[calc(100vh-120px)] border-0" />
      </Drawer>

      {presenting && l.deck && <Present deck={l.deck} start={tab === 'deck' ? page : 0} onClose={() => setPresenting(false)} />}
      <PublishModal open={publishing} lesson={l} onClose={() => setPublishing(false)} onDone={refresh} />
    </div>
  );
}

/** 重来没做成的几手：教案没写成，后面的都要跟着重做；别的只重做那一手，再核对一遍 */
function retryLanes(failed: LaneKey[]): LaneKey[] {
  if (failed.includes('plan')) return [...new Set<LaneKey>([...failed, 'plan', 'deck', 'questions', 'check'])];
  return [...new Set<LaneKey>([...failed, 'check'])];
}

function PartBar({ canUndo, onUndo }: { canUndo: boolean; onUndo: () => void }) {
  if (!canUndo) return null;
  return (
    <div className="mx-auto mb-3 flex max-w-[820px] justify-end">
      <UndoButton onUndo={onUndo} />
    </div>
  );
}
function UndoButton({ onUndo }: { onUndo: () => void }) {
  return (
    <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} onClick={onUndo}>
      撤回上一次改动
    </Button>
  );
}

function Waiting({ making, what, lane }: { making: boolean; what: string; lane: string }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-line-strong px-6 py-16 text-center">
      <img src="/agents/lesson.webp" alt="" className={cn('size-24', making && 'animate-pulse')} />
      <p className="mt-3 text-[15px] text-ink-2">{making ? `${lane}，${what}做好就摆在这` : `还没有${what}`}</p>
    </div>
  );
}

/** 学情：这个班卡在哪，丢分、问过的人数（程序数的），助教建议怎么补 */
function BriefView({ brief }: { brief: Brief | null }) {
  if (!brief?.points.length)
    return <p className="rounded-xl border border-dashed border-line-strong px-4 py-12 text-center text-[14px] text-ink-3">这个班还没有批过的作业，学生也还没问过学伴</p>;
  return (
    <div className="mx-auto grid max-w-[1000px] gap-3 md:grid-cols-2">
      {brief.points.map((p, i) => (
        <div key={i} className="rounded-xl border border-line bg-surface px-4 py-3.5 shadow-xs">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[15.5px] font-semibold text-ink">{p.title}</p>
            <span className="shrink-0 rounded-full bg-bad/10 px-2 py-0.5 text-[12.5px] font-medium text-bad">{p.lost} 人丢分</span>
            {p.asked > 0 && <span className="shrink-0 rounded-full bg-info/10 px-2 py-0.5 text-[12.5px] font-medium text-info">{p.asked} 人问过</span>}
          </div>
          <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">{p.what}</p>
          {p.teach && <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-[13.5px] leading-relaxed text-ink">{p.teach}</p>}
          {p.homework.length > 0 && <p className="mt-2 text-[12.5px] text-ink-3">出在：{p.homework.join('、')}</p>}
        </div>
      ))}
    </div>
  );
}

/** 课后作业发到班里：截止时间（默认一周后的晚上），截止后还收不收 */
function PublishModal({ open, lesson, onClose, onDone }: { open: boolean; lesson: Lesson; onClose: () => void; onDone: () => void }) {
  const navigate = useNavigate();
  const week = new Date(Date.now() + 7 * 86400_000);
  week.setHours(23, 59, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const [due, setDue] = useState(local(week));
  const [late, setLate] = useState(true);
  const [busy, setBusy] = useState(false);
  const total = (lesson.homework || []).reduce((n, q) => n + (q.points ?? 10), 0);
  const go = async () => {
    setBusy(true);
    try {
      const r = await post<{ assignmentId: number; classId: number }>(`/prep/${lesson.id}/publish`, { dueAt: due ? new Date(due).getTime() : null, allowLate: late });
      onDone();
      onClose();
      toast.success(`发到「${lesson.className}」了`);
      navigate(`/classes/${r.classId}/homework/${r.assignmentId}`);
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="发作业"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={go}>
            发到班里
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[14px] text-ink-2">
          {lesson.className} · {lesson.homework?.length ?? 0} 道题 · 满分 {total}
        </p>
        <label className="block">
          <span className="mb-1.5 block text-[13.5px] font-medium text-ink-2">截止时间</span>
          <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <Checkbox checked={late} onChange={setLate} label="截止后还能交（标迟交）" />
      </div>
    </Modal>
  );
}
