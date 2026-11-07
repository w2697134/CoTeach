import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';

// 交资料：压缩包安全、分块上传、取消、老上传方式、长内容转资料。不调用模型。
const dir = mkdtempSync(join(tmpdir(), 'coteach-intake-test-'));
process.env.CT_DATA_DIR = dir;
process.env.CT_DEMO_MODE = '0';
process.env.CT_SECRET = 'test-only-secret-with-at-least-32-characters';
const { db } = await import('../src/db/index.js');
const repo = await import('../src/kb/repo.js');
const { expandArchive, run7z, sevenZipLoader, ArchiveError } = await import('../src/kb/intake/archive.js');
const { cleanRelative } = await import('../src/kb/intake/naming.js');
const { isSystemJunk } = await import('../src/kb/intake/kinds.js');
const service = await import('../src/kb/intake/service.js');
const store = await import('../src/kb/intake/store.js');
const { batchRequest, recoverRuns, publicRun } = await import('../src/kb/keeper.js');
const { createApp } = await import('../src/app.js');
const SevenZip = (await import('7z-wasm')).default;
const app = createApp();
const require = createRequire(import.meta.url);
const sevenZip = sevenZipLoader(join(dirname(require.resolve('7z-wasm/package.json')), '7zz.wasm'), SevenZip as any);

const user = (name: string) =>
  db.insert('users', { username: randomUUID(), name, role: 'teacher', password_hash: 'not-a-login-password', created_at: Date.now() });
const teacher = user('测试老师甲'),
  other = user('测试老师乙');
