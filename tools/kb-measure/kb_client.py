"""本地测试用的知识库接口客户端（只连本机 18660，演示老师登录）"""
import http.cookiejar
import json
import os
import sys
import time
import urllib.request
import uuid

sys.stdout.reconfigure(encoding='utf-8')
B = 'http://127.0.0.1:18660/api'


class Client:
    def __init__(self):
        cj = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        self.call('/auth/demo', {'role': 'teacher'})

    def call(self, path, data=None, method=None):
        body = json.dumps(data, ensure_ascii=False).encode() if data is not None else None
        req = urllib.request.Request(B + path, data=body, method=method or ('POST' if data is not None else 'GET'),
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
        req = urllib.request.Request(f'{B}/courses/{cid}/kb/upload', data=data, method='POST',
                                     headers={'x-tv2': '1', 'Content-Type': f'multipart/form-data; boundary={boundary}'})
        return json.loads(self.op.open(req, timeout=300).read().decode())

    def wait_run(self, cid, run_id, show=True, limit=900):
        seen = set()
        t0 = time.time()
        while time.time() - t0 < limit:
            runs = self.call(f'/courses/{cid}/kb/runs')['runs']
            run = next(r for r in runs if r['id'] == run_id)
            for e in run['events']:
                if e['id'] in seen:
                    continue
                seen.add(e['id'])
                if show:
                    d = e['data']
                    if e['type'] == 'tool':
                        extra = d.get('path') or d.get('text') or (f"{d.get('from')} → {d.get('to')}" if d.get('from') else '') or d.get('title') or ''
                        err = f"  ✗ {d['error']}" if d.get('error') else ''
                        print(f"  [{d.get('label')}] {extra}{'  ' + str(d.get('chars')) + '字' if d.get('chars') else ''}{err}")
                    elif e['type'] == 'say':
                        print('  [说]', d['text'][:300].replace('\n', ' / '))
                    else:
                        print(f"  [{e['type']}]", json.dumps(d, ensure_ascii=False)[:300])
            if run['status'] != 'running':
                print(f"== {run['status']} 用时 {int(time.time() - t0)} 秒  回复：{(run.get('reply') or '')[:200]}  错误：{run.get('error')}")
                return run
            time.sleep(3)
        raise RuntimeError('超时')
