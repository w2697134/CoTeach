import { useRef } from 'react';
import { useNavigate } from 'react-router';
import { KeeperPanel, type KeeperHandle } from '../kb/KeeperPanel';
import { pickedFromDrop } from '../kb/intake';

/**
 * CoT 助教页（2026-11-16）：老师进来先到这里，跟助教说话办班级、作业、成绩，交资料也在这里。
 * 跟知识库页右边那一栏是同一个助教、同一段对话；整页都能把文件拖进来。
 */
export function AssistantPage() {
  const navigate = useNavigate();
  const panel = useRef<KeeperHandle>(null);
  return (
    <div
      className="h-full"
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        void pickedFromDrop(e.dataTransfer).then((files) => panel.current?.handIn(files));
      }}
    >
      <KeeperPanel ref={panel} variant="page" kbId={null} onOpenChange={(kb, id) => navigate(`/knowledge/${kb}?change=${id}`)} />
    </div>
  );
}
