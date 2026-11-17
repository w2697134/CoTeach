# 量助教跟老师说的话有多长
# 读一次尺子的结果（output/ta-measure/<标签>/*.json），算：回话多长、问老师的问题和选项多长、回话里有没有把卡片上已经写着的常规项再说一遍
#   python tools/ta-measure/words.py <标签> [<标签>…]
import json, re, statistics, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# 卡片上已经写着的常规项（满分、截止、迟交），回话里再说一遍就算重复
ROUTINE = re.compile(r'满分\s*\d+|不设截止|截止后仍可|迟交|按常规|常态|默认')


def q(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int((len(xs) - 1) * p))] if xs else 0


for label in sys.argv[1:]:
    d = ROOT / 'output' / 'ta-measure' / label
    replies, questions, options, routine = [], [], [], []
    for f in sorted(d.glob('*.json')):
        r = json.loads(f.read_text(encoding='utf-8'))
        for t in r.get('replies') or []:
            t = (t or '').strip()
            if not t:
                continue
            replies.append(len(t))
            if ROUTINE.search(t):
                routine.append(f"{r['id']}：{t[:80]}")
        for card in r.get('asks') or []:
            for one in card:
                questions.append(len(one['question']))
                options += [len(o) for o in one['options']]
    print(f'== {label}')
    print(f'  回话 {len(replies)} 段：中位 {q(replies, .5)} 字，四分之三 {q(replies, .75)}，最长 {max(replies or [0])}')
    print(f'  问老师 {len(questions)} 个：问题中位 {q(questions, .5)} 字（最长 {max(questions or [0])}），选项中位 {q(options, .5)} 字（最长 {max(options or [0])}）')
    print(f'  回话里重复常规项 {len(routine)} 段')
    for line in routine[:12]:
        print('   ', line)
