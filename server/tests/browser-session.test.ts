import test from 'node:test';
import assert from 'node:assert/strict';
const modulePath = '../../web/src/lib/api.ts';
const { api, resetPrivateSession, subscribe } = await import(modulePath);

test('账号切换丢弃旧请求、晚到响应并关闭旧事件流', async (t) => {
  const originalFetch = globalThis.fetch,
    originalEventSource = (globalThis as any).EventSource;
  try {
    await t.test('未完成的私有请求被取消', async () => {
      globalThis.fetch = ((_url: any, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const e = new Error('cancelled');
            e.name = 'AbortError';
            reject(e);
          });
        })) as typeof fetch;
      const pending = api('/knowledge/1');
      resetPrivateSession();
      await assert.rejects(pending, { name: 'AbortError' });
    });
    await t.test('响应已到但正文尚未完成时也不能交给新会话', async () => {
      let finish: (value: any) => void = () => {};
      globalThis.fetch = async () => {
        const response = new Response('', { headers: { 'content-type': 'application/json' } });
        Object.defineProperty(response, 'json', {
          value: () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        });
        return response;
      };
      const pending = api('/knowledge/1');
      await new Promise<void>((resolve) => setImmediate(resolve));
      resetPrivateSession();
      finish({ private: '上一位老师的资料' });
      await assert.rejects(pending, { name: 'AbortError' });
    });
    await t.test('已有事件流立即关闭，登录请求不被取消', async () => {
      let closed = 0;
      (globalThis as any).EventSource = class {
        addEventListener() {}
        close() {
          closed++;
        }
      };
      const unsubscribe = subscribe('/knowledge/1/kb/stream', {});
      resetPrivateSession();
      assert.equal(closed, 1);
      unsubscribe();
      globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
      const pending = api('/auth/me');
      resetPrivateSession();
      assert.deepEqual(await pending, { ok: true });
    });
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as any).EventSource = originalEventSource;
    resetPrivateSession();
  }
});
