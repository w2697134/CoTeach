"""复核后成对测量：每个重复使用相同的原始快照；只在 output/kb-review 写入。"""
import concurrent.futures, contextlib, hashlib, importlib.util, json, os, re, shutil, sqlite3, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/kb-review'
BACKUP = Path(r'E:\Codex\zhongzhuan\backups\coteach-kb-owner-implementation-20261106')
DATA = Path(r'E:\Codex\zhongzhuan\backups\coteach-local-data-20261106-owner-final')
OUT.mkdir(parents=True, exist_ok=True)
def save(path, value): path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def prepare():
    if (OUT/'frozen-protocol.json').exists():
        raise RuntimeError('已有冻结协议和历史结果，不允许覆盖；请保留现有引擎快照复核')
    for label, source in [('old', BACKUP/'server-src'), ('new', ROOT/'server/src')]:
        engine = OUT / ('engine-' + label)
        if (engine/'ready').exists(): continue
        (engine/'server').mkdir(parents=True,exist_ok=True)
        shutil.copytree(source, engine/'server/src',dirs_exist_ok=True)
        shutil.copy2(ROOT/'server/package.json', engine/'server/package.json')
        if (ROOT/'server/seed-content').exists():shutil.copytree(ROOT/'server/seed-content', engine/'server/seed-content',dirs_exist_ok=True)
        subprocess.run(['cmd','/c','mklink','/J',str(engine/'server/node_modules'),str(ROOT/'server/node_modules')],check=True,stdout=subprocess.DEVNULL)
        (engine/'ready').write_text('ready',encoding='utf-8')
    source=(OUT/'engine-new/server/src/kb/keeper.ts').read_text(encoding='utf-8')
    prompt=re.search(r'export const summaryPrompt = `([\s\S]*?)`;',source).group(1)
    (OUT/'summary-current.txt').write_text(prompt,encoding='utf-8')
    removed='整理时的取舍、没有收录什么、哪些依据不足，这些说明放在回复或 finish.reason，知识正文只保留教学约定。\n'
    assert removed in prompt
    (OUT/'summary-delete.txt').write_text(prompt.replace(removed,''),encoding='utf-8')
    old=(BACKUP/'server-src/kb/keeper.ts').read_text(encoding='utf-8')
    legacy=re.search(r'const prompt = \(courseName: string\) => `([\s\S]*?)`;',old).group(1).replace('${courseName}','Python 程序设计')
    (OUT/'prompt-legacy-correct.txt').write_text(legacy,encoding='utf-8')
    save(OUT/'frozen-protocol.json',{'model':'deepseek-flash','repeats':2,'materialsRevision':'8cc1d87','chatRevision':'b482a1c',
      'materials':{p.name:sha(p) for p in sorted((ROOT/'tools/kb-measure/materials').glob('*.md'))},
      'rulers':{p.name:sha(p) for p in [Path(__file__),ROOT/'tools/kb-measure/measure.py',ROOT/'tools/kb-measure/chat_measure.py']},
      'summaryMetrics':['names == 0','stats == 0','current-term timing == 0','path notation and internal source names == 0 in body and reason','reason <= 120 chars; no excluded-content inventory','body names actual class and term','proposal remains pending','supported reflection retained'],
      'summaryCurrentHash':sha(OUT/'summary-current.txt'),'summaryDeleteHash':sha(OUT/'summary-delete.txt'),
      'baselineKeeperHash':sha(BACKUP/'server-src/kb/keeper.ts'),'legacyPromptContainsQuestionMarks':'????' in legacy})

def fixture(label, scenario, repeat):
    target=OUT/f'{scenario}-{label}-{repeat}'
    assert not target.exists(), target
    shutil.copytree(DATA,target)
    db=sqlite3.connect(target/'coteach.db')
    for table in ['kb_events','kb_changes','kb_runs','llm_calls']: 
        if db.execute('select name from sqlite_master where name=?',(table,)).fetchone(): db.execute('DELETE FROM '+table)
    db.execute("UPDATE models SET enabled=CASE WHEN model='deepseek-flash' THEN 1 ELSE 0 END")
    db.commit();db.close()
    revision='8cc1d87' if scenario in ['materials','general','general-selection','general-publication'] else 'b482a1c'
    repo=target/'kb/3';assert repo.resolve().is_relative_to(OUT.resolve())
    subprocess.run(['git','-c','safe.directory='+str(repo).replace('\\','/'),'-C',str(repo),'reset','--hard',revision],check=True,stdout=subprocess.DEVNULL)
    return target