const kb = await repo.ensureTeacherKb(teacher, '测试老师甲');
function cookie(uid: number) {
  const token = randomUUID();
  db.insert('sessions', { id: createHash('sha256').update(token).digest('hex'), user_id: uid, created_at: Date.now(), expires_at: Date.now() + 3600000 });
  return `ct_sid=${token}`;
}
const cookies = { teacher: cookie(teacher), other: cookie(other) };
async function req(path: string, opts: { who?: keyof typeof cookies; json?: unknown; raw?: Uint8Array; form?: FormData; method?: string } = {}) {
  const headers: Record<string, string> = { cookie: cookies[opts.who || 'teacher'], 'x-tv2': '1' };
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.raw) headers['Content-Type'] = 'application/octet-stream';
  return app.request('/api' + path, {
    method: opts.method || (opts.json !== undefined || opts.raw || opts.form ? 'POST' : 'GET'),
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.raw ? opts.raw : opts.form,
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(id: number, from: string[] = ['uploading', 'reading']) {
  for (let i = 0; i < 300; i++) {
    const row = store.loadIntake(id);
    if (!from.includes(row.status)) return row;
    await sleep(100);
  }
  throw new Error('交资料一直没有读完');
}
const tmp = (name: string) => {
  const d = mkdtempSync(join(dir, 'case-'));
  return { dir: d, file: join(d, name) };
};
const inside = (root: string, p: string) => !relative(root, p).startsWith('..');
const limits = { maxEntries: 100, maxTotal: 50 * 1024 * 1024, maxEntry: 50 * 1024 * 1024 };

test.after(async () => {
  await service.closeReaders();
  // 后台的整理任务（没有模型，会很快停下）先等它收尾，再关库删目录
  for (let i = 0; i < 50 && db.get("SELECT id FROM kb_runs WHERE status='running'"); i++) await sleep(100);
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    db.raw.close();
    (await import('../src/config.js')).releaseDataLock();
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error('收尾出错', err);
    throw err;
  }
});

test('资料名：去掉上级目录和危险字符，系统垃圾文件识别出来', () => {
  assert.equal(cleanRelative('../../第一章/./讲义\\笔记.docx'), '第一章/讲义/笔记.docx');
  assert.equal(cleanRelative('/etc/passwd'), 'etc/passwd');
  assert.equal(cleanRelative(''), '未命名');
  assert.ok(!cleanRelative('a:b*c?.txt').includes(':'));
  for (const junk of ['__MACOSX/资料/._讲义.docx', '资料/.DS_Store', 'Thumbs.db', 'desktop.ini', '~$讲义.docx', '项目/__pycache__/a.pyc']) assert.ok(isSystemJunk(junk), junk);
  for (const ok of ['讲义.docx', '第一章/课件.pptx', 'README.md']) assert.ok(!isSystemJunk(ok), ok);
});

test('分批：放得进一批的文件夹不拆开，大文件夹不留零头，每批不超过 8 份、资料一份不丢；交给整理助手的话不提批次', () => {
  const docs = [
    ...Array.from({ length: 3 }, (_, i) => ({ path: `资料/导论/讲义${i + 1}.md`, chars: 2000 })),
    ...Array.from({ length: 11 }, (_, i) => ({ path: `资料/第一章/讲义${i + 1}.md`, chars: 3000 })),
    ...Array.from({ length: 4 }, (_, i) => ({ path: `资料/第二章/课件${i + 1}.md`, chars: 20000 })),
    ...Array.from({ length: 6 }, (_, i) => ({ path: `资料/第三章/练习${i + 1}.md`, chars: 1000 })),
  ];
  const batches = service.planBatches(docs);
  assert.ok(batches.every((b) => b.paths.length <= 8));
  assert.ok(batches.every((b) => b.paths.reduce((n, p) => n + docs.find((d) => d.path === p)!.chars, 0) <= 60_000));
  assert.deepEqual(batches.flatMap((b) => b.paths).sort(), docs.map((d) => d.path).sort());
  for (const small of ['导论', '第三章']) assert.equal(batches.filter((b) => b.paths.some((p) => p.includes(`/${small}/`))).length, 1, `${small}被拆开了`);
  // 30 个文件夹各 10 份：零头不单独成批，38 批装完
  const many = Array.from({ length: 300 }, (_, i) => ({ path: `资料/第${Math.floor(i / 10) + 1}周/讲义${(i % 10) + 1}.md`, chars: 1500 }));
  assert.equal(service.planBatches(many).length, Math.ceil(300 / 8));
  const text = batchRequest('这是第三章的资料', ['资料/a.md', '资料/b.md']);
  assert.ok(text.startsWith('这是第三章的资料'));
  assert.ok(!/批/.test(text));
});

test('zip：路径穿越写不到外面，谎报大小的条目当损坏，全加密的说设了密码', async () => {
  const z = new JSZip();
  z.file('../../越界.txt', '越界内容');
  z.file('/绝对路径.txt', '绝对路径内容');
  z.file('正常/笔记.md', '# 正常笔记');
  z.file('谎报.txt', 'x'.repeat(10_000), { compression: 'STORE' });
  const buf = Buffer.from(await z.generateAsync({ type: 'uint8array' }));
  // 把「谎报.txt」在中央目录里登记的解压后大小改成 100
  for (let p = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); p >= 0; p = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), p + 4)) {
    const nameLen = buf.readUInt16LE(p + 28);
    if (buf.subarray(p + 46, p + 46 + nameLen).toString('utf8') === '谎报.txt') buf.writeUInt32LE(100, p + 24);
  }
  const { dir: d, file } = tmp('包.zip');
  writeFileSync(file, buf);
  const out = join(d, 'out');
  const r = await expandArchive(file, '包.zip', out, limits, sevenZip);
  for (const f of r.files) assert.ok(inside(out, f.file), `写到了外面：${f.file}`);
  const names = r.files.map((f) => cleanRelative(f.path));
  assert.ok(names.every((n) => !n.split('/').includes('..')));
  assert.ok(names.includes('正常/笔记.md'));
  assert.ok(r.refused.some((x) => x.path.endsWith('谎报.txt') && /损坏/.test(x.reason)));
  assert.ok(!existsSync(join(d, '..', '越界.txt')));

  // 全部条目设了密码（通用标志位第 0 位）
  const enc = Buffer.from(await new JSZip().file('a.txt', 'secret').generateAsync({ type: 'uint8array', compression: 'STORE' }));
  enc.writeUInt16LE(enc.readUInt16LE(6) | 1, 6);
  const cd = enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  enc.writeUInt16LE(enc.readUInt16LE(cd + 8) | 1, cd + 8);
  const e = tmp('加密.zip');
  writeFileSync(e.file, enc);
  await assert.rejects(expandArchive(e.file, '加密.zip', join(e.dir, 'out'), limits, sevenZip), (err: unknown) => err instanceof ArchiveError && /密码/.test(err.reason));

  // 条目太多
  const many = new JSZip();
  for (let i = 0; i < 120; i++) many.file(`f${i}.txt`, String(i));
  const m = tmp('很多.zip');
  writeFileSync(m.file, await many.generateAsync({ type: 'uint8array' }));
  await assert.rejects(expandArchive(m.file, '很多.zip', join(m.dir, 'out'), limits, sevenZip), (err: unknown) => err instanceof ArchiveError && /太多/.test(err.reason));
});

