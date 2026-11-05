"""测试前清掉这门课的对话记录（只动本机测试库），拒掉还挂着的改动"""
import sqlite3, sys
cid = int(sys.argv[1])
db = sqlite3.connect('E:/Codex/zhongzhuan/projects/coteach/server/data/coteach.db', timeout=10)
db.execute("UPDATE kb_changes SET status='rejected' WHERE course_id=? AND status IN ('pending','conflict')", (cid,))
db.execute("DELETE FROM kb_events WHERE run_id IN (SELECT id FROM kb_runs WHERE course_id=? AND kind='chat')", (cid,))
db.execute("DELETE FROM kb_runs WHERE course_id=? AND kind='chat'", (cid,))
db.commit()
print('cleared', cid)
