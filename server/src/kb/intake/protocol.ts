/** 主线程和读资料线程之间传的消息。读资料很吃 CPU，放在单独线程里，不会卡住其他老师的页面。 */
import type { ExpandLimits, ExpandedFile, Refused } from './archive.js';
import type { Kind } from './kinds.js';
import type { VisionImage } from './images.js';

export interface WorkerAssets {
  sevenZipWasm: string;
  pdf: { cMapUrl: string; standardFontDataUrl: string; wasmUrl: string };
}
export type Task =
  | { op: 'read'; name: string; file: string }
  | { op: 'expand'; name: string; file: string; outDir: string; limits: ExpandLimits };
export type WireBlock = { t: 'md'; text: string } | { t: 'img'; key: string; label: string; image: VisionImage };
export type ReadResult =
  | { type: 'archive' }
  | { type: 'cannot'; kind: Kind; reason: string; advice: string }
  | { type: 'failed'; kind: Kind; reason: string; advice: string; skip: boolean }
  | { type: 'document'; kind: Kind; blocks: WireBlock[]; notes: string[] };
export type ExpandResult =
  | { type: 'expanded'; files: ExpandedFile[]; refused: Refused[] }
  | { type: 'failed'; reason: string; advice: string };
export type Reply = { id: number; ok: true; result: ReadResult | ExpandResult } | { id: number; ok: false; error: string };
