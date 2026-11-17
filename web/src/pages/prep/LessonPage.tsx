import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpenCheck, ChevronDown, ClipboardList, Download, FileText, MessageSquareText, MoreHorizontal, Play, Presentation, RotateCcw, Send, Sparkles, Trash2, Users } from 'lucide-react';
import { useCrumbs } from '../../components/layout/Crumbs';
import { del, download, post, put } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, Checkbox, Drawer, ErrorState, IconButton, Input, MenuItem, Modal, PageLoading, Popover, Tabs, cn, useConfirm } from '../../components/ui';
import { when } from '../classes/homework';
import { AskRail, type Focus } from './AskRail';
import { LessonFiles } from './Attach';
import { DeckPane, Present } from './DeckPane';
import { downloadPptx, printDeck, type Deck as KitDeck } from '../../components/deck';
import { Lanes } from './Lanes';
import { LiveDeck } from './LiveDeck';
import { PlanView } from './PlanView';
import { QuestionsView } from './QuestionsView';
import { LANES, doingLine, useLesson, type Brief, type Deck, type LaneKey, type Lesson, type Part, type Plan, type Question } from './data';

type Tab = 'deck' | 'plan' | 'practice' | 'homework' | 'brief';

/**
 * 一节课（2026-11-17）：上面课题、哪个班、多长，右边放映、导出、发作业；下面五份分页：课件、教案、课堂练习、课后作业、学情。
 * 右边一栏跟助教说着改（手机上点按钮弹出来）。
 * 还在备的时候边做边显示：
 * 顶上一句说现在做到哪了，下面自动翻到正在做的那一份，教案一段段写出来、课件一页页摆出来、题目一道道出来；老师点了别的页签就不再自动翻。
 */