test('7-Zip：实际写出超过上限就停下；谎报大小的 gz 解不出来', async () => {
  const big = gzipSync(Buffer.alloc(5 * 1024 * 1024, 0x61));
  const ok = tmp('大.txt.gz');
  writeFileSync(ok.file, big);
  const { module, factory } = await sevenZip();
  mkdirSync(join(ok.dir, 'x'));
  const r = await run7z(module, factory, ['x', '-y', '-bsp0', '-o/w/x', '/w/大.txt.gz'], ok.dir, 1024 * 1024);
  assert.equal(r.overLimit, true);
  const written = readdirSync(join(ok.dir, 'x')).reduce((n, f) => n + statSync(join(ok.dir, 'x', f)).size, 0);
  assert.ok(written <= 1024 * 1024, `写出了 ${written} 字节`);

  // 文件尾登记的原始大小改成 100 字节：7-Zip 按它列目录，实际解出 5MB 时被拦下
  const lie = Buffer.from(big);
  lie.writeUInt32LE(100, lie.length - 4);
  const l = tmp('谎报.txt.gz');
  writeFileSync(l.file, lie);
  const out = join(l.dir, 'out');
  const res = await expandArchive(l.file, '谎报.txt.gz', out, limits, sevenZip).catch((err) => err);
  if (res instanceof ArchiveError) assert.match(res.reason, /大得多|损坏/);
  else assert.ok(res.files.every((f: { size: number }) => f.size <= 100 + 1 + 1024 * 1024), '谎报大小的压缩包被完整解开了');
});

