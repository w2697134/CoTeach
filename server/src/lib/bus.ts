import { EventEmitter } from 'node:events';

/**
 * 进程内事件总线：用于把工作流进度、课堂互动、批改进度等实时推送给 SSE 订阅者。
 * topic 例如 `run:12`、`live:3`、`grading:8`、`user:5`。
 */
class Bus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(0);
  }
  publish(topic: string, event: string, data: unknown) {
    this.ee.emit(topic, { event, data });
  }
  subscribe(topic: string, fn: (msg: { event: string; data: unknown }) => void): () => void {
    this.ee.on(topic, fn);
    return () => this.ee.off(topic, fn);
  }
  listeners(topic: string) {
    return this.ee.listenerCount(topic);
  }
}

export const bus = new Bus();
