"""尺子：整理助手只有一个、管老师所有的知识库（2026-11-10，换成 Claude Code 外壳那次）。

每一遍从同一份数据副本（本机 server/data）起一个本机服务，做一件事，看各个知识库最后的样子和它的回话：
  库内（老师在「王建国的知识库」里说）：交资料（新建「测量用」库在里面交 5 份）、提问、改规矩、重新分-明说
  最外层（老师在全部知识库那一层说）：跨库提问、跨库挪、最外层交资料
跨库提问、最外层交资料之前，先建一个「数据结构」库，放一份「栈与队列」笔记。

旧的整理助手没有最外层：跨库提问、跨库挪改成在「王建国的知识库」里说；最外层交资料做不到，不量。

2026-11-11 起交资料就是说话带附件（像聊天发图、发文件），多量四件：
  发文件不写话（库里）、发图问问题（截图里写了什么，不该存）、发文件让存（最外层，说存进「数据结构」）、最外层发文件不写话。
旧做法（线上那版）只量发图问问题：截图按交资料交，看它答没答、存没存。

用法（在 coteach 目录）：python tools/kb-measure/agent_measure.py <对照名> <new|old> <轮数> [只跑哪几个，逗号隔开]
"""
import json, os, shutil, stat, subprocess, sys, time, urllib.request, urllib.parse, http.cookiejar, uuid

sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'output', 'kb-agent-measure')
# 起点数据：默认本机 server/data；做对照时换成别的副本（比如 make_seed_bycontent.py 做的「按内容分」那份）
SRC_DATA = os.environ.get('CT_MEASURE_DATA') or os.path.join(ROOT, 'server', 'data')
HERE = os.path.dirname(os.path.abspath(__file__))
MATERIALS = os.path.join(HERE, 'materials')
ROUTED = os.path.join(HERE, 'materials-route')
SEED = os.path.join(HERE, 'seed-ds', '栈与队列.md')
CHAT = os.path.join(HERE, 'materials-chat')
PORT = int(os.environ.get('CT_MEASURE_PORT', '18692'))
API = f'http://127.0.0.1:{PORT}/api'
KB = 1
BY_WHO = {'资料', '原件', '笔记', '材料', '原始资料', '整理笔记', '老师原件', '原件区', '笔记区'}
SERVERS = {
    'new': os.path.join(ROOT, 'server', 'dist', 'server.mjs'),
    'old': os.environ.get('CT_OLD_SERVER', ''),
}
CLAUDE = os.environ.get('CT_CLAUDE', 'C:/Users/admin/.local/bin/claude.exe')

CASES = [
    {'key': '交资料', 'want': True},
    {'key': '提问', 'msg': '第6章讲了哪些内容？', 'want': False},
    {'key': '改规矩', 'msg': '规矩里加一条：作业里用到网上找的代码，要在注释里写明出处。', 'want': False},
    {'key': '重新分-明说', 'msg': '别按笔记、资料分了，按内容重新分一下文件夹。', 'want': True},
    {'key': '跨库提问', 'msg': '数据结构那个库里，栈和队列是怎么讲的？', 'top': True, 'seed': True, 'want': False},
    {'key': '跨库挪', 'msg': '新建一个知识库叫「函数专题」，把第6章的笔记和原件都挪过去。', 'top': True, 'want': True},
    {'key': '最外层交资料', 'top': True, 'seed': True, 'want': True, 'newOnly': True},
    {'key': '发文件不写话', 'want': True, 'newOnly': True},
    {'key': '发图问问题', 'msg': '这张截图里，右边最下面老师问了什么，整理助手怎么答的？', 'want': False},
    {'key': '发文件让存', 'msg': '把这份存进「数据结构」库。', 'top': True, 'seed': True, 'want': True, 'newOnly': True},
    {'key': '最外层发文件不写话', 'top': True, 'seed': True, 'want': True, 'newOnly': True},
    # 11-11 老师在线上就这么试的：最外层只贴一张界面截图，不写话。只看它怎么办（存到哪、怎么回），不判对错
    {'key': '最外层发截图不写话', 'top': True, 'want': True, 'newOnly': True},
]


