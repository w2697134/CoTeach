import test from 'node:test';
import assert from 'node:assert/strict';
import { toolPresentation, stepLines, plainPath, plainText, parseRoster, readableError, fileTitle, folderItems, withoutFrontMatter, splitTitle, rehypeKbLinks, kbTarget, KB_LINK } from '../../web/src/pages/kb/presentation.js';

test('工作记录：同一类事连着做的并成一行，没做成的和英文自言自语不摆，名字不带扩展名', () => {
  const ev = (id: number, type: string, data: Record<string, unknown>) => ({ id, type, data });
  const lines = stepLines([
    ev(1, 'say', { text: "I'll start by surveying the directory" }),
    ev(2, 'tool', { name: 'list_files', path: '' }),
    ev(3, 'tool', { name: 'list_files', path: '计科5班', error: '没有这个文件' }),
    ev(4, 'tool', { name: 'read_file', path: '老师发来的/资料/第1章 教案.docx.md' }),
    ev(5, 'tool', { name: 'read_file', path: '老师发来的/资料/第2章 教案.docx.md' }),
    ev(6, 'tool', { name: 'read_file', path: '老师发来的/资料/第3章 程序控制结构.pptx.md' }),
    ev(7, 'tool', { name: 'read_file', path: '老师发来的/资料/学生名单.xlsx.md' }),
    ev(8, 'say', { text: '先写总览。' }),
    ev(9, 'tool', { name: 'write_file', path: '计科5班/00 总览.md' }),
  ]);
  assert.deepEqual(
    lines.map((l) => [l.kind, l.label, l.text]),
    [
      ['tool', '查看目录', ''],
      ['tool', '阅读', '第1章 教案、第2章 教案、第3章 程序控制结构 等 4 份'],
      ['say', '', '先写总览。'],
      ['tool', '整理', '00 总览'],
    ],
  );
});

test('资料名去掉扩展名，名字本身一个字不吃', () => {
  const cases: [string, string][] = [
    ['课程资料包.zip', '课程资料包'],
    ['第一章/讲义.docx', '讲义'],
    ['题库.xlsx', '题库'],
    ['板书照片.png', '板书照片'],
    ['资料/第7章 递归.md', '第7章 递归'],
    ['TCP', 'TCP'],
    ['README', 'README'],
    ['Unit1', 'Unit1'],
    ['Week 3 notes', 'Week 3 notes'],
    ['课程大纲v2', '课程大纲v2'],
    ['第3.2节 小结', '第3.2节 小结'],
    ['讲义v1.2', '讲义v1.2'],
  ];
  for (const [input, want] of cases) assert.equal(fileTitle(input), want, input);
  assert.equal(plainPath('资料/课程资料包/第3章 函数/课件.pptx'), '资料 · 课程资料包 · 第3章 函数 · 课件');
});

test('旧失败步骤缺字段不崩溃，不暴露 undefined、工具纠错话或路径', () => {
  for (const name of ['write_file', 'move_file', 'finish', 'search', 'read_file', 'done']) {
    const view = toolPresentation({ name, label: '旧标签', error: '没有实际改动，无需修改时请调用 done' });
    assert.ok(view.label);
    assert.equal(view.error, '这一步没办成');
    assert.ok(!JSON.stringify(view).includes('undefined'));
  }
  assert.equal(plainPath(undefined), '');
  assert.equal(plainText(null), '');
  for (const name of ['constructor', '__proto__', 'toString']) assert.equal(toolPresentation({ name, error: '工具未完成' }).label, '整理');
  const view = toolPresentation({ name: 'move_file', from: '笔记/旧名.md', to: '教学方法/新名.md' });
  assert.equal(view.target, '旧名，移到新名');
  assert.ok(!/HTTP|402|JSON|API/.test(readableError('HTTP 402 {"error":"Insufficient Balance"}')));
});
test('名单接受空格、逗号、制表符，姓名可含空格', () => {
  assert.deepEqual(parseRoster('2301004 赵六\n2301005,王五\n2301006\tMary Jane'), [
    { studentNo: '2301004', name: '赵六' },
    { studentNo: '2301005', name: '王五' },
    { studentNo: '2301006', name: 'Mary Jane' },
  ]);
  assert.throws(() => parseRoster('只有姓名'), /只有姓名/);
  assert.throws(() => parseRoster('2301004,赵六,额外一列'), /只填写学号和姓名两列/);
  assert.throws(() => parseRoster('2301004\t赵六\t额外一列'), /只填写学号和姓名两列/);
  assert.throws(() => parseRoster('2301004,'), /缺少学号或姓名/);
  assert.deepEqual(parseRoster('2301004 Mary Jane'), [{ studentNo: '2301004', name: 'Mary Jane' }]);
});

