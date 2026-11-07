import type { Workspace } from './workspace.js';
import type { EvidenceFinding } from './evidence.js';
import type { ToolSpec } from '../llm/index.js';
import { bad } from '../lib/http.js';
import { documentName } from './teacher-text.js';

export const experienceTool: ToolSpec = {
  name: 'place_experience',
  description:
    '把已核对的经验放入选定文档的章节。传入经验编号、目标位置和章节标题，系统保留经验文字并附上真实出处。章节已存在时追加到该章节，尚不存在时新建。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, section: { type: 'string' }, indices: { type: 'array', items: { type: 'integer' } } },
    required: ['path', 'section', 'indices'],
  },
};

export function placeExperience(
  workspace: Workspace,
  findings: EvidenceFinding[],
  source: { name: string; term: string | null },
  args: Record<string, unknown>,
  placed: Set<number>,
) {
  if (typeof args.path !== 'string' || !Array.isArray(args.indices) || !args.indices.length) throw bad('请选择经验和存放位置');
  if (typeof args.section !== 'string' || !args.section.trim() || args.section.length > 100 || /[\r\n]/.test(args.section))
    throw bad('请填写章节标题');
  const indices = args.indices as number[];
  if (
    new Set(indices).size !== indices.length ||
    indices.some((i) => !Number.isInteger(i) || i < 1 || i > findings.length || placed.has(i))
  )
    throw bad('经验编号不存在或已经放入文档');
  const paragraphs = indices.map((i) => {
    const finding = findings[i - 1];
    const titles = [...new Set(finding.sources.map((s) => documentName(s.path)))].map((t) => `《${t}》`).join('、');
    return `${finding.text.trim()}\n\n出处：${source.name}，${source.term || '学期待指定'}，${titles}。`;
  });
  const before = workspace.read(args.path) || '';
  const section = args.section.trim().replace(/^#+\s*/, '');
  if (!section) throw bad('请填写章节标题');
  const headings = [...before.matchAll(/^(#{1,6})[ \t]+(.+)$/gm)];
  const matches = headings.filter((h) => h[2].trim() === section);
  if (matches.length > 1) throw bad('这个章节标题重复，请选择独立文档存放');
  const heading = matches[0];
  const end = heading
    ? (headings.find((h) => h.index! > heading.index! && h[1].length <= heading[1].length)?.index ?? before.length)
    : before.length;
  const prefix = before.slice(0, end).trimEnd();
  const suffix = before.slice(end).trim();
  const text = [prefix, ...(!heading ? [`## ${section}`] : []), paragraphs.join('\n\n'), suffix].filter(Boolean).join('\n\n') + '\n';
  workspace.write(args.path, text);
  indices.forEach((i) => placed.add(i));
  return {
    content: JSON.stringify({ status: '已暂存核对后的经验，还未提交', path: args.path, section }),
    event: { name: 'place_experience', label: '整理经验', path: args.path, count: indices.length },
  };
}
