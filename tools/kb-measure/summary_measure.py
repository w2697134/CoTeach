"""出处以真实班级、学期可辨认；不把调用栈/栈帧之类教学表述误判为文件路径。"""
import re
from collections import Counter
from measure import NAMES, STATS

def measure_summary(change):
    body = '\n'.join(f.get('after') or '' for f in change['files']) if change else ''
    reason = (change['change'].get('reason') or '') if change else ''
    combined = body + '\n' + reason
    path_pattern = r'(?:[^\s「」《》：:]+/)[^\n「」《》；;，。]*?\.md|[^\s/「」《》]+\.md\b|(?:本学期档案|资料|笔记)/(?=[：:])'
    introduced_paths = len(re.findall(path_pattern, reason))
    for f in change['files'] if change else []:
        before = Counter(re.findall(path_pattern, f.get('before') or ''))
        after = Counter(re.findall(path_pattern, f.get('after') or ''))
        introduced_paths += sum((after - before).values())
    metrics = {
        'names':sum(body.count(n) for n in NAMES+['验收学生甲']),
        'stats':sum(len(re.findall(p,body)) for p in STATS),
        'timing':len(re.findall('本周|下周|这周|本学期已|60%|均分|4 人',body)),
        'paths':introduced_paths,
        'retainedAndNewPaths':len(re.findall(path_pattern,combined)),
        'internalNames':combined.count('本学期档案'),
        'reasonChars':len(reason),
        'reasonInventory':bool(re.search('未收录|没收录|未纳入|查重|未混为一谈|取舍',reason)),
        'sourceIdentifiable':'软件2301班' in body and '2026秋季' in re.sub(r'\s','',body),
        'supportedReflection':all(x in body for x in ['调用栈','基例']),
        'pending':bool(change and change['change']['status']=='pending'),
    }
    metrics['ok']=all(metrics[k]==0 for k in ['names','stats','timing','paths','internalNames']) and metrics['reasonChars']<=120 and not metrics['reasonInventory'] and all(metrics[k] for k in ['sourceIdentifiable','supportedReflection','pending'])
    return metrics
