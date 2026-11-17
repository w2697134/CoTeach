/**
 * 备课边做边显示。
 * 模型写到一半的教案、课件内容、题目，和做成了还没存进课件的幻灯片页，放在内存里；页面取这节课时一起带上。
 * 写完存进数据库就去掉；服务重启就没了（没做完的那几手本来就会标成出错，老师点重来）。
 */
import type { Plan, Question, Slide } from './lessons.js';

export interface LiveDraft {
  /** 教案写到哪了 */
  plan?: Partial<Plan>;
  /** 课件内容写到哪了（还没做成幻灯片） */
  slides?: Slide[];
  /** 做成幻灯片的页：第几页（0 起）→ HTML，还没存进课件的 */
  pages?: Record<number, string>;
  /** 课堂练习、课后作业出到哪了 */
  practice?: Question[];
  homework?: Question[];
  /** 正在翻知识库里的哪一份、找什么（还没开始写的时候，页面上说它在干什么） */
  activity?: string;
}

const live = new Map<number, LiveDraft>();

export function liveOf(id: number): LiveDraft | null {
  const d = live.get(id);
  if (!d) return null;
  const out: LiveDraft = {};
  if (d.plan) out.plan = d.plan;
  if (d.slides?.length) out.slides = d.slides;
  if (d.pages && Object.keys(d.pages).length) out.pages = d.pages;
  if (d.practice?.length) out.practice = d.practice;
  if (d.homework?.length) out.homework = d.homework;
  if (d.activity) out.activity = d.activity;
  return Object.keys(out).length ? out : null;
}

export function setLive(id: number, patch: LiveDraft) {
  live.set(id, { ...live.get(id), ...patch });
}

/** 做成幻灯片的几页先放着 */
export function setLivePages(id: number, pages: Record<number, string>) {
  const d = live.get(id) || {};
  d.pages = { ...d.pages, ...pages };
  live.set(id, d);
}

/** 这几页存进课件了，不用再放着 */
export function dropLivePages(id: number, pages: number[]) {
  const d = live.get(id);
  if (!d?.pages) return;
  for (const i of pages) delete d.pages[i];
}

/** 去掉写完的那几样；不写就全去掉 */
export function dropLive(id: number, ...keys: (keyof LiveDraft)[]) {
  if (!keys.length) {
    live.delete(id);
    return;
  }
  const d = live.get(id);
  if (d) for (const k of keys) delete d[k];
}
