import { verifyInspectedMigration } from './inspection.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectLegacy } from './inspection.js';
import { config } from '../config.js';
import { db, now } from '../db/index.js';
import {
  archiveDir,
  cleanPath,
  gitAt,
  hashBytes,
  isTextPath,
  manifest,
  prepareCommit,
  publishCommit,
  readEntry,
  repoDir,
  saveSource,
  settleRef,
  type Entry,
} from './repo.js';

export interface ImportPlan {
  courseId: number;
  teacherId: number;
  name: string;
  head: string;
  fingerprint: string;
  files: { path: string; hash: string; size: number }[];
  imported: boolean;
}
export function migrationPlan(): ImportPlan[] {
  const plan = inspectLegacy(db.raw, config.dataDir, config.gitBin);
  for (const p of plan) for (const f of p.files) cleanPath(f.path);
  return plan;
}
function checkpoint(name: string) {
  if (process.env.CT_MIGRATION_FAIL_AT === name) {
    if (process.env.CT_MIGRATION_HARD_EXIT === '1') process.exit(86);
    throw new Error(`测试中断：${name}`);
  }
}
function ensureArchive(plan: ImportPlan) {
  const dest = archiveDir(plan.courseId),
    tmp = dest + '.preparing';
  mkdirSync(join(config.dataDir, 'archives'), { recursive: true });
  if (existsSync(dest)) {
    if (gitAt(dest, ['rev-parse', 'HEAD']).toString().trim() !== plan.head) throw new Error('历史档案版本不一致');
    return;
  }
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  execFileSync(
    config.gitBin,
    [
      '-c',
      `safe.directory=${join(config.kbDir, String(plan.courseId)).replace(/\\/g, '/')}`,
      'clone',
      '--mirror',
      '--no-hardlinks',
      join(config.kbDir, String(plan.courseId)),
      tmp,
    ],
    { windowsHide: true, stdio: 'pipe' },
  );
  gitAt(tmp, ['fsck', '--full']);
  renameSync(tmp, dest);
}
/** 所有归属和业务记录在同一 SQLite 事务内发布；文件先准备，进程中断后可安全复用。 */
export async function migrateOwnership(): Promise<ImportPlan[]> {
  const plans = migrationPlan();
  if (plans.every((p) => p.imported)) return plans;
  const journal = join(config.dataDir, 'kb-owner-migration.json');
  writeFileSync(
    journal,
    JSON.stringify({
      version: 1,
      startedAt: now(),
      courses: plans.filter((p) => !p.imported).map((p) => p.courseId),
    }),
  );
  for (const p of plans.filter((p) => !p.imported)) ensureArchive(p);
  checkpoint('archives');
  const touched: number[] = [];
  db.tx(() => {
    for (const teacherId of new Set(plans.filter((p) => !p.imported).map((p) => p.teacherId))) {
      const teacher = db.get<any>('SELECT name FROM users WHERE id=?', teacherId)!;
      let id = db.value<number>("SELECT id FROM knowledge_bases WHERE teacher_id=? AND kind='teacher' ORDER BY id LIMIT 1", teacherId);
      if (!id)
        id = db.insert('knowledge_bases', {
          teacher_id: teacherId,
          kind: 'teacher',
          name: `${teacher.name}的知识库`,
          status: 'active',
          created_at: now(),
        });
      const entries = manifest(id),
        files = new Map<string, Buffer>();
      const own = plans.filter((p) => p.teacherId === teacherId),
        multiple = own.length > 1;
      for (const p of own.filter((p) => !p.imported)) {
        const prefix = multiple ? `${p.name.replace(/[\\/:*?"<>|]/g, '_')}（${p.courseId}）/` : '';
        for (const f of p.files) {
          const path = prefix + f.path;
          if (entries.some((e) => e.path.toLowerCase() === path.toLowerCase())) throw new Error('迁移目标有同名文件，已停止，未覆盖');
          const bytes = gitAt(archiveDir(p.courseId), ['show', `${p.head}:${f.path}`]);
          const e: Entry = {
            id: randomUUID(),
            path,
            origin: { courseId: p.courseId, path: f.path },
          };
          if (f.path.startsWith('资料/')) {
            const text = isTextPath(f.path) ? bytes.toString('utf8') : '';
            const sourceClass = text.match(/授课班级\s*\|\s*([^|\r\n]+)/)?.[1]?.trim() || null;
            e.sourceId = saveSource(id, f.path, bytes, text, sourceClass);
            e.sourcePart = isTextPath(f.path) ? 'text' : 'original';
          } else files.set(path, bytes);
          entries.push(e);
        }
        db.insert('kb_imports', {
          course_id: p.courseId,
          kb_id: id,
          prefix,
          source_head: p.head,
          fingerprint: p.fingerprint,
          completed_at: now(),
        });
        // 历史 ops 的原路径保持不变；需要操作时才用 prefix 映射。
        db.run('UPDATE kb_changes SET kb_id=? WHERE course_id=?', id, p.courseId);
        db.run('UPDATE kb_runs SET kb_id=? WHERE course_id=?', id, p.courseId);
        db.run('UPDATE courses SET kb_id=? WHERE id=?', id, p.courseId);
      }
      checkpoint('metadata');
      const { sha } = prepareCommit(
        id,
        [],
        '迁移课程知识库归属（原文与旧历史保持不变）',
        { name: 'CoTeach 迁移程序', email: 'migration@coteach.local' },
        undefined,
        { initialEntries: entries, initialFiles: files },
      );
      publishCommit(id, sha);
      touched.push(id);
      for (const p of own)
        for (const f of p.files) {
          const e = entries.find((e) => e.origin?.courseId === p.courseId && e.origin.path === f.path)!;
          if (hashBytes(readEntry(id, e, sha)) !== f.hash) throw new Error('迁移内容核验失败');
        }
      checkpoint('prepared');
    }
    db.run("INSERT OR REPLACE INTO kb_migration_state(key,value) VALUES('owner-v2',?)", JSON.stringify({ completedAt: now() }));
    checkpoint('before-publish');
  });
  checkpoint('published');
  for (const id of touched) settleRef(id);
  rmSync(journal, { force: true });
  return migrationPlan();
}
export function verifyMigration() {
  return verifyInspectedMigration(db.raw, config.dataDir, config.gitBin);
}
export function recoverRepositoryRefs() {
  for (const kb of db.all<any>('SELECT id,head_sha FROM knowledge_bases WHERE head_sha IS NOT NULL')) settleRef(kb.id);
  const indexes = join(config.dataDir, '.indexes');
  if (existsSync(indexes))
    for (const file of readdirSync(indexes)) if (/^[a-f0-9-]+(?:\.lock)?$/.test(file)) rmSync(join(indexes, file), { force: true });
  const journal = join(config.dataDir, 'kb-owner-migration.json');
  if (existsSync(journal) && migrationPlan().every((p) => p.imported)) rmSync(journal, { force: true });
}