class Client:
    def __init__(self):
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, path, data=None, method=None):
        body = json.dumps(data, ensure_ascii=False).encode() if data is not None else None
        req = urllib.request.Request(API + path, data=body, method=method or ('POST' if data is not None else 'GET'),
                                     headers={'x-tv2': '1', 'Content-Type': 'application/json'})
        try:
            return json.loads(self.op.open(req, timeout=300).read().decode())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f'{e.code} {e.read().decode()}')

    def upload(self, url, paths):
        boundary = uuid.uuid4().hex
        parts = []
        for p in paths:
            name = os.path.basename(p)
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + open(p, 'rb').read() + b'\r\n')
        data = b''.join(parts) + f'--{boundary}--\r\n'.encode()
        req = urllib.request.Request(API + url, data=data, method='POST',
                                     headers={'x-tv2': '1', 'Content-Type': f'multipart/form-data; boundary={boundary}'})
        return json.loads(self.op.open(req, timeout=900).read().decode())


def send(c, url, message, kb, paths):
    """像页面那样：先登记这句话和要传的文件，再分块上传"""
    files = [{'name': os.path.basename(p), 'size': os.path.getsize(p)} for p in paths]
    body = {'message': message, 'files': files}
    if url == '/keeper/messages':
        body['kbId'] = kb
    r = c.call(url, body)
    intake, size = r['intake'], r['chunkSize']
    for u in r['uploads']:
        data = open(paths[u['index']], 'rb').read()
        for at in range(0, len(data), size):
            req = urllib.request.Request(f"{API}/knowledge/{intake['kbId']}/intakes/{intake['id']}/items/{u['itemId']}?offset={at}",
                                         data=data[at:at + size], method='PUT',
                                         headers={'x-tv2': '1', 'Content-Type': 'application/octet-stream'})
            c.op.open(req, timeout=300).read()
    return r


def originals(snap):
    return {kid: sorted(f['path'] for f in v['files'] if f.get('protected') or f.get('source')) for kid, v in snap.items()}


def rm(path):
    if os.path.exists(path):  # git 的对象文件和原件是只读的，先去掉只读再删
        shutil.rmtree(path, onexc=lambda func, p, exc: (os.chmod(p, stat.S_IWRITE), func(p)))


def start(engine, run_dir):
    env = dict(os.environ, CT_DATA_DIR=run_dir, CT_PORT=str(PORT), CT_HOST='127.0.0.1', CT_DEMO_MODE='1', NODE_ENV='production', CT_CLAUDE=CLAUDE)
    env.pop('CT_TEST_MODE', None)
    log = open(os.path.join(run_dir, 'server.log'), 'w', encoding='utf-8')
    p = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', SERVERS[engine]], env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(120):
        try:
            urllib.request.urlopen(f'{API}/health', timeout=2)
            return p
        except Exception:
            time.sleep(0.5)
    p.kill()
    raise RuntimeError('服务没起来，看 ' + run_dir)


def bases(c):
    return {k['id']: k for k in c.call('/knowledge')['knowledgeBases']}


def tree(c, kb):
    return c.call(f'/knowledge/{kb}/kb/tree')['files']


def all_runs(c, engine):
    if engine == 'new':
        return c.call('/keeper/runs')
    runs, active = [], None
    for kid in bases(c):
        r = c.call(f'/knowledge/{kid}/kb/runs')
        runs += r['runs']
        active = active or r.get('activeRunId')
    return {'runs': sorted(runs, key=lambda r: r['id']), 'activeRunId': active}


def wait_idle(c, engine, limit=2400):
    """等整理助手空下来，交的资料也都读完、整理完"""
    t0 = time.time()
    while time.time() - t0 < limit:
        r = all_runs(c, engine)
        busy = r.get('activeRunId') or any(x['status'] == 'running' for x in r['runs'])
        for kid in bases(c):
            busy = busy or any(i['status'] in ('uploading', 'reading', 'digesting') for i in c.call(f'/knowledge/{kid}/intakes')['intakes'])
        if not busy:
            return r['runs']
        time.sleep(4)
    raise RuntimeError('超时')


