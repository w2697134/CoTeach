"""对比几遍真实资料上传测试（real_upload.py 跑出来的）：2026-11-11 晚收尾知识库时用。

每一遍看这几样：
- 学生材料（名单、期中成绩、软工2402平时成绩、作业2 的 6 份）存了几份：目标 9/9；
- 整理稿（不是原件的文件）里出现几个学生姓名、学号：目标 0；
- 一模一样的两份第3章课件存了几份：目标 1；
- 工作记录里报错几条、去找已删的「王建国的知识库」几次：目标 0；
- 分了哪些库、各几份原件几份整理稿、有没有按谁做的起名的文件夹；回话多长、提没提重复和学生材料。
用法（在 coteach 目录）：python tools/kb-measure/real_compare.py <资料文件夹> <标签> [<标签> ...]
"""
import json, os, re, sys

sys.stdout.reconfigure(encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'output', 'real-upload')
STUDENT = re.compile(r'学生名单|期中成绩|平时成绩|作业2提交')
TWIN = re.compile(r'第3章 程序控制结构(\(1\))?\.pptx$')


def roster(folder):
    """名单和成绩表里的姓名、学号"""
    import openpyxl
    names, ids = set(), set()
    for d, _, ns in os.walk(folder):
        for n in ns:
            if not n.endswith('.xlsx') or not re.search(r'名单|成绩', n):
                continue
            for ws in openpyxl.load_workbook(os.path.join(d, n), read_only=True, data_only=True).worksheets:
                col = {}  # 表头那一行里「姓名」「学号」在第几列，下面各行取这两列
                for row in ws.iter_rows(values_only=True):
                    cells = [str(v or '').strip() for v in row]
                    if '姓名' in cells:
                        col = {k: cells.index(k) for k in ('姓名', '学号') if k in cells}
                        continue
                    if '姓名' in col and col['姓名'] < len(cells) and re.fullmatch(r'[一-鿿]{2,4}', cells[col['姓名']]):
                        names.add(cells[col['姓名']])
                    if '学号' in col and col['学号'] < len(cells) and re.fullmatch(r'\d{6,12}', cells[col['学号']]):
                        ids.add(cells[col['学号']])
    return names, ids


def notes_text(label):
    out = []
    base = os.path.join(OUT, label, 'notes')
    for d, _, ns in os.walk(base):
        for n in ns:
            out.append((os.path.relpath(os.path.join(d, n), base), open(os.path.join(d, n), encoding='utf-8').read()))
    return out


def one(label, names, ids):
    r = json.load(open(os.path.join(OUT, label, 'result.json'), encoding='utf-8'))
    items = r['items']
    student = [i for i in items if STUDENT.search(i['name']) and not i['name'].endswith('.zip')]
    twins = [i for i in items if TWIN.search(i['name'])]
    notes = notes_text(label)
    hit_names = sorted({n for _, t in notes for n in names if n in t})
    hit_ids = sorted({x for _, t in notes for x in ids if x in t})
    where_names = sorted({p for p, t in notes if any(n in t for n in hit_names) or any(x in t for x in hit_ids)})
    errors = [t for t in r['tools'] if t.get('error')]
    stray = [t for t in r['tools'] if '王建国' in json.dumps(t, ensure_ascii=False)]
    reply = '\n'.join(r['replies'])
    return {
        'label': label,
        'secs': r['secs'],
        'student stored': f"{sum(1 for i in student if i.get('path'))}/{len(student)}",
        'names in notes': f'{len(hit_names)} 个姓名 {len(hit_ids)} 个学号' + (f'（{"、".join(hit_names[:8])}；在 {"、".join(where_names[:4])}）' if hit_names or hit_ids else ''),
        # 标了「重复」（same）的那份记着和哪份一样，有路径但没存
        'twin copies': sum(1 for i in twins if i.get('path') and i.get('status') != 'same'),
        'tool errors': [t.get('error') for t in errors],
        'stray 王建国': len(stray),
        'bases': {k: f"原件 {sum(f['original'] for f in fs)}，整理稿 {sum(not f['original'] for f in fs)}" for k, fs in r['after'].items()},
        'by-who folders': r['byWho'],
        'english say': [s for s in r['says'] if not re.search(r'[㐀-鿿]', s or '')],
        'reply chars': len(reply),
        'reply mentions twin': bool(re.search(r'一模一样|相同|重复|两份|\(1\)|（1）', reply)),
        'reply mentions students': bool(re.search(r'学生', reply)),
        'unstored non-student': [i['name'] for i in items if not i.get('path') and not STUDENT.search(i['name']) and not TWIN.search(i['name']) and i['status'] == 'done'],
        'run errors': r['runErrors'] + r['applyErrors'],
    }


def main():
    folder, labels = sys.argv[1], sys.argv[2:]
    names, ids = roster(folder)
    print(f'名单里 {len(names)} 个姓名、{len(ids)} 个学号')
    rows = [one(l, names, ids) for l in labels]
    for row in rows:
        print('\n== ' + row['label'])
        for k, v in row.items():
            if k != 'label':
                print(f'  {k}: {v}')
    json.dump(rows, open(os.path.join(OUT, 'compare-' + '-'.join(labels)[:80] + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
