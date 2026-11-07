"""只在验收副本写入旧格式失败步骤，复现历史记录渲染错误。"""
from pathlib import Path
import json,sqlite3,time
root=Path(__file__).resolve().parents[2]
data=(root/'output/kb-review/ui-data').resolve()
assert data.is_relative_to((root/'output').resolve())
with sqlite3.connect(data/'coteach.db') as db:
    kb=db.execute("SELECT id FROM knowledge_bases WHERE kind='class' ORDER BY id DESC LIMIT 1").fetchone()[0]
    t=int(time.time()*1000)
    run=db.execute("INSERT INTO kb_runs(kb_id,kind,status,request,error,created_at,finished_at) VALUES(?,'materials','error',?,?,?,?)",(kb,'失败记录兼容验收','模型返回错误：{"error":"Service unavailable"}',t,t)).lastrowid
    for name,label in [('write_file','写'),('move_file','移动'),('finish','提交改动'),('search','查找')]:
        db.execute("INSERT INTO kb_events(run_id,type,data,created_at) VALUES(?,'tool',?,?)",(run,json.dumps({'name':name,'label':label,'error':'没有实际改动，无需修改时请调用 done'},ensure_ascii=False),t))
    db.execute("INSERT INTO kb_runs(kb_id,kind,status,request,error,created_at,finished_at) VALUES(?,'chat','error',?,?,?,?)",(kb,'重启恢复验收','服务中断，这次未完成，可以重试',t+1,t+1))
    print(json.dumps({'kbId':kb,'runId':run}))