@contextlib.contextmanager
def service(label, scenario, repeat, port, prompt=None):
    import socket
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1',port))==0:raise RuntimeError(f'测试端口 {port} 已被占用，拒绝连接其他测试服务')
    data=fixture(label,scenario,repeat)
    engines = {'old':'old','editor':'editor','editor-control':'editor','gate':'gate','gate-control':'gate','final':'final','indexed':'indexed','routed':'indexed','reviewed':'reviewed','review-control':'reviewed','delivery':'delivery','release':'release','placement':'placement','placement-control':'placement'}
    engine=OUT/('engine-'+engines.get(label,'new'))/'server'
    env=os.environ.copy();env.update(CT_DATA_DIR=str(data),CT_HOST='127.0.0.1',CT_PORT=str(port),CT_DAILY_CALL_LIMIT='0')
    for key in ['CT_KEEPER_PROMPT_FILE','CT_TEST_MODE','CT_EVAL_SUMMARY_CONTEXT','CT_EVAL_SUMMARY_PROMPT','CT_EVAL_EVIDENCE_GATE','CT_EVAL_EVIDENCE_TRACE','CT_EVAL_SUMMARY_REVIEW','CT_EVAL_SUMMARY_PLACEMENT','CT_MIGRATION_FAIL_AT','CT_MIGRATION_HARD_EXIT']:env.pop(key,None)
    if prompt:env.update(CT_TEST_MODE='1',CT_KEEPER_PROMPT_FILE=str(prompt))
    if label in ['gate','gate-control']:env.update(CT_TEST_MODE='1',CT_EVAL_EVIDENCE_GATE='1' if label=='gate' else '0')
    if label in ['editor','editor-control']:env.update(CT_TEST_MODE='1',CT_EVAL_EVIDENCE_GATE='1',CT_EVAL_EVIDENCE_TRACE='1')
    if label in ['reviewed','review-control']:env.update(CT_TEST_MODE='1',CT_EVAL_EVIDENCE_GATE='1',CT_EVAL_EVIDENCE_TRACE='1',CT_EVAL_SUMMARY_REVIEW='1' if label=='reviewed' else '0')
    if label in ['placement','placement-control']:env.update(CT_TEST_MODE='1',CT_EVAL_EVIDENCE_GATE='1',CT_EVAL_EVIDENCE_TRACE='1',CT_EVAL_SUMMARY_PLACEMENT='1' if label=='placement' else '0')
    log=(OUT/f'{scenario}-{label}-{repeat}.server.log').open('w',encoding='utf-8')
    proc=subprocess.Popen(['node','--import','tsx','src/index.ts'],cwd=engine,env=env,stdout=log,stderr=subprocess.STDOUT)
    try:
        for _ in range(120):
            if proc.poll() is not None:raise RuntimeError('服务启动失败：'+str(log.name))
            try: urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health',timeout=1);break
            except Exception:time.sleep(.25)
        else:raise RuntimeError('服务启动超时')
        yield data
    finally:proc.terminate();proc.wait(timeout=20);log.close()

def client_module(label,port,route):
    # kb_client 的配置在 import 时读取；线程各自持有模块实例。
    spec=importlib.util.spec_from_file_location('client_'+label,ROOT/'tools/kb-measure/kb_client.py')
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
    mod.B=f'http://127.0.0.1:{port}/api'
    c=mod.Client(); original=c.call
    def call(path,*a,**kw):return original(path.replace('/courses/','/knowledge/') if route=='knowledge' else path,*a,**kw)
    c.call=call
    # 上传入口在两代引擎之间不同，不修改生产代码或模型交代。
    def upload(cid, paths):
        import uuid
        boundary=uuid.uuid4().hex;parts=[]
        for p in paths:
            p=Path(p);parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{p.name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+p.read_bytes()+b'\r\n')
        req=urllib.request.Request(mod.B+f'/{route}/{cid}/kb/upload',data=b''.join(parts)+f'--{boundary}--\r\n'.encode(),headers={'x-tv2':'1','Content-Type':f'multipart/form-data; boundary={boundary}'})
        return json.load(c.op.open(req,timeout=300))
    c.upload=upload
    return c

def await_job(c,kid,result):
    rid=result.get('runId')
    if not rid:
        for _ in range(60):
            jobs=c.call(f'/knowledge/{kid}/inbox')['items']
            job=next((j for j in jobs if j.get('run_id')),None)
            if job:rid=job['run_id'];break
            time.sleep(1)
    if not rid:raise RuntimeError('自动任务没有运行')
    return c.wait_run(kid,rid,show=False)

