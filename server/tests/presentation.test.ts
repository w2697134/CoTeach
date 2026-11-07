import test from 'node:test';
import assert from 'node:assert/strict';
import { toolPresentation, plainPath, plainText, parseRoster, readableError } from '../../web/src/pages/kb/presentation.js';

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
