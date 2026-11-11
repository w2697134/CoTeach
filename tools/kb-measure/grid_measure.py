"""尺子：整理助手是不是按内容分文件夹，老师交的原件和它写的笔记放在一起（不按"谁做的"分成资料、笔记两堆）。

每一遍都从同一份数据副本起一个本机服务，看最后知识库里每份东西放在哪：
  重新分：演示库（原件都在「资料」、笔记都在「笔记」）里老师说一句「按内容重新分一下文件夹」
  交资料：新建一个空库，交 5 份资料，整理完把改动确认掉
  提问、改规矩：不该挪的时候不挪

主要的数：原件和至少一份笔记在同一个文件夹里的比例（应为全部）。
另外记：原件少没少、改动要不要老师确认、按"谁做的"起名的文件夹（资料、笔记、原件……）还在不在。

用法（在 coteach 目录）：python tools/kb-measure/grid_measure.py <对照名> <轮数> [只跑哪几个，逗号隔开]
"""
import json, os, shutil, stat, subprocess, sys, time, urllib.request, urllib.parse, http.cookiejar, uuid

sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'output', 'kb-grid-measure')
BASE_DATA = os.path.join(OUT, 'base')
MATERIALS = os.path.join(ROOT, 'tools', 'kb-measure', 'materials')
PORT = int(os.environ.get('CT_MEASURE_PORT', '18672'))
API = f'http://127.0.0.1:{PORT}/api'
KB = 1
BY_WHO = {'资料', '原件', '笔记', '材料', '原始资料', '整理笔记', '老师原件', '原件区', '笔记区'}

CASES = [
    {'key': '重新分', 'msg': '按内容重新分一下文件夹。', 'want': True},
    {'key': '重新分-明说', 'msg': '别按笔记、资料分了，按内容重新分一下文件夹。', 'want': True},
    {'key': '交资料', 'want': True},
    {'key': '提问', 'msg': '第6章讲了哪些内容？', 'want': False},
    {'key': '改规矩', 'msg': '规矩里加一条：作业里用到网上找的代码，要在注释里写明出处。', 'want': False},
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

    def upload(self, cid, paths):
        boundary = uuid.uuid4().hex
        parts = []
        for p in paths:
            name = os.path.basename(p)
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + open(p, 'rb').read() + b'\r\n')
        data = b''.join(parts) + f'--{boundary}--\r\n'.encode()
        req = urllib.request.Request(f'{API}/knowledge/{cid}/kb/upload', data=data, method='POST',
                                     headers={'x-tv2': '1', 'Content-Type': f'multipart/form-data; boundary={boundary}'})
        return json.loads(self.op.open(req, timeout=300).read().decode())


def start(run_dir):
    env = dict(os.environ, CT_DATA_DIR=run_dir, CT_PORT=str(PORT), CT_HOST='127.0.0.1', CT_TEST_MODE='1', CT_DEMO_MODE='1')
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


def tree(c, kb):
    return c.call(f'/knowledge/{kb}/kb/tree')['files']


def wait_idle(c, kb, limit=900):
    """等这个库里没有在跑的整理，也没有还在读、在整理的交资料"""
    t0 = time.time()
    while time.time() - t0 < limit:
        r = c.call(f'/knowledge/{kb}/kb/runs')
        busy = r.get('activeRunId') or any(x['status'] == 'running' for x in r['runs'])
        intakes = c.call(f'/knowledge/{kb}/intakes')['intakes']
        busy = busy or any(i['status'] in ('uploading', 'reading', 'digesting') for i in intakes)
        if not busy:
            return r['runs']
        time.sleep(3)
    raise RuntimeError('超时')


def layout(files):
    """每份原件所在的文件夹里有没有笔记；按"谁做的"起名的文件夹"""
    folder = lambda p: p.rsplit('/', 1)[0] if '/' in p else ''
    originals = [f for f in files if f.get('protected') or f.get('source')]
    notes = [f for f in files if not (f.get('protected') or f.get('source'))]
    note_dirs = {folder(f['path']) for f in notes}
    # 原件要放进文件夹，而且那个文件夹里有笔记；留在最外层的不算分好
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