test('交资料：分块上传、位置对不上不乱写、系统文件和空文件不传、读完放进知识库', async () => {
  const content = Buffer.from('# 讲义\n\n第一章讲变量和类型。\n'.repeat(50));
  const res = await req(`/knowledge/${kb}/intakes`, {
    json: {
      message: '第一章的讲义',
      files: [
        { name: '第一章/讲义.md', size: content.length },
        { name: '第一章/.DS_Store', size: 6 },
        { name: '空.txt', size: 0 },
      ],
    },
  });
  assert.equal(res.status, 200);
  const created = (await res.json()) as any;
  assert.equal(created.uploads.length, 1);
  assert.equal(created.uploads[0].index, 0);
  assert.equal(created.intake.total, 2);
  const item = created.uploads[0].itemId,
    id = created.intake.id;
  const wrong = await (await req(`/knowledge/${kb}/intakes/${id}/items/${item}?offset=7`, { raw: content.subarray(7, 20), method: 'PUT' })).json() as any;
  assert.deepEqual(wrong, { received: 0, complete: false });
  const half = Math.floor(content.length / 2);
  assert.deepEqual(await (await req(`/knowledge/${kb}/intakes/${id}/items/${item}?offset=0`, { raw: content.subarray(0, half), method: 'PUT' })).json() as any, {
    received: half,
    complete: false,
  });
  const done = await (await req(`/knowledge/${kb}/intakes/${id}/items/${item}?offset=${half}`, { raw: content.subarray(half), method: 'PUT' })).json() as any;
  assert.equal(done.complete, true);
  const row = await settle(id);
  assert.ok(['digesting', 'paused', 'done'].includes(row.status), row.status);
  const items = store.intakeItems(id);
  assert.equal(items.find((i) => i.name === '空.txt')?.status, 'failed');
  const doc = items.find((i) => i.name === '第一章/讲义.md')!;
  assert.equal(doc.status, 'done');
  assert.equal(repo.readText(kb, doc.path!), content.toString('utf8'));
  assert.ok(!existsSync(store.stageDir(id)) || readdirSync(store.stageDir(id)).length === 0, '临时文件没清');
  assert.equal(row.message, '第一章的讲义');

  // 没有模型可用：整理停下，资料已在知识库；「接着整理」重新排上，「就整理到这里」结束这次
  const paused = await settle(id, ['uploading', 'reading', 'digesting']);
  assert.equal(paused.status, 'paused');
  assert.ok(paused.error);
  const resumed = await (await req(`/knowledge/${kb}/intakes/${id}/resume`, { json: {} })).json() as any;
  assert.equal(resumed.intake.status, 'digesting');
  assert.equal((await settle(id, ['digesting'])).status, 'paused');
  // 服务重启：整理到一半（排队记录还是「进行中」）时，重启恢复要把它放回排队并叫醒，不能一直停在「整理中」
  const job = db.get<{ id: number; run_id: number }>("SELECT id,run_id FROM kb_inbox WHERE sender='intake' AND source_id LIKE ? ORDER BY id DESC LIMIT 1", `${id}:%`)!;
  db.update('kb_inbox', job.id, { status: 'running', error: null });
  db.update('kb_runs', job.run_id, { status: 'running', error: null });
  store.setIntake(id, { status: 'digesting', error: null, resumes: 0 });
  recoverRuns();
  service.recoverIntakes();
  // 被打断的那条整理记录不该叫老师「重试」，它会自己重来
  assert.equal(db.get<{ error: string }>('SELECT error FROM kb_runs WHERE id=?', job.run_id)!.error, '服务中断，这一批重新整理');
  assert.equal((await settle(id, ['digesting'])).status, 'paused', '重启后没有接着整理');
  assert.equal(store.loadIntake(id).resumes, 1);
  assert.notEqual(db.get<{ status: string }>('SELECT status FROM kb_inbox WHERE id=?', job.id)!.status, 'pending', '放回排队后没人叫醒');
  // 同一次交资料的几次整理都叫「整理这次交的资料」，不因为排队记录只记着最后一次就换了名字
  const labels = db.all<any>('SELECT * FROM kb_runs WHERE intake_id=?', id).map((r) => publicRun(r).task?.label);
  assert.ok(labels.length >= 2, `只有 ${labels.length} 次整理记录`);
  assert.deepEqual([...new Set(labels)], ['整理这次交的资料']);

  const finished = await (await req(`/knowledge/${kb}/intakes/${id}/finish`, { json: {} })).json() as any;
  assert.equal(finished.intake.status, 'done');
  assert.equal((await req(`/knowledge/${kb}/intakes/${id}/finish`, { json: {} })).status, 409);

  // 同样的内容再交一次：标成和以前一样，不重复进知识库
  const again = await (await req(`/knowledge/${kb}/intakes`, { json: { files: [{ name: '第一章/讲义.md', size: content.length }] } })).json() as any;
  await req(`/knowledge/${kb}/intakes/${again.intake.id}/items/${again.uploads[0].itemId}?offset=0`, { raw: content, method: 'PUT' });
  const second = await settle(again.intake.id);
  assert.equal(store.intakeItems(again.intake.id)[0].status, 'same');
  assert.equal(second.status, 'done');
});

