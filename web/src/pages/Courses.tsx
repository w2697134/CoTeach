import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, Plus } from 'lucide-react';
import { post } from '../lib/api';
import { toast } from '../lib/store';
import { useCourses } from '../components/layout/AppShell';
import { Badge, Button, Card, Empty, Input, Modal, PageHeader, Skeleton } from '../components/ui';

const GRADIENTS = ['from-[#6366f1] to-[#8b5cf6]', 'from-[#0ea5e9] to-[#6366f1]', 'from-[#14b8a6] to-[#0ea5e9]', 'from-[#f59e0b] to-[#ef4444]'];

export function CoursesPage() {
  const q = useCourses();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const create = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const r = await post<{ id: number }>('/courses', { name: name.trim() });
      await qc.invalidateQueries({ queryKey: ['courses'] });
      setOpen(false);
      setName('');
      navigate(`/c/${r.id}`);
    } catch (err) {
      toast.fromError(err);
    } finally {
      setSaving(false);
    }
  };

  const courses = q.data?.courses;
  return (
    <div>
      <PageHeader
        title="我的课程"
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            新建课程
          </Button>
        }
      />
      {!courses ? (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : !courses.length ? (
        <Card>
          <Empty
            icon={<BookOpen />}
            title="还没有课程"
            action={
              <Button variant="primary" onClick={() => setOpen(true)}>
                新建课程
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {courses.map((c, i) => (
            <Card key={c.id} padded={false} hover className="cursor-pointer overflow-hidden" onClick={() => navigate(`/c/${c.id}`)}>
              <div className={`relative h-24 bg-gradient-to-br ${GRADIENTS[i % GRADIENTS.length]} px-5 py-4`}>
                <div className="absolute -right-6 -top-8 size-32 rounded-full bg-white/10" />
                <p className="relative text-[19px] font-semibold tracking-tight text-white">{c.name}</p>
              </div>
              <div className="flex items-center justify-between px-5 py-3.5">
                <span className="flex items-center gap-2 text-[14px] text-ink-2">
                  <BookOpen className="size-4 text-ink-3" />
                  知识库
                </span>
                {c.pending > 0 && <Badge tone="brand">待确认 {c.pending}</Badge>}
              </div>
            </Card>
          ))}
        </div>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="新建课程"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button variant="primary" loading={saving} disabled={!name.trim()} onClick={create}>
              建好
            </Button>
          </>
        }
      >
        <Input autoFocus placeholder="课程名称，比如：Python 程序设计" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()} />
      </Modal>
    </div>
  );
}
