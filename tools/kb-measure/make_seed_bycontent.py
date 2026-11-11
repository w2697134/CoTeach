"""做一份对照用的起点数据：本机 server/data 原样复制，只把「王建国的知识库」从「笔记/、资料/」两个文件夹
改成按内容分（一章一个文件夹，原件和整理稿放一起），目录页、规矩、进度里提到的位置跟着改。

摆法照整理助手自己「重新分-明说」时的做法（files-A 两遍都是这样）：原件名字不变，整理稿叫「X（整理）.md」。
全部用老师的接口做（挪文件、改文件），不经过整理助手，所以它没有任何关于「怎么分」的对话记录。

用法（在 coteach 目录）：python tools/kb-measure/make_seed_bycontent.py <输出目录>
之后：CT_MEASURE_DATA=<输出目录> python tools/kb-measure/agent_measure.py ...
"""
import os, shutil, sys, urllib.parse

sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('CT_MEASURE_PORT', '18703')
import agent_measure as m  # noqa: E402

KB = 1
FOLDER = {
    '课程大纲': '课程大纲',
    '第6章 函数基础': '第6章 函数基础',
    '第7章 递归': '第7章 递归',
    '第7章 递归 教案': '第7章 递归',
    '常见错误与调试技巧': '常见错误与调试技巧',
}

CATALOG = """# 目录

- 进度.md：课讲到哪了
- 规矩.md：全课通用的规矩
- 课程大纲/
  - 课程大纲.md：老师交的原件
  - 课程大纲（整理）.md：课程信息、目标、学时安排、考核方式、学习建议
- 第6章 函数基础/
  - 第6章 函数基础.md：老师交的原件
  - 第6章 函数基础（整理）.md：定义与调用、return 与 print、参数形式、参数传递、作用域、设计习惯
- 第7章 递归/
  - 第7章 递归.md、第7章 递归 教案.md：老师交的原件
  - 第7章 递归（整理）.md：递归两要素、调用栈、常见错误、经典例题、递归与循环、三步法
  - 第7章 递归 教案（整理）.md：教学目标、重难点、90 分钟教学过程、板书、课堂练习与课后作业
- 常见错误与调试技巧/
  - 常见错误与调试技巧.md：老师交的原件
  - 常见错误与调试技巧（整理）.md：读报错、按错误类型速查、逻辑错误、调试方法、提交前自查清单
"""


def new_path(old):
    """资料/X.md → 文件夹/X.md；笔记/X.md → 文件夹/X（整理）.md"""
    top, name = old.split('/', 1)
    stem = name[:-3]
    return f'{FOLDER[stem]}/{name}' if top == '资料' else f'{FOLDER[stem]}/{stem}（整理）.md'


def main(out):
    m.rm(out)
    shutil.copytree(m.SRC_DATA, out)
    p = m.start('new', out)
    try:
        c = m.Client()
        c.call('/auth/demo', {'role': 'teacher'})
        files = [f['path'] for f in m.tree(c, KB)]
        moves = {f: new_path(f) for f in files if f.split('/')[0] in ('资料', '笔记')}
        for a, b in moves.items():
            info = c.call(f'/knowledge/{KB}/kb/file?path={urllib.parse.quote(a)}')
            c.call(f'/knowledge/{KB}/kb/move', {'from': a, 'to': b, 'base': info['hash'], 'baseEntryId': info['id']})
        # 规矩、进度里写的出处跟着改（长的名字先换，免得「第7章 递归」先把「第7章 递归 教案」换坏）
        for page in ('规矩.md', '进度.md'):
            info = c.call(f'/knowledge/{KB}/kb/file?path={urllib.parse.quote(page)}')
            text = info['text']
            for a in sorted(moves, key=len, reverse=True):
                text = text.replace(a, moves[a])
            if text != info['text']:
                c.call(f'/knowledge/{KB}/kb/file', {'path': page, 'content': text, 'base': info['hash'], 'baseEntryId': info['id']}, method='PUT')
        info = c.call(f'/knowledge/{KB}/kb/file?path={urllib.parse.quote("目录.md")}')
        c.call(f'/knowledge/{KB}/kb/file', {'path': '目录.md', 'content': CATALOG, 'base': info['hash'], 'baseEntryId': info['id']}, method='PUT')
        after = m.tree(c, KB)
        print('王建国的知识库现在：')
        for f in after:
            print('  ', f['path'], '（原件）' if f.get('protected') or f.get('source') else '')
        left = [f['path'] for f in after if f['path'].split('/')[0] in ('资料', '笔记')]
        assert not left, left
        for page in ('规矩.md', '进度.md', '目录.md'):
            text = c.call(f'/knowledge/{KB}/kb/file?path={urllib.parse.quote(page)}')['text']
            assert '资料/' not in text and '笔记/' not in text, page
    finally:
        p.terminate()
        try:
            p.wait(10)
        except Exception:
            p.kill()
    m.rm(os.path.join(out, 'agent'))
    print('做好了：', out)


if __name__ == '__main__':
    main(sys.argv[1])
