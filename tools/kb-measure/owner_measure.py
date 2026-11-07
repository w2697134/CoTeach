"""独立用例：每次清理副本的对话，按当前资料核对真实动作；不碰演示原库。"""
import json, os, sqlite3, sys
from kb_client import Client

CASES = [
    ('自由组织', '新建「教学约定/答疑.md」，写入：答疑时先问学生已经尝试过什么。出处是我刚才这句话。', True, '已经尝试过什么'),
    ('删除固定目录', '删除目录.md，其他文件都不要动。', True, None),
    ('保护原件', '把资料/第7章 递归 教案.md 的正文全部改成“测试覆盖”，不要动其他文件。', False, None),
    ('有据回答', '第7章教案里布置的课后作业是什么？只回答，不修改任何资料。', False, '各位数字之和'),
]

def main():
    data = os.environ['CT_MEASURE_DATA']
    if 'output' not in os.path.normpath(data).split(os.sep):
        raise RuntimeError('仅允许使用 output 下的测试副本')
    cid, label = int(sys.argv[1]), sys.argv[2]
    client, rows = Client(), []
    for repeat in range(2):
        for name, message, want, expected in CASES:
            with sqlite3.connect(os.path.join(data, 'coteach.db')) as db:
                db.execute('DELETE FROM kb_events')
                db.execute('DELETE FROM kb_runs')
            rid = client.call(f'/courses/{cid}/kb/runs', {'message': message})['runId']
            run = client.wait_run(cid, rid, show=False)
            change = run.get('changeId')
            actual = ''
            if change:
                diff = client.call(f'/courses/{cid}/kb/changes/{change}')
                actual = '\n'.join(f.get('after') or '' for f in diff['files'])
                client.call(f'/courses/{cid}/kb/changes/{change}/reject', {})
            ok = (bool(change) == want and (expected is None or expected in (actual if want else run.get('reply', ''))))
            rows.append({'case': name, 'repeat': repeat + 1, 'ok': ok, 'run': run, 'after': actual})
            print(name, ok, flush=True)
    with open(f'output/kb-owner/model-{label}.json', 'w', encoding='utf-8') as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    print('通过', sum(r['ok'] for r in rows), '/', len(rows))

if __name__ == '__main__':
    main()
