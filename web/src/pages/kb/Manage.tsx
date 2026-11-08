import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, FilePlus, Users, Sparkles, MoreHorizontal, PenLine, Trash2 } from 'lucide-react';
import { api, get, post } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, Empty, ErrorState, IconButton, Input, MenuItem, Modal, Skeleton, Textarea, useConfirm, Popover } from '../../components/ui';
import { useKnowledgeBases, type KnowledgeBase } from './data';
import { parseRoster } from './presentation';
import { LocationField } from './LocationField';

export interface ClassStudent {
  id: number;
  name: string;
  studentNo: string;
  aliases: string[];
}
export function useStudents(id: number, enabled = true) {
  return useQuery({
    queryKey: ['kb-students', id],
    queryFn: () => get<{ students: ClassStudent[] }>(`/knowledge/${id}/students`),
    enabled,
  });
}
export function KnowledgeTools({ kb, onSelect }: { kb: KnowledgeBase; onSelect: (p: string) => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient(),
    confirm = useConfirm(),
    roster = useStudents(kb.id, kb.kind === 'class');
  const [modal, setModal] = useState<'file' | 'students' | null>(null),
    [name, setName] = useState(''),
    [folder, setFolder] = useState(''),
    [notice, setNotice] = useState(''),
    [content, setContent] = useState(''),
    [studentId, setStudentId] = useState(''),
    [names, setNames] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [editing, setEditing] = useState<ClassStudent | null>(null),
    [studentName, setStudentName] = useState(''),
    [aliases, setAliases] = useState('');
  const archived = kb.status === 'archived';
  const [renaming, setRenaming] = useState(false),
    [newName, setNewName] = useState('');
  const all = useKnowledgeBases().data?.knowledgeBases || [];
  // 最后一个知识库不能删
  const canDelete = kb.kind !== 'teacher' || all.filter((k) => k.kind === 'teacher').length > 1;
  const rename = async () => {
    if (!newName.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/knowledge/${kb.id}`, { method: 'PATCH', body: { name: newName } });
      qc.invalidateQueries({ queryKey: ['knowledge-bases'] });
      qc.invalidateQueries({ queryKey: ['course', kb.id] });
      setRenaming(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const removeKb = async () => {
    if (!(await confirm({ title: `删除「${kb.name}」？`, desc: '里面的笔记和资料会一起删掉。', okText: '删除', danger: true }))) return;
    setBusy(true);
    try {
      const r = await api<{ next: number }>(`/knowledge/${kb.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['knowledge-bases'] });
      navigate(`/knowledge/${r.next}`, { replace: true });
      toast.success('已删除');
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  const refresh = () => {
    for (const key of ['kb-tree', 'kb-file', 'kb-changes', 'course', 'kb-students']) qc.invalidateQueries({ queryKey: [key, kb.id] });
    qc.invalidateQueries({ queryKey: ['knowledge-bases'] });
  };
  const newFile = async () => {
    setBusy(true);
    setError('');
    try {
      const path = [folder, /\.md$/i.test(name.trim()) ? name.trim() : name.trim() + '.md'].filter(Boolean).join('/');
      await api(`/knowledge/${kb.id}/kb/file`, {
        method: 'PUT',
        body: {
          path,
          content,
          base: null,
          ...(studentId ? { studentId: Number(studentId) } : {}),
        },
      });
      refresh();
      setModal(null);
      onSelect(path);
      toast.success('已新建');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const addStudents = async () => {
    setBusy(true);
    setError('');
    try {
      const students = parseRoster(names);
      const result = await post<{
        added: number;
        skipped: { studentNo: string; name: string }[];
        conflicts: { studentNo: string; name: string; existingName: string }[];
      }>(`/knowledge/${kb.id}/students`, { students });
      await roster.refetch();
      setNames(result.conflicts.map((s) => `${s.studentNo} ${s.name}`).join('\n'));
      setNotice(result.skipped.length ? '已在名单：' + result.skipped.map((s) => `${s.studentNo} ${s.name}`).join('、') : '');
      setError(result.conflicts.map((s) => `学号 ${s.studentNo} 已属于「${s.existingName}」，未添加「${s.name}」`).join('；'));
      if (result.added) toast.success(`已添加 ${result.added} 人`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const saveStudent = async () => {
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      await api(`/knowledge/${kb.id}/students/${editing.id}`, {
        method: 'PUT',
        body: {
          name: studentName,
          aliases: aliases
            .split(/[,，\n]/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      setEditing(null);
      await roster.refetch();
      toast.success('已保存');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const summarize = async () => {
    setBusy(true);
    try {
      const result = await post<{ kbId: number; status: string }>(`/knowledge/${kb.id}/summary`, {});
      toast.success(
        result.status === 'done' ? '这个学期已有提炼结果' : result.status === 'running' ? '整理助手正在提炼' : '提炼任务已排队',
      );
      qc.invalidateQueries({ queryKey: ['kb-runs'] });
      navigate(`/knowledge/${result.kbId}`);
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    if (
      !(await confirm({
        title: '结束并封存这个学期？',
        desc: '封存后只能查阅，正在整理的任务会停止。',
        okText: '封存学期',
      }))
    )
      return;
    setBusy(true);
    try {
      await post(`/knowledge/${kb.id}/archive`, {});
      refresh();
      toast.success('学期已封存');
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {(!archived || kb.kind === 'class') && (
        <Popover
          width={176}
          trigger={({ toggle }) => (
            <IconButton label="更多" onClick={toggle} disabled={busy}>
              <MoreHorizontal className="size-[18px]" />
            </IconButton>
          )}
        >
          {(close) => (
            <div onClick={close}>
              {!archived && (
                <MenuItem
                  icon={<FilePlus />}
                  onClick={() => {
                    setModal('file');
                    setName('');
                    setFolder('');
                    setContent('');
                    setStudentId('');
                    setError('');
                  }}
                >
                  新建笔记
                </MenuItem>
              )}
              {!archived && (
                <MenuItem
                  icon={<PenLine />}
                  onClick={() => {
                    setNewName(kb.name);
                    setError('');
                    setRenaming(true);
                  }}
                >
                  改名
                </MenuItem>
              )}
              {canDelete && (
                <MenuItem icon={<Trash2 />} danger onClick={removeKb}>
                  删除这个知识库
                </MenuItem>
              )}
              {kb.kind === 'class' && (
                <>
                  <MenuItem
                    icon={<Users />}
                    onClick={() => {
                      setModal('students');
                      setError('');
                    }}
                  >
                    班级名单
                  </MenuItem>
                  {archived ? (
                    <MenuItem icon={<Sparkles />} onClick={summarize}>
                      提炼教学经验
                    </MenuItem>
                  ) : (
                    <MenuItem icon={<Archive />} onClick={archive}>
                      封存学期
                    </MenuItem>
                  )}
                </>
              )}
            </div>
          )}
        </Popover>
      )}
      <Modal
        open={renaming}
        onClose={() => !busy && setRenaming(false)}
        title="改名"
        footer={
          <>
            <Button disabled={busy} onClick={() => setRenaming(false)}>
              取消
            </Button>
            <Button variant="primary" loading={busy} disabled={!newName.trim() || newName.trim() === kb.name} onClick={rename}>
              保存
            </Button>
          </>
        }
      >
        <label className="block text-[14px] text-ink">
          名称
          <Input autoFocus className="mt-1.5" value={newName} maxLength={40} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && rename()} />
        </label>
        {error && (
          <p role="alert" className="mt-3 text-[14px] text-bad">
            {error}
          </p>
        )}
      </Modal>
      <Modal
        open={modal === 'file'}
        onClose={() => !busy && setModal(null)}
        title="新建笔记"
        footer={
          <>
            <Button disabled={busy} onClick={() => setModal(null)}>
              取消
            </Button>
            <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={newFile}>
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block text-[14px] text-ink">
            名称
            <Input autoFocus className="mt-1.5" value={name} onChange={(e) => setName(e.target.value.replace(/[\\/]/g, ''))} />
          </label>
          <LocationField cid={kb.id} value={folder} onChange={setFolder} />
          {kb.kind === 'class' && (
            <label className="block text-[14px] text-ink">
              这份记录属于
              <select
                className="mt-1.5 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-ink"
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
              >
                <option value="">全班共有</option>
                {roster.data?.students.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.studentNo}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-[14px] text-ink">
            内容
            <Textarea className="mt-1.5 min-h-48" value={content} onChange={(e) => setContent(e.target.value)} />
          </label>
          {error && (
            <p role="alert" className="text-[14px] text-bad">
              {error}
            </p>
          )}
        </div>
      </Modal>
      <Modal
        open={modal === 'students'}
        onClose={() => !busy && setModal(null)}
        title="班级名单"
        footer={<Button onClick={() => setModal(null)}>完成</Button>}
      >
        <div className="space-y-4">
          {roster.error ? (
            <ErrorState error={roster.error} onRetry={() => roster.refetch()} />
          ) : !roster.data ? (
            <Skeleton className="h-24" />
          ) : !roster.data.students.length ? (
            <Empty compact title="还没有学生" />
          ) : (
            <div className="max-h-60 divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {roster.data.students.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="min-w-0">
                    <span className="text-[14px] font-medium text-ink">{s.name}</span>
                    <span className="ml-2 text-[13px] text-ink-3">{s.studentNo}</span>
                  </span>
                  {!archived && (
                    <Button
                      size="sm"
                      onClick={() => {
                        setEditing(s);
                        setStudentName(s.name);
                        setAliases(s.aliases.join('，'));
                        setError('');
                      }}
                    >
                      编辑
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          {!archived && (
            <>
              <label className="block text-[14px] text-ink">
                添加名单
                <Textarea className="mt-1.5 min-h-24" value={names} onChange={(e) => setNames(e.target.value)} placeholder="学号 姓名" />
              </label>
              <Button loading={busy} disabled={!names.trim()} onClick={addStudents}>
                添加名单
              </Button>
            </>
          )}
          {notice && (
            <p role="status" className="text-[14px] text-ink-2">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="text-[14px] text-bad">
              {error}
            </p>
          )}
        </div>
      </Modal>
      <Modal
        open={!!editing}
        onClose={() => !busy && setEditing(null)}
        title="修改学生信息"
        footer={
          <Button variant="primary" loading={busy} disabled={!studentName.trim()} onClick={saveStudent}>
            保存
          </Button>
        }
      >
        <div className="space-y-4">
          <label className="block text-[14px] text-ink">
            姓名
            <Input value={studentName} onChange={(e) => setStudentName(e.target.value)} />
          </label>
          <label className="block text-[14px] text-ink">
            曾用名或常用称呼
            <Input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="多个称呼用逗号分开" />
          </label>
          {error && (
            <p role="alert" className="text-bad">
              {error}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}
