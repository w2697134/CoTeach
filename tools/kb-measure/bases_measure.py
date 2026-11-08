"""尺子：整理助手能不能按老师的话动知识库本身（新建、改名、挪文件、删空库），不该动的时候不动。

每一遍都从同一份数据副本起一个本机服务，只发一句话，看最后的状态：
  A 要动的：做对了几遍（库的名字、挪过去的文件一份不多一份不少）
  B 不该动的：有几遍动了知识库本身（应为 0）；改规矩的那句照旧交出改动

用法（在 coteach 目录）：python tools/kb-measure/bases_measure.py <对照名> <轮数>
  环境变量 CT_EVAL_KB_TOOLS=0 时整理助手没有这些工具（对照组）
"""
import json, os, shutil, subprocess, sys, time, urllib.request, http.cookiejar

sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASE_DATA = os.path.join(ROOT, 'output', 'kb-bases-measure', 'base')
PORT = int(os.environ.get('CT_MEASURE_PORT', '18671'))
API = f'http://127.0.0.1:{PORT}/api'
KB = 1
R7 = {'笔记/第7章 递归 教案.md', '笔记/第7章 递归.md', '资料/第7章 递归 教案.md', '资料/第7章 递归.md'}
DEBUG = {'笔记/常见错误与调试技巧.md', '资料/常见错误与调试技巧.md'}
STRUCT = {'create_knowledge_base', 'rename_knowledge_base', 'move_to_knowledge_base', 'delete_knowledge_base'}

CASES = [
    {'key': '新建并挪入', 'msg': '把第7章递归相关的笔记和资料单独放进一个新的知识库，叫「递归专题」。', 'want': True},
    {'key': '改名', 'msg': '把这个知识库改名叫「Python 程序设计」。', 'want': True},
    {'key': '删空库', 'msg': '「临时」那个知识库用不上了，删掉吧。', 'want': True, 'setup': ['临时']},
    {'key': '挪到已有库', 'msg': '把常见错误与调试技巧的笔记和资料挪到「调试技巧」那个知识库。', 'want': True, 'setup': ['调试技巧']},
    {'key': '提问', 'msg': '第6章讲了哪些内容？', 'want': False},
    {'key': '改规矩', 'msg': '规矩里加一条：作业里用到网上找的代码，要在注释里写明出处。', 'want': False},
    {'key': '接着问', 'msg': '把第7章递归相关的笔记和资料单独放进一个新的知识库，叫「递归专题」。', 'then': '刚才挪过去了吗？挪了哪几份？', 'want': True},
]


class Client:
    def __init__(self):
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, path, data=None, method=None):
        body = json.dumps(data, ensure_ascii=False).encode() if data is not None else None
        req = urllib.request.Request(API + path, data=body, method=method or ('POST' if data is not None else 'GET'),
                                     headers={'x-tv2': '1', 'Content-Type': 'application/json'})
        try:
            return json.loads(self.op.open(req, timeout=120).read().decode())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f'{e.code} {e.read().decode()}')


def start(run_dir, tools_on):
    env = dict(os.environ, CT_DATA_DIR=run_dir, CT_PORT=str(PORT), CT_HOST='127.0.0.1', CT_TEST_MODE='1', CT_DEMO_MODE='1',
               CT_EVAL_KB_TOOLS='1' if tools_on else '0')
    log = open(os.path.join(run_dir, 'server.log'), 'w', encoding='utf-8')
    p = subprocess.Popen(['node', '--import', 'tsx', 'src/index.ts'], cwd=os.path.join(ROOT, 'server'), env=env,
                         stdout=log, stderr=subprocess.STDOUT)
    for _ in range(120):
        try:
            urllib.request.urlopen(f'{API}/health', timeout=2)
            return p
        except Exception:
            time.sleep(0.5)
    p.kill()
    raise RuntimeError('服务没起来，看 ' + run_dir)


def state(c):
    kbs = c.call('/knowledge')['knowledgeBases']
    out = {}
    for k in kbs:
        files = c.call(f"/knowledge/{k['id']}/kb/tree")['files']
        out[k['name']] = {'id': k['id'], 'files': sorted(f['path'] for f in files)}
    return out