test('交资料：和已有资料同名但内容不同，替换原来那份，并标出「替换了」', async () => {
  const v1 = Buffer.from('# 讲义\n\n第一版内容。\n'),
    v2 = Buffer.from('# 讲义\n\n第二版内容，改了例题。\n');
  for (const [i, data] of [v1, v2].entries()) {
    const c = (await (await req(`/knowledge/${kb}/intakes`, { json: { files: [{ name: '同名/讲义.md', size: data.length }] } })).json()) as any;
    await req(`/knowledge/${kb}/intakes/${c.intake.id}/items/${c.uploads[0].itemId}?offset=0`, { raw: data, method: 'PUT' });
    await settle(c.intake.id);
    const [item] = store.intakeItems(c.intake.id);
    const notes = JSON.parse(item.notes || '[]');
    assert.equal(notes.includes('替换了知识库里原来的同名资料'), i === 1, `第 ${i + 1} 次`);
  }
  assert.ok(repo.readText(kb, '资料/同名/讲义.md')?.includes('第二版'));
});

test('交资料：上传中途取消，没传完的不进知识库，临时文件清掉；别的老师看不到也动不了', async () => {
  const data = Buffer.from('取消测试'.repeat(1000));
  const created = await (await req(`/knowledge/${kb}/intakes`, { json: { files: [{ name: '取消/一.md', size: data.length }, { name: '取消/二.md', size: data.length }] } })).json() as any;
  const id = created.intake.id;
  await req(`/knowledge/${kb}/intakes/${id}/items/${created.uploads[0].itemId}?offset=0`, { raw: data.subarray(0, 100), method: 'PUT' });
  assert.equal((await req(`/knowledge/${kb}/intakes/${id}`, { who: 'other' })).status >= 400, true);
  assert.equal((await req(`/knowledge/${kb}/intakes/${id}/cancel`, { who: 'other', json: {} })).status >= 400, true);
  const canceled = await (await req(`/knowledge/${kb}/intakes/${id}/cancel`, { json: {} })).json() as any;
  assert.equal(canceled.intake.status, 'canceled');
  assert.ok(store.intakeItems(id).every((i) => i.status === 'skipped'));
  assert.ok(!existsSync(store.stageDir(id)));
  const late = await req(`/knowledge/${kb}/intakes/${id}/items/${created.uploads[1].itemId}?offset=0`, { raw: data, method: 'PUT' });
  assert.equal(late.status, 409);
  assert.equal(repo.readText(kb, '资料/取消/一.md'), null);
});

test('原件清理：读不了的、取消时收下的从存储里删掉，进了知识库的留着', async () => {
  const video = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, ...new Array(4000).fill(7)]);
  const doc = Buffer.from('# 清理测试\n\n这份要留在知识库里。\n');
  const c = (await (await req(`/knowledge/${kb}/intakes`, { json: { files: [{ name: '清理/录像.mp4', size: video.length }, { name: '清理/讲义.md', size: doc.length }] } })).json()) as any;
  await req(`/knowledge/${kb}/intakes/${c.intake.id}/items/${c.uploads[0].itemId}?offset=0`, { raw: video, method: 'PUT' });
  await req(`/knowledge/${kb}/intakes/${c.intake.id}/items/${c.uploads[1].itemId}?offset=0`, { raw: doc, method: 'PUT' });
  await settle(c.intake.id);
  const [v, d] = store.intakeItems(c.intake.id);
  assert.equal(v.status, 'failed');
  assert.ok(!existsSync(store.blobPath(v.hash!)), '读不了的视频还留在存储里');
  assert.ok(existsSync(store.blobPath(d.hash!)), '进了知识库的原件被删了');

  const part = Buffer.from('取消前收下的'.repeat(500));
  const k = (await (await req(`/knowledge/${kb}/intakes`, { json: { files: [{ name: '清理/甲.md', size: part.length }, { name: '清理/乙.md', size: part.length }] } })).json()) as any;
  await req(`/knowledge/${kb}/intakes/${k.intake.id}/items/${k.uploads[0].itemId}?offset=0`, { raw: part, method: 'PUT' });
  const received = store.intakeItems(k.intake.id).find((i) => i.hash)!;
  assert.ok(existsSync(store.blobPath(received.hash!)));
  await req(`/knowledge/${kb}/intakes/${k.intake.id}/cancel`, { json: {} });
  assert.ok(!existsSync(store.blobPath(received.hash!)), '取消后收下的文件还在');
});

