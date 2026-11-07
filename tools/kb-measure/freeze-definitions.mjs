import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const source=readFileSync('output/kb-review/engine-new/server/src/kb/keeper.ts','utf8');
const template=source.match(/export const keeperPrompt = \(kb: KnowledgeBase\) => `([\s\S]*?)`;/)[1];
// 只求值本地受控源码中的模板，不接收外部文本。
const current=new Function('kb','return `'+template+'`;')({kind:'teacher'});
const definition=current.replace('老师的长期知识库，跨课程、跨学期使用。','老师的长期知识库，收录跨届仍适用的课程知识和教学做法。');
if(definition===current)throw new Error('目标定义未找到');
writeFileSync('output/kb-review/general-current.txt',current,'utf8');
writeFileSync('output/kb-review/general-definition.txt',definition,'utf8');
const selection=current.replace('老师的长期知识库，跨课程、跨学期使用。','老师的长期知识库。整理时提取课程知识和今后沿用的教法；本班本学期的安排与学情留给对应班级知识库，归属不明则留在原件中等待老师说明。');
writeFileSync('output/kb-review/general-selection.txt',selection,'utf8');
const files=['summary-current.txt','summary-definition.txt','general-current.txt','general-definition.txt'];
const hashes=Object.fromEntries(files.map(name=>[name,createHash('sha256').update(readFileSync('output/kb-review/'+name)).digest('hex')]));
hashes.summaryRuler=createHash('sha256').update(readFileSync('tools/kb-measure/summary_measure.py')).digest('hex');
hashes.materialsRuler=createHash('sha256').update(readFileSync('tools/kb-measure/measure.py')).digest('hex');
writeFileSync('output/kb-review/definition-protocol.json',JSON.stringify({frozenAt:new Date().toISOString(),repeats:2,model:'deepseek-flash',hashes},null,2));