test('文件夹名后面的斜杠不给老师看', () => {
  assert.equal(plainText('依据老师交的资料：笔记/ 下新建课程大纲'), '依据老师交的资料：笔记 下新建课程大纲');
  assert.equal(plainText('放在资料/：原件'), '放在资料：原件');
  assert.equal(plainText('见 资料/第7章 递归.md'), '见 资料 · 第7章 递归');
});

test('一格一格的文件：文件夹在前、文件在后，各自按名字排，第2章在第10章前面', () => {
  const files = ['第10章/讲义.md', '第2章/讲义.md', '第2章/课件.md', '第2章/练习/一.md', '规矩.md', '课程大纲.md', '第2章 小结.md'].map((path) => ({ path }));
  const top = folderItems(files, '', new Set(['第2章/练习/一.md']));
  assert.deepEqual(
    top.map((i) => [i.kind, i.name, i.kind === 'folder' ? i.count : null, i.pending]),
    [
      ['folder', '第2章', 3, true],
      ['folder', '第10章', 1, false],
      ['file', '第2章 小结', null, false],
      ['file', '规矩', null, false],
      ['file', '课程大纲', null, false],
    ],
  );
  // 进到文件夹里：只列直接放着的，下一层的文件夹算一项
  assert.deepEqual(
    folderItems(files, '第2章').map((i) => [i.kind, i.name]),
    [
      ['folder', '练习'],
      ['file', '讲义'],
      ['file', '课件'],
    ],
  );
  // 名字前面一样的文件夹不算在里面
  assert.deepEqual(folderItems([{ path: '第2章补充/a.md' }, { path: '第2章/b.md' }], '第2章').map((i) => i.name), ['b']);
});

test('笔记正文：开头的元信息块不显示，大标题单独拿出来', () => {
  assert.equal(withoutFrontMatter('---\ntitle: 第7章\nkps: 递归\n---\n# 第7章 递归\n正文'), '# 第7章 递归\n正文');
  assert.equal(withoutFrontMatter('正文\n---\n不是元信息\n---\n'), '正文\n---\n不是元信息\n---\n');
  assert.deepEqual(splitTitle('# 第7章 递归（整理）\n\n出处：资料/第7章 递归.md', '第7章 递归'), { title: '第7章 递归（整理）', body: '\n出处：资料/第7章 递归.md' });
  assert.deepEqual(splitTitle('没有大标题', '规矩'), { title: '规矩', body: '没有大标题' });
});

test('笔记里写到的位置能点开，普通词和代码里的不动；相对链接认得出是哪一页', () => {
  const paths = ['资料/第7章 递归.md', '资料/第7章 递归 教案.md', '规矩.md', '笔记/第7章 递归.md'];
  const tree = {
    type: 'root',
    children: [
      { type: 'element', tagName: 'p', children: [{ type: 'text', value: '出处：资料/第7章 递归 教案.md；另见 资料/第7章 递归（全文）。规矩里写了。' }] },
      { type: 'element', tagName: 'code', children: [{ type: 'text', value: '资料/第7章 递归.md' }] },
    ],
  } as any;
  rehypeKbLinks(paths)()(tree);
  const p = tree.children[0].children;
  const links = p.filter((n: any) => n.tagName === 'a').map((n: any) => [n.children[0].value, decodeURIComponent(n.properties.href.slice(KB_LINK.length))]);
  assert.deepEqual(links, [
    ['资料/第7章 递归 教案.md', '资料/第7章 递归 教案.md'],
    ['资料/第7章 递归', '资料/第7章 递归.md'],
  ]);
  assert.equal(p.map((n: any) => n.value ?? n.children[0].value).join(''), '出处：资料/第7章 递归 教案.md；另见 资料/第7章 递归（全文）。规矩里写了。');
  assert.equal(tree.children[1].children[0].value, '资料/第7章 递归.md', '代码里的不该变成链接');

  const known = new Set(paths.concat('进度.md'));
  assert.equal(kbTarget('进度.md', '目录.md', known), '进度.md');
  assert.equal(kbTarget('../资料/第7章%20递归.md', '笔记/第7章 递归.md', known), '资料/第7章 递归.md');
  assert.equal(kbTarget('资料/第7章 递归', '笔记/第7章 递归.md', known), '资料/第7章 递归.md');
  assert.equal(kbTarget('https://example.com/规矩.md', '目录.md', known), null);
  assert.equal(kbTarget('#小节', '目录.md', known), null);
  assert.equal(kbTarget('不存在.md', '目录.md', known), null);
});