test('故意构造的网页不拖慢读资料；名字截断不切坏表情符号；老接口一次最多 50MB', async () => {
  const { parseHtml } = await import('../src/kb/intake/html.js');
  const text = (n: any): string => (typeof n === 'string' ? n : (n.children || []).map(text).join(''));
  assert.equal(text(parseHtml('<style>p{}</style><!-- 注 --><p>官方<![CDATA[文档]]></p><SCRIPT>x()</SCRIPT>')), '官方文档');
  const t0 = Date.now();
  parseHtml('<p>开头</p>' + '<script '.repeat(50_000) + '<!-- '.repeat(50_000));
  assert.ok(Date.now() - t0 < 1000, `用了 ${Date.now() - t0}ms`);

  const { cleanSegment } = await import('../src/kb/intake/naming.js');
  const cut = cleanSegment('a' + '😀'.repeat(50) + '.docx');
  assert.ok(![...cut].some((ch) => ch.codePointAt(0)! >= 0xd800 && ch.codePointAt(0)! <= 0xdfff));
  assert.doesNotThrow(() => encodeURIComponent(cut));

  const form = new FormData();
  form.append('file', new File([new Uint8Array(51 * 1024 * 1024)], '太大.md'));
  const res = await req(`/knowledge/${kb}/kb/upload`, { form });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as any).error, /太大/);
});

test('老的一次性上传方式和长内容：照常收下、读好再回答；长内容按一份资料收', async () => {
  const form = new FormData();
  form.append('file', new File(['# 第二章\n\n函数的定义。\n'], '第二章 函数.md'));
  form.append('file', new File([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, ...new Array(64).fill(0)])], '录像.mp4'));
  const legacy = await (await req(`/knowledge/${kb}/kb/upload`, { form })).json() as any;
  assert.equal(legacy.done.length, 1);
  assert.equal(legacy.failed.length, 1);
  assert.match(legacy.failed[0].error, /视频/);

  const long = '# 第三章 讲稿\n\n' + '这一段讲循环的写法和常见错误。'.repeat(400);
  const r = await (await req(`/knowledge/${kb}/kb/runs`, { json: { message: long } })).json() as any;
  assert.ok(r.intakeId);
  const row = await settle(r.intakeId);
  const [doc] = store.intakeItems(r.intakeId);
  assert.equal(doc.kind, 'text');
  assert.equal(doc.name.replace(/\.txt$/, ''), '第三章 讲稿');
  assert.ok(['digesting', 'paused', 'done'].includes(row.status));
  assert.ok(repo.readText(kb, doc.path!)?.includes('这一段讲循环的写法'));
});

test('知识库搜索：按名字（不含扩展名）和内容找，附上下文；别的老师搜不了', async () => {
  const put = await req(`/knowledge/${kb}/kb/file`, { method: 'PUT', json: { path: '笔记/搜索测试 递归讲法.md', content: '# 递归讲法\n\n先讲基例，再讲递归例。汉诺塔放在最后讲，用三根小棒演示。\n', base: null } });
  assert.equal(put.status, 200);
  const find = async (q: string, who?: 'other') => req(`/knowledge/${kb}/kb/search?q=${encodeURIComponent(q)}`, { who });
  const byName = (await (await find('递归讲法')).json()) as any;
  assert.ok(byName.results.some((r: any) => r.path === '笔记/搜索测试 递归讲法.md'));
  const byText = (await (await find('三根小棒')).json()) as any;
  const hit = byText.results.find((r: any) => r.path === '笔记/搜索测试 递归讲法.md');
  assert.ok(hit && hit.snippet.includes('三根小棒') && !hit.snippet.includes('\n'), JSON.stringify(byText));
  assert.equal(((await (await find('md')).json()) as any).results.length, 0, '扩展名不算名字');
  assert.deepEqual(((await (await find('   ')).json()) as any).results, []);
  assert.equal((await find('递归', 'other')).status, 403);
});

