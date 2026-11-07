"""汇总最终组，并保留原始分数与同口径复判，不改原始输出。"""
import hashlib,json,re
from pathlib import Path
from measure import has_source
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'output/kb-review'
report={'model':'deepseek-flash','repeats':2,'materials':{},'chat':{},'summary':{},'audit':{}}
for label in ['old','release']:
    rows=[]
    for i in [1,2]:
        path=OUT/f'final-comparison/materials/materials-{label}-{i}.json'
        d=json.loads(path.read_text(encoding='utf-8'))
        no_source=[f['path'] for f in d['change']['files'] if f.get('after') and f['path'].split('/')[-1]!='目录.md' and not has_source(f['after'])]
        rows.append({'repeat':i,'raw':d['metrics'],'reviewed':{**d['metrics'],'no_source':no_source},'file':str(path.relative_to(ROOT))})
    report['materials'][label]=rows
    rows=[]
    for i in [1,2]:
        path=OUT/f'final-comparison/chat/chat-{label}-{i}.json';d=json.loads(path.read_text(encoding='utf-8'))
        ch=[r for r in d['rows'] if r['want_change']];ask=[r for r in d['rows'] if not r['want_change']]
        rows.append({'repeat':i,'edits':sum(r['ok'] for r in ch),'editTotal':len(ch),'questionsRaw':sum(r['ok'] for r in ask),'questionTotal':len(ask),'falseClaims':sum(r['false_claim'] for r in ch),'file':str(path.relative_to(ROOT))})
    report['chat'][label]=rows
for kind in ['evidence','empty']:
    report['summary'][kind]={}
    for label in ['current','release']:
        report['summary'][kind][label]=[json.loads((OUT/f'summary-release-{kind}-{label}-{i}.json').read_text(encoding='utf-8'))['metrics'] for i in [1,2]]
report['audit']={
 'materials':'原始 release 第1轮把“来自《课程大纲》和《常见错误与调试技巧手册》”误判为无出处；has_source 已补测并对双方复判。原始JSON不覆盖。',
 'chat':'冻结尺子 old 10/12、release 12/12。实读 old 第1轮第6条明确迟交未生效，不能算捏造规则，应改判通过；第2轮第6条确实捏造周作业、选做、抄袭零分等。实读校正 old 11/12、release 12/12。未修改 chat_measure.py 的原始指标。',
 'summary':'线上旧引擎没有班级封存/学期总结，无法直接比较。current 是本轮审查前的归属新版及当时的学期总结交代，不是线上版。',
 'rulerSha256':hashlib.sha256((ROOT/'tools/kb-measure/measure.py').read_bytes()).hexdigest(),
 'limits':'上传第2轮仍有原始文件路径引用，页面按资料名展示。未宣称原始模型正文全面消除路径。两轮样本不代表普遍质量保证；用户实读关未代签。'
}
(OUT/'final-model-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