def judge(case, before, after, run, tools):
    names = set(after)
    orig = next(n for n, v in before.items() if v['id'] == KB)
    me = next(n for n, v in after.items() if v['id'] == KB)
    moved_out = set(before[orig]['files']) - set(after[me]['files'])
    struct_ops = [t for t in tools if t in STRUCT]
    k = case['key']
    if k == '新建并挪入':
        got = set(after.get('递归专题', {}).get('files', []))
        return got == R7 and moved_out == R7, f'递归专题={sorted(got)} 挪走={sorted(moved_out)}'
    if k == '改名':
        return me == 'Python 程序设计' and not moved_out, f'名字={me} 挪走={sorted(moved_out)}'
    if k == '删空库':
        return '临时' not in names and not moved_out and me == orig, f'还有={sorted(names)}'
    if k == '挪到已有库':
        got = set(after.get('调试技巧', {}).get('files', []))
        return got == DEBUG and moved_out == DEBUG, f'调试技巧={sorted(got)} 挪走={sorted(moved_out)}'
    if k == '提问':
        return not struct_ops and not moved_out and names == set(before), f'动作={struct_ops}'
    if k == '接着问':
        got = set(after.get('递归专题', {}).get('files', []))
        said = run.get('reply2') or ''
        denied = any(w in said for w in ['没有挪', '没挪', '未修改', '没有修改', '还没有'])
        return got == R7 and not denied, f'递归专题={len(got)}份 第二句回复={said[:80]}'
    if k == '改规矩':
        return not struct_ops and not moved_out and bool(run.get('changeId')), f'动作={struct_ops} 改动={run.get("changeId")}'


def one(case, label, rnd, tools_on):
    run_dir = os.path.join(ROOT, 'output', 'kb-bases-measure', f'{label}-{case["key"]}-{rnd}')
    shutil.rmtree(run_dir, ignore_errors=True)
    shutil.copytree(BASE_DATA, run_dir)
    p = start(run_dir, tools_on)
    try:
        c = Client()
        c.call('/auth/demo', {'role': 'teacher'})
        for name in case.get('setup', []):
            c.call('/knowledge', {'name': name})
        before = state(c)
        rid = c.call(f'/knowledge/{KB}/kb/runs', {'message': case['msg']})['runId']
        t0 = time.time()
        while True:
            run = next(r for r in c.call(f'/knowledge/{KB}/kb/runs')['runs'] if r['id'] == rid)
            if run['status'] != 'running':
                break
            if time.time() - t0 > 600:
                raise RuntimeError('超时')
            time.sleep(2)
        if case.get('then'):
            rid2 = c.call(f'/knowledge/{KB}/kb/runs', {'message': case['then']})['runId']
            while True:
                run2 = next(r for r in c.call(f'/knowledge/{KB}/kb/runs')['runs'] if r['id'] == rid2)
                if run2['status'] != 'running':
                    break
                time.sleep(2)
            says2 = [e['data'].get('text', '') for e in run2['events'] if e['type'] == 'say']
            run['reply2'] = says2[-1] if says2 else (run2.get('reply') or '')
        after = state(c)
        tools = [e['data'].get('name') for e in run['events'] if e['type'] == 'tool' and not e['data'].get('error')]
        errors = [f"{e['data'].get('label')}：{e['data'].get('error')}" for e in run['events'] if e['type'] == 'tool' and e['data'].get('error')]
        says = [e['data'].get('text', '') for e in run['events'] if e['type'] == 'say']
        ok, why = judge(case, before, after, run, tools)
        return {'case': case['key'], 'round': rnd, 'ok': ok, 'why': why, 'status': run['status'], 'tools': tools, 'errors': errors, 'reply2': run.get('reply2'),
                'reply': run.get('reply') or '', 'says': says, 'secs': round(time.time() - t0), 'after': after}
    finally:
        p.terminate()
        try:
            p.wait(10)
        except Exception:
            p.kill()


if __name__ == '__main__':
    label, rounds = sys.argv[1], int(sys.argv[2])
    tools_on = os.environ.get('CT_EVAL_KB_TOOLS', '1') != '0'
    only = sys.argv[3].split(',') if len(sys.argv) > 3 else None
    rows = []
    for rnd in range(1, rounds + 1):
        for case in CASES:
            if only and case['key'] not in only:
                continue
            r = one(case, label, rnd, tools_on)
            rows.append(r)
            print(f"{'✓' if r['ok'] else '✗'} {r['case']} 第{rnd}遍 {r['secs']}秒 | {r['why']} | 工具 {r['tools']} | 出错 {r['errors']}")
            print('   回复：', (r['says'][-1] if r['says'] else r['reply'])[:200].replace('\n', ' / '))
    want = [r for r in rows if next(c for c in CASES if c['key'] == r['case'])['want']]
    guard = [r for r in rows if not next(c for c in CASES if c['key'] == r['case'])['want']]
    print(f"\n{label}：要动的做对 {sum(r['ok'] for r in want)}/{len(want)}，不该动的守住 {sum(r['ok'] for r in guard)}/{len(guard)}")
    out = os.path.join(ROOT, 'output', 'kb-bases-measure', f'{label}.json')
    json.dump(rows, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