test('长期库交了带学生信息的资料：标出哪个班几个人，整理完能改交到那个班；两个班的不给改交', async () => {
  const cls = await repo.createKnowledgeBase({ teacherId: teacher, name: '演练2401班', className: '演练2401班', term: '2026秋' });
  const cls2 = await repo.createKnowledgeBase({ teacherId: teacher, name: '演练2402班', className: '演练2402班', term: '2026秋' });
  db.insert('kb_students', { kb_id: cls, name: '林小雨', student_no: '2401001', aliases: '[]', created_at: Date.now() });
  db.insert('kb_students', { kb_id: cls, name: '周明', student_no: '2401002', aliases: '[]', created_at: Date.now() });
  db.insert('kb_students', { kb_id: cls2, name: '吴桐', student_no: '2402001', aliases: '[]', created_at: Date.now() });
  const hand = async (name: string, text: string) => {
    const data = Buffer.from(text);
    const c = (await (await req(`/knowledge/${kb}/intakes`, { json: { files: [{ name, size: data.length }] } })).json()) as any;
    await req(`/knowledge/${kb}/intakes/${c.intake.id}/items/${c.uploads[0].itemId}?offset=0`, { raw: data, method: 'PUT' });
    await settle(c.intake.id);
    return c.intake.id as number;
  };
  const move = (id: number, item: number, classId: number, who?: 'other') => req(`/knowledge/${kb}/intakes/${id}/items/${item}/to-class`, { who, json: { classId } });
  const one = await hand('递归作业成绩.csv', '学号,姓名,分数\n2401001,林小雨,92\n2401002,周明,58\n');
  let view = ((await (await req(`/knowledge/${kb}/intakes/${one}`)).json()) as any).intake;
  assert.equal(view.students.length, 1);
  assert.deepEqual(
    view.students[0].classes.map((c: any) => [c.kbId, c.name, c.count, c.active]),
    [[cls, '演练2401班', 2, true]],
  );
  const item = view.students[0];
  // 还在整理（没有模型时停在「已停下」）就不能挪
  assert.equal((await move(one, item.itemId, cls)).status, 409);
  await req(`/knowledge/${kb}/intakes/${one}/finish`, { json: {} });
  const moved = await move(one, item.itemId, cls);
  assert.equal(moved.status, 200);
  const res = (await moved.json()) as any;
  assert.equal(res.intake.students.length, 0);
  assert.ok(res.intake.items.find((i: any) => i.id === item.itemId).notes.includes('已改交到演练2401班'));
  assert.ok(!repo.manifest(kb).some((e) => e.path === item.path), '长期库里还留着原件');
  await settle(res.moved.id);
  const classItem = store.intakeItems(res.moved.id).find((i) => i.method !== 'archive')!;
  assert.ok(classItem.path && repo.manifest(cls).some((e) => e.path === classItem.path), '班级库没收到');
  assert.ok((await move(one, item.itemId, cls)).status >= 400, '同一份不能改交两次');
  // 两个班的学生都有：标出来，但不给改交；别的老师也动不了
  const two = await hand('两个班的名单.csv', '姓名\n林小雨\n吴桐\n');
  await req(`/knowledge/${kb}/intakes/${two}/finish`, { json: {} });
  view = ((await (await req(`/knowledge/${kb}/intakes/${two}`)).json()) as any).intake;
  assert.equal(view.students[0].classes.length, 2);
  assert.equal((await move(two, view.students[0].itemId, cls)).status, 400);
  assert.ok((await move(two, view.students[0].itemId, cls, 'other')).status >= 400);
});
