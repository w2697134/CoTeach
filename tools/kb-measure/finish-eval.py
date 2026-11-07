"""最终验收入口：冻结源码/尺子后逐组执行，绝不覆盖已有结果。"""
import concurrent.futures, importlib.util, json, os, shutil, subprocess, sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('review_eval',HERE/'review-eval.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)

def snapshot(name):
    target=runner.OUT/('engine-'+name)
    if target.exists():raise RuntimeError('快照已存在，不能覆盖：'+str(target))
    shutil.copytree(runner.ROOT/'server/src',target/'server/src')
    shutil.copy2(runner.ROOT/'server/package.json',target/'server/package.json')
    subprocess.run(['cmd','/c','mklink','/J',str(target/'server/node_modules'),str(runner.ROOT/'server/node_modules')],check=True,stdout=subprocess.DEVNULL)
    protocol={'model':'deepseek-flash','repeats':2,'source':{p.relative_to(target).as_posix():runner.sha(p) for p in (target/'server/src').rglob('*') if p.is_file()},'rulers':{p.name:runner.sha(p) for p in HERE.glob('*measure.py')},'editorPrompt':runner.sha(runner.OUT/'summary-editor.txt')}
    runner.save(runner.OUT/(name+'-protocol.json'),protocol)

if __name__=='__main__':
    action=sys.argv[1]
    if action=='snapshot':snapshot(sys.argv[2])
    else:
        options={
          'placement-evidence':('summary-placement-evidence',['placement-control','placement'],runner.OUT/'summary-editor.txt'),
          'placement-empty':('summary-placement-empty',['placement-control','placement'],runner.OUT/'summary-editor.txt'),
          'review-evidence':('summary-reviewed-evidence',['review-control','reviewed'],runner.OUT/'summary-editor.txt'),
          'review-empty':('summary-reviewed-empty',['review-control','reviewed'],runner.OUT/'summary-editor.txt'),
          'materials':('materials',['old','release'],None),
          'chat':('chat',['old','release'],None),
          'summary-evidence':('summary-release-evidence',['current','release'],None),
          'summary-empty':('summary-release-empty',['current','release'],None),
        }
        scenario,labels,prompt=options[action]
        # 历史 materials/chat 结果已存在，因此把最终组单独放在新目录。
        if action in ['materials','chat']:
            runner.OUT=runner.ROOT/'output/kb-review/final-comparison'/action
            runner.OUT.mkdir(exist_ok=True,parents=True)
            for name in ['old','release']:
                link=runner.OUT/('engine-'+name)
                if not link.exists():subprocess.run(['cmd','/c','mklink','/J',str(link),str(runner.ROOT/'output/kb-review'/('engine-'+name))],check=True,stdout=subprocess.DEVNULL)
        for repeat in range(1,3):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futures=[pool.submit(runner.trial,label,scenario,repeat,int(os.environ.get('CT_EVAL_PORT_BASE','18670'))+i,(runner.OUT/'summary-current.txt' if label=='current' else prompt)) for i,label in enumerate(labels)]
                for future in futures:future.result()
