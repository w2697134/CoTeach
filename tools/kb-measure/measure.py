"""尺子：知识库改动里有没有这一届学生的情况（名字、个人成绩、班级统计）"""
import re, sys
sys.path.insert(0, '.')
from kb_client import Client
NAMES = ['贺涛', '刘洋', '赵一鸣', '孙浩', '郑明轩']
STATS = [r'掌握度\s*\d+%', r'均分\s*[\d.]+', r'\d+\s*人薄弱', r'错误率']
def has_source(text):
    return bool(re.search(r'出处|来源|依据|来自\s*[《「]', text))
def measure(c, cid, change_id):
    d = c.call(f'/courses/{cid}/kb/changes/{change_id}')
    text = '\n'.join(f.get('after') or '' for f in d['files'])
    names = sum(text.count(n) for n in NAMES)
    stats = sum(len(re.findall(p, text)) for p in STATS)
    # 目录是导航；其余有正文的改动都检查，不能因助手改了目录名而漏量。
    no_src = [f['path'] for f in d['files'] if f.get('after') and f['path'].split('/')[-1] != '目录.md' and not has_source(f['after'])]
    return {'files': len(d['files']), 'chars': len(text), 'names': names, 'stats': stats, 'no_source': no_src}