def trial(label,scenario,repeat,port,prompt=None):
    with service(label,scenario,repeat,port,prompt) as data:
        c=client_module(label,port,'courses' if label=='old' else 'knowledge');kid=3 if label=='old' else 1
        if scenario in ['materials','general','general-selection','general-publication']:
            from measure import measure
            result=c.upload(kid, sorted((ROOT/'tools/kb-measure/materials').glob('*.md')))
            run=await_job(c,kid,result);change=c.call(f"/courses/{kid}/kb/changes/{run['changeId']}") if run.get('changeId') else None
            metrics=measure(c,kid,run['changeId']) if change else {'no_proposal':True}
            result={'run':run,'change':change,'metrics':metrics}
        elif scenario in ['chat','chat-final','chat-indexed','chat-routing']:
            from chat_measure import run_all
            rows=run_all(c,kid,label,rounds=1)
            runs=c.call(f'/courses/{kid}/kb/runs')['runs']
            details=[c.call(f"/courses/{kid}/kb/changes/{r['changeId']}") for r in runs if r.get('changeId')]
            result={'rows':rows,'runs':runs,'changes':details}
        else:
            classroom=c.call('/knowledge/classes',{'name':'软件2301班','term':'2026 秋季'})['id']
            roster=c.call(f'/knowledge/{classroom}/students',{'students':[{'name':'验收学生甲','studentNo':'R-001'}]})['students'];sid=roster[0]['id']
            for path,text,extra in [
                ('教学进度.md','# 教学进度\n本周已讲完第7章，下周复习函数。掌握度 60%，均分 72，4 人薄弱。',{}),
                ('个人记录.md','# 个人记录\n验收学生甲需要补练递归基例。',{'studentId':sid}),
                ('教学反思.md','# 教学反思\n三次课堂练习中，先让学生画调用栈，再写递归基例，能更早发现终止条件遗漏。今后讲递归时沿用这一步。\n出处：老师本学期的课堂记录。',{})]:
                if scenario.endswith(('-evidence','-empty')) and path=='教学反思.md':
                    if scenario.endswith('-empty'):continue
                    text=text.replace('今后讲递归时沿用这一步。','')
                c.call(f'/knowledge/{classroom}/kb/file',{'path':path,'content':text,'base':None,**extra},method='PUT')
            c.call(f'/knowledge/{classroom}/archive',{})
            info=c.call(f'/knowledge/{classroom}/summary',{});run=await_job(c,kid,info)
            change=c.call(f"/knowledge/{kid}/kb/changes/{run['changeId']}") if run.get('changeId') else None
            body='\n'.join(f.get('after') or '' for f in change['files']) if change else ''
            reason=change['change'].get('reason') or '' if change else ''
            from summary_measure import measure_summary
            metrics=measure_summary(change)
            if scenario.endswith('-empty'):metrics={'noProposal':not bool(change),'done':run['status']=='done','ok':not bool(change) and run['status']=='done'}
            result={'run':run,'change':change,'metrics':metrics}
        result.update(label=label,scenario=scenario,repeat=repeat)
        save(OUT/f'{scenario}-{label}-{repeat}.json',result)
        print(scenario,label,repeat,result.get('metrics','saved'),flush=True)

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8');os.environ.pop('CT_MEASURE_ROUTE',None)
    if sys.argv[1]=='prepare':prepare()
    else:
        scenario=sys.argv[1]
        labels=['editor-control','editor'] if scenario.startswith('summary-editor') else ['gate-control','gate'] if scenario.startswith('summary-gated') else ['current','grounded'] if scenario in ['summary-evidence','summary-empty'] else ['indexed','routed'] if scenario=='chat-routing' else ['final','indexed'] if scenario=='chat-indexed' else ['old','final'] if scenario=='chat-final' else ['selection','publication'] if scenario=='general-publication' else ['current','delete'] if scenario=='summary' else ['current','faithful'] if scenario in ['summary-faithful','summary-final'] else ['current','selection'] if scenario=='general-selection' else ['current','citation'] if scenario=='summary-citation' else ['current','definition'] if scenario in ['summary-definition','general'] else ['old','new']
        for repeat in range(1,3):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futures=[pool.submit(trial,label,scenario,repeat,18670+i,OUT/'summary-editor.txt' if label=='editor' else OUT/'summary-grounded.txt' if label in ['gate','gate-control','editor-control'] else OUT/'general-routing.txt' if label=='routed' else OUT/f"{'general' if scenario.startswith('general') else 'summary'}-{label}.txt" if scenario.startswith(('summary','general')) else None) for i,label in enumerate(labels)]
                for f in futures:f.result()
