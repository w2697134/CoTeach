import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import { AgentAvatar } from './ui';

/**
 * CoT 助教、CoT 学伴的首页（2026-11-18，照 Claude 桌面版首页）：屏幕中间一行问候，下面一个大输入框（一圈慢慢流动的光），
 * 再下面几句点一下就填进输入框的话。发出去就接着聊：输入框落到底下，上面是这段会话（输入框用同一个 layoutId 过渡）。
 */

/** 称呼老师：名字后面加「老师」；名字本身已经以「老师」结尾的（比如「评委老师」）不再加，免得成了「评委老师老师」 */
export const teacherCall = (name?: string | null) => (!name ? '' : name.endsWith('老师') ? name : `${name}老师`);

/** 按早上、下午、晚上、深夜换说法 */
export function greeting(name: string, now = new Date()) {
  const h = now.getHours();
  const word = h >= 5 && h < 11 ? '早上好' : h >= 11 && h < 13 ? '中午好' : h >= 13 && h < 18 ? '下午好' : h >= 18 && h < 23 ? '晚上好' : '夜深了';
  return name ? `${word}，${name}` : word;
}

export function HomeStage({
  agent,
  hello,
  composer,
  chips,
  onPick,
  onHistory,
  extra,
}: {
  agent: Parameters<typeof AgentAvatar>[0]['agent'];
  hello: string;
  /** 输入框（外面包好 motion.div layoutId，发出去时落到底下） */
  composer: ReactNode;
  chips: string[];
  onPick: (text: string) => void;
  /** 有以前的对话：一个不起眼的入口 */
  onHistory?: () => void;
  /** 摆在大输入框下面的东西（比如助教上一句问了老师、还在等回答的那张卡片，在首页就能答） */
  extra?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-[10vh] pt-6">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }} className="flex items-center gap-3.5">
        <AgentAvatar agent={agent} size={44} />
        <h1 className="text-[28px] font-semibold tracking-tight text-ink sm:text-[34px]">{hello}</h1>
      </motion.div>
      <div className="home-glow mt-8 w-full max-w-[760px] sm:mt-10">{composer}</div>
      {extra && <div className="mt-4 w-full max-w-[760px] text-left">{extra}</div>}
      {chips.length > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.15, duration: 0.4 }}
          className="mt-5 flex w-full max-w-[760px] flex-wrap justify-center gap-2"
        >
          {chips.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onPick(t)}
              className="max-w-full truncate rounded-full border border-line bg-surface/80 px-3.5 py-1.5 text-[14px] text-ink-2 shadow-xs backdrop-blur transition-colors hover:border-brand/40 hover:text-ink"
            >
              {t}
            </button>
          ))}
        </motion.div>
      )}
      {onHistory && (
        <button type="button" onClick={onHistory} className="mt-8 inline-flex items-center gap-1 text-[13px] text-ink-3 transition-colors hover:text-ink-2">
          之前的对话
          <ChevronDown className="size-3.5" />
        </button>
      )}
    </div>
  );
}
