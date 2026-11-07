import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Entry } from './repo.js';

export function inspectLegacy(raw: DatabaseSync, dataDir: string, gitBin = 'git') {
  const hasOwner = raw
    .prepare('PRAGMA table_info(courses)')
    .all()
    .some((r) => r.name === 'kb_id');
  const sql = hasOwner
    ? 'SELECT * FROM courses WHERE kb_id IS NULL OR id IN (SELECT course_id FROM kb_imports) ORDER BY teacher_id,id'
    : 'SELECT * FROM courses ORDER BY teacher_id,id';
  return raw
    .prepare(sql)
    .all()
    .map((c) => {
      const git = (args: string[]) =>
        execFileSync(
          gitBin,
          [
            '-c',
            `safe.directory=${join(dataDir, 'kb', String(c.id)).replace(/\\/g, '/')}`,
            '-c',
            'core.quotepath=off',
            '-C',
            join(dataDir, 'kb', String(c.id)),
            ...args,
          ],
          {
            windowsHide: true,
            maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
      const head = git(['rev-parse', 'HEAD']).toString().trim();
      if (git(['status', '--porcelain', '--untracked-files=all']).toString().trim())
        throw new Error(`课程 ${c.id} 有未提交内容，迁移已停止，原数据未改`);
      const paths = git(['ls-tree', '-r', '--name-only', '-z', head])
        .toString()
        .split('\0')
        .filter((p) => p && !p.split('/').some((s) => s.startsWith('.')));
      const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
      const files = paths.map((path) => {
        const b = git(['show', `${head}:${path}`]);
        return { path, hash: hash(b), size: b.length };
      });
      const fingerprint = hash(JSON.stringify({ head, files }));
      const imp = hasOwner ? raw.prepare('SELECT * FROM kb_imports WHERE course_id=?').get(c.id) : null;
      if (imp && imp.fingerprint !== fingerprint) throw new Error(`旧课程 ${c.id} 在迁移后又被改动，不能覆盖，请先核对`);
      return {
        courseId: Number(c.id),
        teacherId: Number(c.teacher_id),
        name: String(c.name),
        head,
        fingerprint,
        files,
        imported: !!imp,
      };
    });
}

export function verifyInspectedMigration(raw: DatabaseSync, dataDir: string, gitBin = 'git') {
  if (!raw.prepare("SELECT name FROM sqlite_master WHERE name='kb_imports'").get()) throw new Error('知识库尚未迁移；核验没有修改数据');
  const git = (dir: string, args: string[]) =>
    execFileSync(gitBin, ['-c', `safe.directory=${dir.replace(/\\/g, '/')}`, '-c', 'core.quotepath=off', '-C', dir, ...args], {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const rows = inspectLegacy(raw, dataDir, gitBin).map((p) => {
    const imp = raw.prepare('SELECT * FROM kb_imports WHERE course_id=?').get(p.courseId);
    if (!imp) throw new Error('仍有课程尚未迁移');
    const kb = raw.prepare('SELECT head_sha FROM knowledge_bases WHERE id=?').get(imp.kb_id);
    const repo = join(dataDir, 'knowledge', String(imp.kb_id));
    const entries: Entry[] = JSON.parse(git(repo, ['show', `${kb!.head_sha}:.coteach.json`]).toString('utf8'));
    const files = p.files.map((f) => {
      const e = entries.find((e) => e.origin?.courseId === p.courseId && e.origin.path === f.path);
      let bytes: Buffer | null = null;
      if (e?.sourceId) {
        const source = raw.prepare('SELECT * FROM kb_sources WHERE id=? AND kb_id=?').get(e.sourceId, imp.kb_id);
        const fingerprint = source?.[e.sourcePart === 'original' ? 'original_hash' : 'text_hash'];
        if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('原始资料指纹无效');
        bytes = readFileSync(join(dataDir, 'sources', fingerprint));
        if (hash(bytes) !== fingerprint) throw new Error('原始资料校验失败');
      } else if (e) bytes = git(repo, ['show', `${kb!.head_sha}:${e.path}`]);
      return { path: f.path, expected: f.hash, actual: bytes ? hash(bytes) : null };
    });
    const commits = (dir: string) => git(dir, ['rev-list', '--all']).toString().trim().split('\n').sort();
    const sourceCommits = commits(join(dataDir, 'kb', String(p.courseId)));
    return {
      courseId: p.courseId,
      kbId: Number(imp.kb_id),
      files,
      commits: sourceCommits.length,
      historyEqual: JSON.stringify(sourceCommits) === JSON.stringify(commits(join(dataDir, 'archives', String(p.courseId)))),
      contentsEqual: files.every((f) => f.expected === f.actual),
      changes: raw.prepare('SELECT count(*) AS n FROM kb_changes WHERE course_id=?').get(p.courseId)!.n,
      runs: raw.prepare('SELECT count(*) AS n FROM kb_runs WHERE course_id=?').get(p.courseId)!.n,
    };
  });
  return { ok: rows.every((r) => r.contentsEqual && r.historyEqual), courses: rows };
}
