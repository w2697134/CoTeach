"""真实老师资料上传测试（2026-11-11）。

把一整个文件夹原样交给整理助手：跟页面上把文件夹拖进去、不写话一样，文件名带着文件夹里的位置。
起点照线上：只有一个空的「计科5班」（王建国的知识库已删）。数据是本机 server/data 的副本。
跑完把它交的改动全部确认（像老师点了确认），记下每份文件读得怎样、存到哪、写了哪些笔记、回了什么话。

用法（在 coteach 目录）：python tools/kb-measure/real_upload.py <资料文件夹> <库里|最外层> <标签> [这句话]
结果：output/real-upload/<标签>/（数据副本、server.log、notes/ 下是笔记原文、result.json）
"""
import json, os, shutil, stat, subprocess, sys, time, urllib.request, urllib.parse, http.cookiejar

sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'output', 'real-upload')
SRC_DATA = os.path.join(ROOT, 'server', 'data')
SERVER = os.path.join(ROOT, 'server', 'dist', 'server.mjs')
PORT = int(os.environ.get('CT_MEASURE_PORT', '18693'))
API = f'http://127.0.0.1:{PORT}/api'
CLAUDE = os.environ.get('CT_CLAUDE', 'C:/Users/admin/.local/bin/claude.exe')
BY_WHO = {'资料', '原件', '笔记', '材料', '原始资料', '整理笔记', '老师原件', '原件区', '笔记区', '老师发来的'}


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


def rm(path):
    if os.path.exists(path):  # git 的对象文件和原件是只读的，先去掉只读再删
        shutil.rmtree(path, onexc=lambda func, p, exc: (os.chmod(p, stat.S_IWRITE), func(p)))


def balance(data_dir):
    r = subprocess.run(['node', '--disable-warning=ExperimentalWarning', os.path.join(ROOT, 'tools', 'kb-measure', 'balance.mjs')],
                       env=dict(os.environ, CT_MEASURE_DATA=data_dir), capture_output=True, text=True, encoding='utf-8', cwd=ROOT)
    try:
        return float(json.loads(r.stdout.strip().splitlines()[-1])['balance']['balance_infos'][0]['total_balance'])
    except Exception:
        return None


def start(run_dir):
    env = dict(os.environ, CT_DATA_DIR=run_dir, CT_PORT=str(PORT), CT_HOST='127.0.0.1', CT_DEMO_MODE='1', NODE_ENV='production', CT_CLAUDE=CLAUDE)
    env.pop('CT_TEST_MODE', None)
    log = open(os.path.join(run_dir, 'server.log'), 'w', encoding='utf-8')
    p = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', SERVER], env=env, stdout=log, stderr=subprocess.STDOUT)
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


def is_original(f):
    return bool(f.get('protected') or f.get('source'))


def busy(c):
    r = c.call('/keeper/runs')
    if r.get('activeRunId') or any(x['status'] == 'running' for x in r['runs']):
        return True, r
    for kid in bases(c):
        if any(i['status'] in ('uploading', 'reading', 'digesting') for i in c.call(f'/knowledge/{kid}/intakes')['intakes']):
            return True, r
    return False, r


def find_intake(c, iid):
    """跟一句话一起发的文件不在整理助手那一栏单列，要到各个库的资料列表里找"""
    for kid in bases(c):
        for i in c.call(f'/knowledge/{kid}/intakes')['intakes']:
            if i['id'] == iid:
                return i
    return None


def send(c, message, kb, files):
    """像页面那样：先登记这句话和要传的文件（名字带文件夹里的位置），再分块上传"""
    r = c.call('/keeper/messages', {'message': message, 'kbId': kb, 'files': [{'name': rel, 'size': os.path.getsize(p)} for rel, p in files]})
    intake, size = r['intake'], r['chunkSize']
    for u in r['uploads']:
        data = open(files[u['index']][1], 'rb').read()
        for at in range(u.get('received') or 0, len(data), size):
            req = urllib.request.Request(f"{API}/knowledge/{intake['kbId']}/intakes/{intake['id']}/items/{u['itemId']}?offset={at}",
                                         data=data[at:at + size], method='PUT',
                                         headers={'x-tv2': '1', 'Content-Type': 'application/octet-stream'})
            c.op.open(req, timeout=300).read()
    return r


