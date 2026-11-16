import test from 'node:test';
import assert from 'node:assert/strict';

const { agyForTest } = await import('../src/llm/adapters/agy.js');
const { toWire, parseStep } = agyForTest;

const tools = [
  { name: 'create_class', description: '建一个班', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'list_classes', description: '列出老师的班', parameters: { type: 'object', properties: {} } },
];

test('Gemini 接口：工具写进要求里，用过的工具写成 JSON，工具结果当下一条消息', () => {
  const wire = toWire(
    [
      { role: 'system', content: '你是助教' },
      { role: 'user', content: '帮我建个计科5班' },
      { role: 'assistant', content: '好的', toolCalls: [{ id: 'c1', name: 'create_class', args: { name: '计科5班' }, raw: '' }] },
      { role: 'tool', toolCallId: 'c1', content: '建好了「计科5班」' },
    ],
    tools,
  );
  assert.equal(wire[0].role, 'system');
  assert.match(String(wire[0].content), /create_class：建一个班/);
  assert.deepEqual(JSON.parse(String(wire[3].content)), { say: '好的', calls: [{ tool: 'create_class', args: { name: '计科5班' } }] });
  assert.deepEqual(wire[4], { role: 'user', content: '（create_class 的结果）\n建好了「计科5班」' });
});

test('Gemini 接口：交上来的 JSON 拆成要说的话和工具调用；参数写成字符串的也认；拆不开整段当话', () => {
  const a = parseStep('{"say":"这就建","calls":[{"tool":"create_class","args":{"name":"计科5班"}},{"tool":"list_classes","args":"{}"}]}');
  assert.equal(a.say, '这就建');
  assert.deepEqual(
    a.calls.map((c) => [c.name, c.args]),
    [
      ['create_class', { name: '计科5班' }],
      ['list_classes', {}],
    ],
  );
  assert.deepEqual(parseStep('```json\n{"say":"好","calls":[]}\n```'), { say: '好', calls: [] });
  assert.deepEqual(parseStep('就是一段话'), { say: '就是一段话', calls: [] });
});
