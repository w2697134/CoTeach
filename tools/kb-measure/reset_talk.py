"""仅清理明确指定的隔离测试副本；禁止默认连接演示原库。"""
import os, sqlite3, sys
from pathlib import Path

data = Path(os.environ['CT_MEASURE_DATA']).resolve()
project = Path(__file__).resolve().parents[2]
if project / 'output' not in data.parents:
    raise RuntimeError('只允许清理本项目 output 下的测试副本')
kb_id = int(sys.argv[1])
with sqlite3.connect(data / 'coteach.db', timeout=10) as db:
    columns = {r[1] for r in db.execute('PRAGMA table_info(kb_runs)')}
    owner = 'kb_id' if 'kb_id' in columns else 'course_id'
    if db.execute(f"SELECT 1 FROM kb_runs WHERE {owner}=? AND status='running'", (kb_id,)).fetchone():
        raise RuntimeError('还有运行中的任务，不能清理')
    db.execute(f"UPDATE kb_changes SET status='rejected' WHERE {owner}=? AND status IN ('pending','conflict')", (kb_id,))
    db.execute(f"DELETE FROM kb_events WHERE run_id IN (SELECT id FROM kb_runs WHERE {owner}=? AND kind='chat')", (kb_id,))
    db.execute(f"DELETE FROM kb_runs WHERE {owner}=? AND kind='chat'", (kb_id,))
print('cleared test conversations', kb_id)