def layout(files):
    """每份原件所在的文件夹里有没有笔记；按"谁做的"起名的文件夹"""
    folder = lambda p: p.rsplit('/', 1)[0] if '/' in p else ''
    originals = [f for f in files if f.get('protected') or f.get('source')]
    notes = [f for f in files if not (f.get('protected') or f.get('source'))]
    note_dirs = {folder(f['path']) for f in notes}
    together = [f['path'] for f in originals if folder(f['path']) and folder(f['path']) in note_dirs]
    dirs = {seg for f in files for seg in f['path'].split('/')[:-1]}
    return {
        'originals': len(originals),
        'notes': len(notes),
        'together': len(together),
        'apart': sorted(f['path'] for f in originals if f['path'] not in together),
        'byWho': sorted(d for d in dirs if d in BY_WHO),
        'paths': sorted(f['path'] for f in files),
    }


def note_chars(c, kb, files):
    return sum(len(c.call(f"/knowledge/{kb}/kb/file?path={urllib.parse.quote(f['path'])}").get('text') or '') for f in files if not (f.get('protected') or f.get('source')))


def snapshot(c):
    return {kid: {'name': k['name'], 'files': tree(c, kid)} for kid, k in bases(c).items()}


def pending_all(c):
    return {kid: c.call(f'/knowledge/{kid}/kb/changes?status=pending')['changes'] for kid in bases(c)}


def apply_all(c, errors):
    applied = []
    for kid, changes in pending_all(c).items():
        for ch in reversed(changes):
            try:
                c.call(f"/knowledge/{kid}/kb/changes/{ch['id']}/apply", {})
                applied.append(f"{kid}:{ch['title']}")
            except RuntimeError as e:
                errors.append(f'确认改动失败：{e}')
    return applied