export function LessonPage() {
  const id = Number(useParams().id);
  const q = useLesson(id);
  const l = q.data?.lesson;
  useCrumbs([{ label: '备课', to: '/prep' }, { label: l ? l.title || '下一节课' : null }]);
  // 这一页外面不留边（右边助教一栏要贴着屏幕边），没打开、在打开时自己留边
  if (q.isError)
    return (
      <div className="px-4 py-6 sm:px-6 lg:px-10">
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </div>
    );
  if (!l)
    return (
      <div className="px-4 py-6 sm:px-6 lg:px-10">
        <PageLoading />
      </div>
    );
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
  // 课件每改一下编辑器都告诉外面：先放进页面的数据（同一个对象，编辑器不会当成外面换了新的），停 0.9 秒没再改才存
  const deckTimer = useRef<number | undefined>(undefined);
  const pendingDeck = useRef<Deck | null>(null);
  const flushDeck = () => {
    window.clearTimeout(deckTimer.current);
    const d = pendingDeck.current;
    pendingDeck.current = null;
    if (d) void put(`/prep/${l.id}/deck`, { data: d }).catch((e) => toast.fromError(e));
  };
  const onDeckChange = (d: Deck) => {
    qc.setQueryData<{ lesson: Lesson }>(['lesson', l.id], (old) => (old ? { lesson: { ...old.lesson, deck: d } } : old));
    pendingDeck.current = d;
    window.clearTimeout(deckTimer.current);
    deckTimer.current = window.setTimeout(flushDeck, 900);
  };
  useEffect(() => () => flushDeck(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const askAbout = (i: number) => {
    flushDeck();
    setPage(i);
    setFocusOff(false);
    if (window.innerWidth < 1280) setRail(true);
    else requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-ask-input]')?.focus());
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
  // 还在备：跟着正在做的那一份翻页签（课件和题目一起做时看课件）；老师自己点了页签就不跟了
  const [follow, setFollow] = useState(making);
  const at = (k: LaneKey) => l.lanes[k]?.status === 'doing';
  const target: Tab | null = !making ? null : at('brief') ? 'brief' : at('plan') ? 'plan' : at('deck') ? 'deck' : at('questions') ? 'practice' : null;
  useEffect(() => {
    if (follow && target) setTab(target);
  }, [follow, target]);
  useEffect(() => {
    if (!making) setFollow(false);
  }, [making]);
  // 备完那一下：说一声备好了什么（只在这一页看着它备完时说；打开一节早就备好的课不说）
  const wasMaking = useRef(making);
  useEffect(() => {
    if (wasMaking.current && !making && l.status === 'ready') {
      const got = [l.counts.slides && `课件 ${l.counts.slides} 页`, l.counts.practice && `练习 ${l.counts.practice} 道`, l.counts.homework && `作业 ${l.counts.homework} 道`].filter(Boolean);
      toast.success('备好了', `${got.join('，')}。先翻翻，哪里不合适跟我说`);
    }
    wasMaking.current = making;
  }, [making, l.status, l.counts]);
  const switchTab = (t: Tab) => {
    setTab(t);
    setFollow(false);
    setFocusOff(false);
  };
  const live = l.live || {};
  const deckSlides = l.deck?.slides ?? live.slides ?? [];
  // 写出来的新内容在最下面：跟着往下滚到正在写的地方；老师自己滚了就不跟（在看前面的）
  const endRef = useRef<HTMLDivElement>(null);
  const manual = useRef(false);
  useEffect(() => {
    if (!making) return;
    const stop = () => {
      manual.current = true;
    };
    window.addEventListener('wheel', stop, { passive: true, capture: true });
    window.addEventListener('touchmove', stop, { passive: true, capture: true });
    return () => {
      window.removeEventListener('wheel', stop, true);
      window.removeEventListener('touchmove', stop, true);
    };
  }, [making]);
  const grown = making ? `${tab}:${JSON.stringify(live).length}:${l.deck?.slides.filter((s) => s.html).length ?? 0}:${l.practice?.length ?? 0}` : '';
  useEffect(() => {
    if (!grown || manual.current || !follow) return;
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [grown, follow]);
  const failed = LANES.map((x) => x.key).filter((k) => l.lanes[k]?.status === 'error');
  const note = failed.length ? l.lanes[failed[0]]?.note || '' : '';
  const reason = note && /[一-鿿]/.test(note) && !/HTTP|[A-Za-z]{12,}|服务中断/.test(note) ? note : '';
  const lanesShown = making || showLanes || failed.length > 0;
  const meta = [l.className, l.minutes ? `${l.minutes} 分钟` : '', when(l.updatedAt)].filter(Boolean);
  const missing = !making && l.plan && (!l.deck || !l.practice);

  return (
    // 左边是这节课，右边助教一栏贴着屏幕右边、从顶栏下面到底（屏幕窄的时候收成右下角一个按钮）
    <div className="flex w-full items-start">
    <div className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-10 lg:py-7">
      {/* 课题和要做的事 */}
      {/* 手机上按钮放到课题下面一行（并排会把课题挤成一个字一行） */}
      {/* 放不下就让按钮换到下一行，课题至少留出一截宽，不被挤成一两个字一行 */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-[1_1_460px]">
          <h1 className="break-keep text-[22px] font-semibold leading-snug text-ink [overflow-wrap:anywhere] sm:text-[24px]">{l.title || l.request || '下一节课'}</h1>
          <p className="mt-1 text-[14px] text-ink-3">
            {meta.map((m, i) => (
              <Fragment key={i}>
                {i > 0 && ' · '}
                <span className="whitespace-nowrap">{m}</span>
              </Fragment>
            ))}
            {!making && (
              <button type="button" className="ml-3 text-brand-ink hover:underline" onClick={() => setShowLanes(!showLanes)}>
                {showLanes ? '收起备课过程' : '备课过程'}
              </button>
            )}
          </p>
          {/* 老师备课时带的文件：跟邮件的附件一样摆在课题下面，点开看或下载 */}
          <LessonFiles lessonId={l.id} files={l.files} className="mt-3" />
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
                <MenuItem
                  icon={<Presentation className="size-4" />}
                  disabled={!l.deck}
                  onClick={() => (close(), l.deck && void downloadPptx(l.deck as unknown as KitDeck, { fileName: l.title }).catch((e) => toast.fromError(e)))}
                >
                  课件（PPT）
                </MenuItem>
                <MenuItem
                  icon={<Presentation className="size-4" />}
                  disabled={!l.deck}
                  onClick={() => (close(), l.deck && void printDeck(l.deck as unknown as KitDeck, { title: l.title }).catch((e) => toast.fromError(e)))}
                >
                  课件（PDF）
                </MenuItem>
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

      {making ? (
        // 还在备：一句话说做到哪了，下面一排几步；钉在顶上，页面跟着新内容往下滚也看得见
        <div className="sticky top-[76px] z-20 mt-4 rounded-2xl border border-brand/15 bg-brand-soft px-4 py-3.5 shadow-sm">
          <p className="flex items-center gap-2.5 text-[15px] font-medium text-ink">
            <span className="relative flex size-2.5 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand/50" />
              <span className="relative inline-flex size-2.5 rounded-full bg-brand" />
            </span>
            {doingLine(l)}
          </p>
          <Lanes lanes={l.lanes} className="mt-3" />
        </div>
      ) : (
        lanesShown && <Lanes lanes={l.lanes} detail className="mt-4" />
      )}
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

      <div className="mt-5">
        <div className="min-w-0">
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
              (making ? (
                // 还在备：写出来一页摆一页，排好版的换成幻灯片
                deckSlides.length ? (
                  <LiveDeck slides={deckSlides} theme={l.deck?.theme} pages={live.pages} writing={!l.deck && at('deck')} />
                ) : at('deck') && l.plan?.steps.length ? (
                  <DeckComing plan={l.plan} />
                ) : (
                  <Waiting busy text={at('deck') ? '课件我照着教案在写，这一步一般要两三分钟' : '教案写完，我就接着做课件'} />
                )
              ) : l.deck ? (
                // 编辑器要一个定高：不然左边缩略图有多长它就多高，中间那页居中跑到屏幕下面去（2026-11-17 截图时看到中间是空的）
                <div className="h-[min(82vh,700px)] md:h-[calc(100vh-250px)] md:min-h-[520px]">
                  <DeckPane
                    deck={l.deck}
                    readOnly={making}
                    busyPage={l.asking && focus?.part === 'deck' && focus.page ? focus.page - 1 : null}
                    fileName={l.title}
                    initialSlide={Math.min(page, l.deck.slides.length - 1)}
                    onChange={onDeckChange}
                    onAskAI={askAbout}
                  />
                </div>
              ) : (
                <Waiting text="这节课还没有课件" />
              ))}
            {tab === 'plan' &&
              (l.plan ? (
                <>
                  <PartBar canUndo={!making && (l.versions.plan?.count ?? 0) > 1} onUndo={() => undo('plan')} />
                  <PlanView plan={l.plan} onSave={making ? undefined : (p: Plan) => save('plan')(p)} />
                </>
              ) : making && live.plan ? (
                <PlanView plan={fullPlan(live.plan)} live />
              ) : making && at('plan') ? (
                <PlanComing brief={l.brief} />
              ) : (
                <Waiting busy={making} text={!making ? '这节课还没有教案' : at('read') ? '你给的资料我看完就写教案' : '我先看看大家卡在哪，接着就写教案'} />
              ))}
            {(tab === 'practice' || tab === 'homework') &&
              (l[tab] || (making && live[tab]?.length) ? (
                <QuestionsView
                  key={tab}
                  list={(l[tab] || live[tab]) as Question[]}
                  homework={tab === 'homework'}
                  selected={picked[tab]}
                  onSelect={(i) => (setPicked({ ...picked, [tab]: i }), setFocusOff(false))}
                  onSave={(next) => save(tab)(next)}
                  head={!making && (l.versions[tab]?.count ?? 0) > 1 ? <UndoButton onUndo={() => undo(tab)} /> : null}
                  live={making && !l[tab]}
                  readOnly={making}
                />
              ) : (
                <Waiting
                  busy={making}
                  text={!making ? `这节课还没有${tab === 'practice' ? '课堂练习' : '课后作业'}` : at('questions') ? '题目我在出，一般一两分钟' : '教案写完，我就接着出题'}
                />
              ))}
            {tab === 'brief' && (making && at('brief') ? <Waiting busy text="我在翻这门课最近的作业，还有学生问过学伴的问题" /> : <BriefView brief={l.brief} />)}
            <div ref={endRef} className="h-4" />
          </div>
        </div>
      </div>

      {/* 屏幕窄的时候：右下角一个按钮，点开跟助教说 */}
      {!making && (
        <Button variant="primary" className="fixed bottom-5 right-5 z-30 rounded-full shadow-lg xl:hidden" icon={<Sparkles className="size-4" />} onClick={() => setRail(true)}>
          跟助教说
        </Button>
      )}
      <Drawer open={rail} onClose={() => setRail(false)} title="CoT 助教" width={420}>
        <AskRail lesson={l} focus={focus} onClearFocus={() => setFocusOff(true)} className="h-[calc(100vh-120px)] border-0" />
      </Drawer>

      {presenting && l.deck && <Present deck={l.deck} start={tab === 'deck' ? page : 0} onClose={() => setPresenting(false)} />}
      <PublishModal open={publishing} lesson={l} onClose={() => setPublishing(false)} onDone={refresh} />
    </div>
    {/* 还在备的时候不摆（那会儿也改不了，摆着是一大块空白）：正在长出来的内容占满 */}
    {!making && (
      <AskRail
        lesson={l}
        focus={focus}
        onClearFocus={() => setFocusOff(true)}
        className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-[340px] shrink-0 rounded-none border-0 border-l xl:flex 2xl:w-[380px]"
      />
    )}
    </div>
  );
}

/** 重来没做成的几手：教案没写成（或者带的文件没看成），后面的都要跟着重做；别的只重做那一手，再核对一遍 */
function retryLanes(failed: LaneKey[]): LaneKey[] {
  if (failed.includes('plan') || failed.includes('read')) return [...new Set<LaneKey>([...failed, 'plan', 'deck', 'questions', 'check'])];
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

/** 这一份还没有：一句具体的话（在做什么、等什么），不套模板 */
function Waiting({ text, busy }: { text: string; busy?: boolean }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-line-strong px-6 py-16 text-center">
      <img src="/agents/lesson.webp" alt="" className={cn('size-24', busy && 'animate-pulse')} />
      <p className="mt-3 text-[15px] text-ink-2">{text}</p>
    </div>
  );
}

/**
 * 教案还没动笔（助教在翻知识库）：摆这个班卡得最多的几处，教案开头会先补讲这些。
 * 不摆「做好就摆在这」这类空话。
 */
function PlanComing({ brief }: { brief: Brief | null }) {
  const points = brief?.points.slice(0, 3) || [];
  if (!points.length) return <Waiting busy text="这门课还没有批过的作业，我照授课计划往下写教案" />;
  return (
    <div className="mx-auto max-w-[820px] rounded-xl border border-line bg-surface px-5 py-6 sm:px-10 sm:py-8">
      <p className="text-[15px] font-medium text-ink">大家卡得最多的几处，我放在教案开头先补讲</p>
      <ol className="mt-4 space-y-3">
        {points.map((p, i) => (
          <li key={i} className="flex gap-3">
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-brand-soft text-[13px] font-semibold text-brand-ink">{i + 1}</span>
            <div className="min-w-0">
              <p className="text-[15px] text-ink">
                {p.title}
                <span className="ml-2 text-[13px] text-ink-3">{p.lost} 人丢分</span>
              </p>
              {p.what && <p className="mt-0.5 max-w-[44em] text-[14px] leading-relaxed text-ink-2">{p.what}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * 课件还没写出来（模型多半想好了一口气写完，中间看不到写到哪页）：先按教案的几个环节摆出课件的样子，
 * 写完换成真的页。只摆教案里真有的环节，不编。
 */
function DeckComing({ plan }: { plan: Plan }) {
  return (
    <div>
      <p className="mb-4 text-[15px] text-ink-2">课件我照着教案的 {plan.steps.length} 个环节在写，一般要两三分钟</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-3 2xl:grid-cols-4">
        {plan.steps.map((s, i) => (
          <figure key={i}>
            <div className="relative aspect-video overflow-hidden rounded-lg border border-dashed border-line-strong bg-surface">
              <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-brand-soft/70 via-surface to-surface" style={{ animationDelay: `${i * 160}ms` }} />
              <div className="relative flex h-full flex-col justify-center px-4">
                <p className="line-clamp-2 text-[15px] font-medium text-ink-2">{s.name}</p>
                {s.minutes ? <p className="mt-1 text-[13px] text-ink-3">{s.minutes} 分钟</p> : null}
              </div>
            </div>
          </figure>
        ))}
      </div>
    </div>
  );
}

/** 写到一半的教案补齐没写到的栏（空的不显示） */
function fullPlan(p: Partial<Plan>): Plan {
  return { title: p.title || '', goals: p.goals || [], focus: p.focus || '', hard: p.hard || '', review: p.review || '', steps: p.steps || [], board: p.board || '', sources: p.sources || [] };
}

/** 学情：这个班卡在哪，丢分、问过的人数（程序数的），助教建议怎么补 */
function BriefView({ brief }: { brief: Brief | null }) {
  if (!brief?.points.length)
    return <p className="rounded-xl border border-dashed border-line-strong px-4 py-12 text-center text-[14px] text-ink-3">这门课还没有批过的作业，学生也还没问过学伴</p>;
  return (
    <div className="mx-auto grid max-w-[1000px] gap-3 md:grid-cols-2">
      {brief.points.map((p, i) => (
        <div key={i} className="rounded-xl border border-line bg-surface px-4 py-3.5 shadow-xs">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[16px] font-semibold text-ink">{p.title}</p>
            <span className="shrink-0 rounded-full bg-bad/10 px-2 py-0.5 text-[13px] font-medium text-bad">{p.lost} 人丢分</span>
            {p.asked > 0 && <span className="shrink-0 rounded-full bg-info/10 px-2 py-0.5 text-[13px] font-medium text-info">{p.asked} 人问过</span>}
          </div>
          <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">{p.what}</p>
          {p.teach && <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-[14px] leading-relaxed text-ink">{p.teach}</p>}
          {p.homework.length > 0 && <p className="mt-2 text-[13px] text-ink-3">出在：{p.homework.join('、')}</p>}
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
            发给学生
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[14px] text-ink-2">
          {lesson.className} · {lesson.homework?.length ?? 0} 道题 · 满分 {total}
        </p>
        <label className="block">
          <span className="mb-1.5 block text-[14px] font-medium text-ink-2">截止时间</span>
          <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <Checkbox checked={late} onChange={setLate} label="截止后还能交（标迟交）" />
      </div>
    </Modal>
  );
}
