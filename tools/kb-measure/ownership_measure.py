"""独立的归属复核；原 chat_measure 分数保留，不把等待班级的回答算作已修改。"""
import re
from chat_measure import CHANGE, answer_ok

def judge(rows):
    result=[]
    for row in rows:
        temporary=row['msg'] in (CHANGE[1],CHANGE[3])
        if temporary:
            ok=not row['changed'] and bool(re.search('班级|哪个班|哪一个班|哪个学期|哪学期',row['reply'])) and bool(re.search(r'确认|提供|告诉|需要|请|？|\?',row['reply']))
        elif row['want_change']:ok=row['changed']
        else:ok=not row['changed'] and answer_ok(row['msg'],row['reply'])
        result.append({'msg':row['msg'],'expected':'confirm_class' if temporary else 'proposal' if row['want_change'] else 'grounded_answer','ok':bool(ok)})
    return result
