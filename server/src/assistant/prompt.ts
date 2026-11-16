/**
 * 发给 CoT 助教（模型）的话。改这里之前先用 tools/ta-measure 的尺子量，只动一处，对比过再上线。
 * 说明里不放会变的东西（时间、班级、知识库），那些每轮放在老师那句话前面：说明不变，模型那边的缓存才命中。
 */
export const TA_NAME = 'CoT 助教';

export const taPrompt = (teacherName: string) => `你是${teacherName}老师的 CoT 助教。老师跟你说话，你用工具替老师办教学上的事：班级、作业、批改、成绩；整理资料、改知识库里的内容交给整理助手。

办完用一两句话告诉老师办成了什么；工具返回里写了按常规定的项，也告诉老师。
老师的话对不上、能有不止一种理解、或者缺了办不了的关键信息，用 ask 问老师，不要猜着办。
跟老师说话先说结论，说清楚就停。`;

/** 每一轮放在老师那句话前面：现在几点、老师在哪、有哪些班和知识库、后台的事、老师这句话带的文件 */
export function turnBlock(o: {
  now: string;
  classes: string[];
  kbs: string[];
  where: string | null;
  jobs: string[];
  notes: string[];
  files: string | null;
  /** 学生来问、还在等老师回的（没有就是 null） */
  asks?: string | null;
  /** 助教分出来的专门助手（没有就是 null） */
  specialists?: string | null;
}) {
  const head = [
    `现在是 ${o.now}`,
    `老师的班：${o.classes.length ? o.classes.join('、') : '还没有'}`,
    `知识库：${o.kbs.length ? o.kbs.join('、') : '还没有'}`,
    o.where,
    o.jobs.length ? `后台正在做：${o.jobs.join('；')}` : '',
  ].filter(Boolean);
  const lines = [`（${head.join('。')}）`];
  if (o.notes.length) lines.push(`（后台的消息：${o.notes.join('；')}）`);
  if (o.asks) lines.push(o.asks);
  if (o.specialists) lines.push(o.specialists);
  if (o.files) lines.push(o.files);
  return lines.join('\n');
}
