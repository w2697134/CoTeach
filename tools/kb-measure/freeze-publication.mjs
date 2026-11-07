import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const current=readFileSync('output/kb-review/general-selection.txt','utf8');
const candidate=current.replace('记录真实出处；依据不足的结论不要写。','正文直接写教学内容；引用资料时使用资料标题和章节作为出处。依据不足的结论不要写。');
if(candidate===current)throw new Error('目标句未找到');
writeFileSync('output/kb-review/general-publication.txt',candidate,'utf8');
const files=['general-selection.txt','general-publication.txt'];
writeFileSync('output/kb-review/publication-protocol.json',JSON.stringify({frozenAt:new Date().toISOString(),repeats:2,change:'正文与出处的表达方式；长期归属定义保持相同',hashes:Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync('output/kb-review/'+f)).digest('hex')]))},null,2));
