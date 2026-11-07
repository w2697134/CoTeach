import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const current=readFileSync('output/kb-review/general-publication.txt','utf8');
const candidate=current.replace('老师的长期知识库。整理时提取课程知识和今后沿用的教法；本班本学期的安排与学情留给对应班级知识库，归属不明则留在原件中等待老师说明。','老师的长期知识库，保存跨届使用的课程知识和教学做法。本学期的教学事实与临时取舍归班级库；班级或学期未明确时，先向老师确认归属。原件里的未归班信息保持原样。');
if(candidate===current)throw new Error('目标定义未找到');
writeFileSync('output/kb-review/general-routing.txt',candidate,'utf8');
const files=['output/kb-review/general-publication.txt','output/kb-review/general-routing.txt','tools/kb-measure/ownership_measure.py','tools/kb-measure/chat_measure.py'];
writeFileSync('output/kb-review/routing-protocol.json',JSON.stringify({frozenAt:new Date().toISOString(),repeats:2,change:'长期与学期记录的归属定义，原聊天尺子与独立归属复核同时保留',hashes:Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')]))},null,2));
