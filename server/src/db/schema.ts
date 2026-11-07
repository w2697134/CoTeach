/**
 * 数据库迁移，按顺序执行，每条只执行一次。
 * 时间字段是毫秒时间戳，JSON 字段存为 TEXT。
 * 知识库的正文不在数据库里，在每门课自己的 git 仓库里；这里只放改动、整理助手的工作记录这些。
 */
export const migrations: string[] = [
  /* v1 */ `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','teacher','student')),
  avatar TEXT,
  gender TEXT,
  email TEXT,
  phone TEXT,
  student_no TEXT,
  title TEXT,
  bio TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  is_super INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  last_active_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  ua TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE providers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('openai','anthropic','gemini')),
  base_url TEXT NOT NULL,
  api_key_enc TEXT,
  headers TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE models (
  id INTEGER PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  label TEXT NOT NULL,
  caps TEXT NOT NULL DEFAULT '{}',
  context_window INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (provider_id, model)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY,
  agent_key TEXT,
  provider_id INTEGER,
  model_id INTEGER,
  model TEXT,
  user_id INTEGER,
  purpose TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  first_token_ms INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  request_preview TEXT,
  response_preview TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_llm_created ON llm_calls(created_at);
CREATE INDEX idx_llm_user ON llm_calls(user_id, created_at);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE courses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

-- 知识库的一次改动：整理助手提的要等老师确认，老师自己改的直接生效
CREATE TABLE kb_changes (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  reason TEXT,
  author TEXT NOT NULL,
  author_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  ops TEXT NOT NULL,
  commit_sha TEXT,
  run_id INTEGER,
  reverts INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by INTEGER
);
CREATE INDEX idx_kb_changes_course ON kb_changes(course_id, status);

-- 整理助手的一次工作：老师交代的一句话、交资料后的整理
CREATE TABLE kb_runs (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  request TEXT NOT NULL,
  reply TEXT,
  change_id INTEGER,
  error TEXT,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_kb_runs_course ON kb_runs(course_id, id);

-- 工作记录：读了什么、写了什么、说了什么
CREATE TABLE kb_events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES kb_runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_kb_events_run ON kb_events(run_id, id);
`,
];

// 老表的课程归属保留用于迁移追溯；新记录归 knowledge_bases。
migrations.push(`
CREATE TABLE knowledge_bases (
  id INTEGER PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('teacher','class')),
  name TEXT NOT NULL,
  class_name TEXT,
  term TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  head_sha TEXT,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE UNIQUE INDEX kb_one_teacher ON knowledge_bases(teacher_id) WHERE kind='teacher';
CREATE UNIQUE INDEX kb_one_class_term ON knowledge_bases(teacher_id,class_name,term) WHERE kind='class';
ALTER TABLE courses ADD COLUMN kb_id INTEGER REFERENCES knowledge_bases(id);
CREATE TABLE kb_identity_terms (
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  term TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY(teacher_id,term)
);
CREATE TABLE kb_students (
  id INTEGER PRIMARY KEY,
  kb_id INTEGER NOT NULL REFERENCES knowledge_bases(id),
  name TEXT NOT NULL,
  student_no TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  user_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE(kb_id,student_no), UNIQUE(kb_id,user_id)
);
CREATE TABLE kb_sources (
  id TEXT PRIMARY KEY,
  kb_id INTEGER NOT NULL REFERENCES knowledge_bases(id),
  name TEXT NOT NULL,
  original_hash TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  source_class TEXT,
  term TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE kb_imports (
  course_id INTEGER PRIMARY KEY REFERENCES courses(id),
  kb_id INTEGER NOT NULL REFERENCES knowledge_bases(id),
  prefix TEXT NOT NULL,
  source_head TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  completed_at INTEGER NOT NULL
);
CREATE TABLE kb_migration_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE kb_inbox (
  id INTEGER PRIMARY KEY,
  kb_id INTEGER NOT NULL REFERENCES knowledge_bases(id),
  student_id INTEGER REFERENCES kb_students(id),
  sender TEXT NOT NULL,
  source_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','accepted','dismissed','error')),
  source_kb_id INTEGER REFERENCES knowledge_bases(id), run_id INTEGER, error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(kb_id,sender,source_id)
);
CREATE TABLE kb_changes_next (
  id INTEGER PRIMARY KEY,
  course_id INTEGER REFERENCES courses(id),
  kb_id INTEGER REFERENCES knowledge_bases(id),
  title TEXT NOT NULL, reason TEXT, author TEXT NOT NULL, author_name TEXT NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, ops TEXT NOT NULL, commit_sha TEXT,
  run_id INTEGER, reverts INTEGER, error TEXT, created_at INTEGER NOT NULL,
  decided_at INTEGER, decided_by INTEGER, base_sha TEXT, request_key TEXT,
  commit_repo TEXT NOT NULL DEFAULT 'current',
  UNIQUE(kb_id,request_key)
);
INSERT INTO kb_changes_next (id,course_id,title,reason,author,author_name,kind,status,ops,commit_sha,run_id,reverts,error,created_at,decided_at,decided_by)
 SELECT id,course_id,title,reason,author,author_name,kind,status,ops,commit_sha,run_id,reverts,error,created_at,decided_at,decided_by FROM kb_changes;
UPDATE kb_changes_next SET commit_repo='legacy';
DROP TABLE kb_changes;
ALTER TABLE kb_changes_next RENAME TO kb_changes;
CREATE INDEX idx_kb_changes_owner ON kb_changes(kb_id,status,id);
CREATE TABLE kb_events_copy AS SELECT * FROM kb_events;
DROP TABLE kb_events;
CREATE TABLE kb_runs_next (
  id INTEGER PRIMARY KEY, course_id INTEGER REFERENCES courses(id), kb_id INTEGER REFERENCES knowledge_bases(id),
  kind TEXT NOT NULL,status TEXT NOT NULL,request TEXT NOT NULL,reply TEXT,change_id INTEGER,
  error TEXT,created_by INTEGER,created_at INTEGER NOT NULL,finished_at INTEGER,
  student_id INTEGER REFERENCES kb_students(id), source_kb_id INTEGER REFERENCES knowledge_bases(id)
);
INSERT INTO kb_runs_next (id,course_id,kind,status,request,reply,change_id,error,created_by,created_at,finished_at)
 SELECT id,course_id,kind,status,request,reply,change_id,error,created_by,created_at,finished_at FROM kb_runs;
DROP TABLE kb_runs;
ALTER TABLE kb_runs_next RENAME TO kb_runs;
CREATE INDEX idx_kb_runs_owner ON kb_runs(kb_id,id);
CREATE TABLE kb_events (
  id INTEGER PRIMARY KEY,run_id INTEGER NOT NULL REFERENCES kb_runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL
);
INSERT INTO kb_events SELECT * FROM kb_events_copy;
DROP TABLE kb_events_copy;
CREATE INDEX idx_kb_events_run ON kb_events(run_id,id);
`);