def one(case, label, rnd):
    run_dir = os.path.join(OUT, f'{label}-{case["key"]}-{rnd}')
    if os.path.exists(run_dir):  # git 的对象文件是只读的，先去掉只读再删
        shutil.rmtree(run_dir, onexc=lambda func, path, exc: (os.chmod(path, stat.S_IWRITE), func(path)))
    shutil.copytree(BASE_DATA, run_dir)
    p = start(run_dir)
    t0 = time.time()
    try:
        c = Client()
        c.call('/auth/demo', {'role': 'teacher'})
        kb = KB
        if case['key'] == '交资料':
            kb = c.call('/knowledge', {'name': '测量用'})['id']
        known = {r['id'] for r in c.call(f'/knowledge/{kb}/kb/runs')['runs']}
        before = tree(c, kb)
        if case['key'] == '交资料':
            files = sorted(os.path.join(MATERIALS, n) for n in os.listdir(MATERIALS))
            c.upload(kb, files)
        else:
            c.call(f'/knowledge/{kb}/kb/runs', {'message': case['msg']})
        runs = wait_idle(c, kb)
        mine = [r for r in runs if r['id'] not in known]
        broken = [r.get('error') for r in mine if r['status'] == 'error' and any(w in (r.get('error') or '') for w in ('无法连接', 'ECONNRESET', 'timeout', '超时', '暂时不可用'))]
        if broken or not mine:
            return {'case': case['key'], 'round': rnd, 'ok': None, 'why': f'作废：{broken or "没有开始整理"}', 'needConfirm': [], 'tools': [], 'errors': broken,
                    'says': [], 'secs': round(time.time() - t0), 'before': layout(before), 'after': layout(before), 'status': [r['status'] for r in mine]}
        events = [e for r in mine for e in r['events']]
        tools = [e['data'].get('name') for e in events if e['type'] == 'tool' and not e['data'].get('error')]
        errors = [f"{e['data'].get('label')}：{e['data'].get('error')}" for e in events if e['type'] == 'tool' and e['data'].get('error')]
        says = [e['data'].get('text', '') for e in events if e['type'] == 'say']
        pending = c.call(f'/knowledge/{kb}/kb/changes?status=pending')['changes']
        applied = []
        for ch in reversed(pending):
            try:
                c.call(f"/knowledge/{kb}/kb/changes/{ch['id']}/apply", {})
                applied.append(ch['title'])
            except RuntimeError as e:
                errors.append(f'确认改动失败：{e}')
        after = tree(c, kb)
        lb, la = layout(before), layout(after)
        moves = tools.count('move_file')
        k = case['key']
        if k in ('重新分', '重新分-明说', '交资料'):
            ok = la['originals'] == (5 if k == '交资料' else lb['originals']) and la['together'] == la['originals'] and not la['byWho']
            why = f"原件 {la['together']}/{la['originals']} 和笔记同一文件夹；按谁做的分的文件夹 {la['byWho']}；没在一起的 {la['apart']}"
            if k == '交资料':
                # 答疑这些助手只看笔记：交上来的内容要写进笔记，不能只写几句使用说明
                chars = sum(len(c.call(f"/knowledge/{kb}/kb/file?path={urllib.parse.quote(f['path'])}").get('text') or '') for f in after if not (f.get('protected') or f.get('source')))
                ok = ok and la['notes'] >= 4 and chars >= 10000
                why += f"；笔记 {la['notes']} 份 {chars} 字"
        elif k == '提问':
            ok = moves == 0 and lb['paths'] == la['paths']
            why = f'挪了 {moves} 次'
        else:
            ok = moves == 0 and bool(applied)
            why = f'挪了 {moves} 次；交出改动 {applied}'
        return {'case': k, 'round': rnd, 'ok': ok, 'why': why, 'needConfirm': applied, 'tools': tools, 'errors': errors,
                'says': says, 'secs': round(time.time() - t0), 'before': lb, 'after': la, 'status': [r['status'] for r in mine]}
    finally:
        p.terminate()
        try:
            p.wait(10)
        except Exception:
            p.kill()


if __name__ == '__main__':
    label, rounds = sys.argv[1], int(sys.argv[2])
    only = sys.argv[3].split(',') if len(sys.argv) > 3 else None
    rows = []
    for rnd in range(1, rounds + 1):
        for case in CASES:
            if only and case['key'] not in only:
                continue
            for attempt in range(3):
                r = one(case, label, rnd)
                if r['ok'] is not None:
                    break
                print(f"  作废重来（{r['why']}）")
                time.sleep(20)
            rows.append(r)
            print(f"{'✓' if r['ok'] else '✗'} {r['case']} 第{rnd}遍 {r['secs']}秒 | {r['why']} | 要确认 {r['needConfirm']} | 挪 {r['tools'].count('move_file')} 次 | 出错 {r['errors']}")
            print('   之后：', ' / '.join(r['after']['paths']))
            print('   回复：', (r['says'][-1] if r['says'] else '')[:200].replace('\n', ' / '))
    want = [r for r in rows if r['ok'] is not None and next(c for c in CASES if c['key'] == r['case'])['want']]
    guard = [r for r in rows if r['ok'] is not None and not next(c for c in CASES if c['key'] == r['case'])['want']]
    print(f"\n{label}：要分的做对 {sum(r['ok'] for r in want)}/{len(want)}，不该挪的守住 {sum(r['ok'] for r in guard)}/{len(guard)}")
    json.dump(rows, open(os.path.join(OUT, f'{label}.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
