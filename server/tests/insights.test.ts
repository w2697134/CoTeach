import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CT_DATA_DIR = mkdtempSync(join(tmpdir(), 'ct-insights-'));
const { cleanInsights } = await import('../src/grading/insights.js');

const entries = [
  { id: 'a1-1', kind: 'item' as const, homework: '第三章', users: [1, 2, 3], loss: 18, text: '', samples: ['张三 range(1,100) 少了 100', '少加了 100'] },
  { id: 'a1-2', kind: 'item' as const, homework: '第三章', users: [1, 2, 3, 4, 5], loss: 10, text: '', samples: ['没写注释'] },
  { id: 'q7', kind: 'ask' as const, users: [6], loss: 0, text: 'range(1,100) 和 range(1,101) 有什么区别', samples: [] },
];

test('学情：人数按编号数，编号对不上的不算，丢分多的在前，名字换成「有同学」', () => {
  const points = cleanInsights(
    {
      points: [
        { title: '注释', what: '没写注释', teach: '讲注释', refs: ['a1-2'] },
        { title: 'range 边界', what: '张三 漏了 100', teach: '画数轴', refs: ['[a1-1]', 'q7', 'x9'] },
        { title: '对不上的', what: '', teach: '', refs: ['x9'] },
      ],
    },
    entries,
    ['张三'],
  );
  assert.deepEqual(
    points.map((p) => [p.title, p.lost, p.asked]),
    [
      ['range 边界', 3, 1],
      ['注释', 5, 0],
    ],
  );
  assert.equal(points[0].what, '有同学 漏了 100');
  assert.deepEqual(points[0].reasons, ['有同学 range(1,100) 少了 100', '少加了 100']);
  assert.deepEqual(points[0].questions, ['range(1,100) 和 range(1,101) 有什么区别']);
});