def main():
    folder, where, label = os.path.abspath(sys.argv[1]), sys.argv[2], sys.argv[3]
    message = sys.argv[4] if len(sys.argv) > 4 else ''
    assert where in ('库里', '最外层')
    run_dir = os.path.join(OUT, label)
    rm(run_dir)
    os.makedirs(OUT, exist_ok=True)
    shutil.copytree(SRC_DATA, run_dir)
    base = os.path.dirname(folder)
    files = sorted((os.path.relpath(os.path.join(d, n), base).replace('\\', '/'), os.path.join(d, n))
                   for d, _, ns in os.walk(folder) for n in ns)
    money0 = balance(run_dir)
    p = start(run_dir)
    t0 = time.time()
    try:
        c = Client()
        c.call('/auth/demo', {'role': 'teacher'})
        for kid in list(bases(c)):  # 照线上：原来的库删掉，只留一个空的「计科5班」
            c.call(f'/knowledge/{kid}', method='DELETE')
        kb = c.call('/knowledge', {'name': '计科5班'})['id']
        known = {r['id'] for r in c.call('/keeper/runs')['runs']}
        print(f'交 {len(files)} 份，{where}，这句话：{message or "（不写话）"}')
        sent = send(c, message, kb if where == '库里' else None, files)
        print(f'上传完 {round(time.time() - t0)} 秒')
        last = 0
        while True:
            on, runs = busy(c)
            if not on:
                break
            if time.time() - t0 > 3600:
                raise RuntimeError('超过一小时还没做完')
            if time.time() - last > 60:
                last = time.time()
                it = find_intake(c, sent['intake']['id'])
                print(f"{round(time.time() - t0)} 秒：资料 {it and it['status']} {it and {k: v for k, v in it['counts'].items() if v}}；整理助手 {'在忙' if runs.get('activeRunId') else '空'}")
            time.sleep(5)
        secs = round(time.time() - t0)
        intake = find_intake(c, sent['intake']['id'])
        items = [{k: it.get(k) for k in ('name', 'kind', 'status', 'method', 'reason', 'advice', 'notes', 'path')} for it in intake['items']]
        mine = [r for r in c.call('/keeper/runs')['runs'] if r['id'] not in known]
        events = [e for r in mine for e in r['events']]
        tools = [{'name': e['data'].get('name'), 'label': e['data'].get('label'), 'error': e['data'].get('error')} for e in events if e['type'] == 'tool']
        says = [e['data'].get('text') for e in events if e['type'] == 'say']
        replies = [r.get('reply') for r in mine if r.get('reply')]
        run_errors = [f"[{r['status']}] {r.get('error')}" for r in mine if r['status'] == 'error']
        pending = {bases(c)[kid]['name']: [{'title': ch['title'], 'files': [f.get('path') for f in ch.get('files', [])]} for ch in c.call(f'/knowledge/{kid}/kb/changes?status=pending')['changes']] for kid in bases(c)}
        applied, apply_errors = [], []
        for kid in bases(c):
            for ch in reversed(c.call(f'/knowledge/{kid}/kb/changes?status=pending')['changes']):
                try:
                    c.call(f"/knowledge/{kid}/kb/changes/{ch['id']}/apply", {})
                    applied.append(f"{bases(c)[kid]['name']}：{ch['title']}")
                except RuntimeError as e:
                    apply_errors.append(f"{ch['title']}：{e}")
        after = {}
        notes_dir = os.path.join(run_dir, 'notes')
        for kid, k in bases(c).items():
            fs = tree(c, kid)
            after[k['name']] = [{'path': f['path'], 'original': is_original(f)} for f in fs]
            for f in fs:
                if is_original(f):
                    continue
                text = c.call(f"/knowledge/{kid}/kb/file?path={urllib.parse.quote(f['path'])}").get('text') or ''
                out = os.path.join(notes_dir, k['name'], *f['path'].split('/'))
                os.makedirs(os.path.dirname(out), exist_ok=True)
                open(out, 'w', encoding='utf-8').write(text)
        dirs = {seg for fs in after.values() for f in fs for seg in f['path'].split('/')[:-1]}
        result = {
            'label': label, 'where': where, 'message': message, 'files': len(files), 'secs': secs,
            'cost': round(money0 - balance(run_dir), 2) if money0 is not None else None,
            'items': items, 'tools': tools, 'says': says, 'replies': replies, 'runErrors': run_errors,
            'pending': pending, 'applied': applied, 'applyErrors': apply_errors, 'after': after,
            'byWho': sorted(d for d in dirs if d in BY_WHO),
        }
        json.dump(result, open(os.path.join(run_dir, 'result.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        counts = {}
        for it in items:
            counts[it['status']] = counts.get(it['status'], 0) + 1
        print(f'\n用时 {secs} 秒，花费 {result["cost"]} 元；资料 {counts}')
        for it in items:
            if it['status'] not in ('done',):
                print(f"  {it['status']} {it['name']}：{it['reason'] or ''} {it['advice'] or ''}")
        for name, fs in after.items():
            print(f'\n【{name}】原件 {sum(f["original"] for f in fs)}，笔记 {sum(not f["original"] for f in fs)}')
            for f in sorted(fs, key=lambda f: f['path']):
                print(('  原件 ' if f['original'] else '  笔记 ') + f['path'])
        print(f"\n按谁做的起名的文件夹：{result['byWho']}")
        print(f"工具出错：{[t for t in tools if t['error']]}")
        print(f"出错：{run_errors + apply_errors}")
        print('\n回话：\n' + '\n---\n'.join(replies))
    finally:
        p.terminate()
        try:
            p.wait(10)
        except Exception:
            p.kill()


if __name__ == '__main__':
    main()
