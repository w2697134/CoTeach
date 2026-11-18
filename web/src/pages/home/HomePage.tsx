import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowUp, CircleCheck, ClipboardList, Megaphone, Presentation, Upload } from 'lucide-react';
import { HomeStage, greeting } from '../../components/HomeStage';
import { VoiceButton } from '../../components/VoiceButton';
import { Button, Popover, Segmented, Textarea, cn } from '../../components/ui';
import { post } from '../../lib/api';
import { toast, useAuth } from '../../lib/store';
import { TA } from '../kb/data';
import { useClasses } from '../classes/data';
import { useChatList } from '../messages/data';
import { NewNotice } from '../messages/NewNotice';

/**
 * 首页：
 * 问候、一个大输入框（说一句话，CoT 助教去办，发出去到助教那边接着聊），下面一行功能按钮直接办事：
 * 备课、布置作业、发通知、签到、交资料。别的不放。
 */
export function HomePage() {
  const me = useAuth((s) => s.user);
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [notice, setNotice] = useState(false);
  const classes = (useClasses().data?.classes || []).filter((k) => !k.archived);
  const say = () => {
    const t = text.trim();
    if (t) navigate(`/assistant?say=${encodeURIComponent(t)}`);
  };
  const needCourse = () => {
    toast.info('先建一门课');
    navigate('/classes');
  };

  const composer = (
    <div className="rounded-[28px] border border-line bg-surface shadow-lg transition-colors focus-within:border-brand/50">
      <Textarea
        autoGrow
        rows={3}
        maxRows={8}
        value={text}
        maxLength={4000}
        placeholder="想让我办点什么？"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (e.preventDefault(), say())}
        className="min-h-0 resize-none border-0 bg-transparent px-5 pb-1 pt-4 text-[16px] shadow-none! hover:border-0 focus:ring-0"
      />
      <div className="flex items-center justify-end gap-1 px-2 pb-2">
        <VoiceButton onText={(t) => setText((x) => x + t)} />
        <button
          type="button"
          onClick={say}
          disabled={!text.trim()}
          aria-label="发送"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition-colors hover:bg-brand-hover disabled:opacity-40"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  );

  const pill = 'inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/80 px-3.5 py-1.5 text-[14px] text-ink-2 shadow-xs backdrop-blur transition-colors hover:border-brand/40 hover:text-ink [&>svg]:size-4 [&>svg]:text-ink-3';
  const actions = (
    <div className="flex flex-wrap justify-center gap-2">
      <button type="button" className={pill} onClick={() => navigate('/prep')}>
        <Presentation />
        备课
      </button>
      <CoursePick
        label="布置作业"
        icon={<ClipboardList />}
        className={pill}
        classes={classes}
        onEmpty={needCourse}
        onPick={(id) => navigate(`/classes/${id}/homework/new`)}
      />
      <button type="button" className={pill} onClick={() => (classes.length ? setNotice(true) : needCourse())}>
        <Megaphone />
        发通知
      </button>
      <CheckinStart className={pill} classes={classes} onEmpty={needCourse} />
      <button type="button" className={pill} onClick={() => navigate('/knowledge')}>
        <Upload />
        交资料
      </button>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <HomeStage agent={TA} hello={greeting(me?.name ? `${me.name}老师` : '')} composer={composer} chips={[]} onPick={() => {}} extra={actions} />
      <NewNotice open={notice} onClose={() => setNotice(false)} />
    </div>
  );
}

type Course = { id: number; name: string };

/** 只有一门课就直接办；好几门先挑一门 */
function CoursePick({
  label,
  icon,
  className,
  classes,
  onEmpty,
  onPick,
}: {
  label: string;
  icon: React.ReactNode;
  className: string;
  classes: Course[];
  onEmpty: () => void;
  onPick: (id: number) => void;
}) {
  if (classes.length <= 1)
    return (
      <button type="button" className={className} onClick={() => (classes[0] ? onPick(classes[0].id) : onEmpty())}>
        {icon}
        {label}
      </button>
    );
  return (
    <Popover
      align="center"
      width={260}
      trigger={({ toggle }) => (
        <button type="button" className={className} onClick={toggle}>
          {icon}
          {label}
        </button>
      )}
    >
      {(close) => (
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {classes.map((k) => (
            <button key={k.id} type="button" onClick={() => (close(), onPick(k.id))} className="block w-full truncate px-3 py-2 text-left text-[14px] text-ink hover:bg-surface-3">
              {k.name}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

/** 签到：挑课（只有一门就不用挑）、开多久，发起以后到这门课的群里，卡片上能全屏、分屏 */
function CheckinStart({ className, classes, onEmpty }: { className: string; classes: Course[]; onEmpty: () => void }) {
  const navigate = useNavigate();
  const chats = useChatList(false).data?.chats || [];
  const [course, setCourse] = useState<number | null>(null);
  const [minutes, setMinutes] = useState(5);
  const [busy, setBusy] = useState(false);
  const picked = course ?? classes[0]?.id ?? null;
  const start = async (close: () => void) => {
    if (!picked) return;
    setBusy(true);
    try {
      await post('/messages/checkins', { classId: picked, minutes });
      close();
      const chat = chats.find((c) => c.kind === 'class' && c.classId === picked);
      navigate(chat ? `/messages/${chat.id}` : '/messages');
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  if (!classes.length)
    return (
      <button type="button" className={className} onClick={onEmpty}>
        <CircleCheck />
        签到
      </button>
    );
  return (
    <Popover
      align="center"
      width={340}
      trigger={({ toggle }) => (
        <button type="button" className={className} onClick={toggle}>
          <CircleCheck />
          签到
        </button>
      )}
    >
      {(close) => (
        <div className="space-y-3 p-3">
          {classes.length > 1 && (
            <div className="max-h-40 space-y-0.5 overflow-y-auto">
              {classes.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => setCourse(k.id)}
                  className={cn('block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[14px] transition-colors', picked === k.id ? 'bg-brand-soft text-brand-ink' : 'text-ink hover:bg-surface-3')}
                >
                  {k.name}
                </button>
              ))}
            </div>
          )}
          <p className="text-[14px] font-medium text-ink">签到开多久</p>
          <Segmented<number> size="sm" value={minutes} onChange={setMinutes} options={[3, 5, 10, 15].map((v) => ({ value: v, label: `${v} 分钟` }))} />
          <Button block variant="primary" loading={busy} onClick={() => start(close)}>
            发起签到
          </Button>
        </div>
      )}
    </Popover>
  );
}
