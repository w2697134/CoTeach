"""整理稿记下了多少要紧的事（2026-11-11 晚）：真实资料测试那套资料里挑出来的 15 条，各遍逐条查整理稿里有没有。
字数多少说明不了记没记全，这把尺子量「新来的助教读了整理稿，能不能知道这些事」（别的助手只能读整理稿，读不到原件）。
用法（在 coteach 目录）：python tools/kb-measure/real_facts.py <标签> [<标签> ...]
"""
import os, re, sys

sys.stdout.reconfigure(encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'output', 'real-upload')
FACTS = [
    ('期中平均分 72.1', r'72\.1'),
    ('及格率 87.8%', r'87\.8'),
    ('运动会停课，实验顺延到 11 月 26 日', r'11\s*月\s*26|11[-./]26'),
    ('期中检查材料 11 月 13 日前交', r'11\s*月\s*13|11[-./]13'),
    ('听课人李国华的意见', r'李国华'),
    ('板书照片：循环结构', r'板书'),
    ('作业本照片：九九乘法表', r'九九乘法表'),
    ('随手记：第5章默认参数多举例', r'默认参数'),
    ('随手记：期中编程题没写 return 扣 2 分', r'return'),
    ('终稿改了编程第2题「不含空格」', r'不含空格'),
    ('作业3', r'作业\s*3|作业三'),
    ('C402 报修', r'报修'),
    ('实验三最后一页是教师答案，发给学生前删掉', r'(删|去掉|撤下|抽掉).{0,12}(答案|参考)|(答案|参考).{0,20}(删|去掉|不要发|别发|不发)'),
    ('课程思政', r'思政'),
    ('学生群里问得多的：PATH 环境变量', r'PATH'),
]


def notes(label):
    text = ''
    for d, _, ns in os.walk(os.path.join(OUT, label, 'notes')):
        for n in ns:
            text += open(os.path.join(d, n), encoding='utf-8').read() + '\n'
    return text


def main():
    labels = sys.argv[1:]
    texts = {l: notes(l) for l in labels}
    print('事'.ljust(30), *[l[:10].ljust(11) for l in labels])
    for name, pat in FACTS:
        print(name[:28].ljust(30), *[('有' if re.search(pat, texts[l]) else '—').ljust(11) for l in labels])
    print('合计'.ljust(30), *[f'{sum(bool(re.search(p, texts[l])) for _, p in FACTS)}/{len(FACTS)}'.ljust(11) for l in labels])
    print('整理稿字数'.ljust(28), *[str(len(texts[l])).ljust(11) for l in labels])


if __name__ == '__main__':
    main()
