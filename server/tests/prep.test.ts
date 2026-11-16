import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CT_DATA_DIR = mkdtempSync(join(tmpdir(), 'ct-prep-'));
const { cleanPlan } = await import('../src/grading/prep.js');

test('备课：教案要有课题和教学过程；分钟数不像样的不要，空的环节去掉', () => {
  assert.throws(() => cleanPlan({ title: '', steps: [{ name: '导入', content: '讲' }] }), /课题和教学过程/);
  assert.throws(() => cleanPlan({ title: '递归', steps: [] }), /课题和教学过程/);
  const p = cleanPlan({
    title: '递归',
    goals: ['会写递归', ''],
    steps: [
      { name: '导入', minutes: 5, content: '排队报数' },
      { name: '讲授', minutes: 999, content: '两要素' },
      { name: '空的', minutes: 3, content: '' },
    ],
  });
  assert.deepEqual(p.goals, ['会写递归']);
  assert.deepEqual(
    p.steps.map((s) => [s.name, s.minutes]),
    [
      ['导入', 5],
      ['讲授', null],
    ],
  );
});
