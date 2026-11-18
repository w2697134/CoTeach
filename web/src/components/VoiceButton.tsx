import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Mic, Square } from 'lucide-react';
import { api, get } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from './ui';

/**
 * 说话输入：点话筒开始说，再点一下停；认出来的字交给 onText，
 * 放进输入框，改了再发。录的时候话筒变成红的，跟着声音跳，旁边走秒；Esc 不要这段。一次最长一分钟。
 * 服务器没开语音输入（没配阿里云的 key）就不摆这个按钮。
 */
export function VoiceButton({ onText, disabled, className }: { onText: (text: string) => void; disabled?: boolean; className?: string }) {
  const status = useQuery({ queryKey: ['voice-status'], queryFn: () => get<{ on: boolean }>('/voice/status'), staleTime: Infinity, retry: false });
  const [state, setState] = useState<'idle' | 'rec' | 'wait'>('idle');
  const [secs, setSecs] = useState(0);
  const [level, setLevel] = useState(0);
  const cur = useRef<{
    mr: MediaRecorder;
    stream: MediaStream;
    chunks: Blob[];
    ctx?: AudioContext;
    raf: number;
    timer: number;
    cancel: boolean;
  } | null>(null);
  const said = useRef(onText);
  said.current = onText;

  const stop = (cancel = false) => {
    const r = cur.current;
    if (!r) return;
    r.cancel = cancel;
    if (r.mr.state !== 'inactive') r.mr.stop();
  };

  // 离开页面：录着的不要了
  useEffect(() => () => stop(true), []);
  // 录着的时候按 Esc：这段不要了
  useEffect(() => {
    if (state !== 'rec') return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && stop(true);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state]);

  const finish = async () => {
    const r = cur.current;
    cur.current = null;
    if (!r) return;
    cancelAnimationFrame(r.raf);
    clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
    r.ctx?.close().catch(() => {});
    setLevel(0);
    if (r.cancel) return setState('idle');
    const type = (r.mr.mimeType || 'audio/webm').split(';')[0];
    const blob = new Blob(r.chunks, { type });
    if (blob.size < 800) {
      setState('idle');
      return toast.error('没录到声音');
    }
    setState('wait');
    try {
      const d = await api<{ text: string }>(`/voice/asr?type=${encodeURIComponent(type)}`, { method: 'POST', body: blob });
      if (d.text) said.current(d.text);
      else toast.error('没听清，再说一遍试试');
    } catch (e) {
      toast.fromError(e);
    } finally {
      setState('idle');
    }
  };

  const start = async () => {
    if (state !== 'idle' || disabled) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return toast.error('这个浏览器录不了音，换 Chrome 或 Edge 试试');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    } catch (e) {
      const name = (e as DOMException)?.name;
      return toast.error(name === 'NotAllowedError' || name === 'SecurityError' ? '浏览器没让用麦克风：点地址栏左边的图标，把麦克风打开' : '没找到麦克风');
    }
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t));
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48_000 } : undefined);
    const r = { mr, stream, chunks: [] as Blob[], ctx: undefined as AudioContext | undefined, raf: 0, timer: 0, cancel: false };
    mr.ondataavailable = (e) => {
      if (e.data.size) r.chunks.push(e.data);
    };
    mr.onstop = () => void finish();
    // 话筒跟着声音跳：取一下音量
    try {
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 5));
        r.raf = requestAnimationFrame(loop);
      };
      r.ctx = ctx;
      // 有的浏览器新建的音频是停着的，叫醒它，竖条才跳
      void ctx.resume?.().catch(() => {});
      loop();
    } catch {
      /* 取不到音量也照样录 */
    }
    const began = Date.now();
    r.timer = window.setInterval(() => {
      const s = Math.floor((Date.now() - began) / 1000);
      setSecs(s);
      if (s >= 60) stop();
    }, 250);
    cur.current = r;
    mr.start(250);
    setSecs(0);
    setState('rec');
  };

  if (!status.data?.on) return null;
  if (state === 'rec')
    return (
      <button
        type="button"
        onClick={() => stop()}
        title="说完了（Esc 不要这段）"
        aria-label="说完了"
        className={cn('inline-flex h-9 shrink-0 items-center gap-2 rounded-xl bg-bad px-2.5 text-white shadow-sm transition-colors hover:bg-bad/90', className)}
      >
        {/* 五根跟着声音跳的小竖条 */}
        <span className="flex h-4 items-center gap-[3px]" aria-hidden>
          {[0.55, 0.85, 1, 0.8, 0.6].map((k, i) => (
            <span key={i} className="w-[3px] rounded-full bg-white transition-[height] duration-75" style={{ height: `${Math.max(3, Math.round(16 * Math.min(1, level * k + (i % 2 ? 0.08 : 0.04))))}px` }} />
          ))}
        </span>
        <span className="font-mono text-[13px] tabular-nums">{`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`}</span>
        <Square className="size-3 fill-current" />
      </button>
    );
  return (
    <button
      type="button"
      onClick={start}
      disabled={disabled || state === 'wait'}
      title={state === 'wait' ? '在听写' : '说话输入'}
      aria-label={state === 'wait' ? '在听写' : '说话输入'}
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent',
        className,
      )}
    >
      {state === 'wait' ? <Loader2 className="size-[18px] animate-spin" /> : <Mic className="size-[18px]" />}
    </button>
  );
}