def one(case, engine, label, rnd):
    run_dir = os.path.join(OUT, f'{label}-{case["key"]}-{rnd}')
    rm(run_dir)
    shutil.copytree(SRC_DATA, run_dir)
    p = start(engine, run_dir)
    t0 = time.time()
    k = case['key']
    try:
        c = Client()
        c.call('/auth/demo', {'role': 'teacher'})
        if case.get('seed'):
            ds = c.call('/knowledge', {'name': '数据结构'})['id']
            c.call(f'/knowledge/{ds}/kb/file', {'path': '栈与队列.md', 'content': open(SEED, encoding='utf-8').read(), 'base': None}, method='PUT')
        target = KB
        if k in ('交资料', '发文件不写话'):  # 交进一个新建的空库（王建国的库里本来就有这几份）
            target = c.call('/knowledge', {'name': '测量用'})['id']
        known = {r['id'] for r in all_runs(c, engine)['runs']}
        before = snapshot(c)
        pending_before = sum(len(v) for v in pending_all(c).values())
        top = case.get('top') and engine == 'new'
        if k == '交资料':
            c.upload(f'/knowledge/{target}/kb/upload', sorted(os.path.join(MATERIALS, n) for n in os.listdir(MATERIALS)))
        elif k == '最外层交资料':
            c.upload('/keeper/upload', sorted(os.path.join(ROUTED, n) for n in os.listdir(ROUTED)))
        elif k == '发文件不写话':
            send(c, '/keeper/messages', '', target, sorted(os.path.join(MATERIALS, n) for n in os.listdir(MATERIALS)))
        elif k == '最外层发文件不写话':
            send(c, '/keeper/messages', '', None, sorted(os.path.join(ROUTED, n) for n in os.listdir(ROUTED)))
        elif k == '发文件让存':
            send(c, '/keeper/messages', case['msg'], None, [os.path.join(ROUTED, '第3章 链表.md')])
        elif k == '最外层发截图不写话':
            send(c, '/keeper/messages', '', None, [os.path.join(CHAT, '截图.png')])
        elif k == '发图问问题':
            pic = [os.path.join(CHAT, '截图.png')]
            if engine == 'new':
                send(c, '/keeper/messages', case['msg'], KB, pic)
            else:  # 线上那版：截图按交资料交，随资料说的话带上
                send(c, f'/knowledge/{KB}/intakes', case['msg'], KB, pic)
        elif engine == 'new':
            c.call('/keeper/runs', {'message': case['msg'], 'kbId': None if top else KB})
        else:
            c.call(f'/knowledge/{KB}/kb/runs', {'message': case['msg']})
        runs = wait_idle(c, engine)
        mine = [r for r in runs if r['id'] not in known]
        broken = [r.get('error') for r in mine if r['status'] == 'error' and any(w in (r.get('error') or '') for w in ('无法连接', 'ECONNRESET', 'timeout', '暂时不可用', 'overloaded', '529'))]
        if broken or not mine:
            return {'case': k, 'round': rnd, 'ok': None, 'why': f'作废：{broken or "没有开始"}', 'secs': round(time.time() - t0), 'errors': broken, 'reply': '', 'tools': [], 'after': {}}
        events = [e for r in mine for e in r['events']]
        tools = [e['data'].get('name') for e in events if e['type'] == 'tool' and not e['data'].get('error')]
        errors = [f"{e['data'].get('label')}：{e['data'].get('error')}" for e in events if e['type'] == 'tool' and e['data'].get('error')]
        errors += [f"[{r['status']}] {r.get('error')}" for r in mine if r['status'] == 'error']
        reply = '\n'.join(r.get('reply') or '' for r in mine if r['kind'] == 'chat')
        pending_after = pending_all(c)
        new_pending = sum(len(v) for v in pending_after.values()) - pending_before
        pending_files = [f['path'] for v in pending_after.values() for ch in v for f in ch.get('files', [])]
        applied = apply_all(c, errors)
        after = snapshot(c)
        moves = tools.count('move_file') + tools.count('move_to_knowledge_base')
        same_paths = all(sorted(f['path'] for f in after[kid]['files']) == sorted(f['path'] for f in before[kid]['files']) for kid in before if kid in after) and set(after) == set(before)
        if k == '发文件不写话':
            k = '交资料'
        if k == '最外层发文件不写话':
            k = '最外层交资料'
        if k == '交资料':
            la = layout(after[target]['files'])
            chars = note_chars(c, target, after[target]['files'])
            leaked = [kid for kid in before if kid != target and sorted(f['path'] for f in after.get(kid, {}).get('files', [])) != sorted(f['path'] for f in before[kid]['files'])]
            ok = la['originals'] == 5 and la['together'] == 5 and not la['byWho'] and la['notes'] >= 4 and chars >= 10000 and not leaked
            why = f"原件 {la['together']}/{la['originals']} 和笔记同一文件夹；笔记 {la['notes']} 份 {chars} 字；按谁做的分 {la['byWho']}；没在一起 {la['apart']}；动了别的库 {leaked}"
        elif k == '提问':
            ok = same_paths and new_pending == 0 and bool(reply.strip())
            why = f'文件没动 {same_paths}；新改动 {new_pending}'
        elif k == '改规矩':
            rules = next((f for f in after[KB]['files'] if f['path'].endswith('规矩.md')), None)
            text = c.call(f"/knowledge/{KB}/kb/file?path={urllib.parse.quote(rules['path'])}").get('text') if rules else ''
            ok = same_paths and new_pending >= 1 and '出处' in (text or '') and '注释' in (text or '')
            why = f'文件位置没动 {same_paths}；新改动 {new_pending}；确认 {applied}；规矩里有出处、注释 {"出处" in (text or "") and "注释" in (text or "")}'
        elif k == '重新分-明说':
            la = layout(after[KB]['files'])
            ok = la['originals'] == layout(before[KB]['files'])['originals'] and la['together'] == la['originals'] and not la['byWho']
            why = f"原件 {la['together']}/{la['originals']} 和笔记同一文件夹；按谁做的分 {la['byWho']}；没在一起 {la['apart']}"
        elif k == '发图问问题':
            # 截图右下角：老师问「现在一共有几个知识库？」，整理助手答「目前只有 1 个知识库：王建国的知识库。」
            said = reply + ' '.join(e['data'].get('text', '') for e in events if e['type'] == 'say')
            hit = '几个知识库' in said and any(w in said for w in ('1 个', '1个', '一个'))
            saved = originals(after) != originals(before)
            ok = hit and not saved
            why = f'答出截图里那句 {hit}；存进了知识库 {saved}'
        elif k == '发文件让存':
            ds = next((kid for kid, v in after.items() if v['name'] == '数据结构'), None)
            there = [p for p in originals(after).get(ds, []) if '链表' in p]
            elsewhere = [p for kid, ps in originals(after).items() if kid != ds for p in ps if '链表' in p]
            ok = bool(there) and not elsewhere
            why = f'存进数据结构 {there}；存到别处 {elsewhere}'
        elif k == '跨库提问':
            hits = [w for w in ('盘子', '打饭', '假溢出') if w in reply]
            ok = same_paths and new_pending == 0 and len(hits) >= 2
            why = f'回话里用到「数据结构」库的内容 {hits}；文件没动 {same_paths}；新改动 {new_pending}'
        elif k == '跨库挪':
            fx = next((kid for kid, v in after.items() if v['name'] == '函数专题'), None)
            there = [f for f in after[fx]['files'] if '第6章' in f['path']] if fx else []
            left = [f['path'] for f in after[KB]['files'] if '第6章' in f['path']]
            ok = bool(fx) and any(f.get('protected') for f in there) and any(not f.get('protected') for f in there) and not left
            why = f"新库 {'有' if fx else '没有'}；第6章在新库 {[f['path'] for f in there]}；还留在原库 {left}"
        elif k == '最外层发截图不写话':
            new = {after[kid]['name']: sorted(set(ps) - set(originals(before).get(kid, []))) for kid, ps in originals(after).items()}
            new = {n: ps for n, ps in new.items() if ps}
            ok = True
            why = f'存了 {new or "没存"}；新库 {[v["name"] for kid, v in after.items() if kid not in before]}'
        else:  # 最外层交资料
            def where(name):
                return [(kid, f['path']) for kid, v in after.items() for f in v['files'] if (f.get('protected') or f.get('source')) and name in f['path']]
            ds = next((kid for kid, v in after.items() if v['name'] == '数据结构'), None)
            ll, st, en = where('链表'), where('第4章 栈'), where('大学英语')
            ds_ok = ds is not None and all(kid == ds for kid, _ in ll + st) and ll and st and layout(after[ds]['files'])['together'] == layout(after[ds]['files'])['originals']
            en_kb = en[0][0] if en else None
            en_ok = en_kb not in (None, KB, ds) and layout(after[en_kb]['files'])['notes'] >= 1
            in_main = [p for kid, p in ll + st + en if kid == KB]
            ok = bool(ds_ok and en_ok and not in_main)
            why = f"链表 {ll}；栈 {st}；英语 {en}（{after[en_kb]['name'] if en_kb else '无'}）；数据结构库原件都和笔记在一起 {bool(ds_ok)}；留在王建国的库 {in_main}"
        return {'case': k, 'round': rnd, 'ok': ok, 'why': why, 'secs': round(time.time() - t0), 'tools': tools, 'errors': errors, 'reply': reply,
                'applied': applied, 'pendingFiles': pending_files, 'after': {v['name']: layout(v['files'])['paths'] for v in after.values()}}
    finally:
        p.terminate()
        try:
            p.wait(10)
        except Exception:
            p.kill()


