import test from 'node:test';
import assert from 'node:assert/strict';
import { toolPresentation, plainPath, plainText, parseRoster, readableError, fileTitle, outline, withoutFrontMatter, splitTitle, rehypeKbLinks, kbTarget, KB_LINK } from '../../web/src/pages/kb/presentation.js';

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
    assert.equal(view.error, '这一步没有完成');
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

test('目录的顺序跟着整理助手写的「目录」走，「第7章 递归」不算在「第7章 递归 教案」里提到', () => {
  const directory = '# 目录\n- [进度](进度.md)：课讲到哪了\n- 规矩：全课通用的规矩\n- 笔记：整理好的内容\n  - 课程大纲：课程信息\n  - 第7章 递归 教案：教学过程\n  - 第6章 函数基础：定义与调用\n  - 第7章 递归：两要素\n';
  const files = ['笔记/第7章 递归.md', '笔记/常见错误.md', '规矩.md', '目录.md', '笔记/第6章 函数基础.md', '进度.md', '笔记/课程大纲.md', '笔记/第7章 递归 教案.md'].map((path) => ({ path }));
  // 「笔记」这一栏里不再套一层「笔记」文件夹；目录里没提到的排在最后
  assert.deepEqual(
    outline(files, directory, '笔记').map((n) => n.path),
    ['目录.md', '进度.md', '规矩.md', '笔记/课程大纲.md', '笔记/第7章 递归 教案.md', '笔记/第6章 函数基础.md', '笔记/第7章 递归.md', '笔记/常见错误.md'],
  );
  // 没有目录时按名字排，数字按大小
  assert.deepEqual(
    outline([{ path: '第10章.md' }, { path: '第9章.md' }, { path: '目录.md' }], '', '笔记').map((n) => n.path),
    ['目录.md', '第9章.md', '第10章.md'],
  );
  // 子文件夹保留层级，按里面最早提到的那一页排
  const nested = outline([{ path: '第二单元/讲义.md' }, { path: '第一单元/作业.md' }], '- 作业\n- 讲义', '笔记');
  assert.deepEqual(nested.map((n) => [n.name, n.children.map((c) => c.name)]), [['第一单元', ['作业.md']], ['第二单元', ['讲义.md']]]);
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
