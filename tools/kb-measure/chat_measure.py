"""尺子：
1. 要改的交代有没有真的交出改动
2. 没改却说“改好了”的次数（假话）
3. 问问题的答案是不是知识库里真有的：第7章课后作业要提到「各位数字之和」；
   作业要求要提到知识库里真有的一条（30% / 思路引导 / 自查），并且不能出现知识库里没有的（微信、QQ、抄袭、迟交、扣10）"""
import json, re, sys
sys.path.insert(0, '.')
from kb_client import Client
CHANGE = [
    '规矩里加一条：作业迟交一天扣10%，超过三天不收',
    '第7章这周讲完了，下周开始讲第8章',
    '答疑的时候，学生问到还没讲的内容，先告诉他后面会讲，别展开',
    '把递归笔记里汉诺塔的例子删掉，我们这学期不讲汉诺塔',
]
ASK = ['第7章教案里布置的课后作业是什么？', '规矩里关于作业的要求有哪些？']
CLAIM = re.compile(r'已(经)?(加|删|改|标|记|更新|写|补|整理)|加了|删掉了|删了|改了|记进|标为|写进|更新了')
def answer_ok(msg, reply):
    if msg == ASK[0]:
        return '各位数字之和' in reply
    true = any(k in reply for k in ['30%', '思路引导', '自查'])
    fake = [k for k in ['微信', 'QQ', '抄袭', '迟交', '扣10', '扣 10'] if k in reply]
    return true and not fake
def run_all(c, cid, label, rounds=2):
    rows = []
    for k in range(rounds):
        for msg in CHANGE + ASK:
            rid = c.call(f'/courses/{cid}/kb/runs', {'message': msg})['runId']
            r = c.wait_run(cid, rid, show=False)
            reply = r.get('reply') or ''
            want = msg in CHANGE
            got = bool(r.get('changeId'))
            row = {'msg': msg, 'want_change': want, 'changed': got, 'reply': reply, 'secs': round((r['finishedAt'] - r['createdAt']) / 1000), 'status': r['status']}
            row['false_claim'] = want and not got and bool(CLAIM.search(reply))
            row['ok'] = got if want else (not got and answer_ok(msg, reply))
            rows.append(row)
            if got:
                c.call(f"/courses/{cid}/kb/changes/{r['changeId']}/reject", {})
    ch = [r for r in rows if r['want_change']]
    ask = [r for r in rows if not r['want_change']]
    print(f"{label}: 要改的真改了 {sum(r['ok'] for r in ch)}/{len(ch)}，没改却说改了 {sum(r['false_claim'] for r in ch)} 次，问题答对 {sum(r['ok'] for r in ask)}/{len(ask)}，平均 {sum(r['secs'] for r in rows) / len(rows):.0f} 秒")
    for r in rows:
        if not r['ok']:
            print('   ✗', r['msg'][:18], '|', r['reply'][:120].replace('\n', ' / '))
    return rows
if __name__ == '__main__':
    c = Client()
    rows = run_all(c, int(sys.argv[1]), sys.argv[2])
    json.dump(rows, open(f'chat_{sys.argv[2]}.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
