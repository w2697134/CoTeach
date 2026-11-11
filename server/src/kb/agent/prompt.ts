/**
 * 发给整理助手（Claude Code）的说明和每一轮的话。
 * 在原来那份 keeperPrompt 上改（2026-11-10）：工作范围从「当前这个知识库」换成「老师所有的知识库，一个文件夹一个」；
 * 工具从自己写的那套换成 Claude Code 自带的读写加 ct 命令；班级、学期、其他助手来源记录那几句已经用不上，删掉。
 * 改这里之前走「定目标」：先量，只动一处，对比过再上线。
 */
import { db } from '../../db/index.js';

export const agentPrompt = (teacherName: string) => `你是${teacherName}老师的整理助手。老师所有的知识库都在工作目录里，一个文件夹就是一个知识库。知识库要让一个新来的助教读完，就能照这位老师的意思办事。

各个知识库里的目录由你按老师的资料和使用需要组织。读、找、写文字文档用自带的工具；挪动、删除文件，新建、改名、删除知识库，都用 ct 命令（ct 帮助 看用法），别的命令用不了。
老师交的原件和转换文字是只读的，不能改写内容；位置由你定，和根据它写的文档放在同一个文件夹。
整理时提取课程知识和今后沿用的教法；学生的个人情况不写进知识库。

只写资料、老师交代所支持的内容，不替老师补充。正文直接写教学内容；引用资料时使用资料标题和章节作为出处。依据不足的结论不要写。老师拒绝或撤回过的交代不能再执行。
改完用 ct 交 交给老师：内容改动等老师确认后生效，只挪位置的直接生效。生效状态以 ct 的返回和系统记录为准。只是问问题或不用改，就直接回答。跟老师说话先说结论，说清楚就停。`;

/** 老师现在在哪：在某个知识库里（看着哪一页），还是在最外层 */
export function whereLine(folder: string | null, file?: string | null) {
  if (!folder) return '（老师现在在最外层，看着所有知识库）';
  return `（老师现在在「${folder}」里${file ? `，看着「${folder}/${file}」` : ''}）`;
}

const OUTCOME: Record<string, string> = { applied: '已生效', rejected: '老师没要', reverted: '老师撤回了', conflict: '没生效' };
/**
 * 上一次说话以后，整理助手交的改动老师怎么处理了（确认、不要、撤回），交资料整理完的也在里面。
 * 整理助手接着同一段对话说，它记得自己交过什么，但不知道老师后来点了什么。
 */
export function outcomesSince(teacherId: number, since: number): string {
  // 撤回是另记一份「撤回」改动，原来那份只改状态，所以按撤回那份的时间找
  const rows = db.all<{ title: string; status: string; name: string }>(
    `SELECT c.title, c.status, k.name FROM kb_changes c JOIN knowledge_bases k ON k.id=c.kb_id
     WHERE k.teacher_id=? AND c.author='keeper' AND c.kind<>'tidy'
       AND ((c.decided_at IS NOT NULL AND c.decided_at>?) OR c.id IN (SELECT reverts FROM kb_changes WHERE kind='revert' AND reverts IS NOT NULL AND decided_at>?))
     ORDER BY c.id LIMIT 12`,
    teacherId,
    since,
    since,
  );
  const lines = rows.filter((r) => OUTCOME[r.status]).map((r) => `「${r.name}」的「${r.title}」：${OUTCOME[r.status]}`);
  return lines.length ? `（系统记录：${lines.join('；')}）` : '';
}

/**
 * 老师这句话带的文件（2026-11-11 起，交资料就是说话带附件）：告诉它文件摆在哪、各是什么、哪些没读出来。
 * 怎么用这些文件只在这里说，不写进 agentPrompt：没带文件的时候用不着。
 */
export function inboxBlock(root: string, files: { rel: string; note: string }[], failed: { name: string; reason: string }[]) {
  const lines = files.map((f) => `${root}/${f.rel}${f.note ? `（${f.note}）` : ''}`);
  const bad = failed.length ? `\n没读出来的：${failed.map((f) => `${f.name}（${f.reason}）`).join('；')}` : '';
  return `（文件在「${root}」文件夹里，只读；要存进知识库用 ct 存：\n${lines.join('\n')}${bad}）`;
}

/** 老师只发了文件、没写话：在哪个库里发的就存进哪个库，在最外层发的看内容存进合适的库；都要整理好（和以前交资料一样） */
export function noWordsRequest(folder: string | null) {
  return folder
    ? `（老师只发了文件，没写话：存进「${folder}」，整理好）`
    : '（老师只发了文件，没写话：看内容存进合适的知识库，没有合适的就新建一个，整理好）';
}

/** 交资料：在某个知识库里交的就整理进这个库；在最外层交的，系统先放在一个库的最外层，由整理助手看内容放到合适的库 */
export function materialsRequest(message: string | null, folder: string, paths: string[], route: boolean) {
  const lead = message?.trim() ? message.trim() + '\n\n' : '';
  const list = paths.map((p) => `${folder}/${p}`).join('\n');
  return route
    ? `${lead}我在最外层交了资料，系统先放在「${folder}」的最外层：\n${list}\n看内容放进合适的知识库（没有合适的就新建一个），再整理。`
    : `${lead}我交了资料：\n${list}\n请整理进「${folder}」。`;
}
