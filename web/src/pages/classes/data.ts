import { useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';

/** 老师看到的班带人数和前几个学生（卡片上摆头像），学生看到的班带老师 */
export interface ClassItem {
  id: number;
  name: string;
  count?: number;
  preview?: { id: number; name: string }[];
  teacher?: string;
}
export interface ClassStudent {
  id: number;
  studentNo: string;
  name: string;
}
export interface ClassDetail {
  id: number;
  name: string;
  students?: ClassStudent[];
  teacher?: string;
}

export const useClasses = () => useQuery({ queryKey: ['classes'], queryFn: () => get<{ classes: ClassItem[] }>('/classes') });
export const useClass = (id: number) => useQuery({ queryKey: ['class', id], queryFn: () => get<ClassDetail>(`/classes/${id}`) });

/** 名单放在框里是一行一个「学号 姓名」 */
export const rosterText = (list: { studentNo: string; name: string }[]) => list.map((s) => `${s.studentNo} ${s.name}`).join('\n');
export const rosterCount = (text: string) => text.split(/\r?\n/).filter((l) => l.trim()).length;
export const unreadNote = (lines: string[]) =>
  lines.length ? `这几行没认出来：${lines.slice(0, 5).map((l) => `「${l}」`).join('、')}${lines.length > 5 ? ` 等 ${lines.length} 行` : ''}` : '';
