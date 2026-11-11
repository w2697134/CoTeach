// 只读命令不导入 config/db，避免创建运行锁、密钥、表或原目录下的 WAL/SHM。
async function main() {
  const dir = process.env.CT_DATA_DIR;
  if (!dir) throw new Error('请设置 CT_DATA_DIR 为要处理的数据目录');
  const mode = process.argv[2] || 'check';
  if (mode === 'check' || mode === 'verify') {
    const { withInspectionDb } = await import('../server/src/kb/inspection-db.js');
    const { inspectLegacy, verifyInspectedMigration } = await import('../server/src/kb/inspection.js');
    const { migrations } = await import('../server/src/db/schema.js');
    const result = withInspectionDb(
      dir,
      (raw) => {
        const schemaVersion = Number(raw.prepare('SELECT COALESCE(MAX(version),0) AS version FROM _migrations').get()?.version || 0);
        if (mode === 'verify') return verifyInspectedMigration(raw, dir, process.env.CT_GIT || 'git');
        return { schemaVersion, requiredVersion: migrations.length, courses: inspectLegacy(raw, dir, process.env.CT_GIT || 'git') };
      },
      process.env.CT_DB_FILE,
    );
    console.log(JSON.stringify(result, null, 2));
    if ('ok' in result && !result.ok) process.exitCode = 1;
    return;
  }
  if (mode !== 'migrate') throw new Error('用法：kb-owner.ts check|migrate|verify');
  const { migrateOwnership, verifyMigration, recoverRepositoryRefs } = await import('../server/src/kb/migrate.js');
  await migrateOwnership();
  recoverRepositoryRefs();
  const result = verifyMigration();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