if __name__ == '__main__':
    label, engine, rounds = sys.argv[1], sys.argv[2], int(sys.argv[3])
    only = sys.argv[4].split(',') if len(sys.argv) > 4 else None
    os.makedirs(OUT, exist_ok=True)
    rows = []
    for rnd in range(1, rounds + 1):
        for case in CASES:
            if (only and case['key'] not in only) or (engine == 'old' and case.get('newOnly')):
                continue
            for attempt in range(3):
                r = one(case, engine, label, rnd)
                if r['ok'] is not None:
                    break
                print(f"  作废重来（{r['why']}）")
                time.sleep(20)
            rows.append(r)
            print(f"{'✓' if r['ok'] else '✗'} {r['case']} 第{rnd}遍 {r['secs']}秒 | {r['why']} | 出错 {r['errors'][:3]}")
            print('   回话：', (r['reply'] or '')[:300].replace('\n', ' / '))
            json.dump(rows, open(os.path.join(OUT, f'{label}.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    done = [r for r in rows if r['ok'] is not None]
    print(f"\n{label}（{engine}）：做对 {sum(r['ok'] for r in done)}/{len(done)}")
    for key in dict.fromkeys(r['case'] for r in done):
        rs = [r for r in done if r['case'] == key]
        print(f"  {key}：{sum(r['ok'] for r in rs)}/{len(rs)}，平均 {round(sum(r['secs'] for r in rs) / len(rs))} 秒")
