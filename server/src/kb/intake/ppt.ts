/**
 * 老版 PowerPoint（97–2003）的文字：按演示顺序取每页标题、正文、文本框和备注。
 * 依据微软公开的 [MS-PPT] 格式说明，沿最后一次保存的记录找每页内容，旧版本的残留文字不会混进来。
 */
export interface PptSlide {
  title: string;
  texts: string[];
  notes: string[];
}
export class PptEncrypted extends Error {}

const T = {
  Document: 0x03e8,
  Slide: 0x03ee,
  SlideAtom: 0x03ef,
  Notes: 0x03f0,
  SlidePersistAtom: 0x03f3,
  TextHeaderAtom: 0x0f9f,
  TextCharsAtom: 0x0fa0,
  TextBytesAtom: 0x0fa8,
  SlideListWithText: 0x0ff0,
  UserEditAtom: 0x0ff5,
  PersistDirectoryAtom: 0x1772,
} as const;

interface Rec {
  ver: number;
  inst: number;
  type: number;
  len: number;
  body: number;
  end: number;
}

export function readPptStreams(doc: Uint8Array, currentUser: Uint8Array | null): PptSlide[] {
  const dv = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  const rec = (off: number): Rec | null => {
    if (off < 0 || off + 8 > doc.length) return null;
    const vi = u16(off),
      len = u32(off + 4);
    const end = off + 8 + len;
    if (end > doc.length) return null;
    return { ver: vi & 0xf, inst: vi >> 4, type: u16(off + 2), len, body: off + 8, end };
  };
  const children = (r: Rec): Rec[] => {
    const out: Rec[] = [];
    for (let p = r.body; p + 8 <= r.end; ) {
      const c = rec(p);
      if (!c || c.end > r.end) break;
      out.push(c);
      p = c.end;
    }
    return out;
  };
  const textOf = (r: Rec) => {
    const bytes = doc.subarray(r.body, r.end);
    const s = r.type === T.TextCharsAtom ? Buffer.from(bytes).toString('utf16le') : Buffer.from(bytes).toString('latin1');
    return s
      .replace(/[\r\u000b]/g, '\n')
      .replace(/[\u0000-\u0008\u000e-\u001f]/g, '')
      .trim();
  };
  /** 在一个容器里按出现顺序取「文字类型 + 文字」 */
  const collect = (r: Rec, out: { type: number; text: string }[], depth = 0) => {
    if (depth > 40) return;
    let type = -1;
    for (const c of children(r)) {
      if (c.type === T.TextHeaderAtom && c.len >= 4) type = u32(c.body);
      else if (c.type === T.TextCharsAtom || c.type === T.TextBytesAtom) {
        const text = textOf(c);
        if (text && text !== '*') out.push({ type, text });
        type = -1;
      } else if (c.ver === 0xf) collect(c, out, depth + 1);
    }
  };

  const persist = new Map<number, number>();
  let docRef = 0;
  let edit = currentUser && currentUser.length >= 20 ? new DataView(currentUser.buffer, currentUser.byteOffset, currentUser.byteLength).getUint32(16, true) : 0;
  const seen = new Set<number>();
  while (edit && !seen.has(edit)) {
    seen.add(edit);
    const r = rec(edit);
    if (!r || r.type !== T.UserEditAtom || r.len < 28) break;
    if (r.len >= 32 && u32(r.body + 28)) throw new PptEncrypted();
    if (!docRef) docRef = u32(r.body + 16);
    const dir = rec(u32(r.body + 12));
    if (dir && dir.type === T.PersistDirectoryAtom) {
      for (let p = dir.body; p + 4 <= dir.end; ) {
        const v = u32(p);
        const id = v & 0xfffff,
          count = v >>> 20;
        p += 4;
        for (let k = 0; k < count && p + 4 <= dir.end; k++, p += 4) if (!persist.has(id + k)) persist.set(id + k, u32(p));
      }
    }
    edit = u32(r.body + 8);
  }

  const document = docRef && persist.has(docRef) ? rec(persist.get(docRef)!) : null;
  if (!document || document.type !== T.Document) return fallback(doc, rec, children, collect);

  const lists = children(document).filter((c) => c.type === T.SlideListWithText);
  const slideList = lists.find((l) => l.inst === 0);
  const notesList = lists.find((l) => l.inst === 2);
  const notesById = new Map<number, number>();
  if (notesList)
    for (const c of children(notesList)) if (c.type === T.SlidePersistAtom && c.len >= 16) notesById.set(u32(c.body + 12), u32(c.body));

  const slides: PptSlide[] = [];
  if (!slideList) return fallback(doc, rec, children, collect);
  type Group = { persist: number; texts: { type: number; text: string }[] };
  let current: Group | null = null;
  const groups: Group[] = [];
  let pendingType = -1;
  for (const c of children(slideList)) {
    if (c.type === T.SlidePersistAtom) {
      current = { persist: u32(c.body), texts: [] };
      groups.push(current);
      pendingType = -1;
    } else if (current && c.type === T.TextHeaderAtom && c.len >= 4) pendingType = u32(c.body);
    else if (current && (c.type === T.TextCharsAtom || c.type === T.TextBytesAtom)) {
      const text = textOf(c);
      if (text && text !== '*') current.texts.push({ type: pendingType, text });
      pendingType = -1;
    }
  }
  for (const g of groups) {
    const all = [...g.texts];
    const off = persist.get(g.persist);
    const container = off === undefined ? null : rec(off);
    let notes: string[] = [];
    if (container && container.type === T.Slide) {
      collect(container, all);
      const atom = children(container).find((c) => c.type === T.SlideAtom);
      const notesRef = atom && atom.len >= 20 ? u32(atom.body + 16) : 0;
      const notesPersist = notesRef ? notesById.get(notesRef) : undefined;
      const notesOff = notesPersist === undefined ? undefined : persist.get(notesPersist);
      const notesRec = notesOff === undefined ? null : rec(notesOff);
      if (notesRec && notesRec.type === T.Notes) {
        const found: { type: number; text: string }[] = [];
        collect(notesRec, found);
        notes = unique(found.filter((t) => t.type === 2 || t.type === -1 || t.type === 4).map((t) => t.text)).filter((t) => !/^\d+$/.test(t));
      }
    }
    const titleItem = all.find((t) => t.type === 0 || t.type === 6);
    slides.push({
      title: titleItem?.text.replace(/\n+/g, ' ') || '',
      texts: unique(all.filter((t) => t !== titleItem && t.text !== titleItem?.text).map((t) => t.text)),
      notes,
    });
  }
  return slides;
}

function unique(list: string[]) {
  const seen = new Set<string>();
  return list.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
}

/** 找不到保存记录时，按页容器顺序把文字取出来；内容可能含已删的旧页，所以只作后备。 */
function fallback(
  doc: Uint8Array,
  rec: (o: number) => Rec | null,
  children: (r: Rec) => Rec[],
  collect: (r: Rec, out: { type: number; text: string }[]) => void,
): PptSlide[] {
  const slides: PptSlide[] = [];
  for (let p = 0; p + 8 <= doc.length; ) {
    const r = rec(p);
    if (!r) break;
    if (r.type === T.Slide) {
      const texts: { type: number; text: string }[] = [];
      collect(r, texts);
      const title = texts.find((t) => t.type === 0 || t.type === 6);
      slides.push({ title: title?.text || '', texts: unique(texts.filter((t) => t !== title).map((t) => t.text)), notes: [] });
    }
    p = r.ver === 0xf && r.type !== T.Slide ? r.body : r.end;
    void children;
  }
  return slides;
}
