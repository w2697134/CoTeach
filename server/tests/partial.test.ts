import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePartialJson, partialCall, throttle } from '../src/llm/partial.js';

test('写到一半的 JSON：读出写完的部分，字符串写了一半也照样给，读不出来给 undefined', () => {
  const full = JSON.stringify({ title: '字典', slides: [{ title: '封面', points: ['a', 'b'] }, { title: '第二页', points: ['c'] }] });
  assert.deepEqual(parsePartialJson(full), JSON.parse(full));
  assert.equal(parsePartialJson(''), undefined);
  assert.equal(parsePartialJson('{"a": tru'), undefined);
  // 停在值的字符串里：补完
  assert.deepEqual(parsePartialJson('{"title": "字'), { title: '字' });
  // 停在键的字符串里：切回上一个写完的值
  assert.deepEqual(parsePartialJson('{"title": "字典", "sli'), { title: '字典' });
  // 停在冒号后、数字中间
  assert.deepEqual(parsePartialJson('{"a": 1, "b":'), { a: 1 });
  assert.deepEqual(parsePartialJson('{"a": 12'), { a: 12 });
  // 数组里写到第二个对象一半
  assert.deepEqual(parsePartialJson('{"slides": [{"title": "封面"}, {"title": "第二'), { slides: [{ title: '封面' }, { title: '第二' }] });
  // 字符串里带转义、停在半截转义上
  assert.deepEqual(parsePartialJson('{"html": "<div class=\\"slide\\">一\\'), { html: '<div class="slide">一' });
  // 一截一截往后读，读出来有内容的页只会越来越多（刚开了个「{」的空页不算，页面上本来也不摆）
  let last = -1;
  for (let n = 1; n <= full.length; n++) {
    const v = parsePartialJson(full.slice(0, n)) as { slides?: object[] } | undefined;
    const k = (v?.slides ?? []).filter((s) => s && Object.keys(s).length).length;
    assert.ok(k >= last || k === 0, `第 ${n} 个字：${k} < ${last}`);
    if (k) last = k;
  }
});

test('写到一半的工具调用：普通的直接是参数；Gemini 接口那种整步 JSON 取最后一个工具', () => {
  assert.deepEqual(partialCall({ name: 'save_deck', text: '{"slides": [{"title": "A"}' }), { name: 'save_deck', args: { slides: [{ title: 'A' }] } });
  assert.equal(partialCall({ name: 'save_deck', text: '[1, 2' }), null);
  const step = JSON.stringify({ say: '存', calls: [{ tool: 'read_kb', args: { path: 'a' } }, { tool: 'save_deck', args: { slides: [{ title: 'A' }, { title: 'B' }] } }] });
  assert.deepEqual(partialCall({ name: '', text: step.slice(0, step.length - 6), wrapped: true }), { name: 'save_deck', args: { slides: [{ title: 'A' }, { title: 'B' }] } });
  assert.equal(partialCall({ name: '', text: '{"say": "想一想", "cal', wrapped: true }), null);
});

test('隔一会儿才报一次：同样长、太快的不报', async () => {
  const due = throttle(30);
  assert.equal(due(10), true);
  assert.equal(due(20), false);
  await new Promise((ok) => setTimeout(ok, 40));
  assert.equal(due(10), false);
  assert.equal(due(25), true);
});
