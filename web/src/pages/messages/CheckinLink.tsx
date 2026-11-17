import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CircleCheck, CircleX } from 'lucide-react';
import { post } from '../../lib/api';
import { Button, Spinner } from '../../components/ui';

/**
 * 扫签到二维码、打开签到链接进来的（/checkin/:token）：没登录先登录，登录完回到这里，一打开就签上。
 * 链接只在签到时间里有效，过了写一句签到结束了。
 */
export function CheckinLinkPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<{ ok: true; className: string } | { ok: false; error: string } | null>(null);
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    post<{ className: string }>(`/messages/checkin-links/${encodeURIComponent(token)}`, {}).then(
      (r) => setState({ ok: true, className: r.className }),
      (e) => setState({ ok: false, error: (e as Error).message || '没签上' }),
    );
  }, [token]);
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      {!state ? (
        <Spinner label="正在签到" />
      ) : state.ok ? (
        <>
          <CircleCheck className="size-20 text-ok" strokeWidth={1.5} />
          <p className="mt-4 text-[24px] font-semibold text-ink">签到成功</p>
          <p className="mt-1 text-[16px] text-ink-2">{state.className}</p>
        </>
      ) : (
        <>
          <CircleX className="size-20 text-ink-3" strokeWidth={1.5} />
          <p className="mt-4 text-[20px] font-semibold text-ink">{state.error}</p>
        </>
      )}
      {state && (
        <Button className="mt-8" variant="secondary" onClick={() => navigate('/messages')}>
          去消息
        </Button>
      )}
    </div>
  );
}
