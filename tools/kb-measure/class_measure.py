"""真实模型验收：班级直接生效、个人归属、问答不误写、学期总结待确认。仅运行测试副本。"""
import json, os, sys, time, re
from kb_client import Client

def main():
    if 'output' not in os.path.normpath(os.environ['CT_MEASURE_DATA']).split(os.sep):
        raise RuntimeError('仅允许 output 下的测试副本')
    c=Client(); rows=[]; label=sys.argv[1]
    for repeat in range(2):
        kid=c.call('/knowledge/classes',{'name':f"模型验收班{repeat+1}{os.environ.get('CT_MEASURE_SUFFIX','')}",'term':'隔离测试学期'})['id']
        roster=c.call(f'/knowledge/{kid}/students',{'students':[{'name':'验收学生甲','studentNo':f'EVAL-{repeat}-A'},{'name':'验收学生乙','studentNo':f'EVAL-{repeat}-B'}]})['students']
        sid=roster[0]['id']
        cases=[('个人记录','记录验收学生甲这周的情况：递归基例还需要练习。只记这位学生，别改全班记录。',True),('全班进度','全班这周已经讲完第7章，下周复习函数。请记录在本班的共有进度里。',True),('班级问答','我只问一个问题：这个班下周安排是什么？不要改记录。',False)]
        for name,msg,want in cases:
            rid=c.call(f'/courses/{kid}/kb/runs',{'message':msg})['runId']; run=c.wait_run(kid,rid,show=False)
            ch=c.call(f"/courses/{kid}/kb/changes/{run['changeId']}") if run.get('changeId') else None
            files=c.call(f'/courses/{kid}/kb/tree')['files'];ok=run['status']=='done' and bool(ch)==want
            if name=='个人记录':
                ok=ok and ch['change']['status']=='applied' and any(f.get('studentId')==sid for f in files)
            elif name=='全班进度':
                ok=ok and ch['change']['status']=='applied' and any('复习函数' in (f.get('after') or '') for f in ch['files'])
            else:ok=ok and '复习函数' in (run.get('reply') or '')
            rows.append({'case':name,'repeat':repeat+1,'ok':ok,'run':run,'change':ch});print(name,ok,flush=True)
        c.call(f'/knowledge/{kid}/kb/file',{'path':'教学反思.md','content':'# 教学反思\n\n三次课堂练习中，先让学生画调用栈，再写递归基例，能更早发现终止条件遗漏。今后讲递归时沿用这一步。\n\n出处：老师本学期的课堂记录。\n','base':None},method='PUT')
        c.call(f'/knowledge/{kid}/archive',{})
        summary=c.call(f'/knowledge/{kid}/summary',{});long=summary['kbId'];rid=summary.get('runId')
        if not rid:
            for _ in range(10):
                items=c.call(f'/knowledge/{long}/inbox')['items'];job=next((j for j in items if j['id']==summary['jobId']),None)
                if job and job.get('run_id'):rid=job['run_id'];break
                time.sleep(1)
        run=c.wait_run(long,rid,show=False)
        ch=c.call(f"/courses/{long}/kb/changes/{run['changeId']}") if run.get('changeId') else None
        text=json.dumps(ch,ensure_ascii=False) if ch else ''
        published='\n'.join(f.get('after') or '' for f in ch['files']) if ch else ''
        temporary=re.findall(r'下周|本周|掌握度\s*\d|均分\s*\d|\d+\s*人薄弱|下一阶段安排|第\s*7\s*章[^\n。]*已讲完',published)
        ok=run['status']=='done' and bool(ch) and ch['change']['status']=='pending' and not temporary and all(n not in text for n in ['验收学生甲','验收学生乙',f'EVAL-{repeat}-A',f'EVAL-{repeat}-B'])
        rows.append({'case':'学期提炼','repeat':repeat+1,'ok':ok,'temporary':temporary,'run':run,'change':ch});print('学期提炼',ok,'temporary',temporary,flush=True)
        if ch:c.call(f"/courses/{long}/kb/changes/{run['changeId']}/reject",{})
    with open(f'output/kb-owner/model-{label}.json','w',encoding='utf-8') as f:json.dump(rows,f,ensure_ascii=False,indent=2)
    print('通过',sum(bool(r['ok']) for r in rows),'/',len(rows))
if __name__=='__main__':main()
