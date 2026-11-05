"""尺子：知识库改动里有没有这一届学生的情况（名字、个人成绩、班级统计）"""
import re, sys
sys.path.insert(0, '.')
from kb_client import Client
NAMES = ['贺涛', '刘洋', '赵一鸣', '孙浩', '郑明轩']
STATS = [r'掌握度\s*\d+%', r'均分\s*[\d.]+', r'\d+\s*人薄弱', r'错误率']
def measure(c, cid, change_id):
    d = c.call(f'/courses/{cid}/kb/changes/{change_id}')
    text = '\n'.join(l['s'] for f in d['files'] for h in f['hunks'] for l in h['lines'] if l['t'] == '+')
    names = sum(text.count(n) for n in NAMES)
    stats = sum(len(re.findall(p, text)) for p in STATS)
    no_src = [f['path'] for f in d['files'] if f['path'].startswith('笔记/') and '出处' not in '\n'.join(l['s'] for h in f['hunks'] for l in h['lines'])]
    return {'files': len(d['files']), 'chars': len(text), 'names': names, 'stats': stats, 'no_source': no_src}
