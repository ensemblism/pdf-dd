import { diffArrays, diffChars } from 'diff';
import type { Anchor, Change, Comparison, Page, Span, TextItem } from './model';

interface Mapped {
  text: string;
  refs: (Span | null)[];
}
interface Block extends Mapped {
  page: number;
  y: number;
}
interface Line {
  ids: number[];
  x: number;
  y: number;
  right: number;
  height: number;
}
const words = new Intl.Segmenter('zh', { granularity: 'word' });
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Split columns at real gutters, then read each column top-to-bottom. Full-width
// headings divide the page into vertical sections instead of mixing columns.
function readingOrder(lines: Line[], width: number): Line[] {
  if (lines.length < 4) return lines.sort((a, b) => a.y - b.y || a.x - b.x);
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  const candidates = lines
    .filter((l) => l.x > width * 0.28 && l.x < width * 0.72)
    .map((l) => l.x - 5);
  let best = 0,
    split = 0;
  for (const x of candidates) {
    const left = lines.filter((l) => l.right < x),
      right = lines.filter((l) => l.x > x);
    const overlap = left.filter((l) =>
      right.some((r) => Math.abs(r.y - l.y) < Math.max(l.height, r.height)),
    ).length;
    const score = overlap - lines.filter((l) => l.x < x && l.right > x).length * 0.2;
    if (left.length >= 3 && right.length >= 3 && score > best) {
      best = score;
      split = x;
    }
  }
  if (best < 3) return sorted;
  const out: Line[] = [],
    band: Line[] = [];
  const flush = () => {
    out.push(
      ...band.filter((l) => l.right < split).sort((a, b) => a.y - b.y),
      ...band.filter((l) => l.x >= split).sort((a, b) => a.y - b.y),
    );
    band.length = 0;
  };
  for (const line of sorted) {
    if (line.x < split && line.right >= split) {
      flush();
      out.push(line);
    } else band.push(line);
  }
  flush();
  return out;
}

function linesOf(page: Page): Line[] {
  const rows: { id: number; item: TextItem }[][] = [];
  const sorted = page.items
    .map((item, id) => ({ item, id }))
    .filter((x) => x.item.str.trim())
    .sort((a, b) => a.item.y - b.item.y || a.item.x - b.item.x);
  for (const value of sorted) {
    const row = rows.at(-1);
    if (
      row &&
      Math.abs(row[0].item.y - value.item.y) <
        Math.max(2, Math.min(row[0].item.height, value.item.height) * 0.45)
    )
      row.push(value);
    else rows.push([value]);
  }
  const lines: Line[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.item.x - b.item.x);
    let line: Line | undefined;
    for (const { item, id } of row) {
      if (!line || item.x - line.right > Math.max(16, item.height * 2.3)) {
        line = { ids: [], x: item.x, y: item.y, right: item.x, height: item.height };
        lines.push(line);
      }
      line.ids.push(id);
      line.right = Math.max(line.right, item.x + item.width);
      line.height = Math.max(line.height, item.height);
    }
  }
  return readingOrder(lines, page.width);
}

function mappedItems(page: Page, pageIndex: number, ids: number[]): Mapped {
  let text = '';
  const refs: (Span | null)[] = [];
  let previous: TextItem | undefined;
  for (const id of ids) {
    const item = page.items[id];
    if (
      previous &&
      item.x - (previous.x + previous.width) > Math.max(0.7, item.height * 0.12) &&
      !/[\u3400-\u9fff]$/.test(text) &&
      !/^[\u3400-\u9fff]/.test(item.str)
    ) {
      text += ' ';
      refs.push(null);
    }
    for (const { segment, index } of graphemes.segment(item.str)) {
      const normalized = segment.normalize('NFKC').replace(/\s/g, ' ');
      for (let k = 0; k < normalized.length; k++) {
        text += normalized[k];
        refs.push({ page: pageIndex, item: id, start: index, end: index + segment.length });
      }
    }
    previous = item;
  }
  return { text, refs };
}
function compact(value: Mapped): Mapped {
  const refs: (Span | null)[] = [];
  let text = '';
  for (let i = 0; i < value.text.length; i++) {
    const c = value.text[i];
    if (c === ' ' && (!text || text.endsWith(' '))) continue;
    text += c;
    refs.push(value.refs[i]);
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    refs.pop();
  }
  return { text, refs };
}
export function blocksOf(pages: Page[]): Block[] {
  const blocks: Block[] = [];
  pages.forEach((page, p) => {
    let block: Block | undefined, previous: Line | undefined;
    for (const line of linesOf(page)) {
      const next = mappedItems(page, p, line.ids);
      const gap = previous ? line.y - previous.y : Infinity;
      const indent = previous ? line.x - previous.x : 0;
      const paragraph =
        !previous ||
        gap < 0 ||
        gap > Math.max(line.height, previous.height) * 1.65 ||
        Math.abs(indent) > Math.max(18, line.height * 1.6) ||
        Math.abs(line.height - previous.height) > line.height * 0.3;
      if (!block || paragraph) {
        block = { ...next, page: p, y: line.y };
        blocks.push(block);
      } else {
        // Discretionary (soft) hyphens are unambiguously layout-only; ordinary
        // hyphens remain significant to avoid hiding real spelling changes.
        if (block.text.endsWith('\u00ad')) {
          block.text = block.text.slice(0, -1);
          block.refs.pop();
        } else if (!/[\u3400-\u9fff]$/.test(block.text) || !/^[\u3400-\u9fff]/.test(next.text)) {
          block.text += ' ';
          block.refs.push(null);
        }
        block.text += next.text;
        block.refs.push(...next.refs);
      }
      previous = line;
    }
  });
  return blocks.map((b) => ({ ...b, ...compact(b) })).filter((b) => b.text);
}
function join(blocks: Block[]): Mapped {
  const result: Mapped = { text: '', refs: [] };
  for (const b of blocks) {
    if (result.text) {
      result.text += ' ';
      result.refs.push(null);
    }
    result.text += b.text;
    result.refs.push(...b.refs);
  }
  return result;
}
function spans(refs: (Span | null)[]): Span[] {
  const result: Span[] = [];
  for (const ref of refs) {
    if (!ref) continue;
    const last = result.at(-1);
    if (last && last.page === ref.page && last.item === ref.item && ref.start <= last.end)
      last.end = Math.max(last.end, ref.end);
    else result.push({ ...ref });
  }
  return result;
}
function tokens(text: string) {
  const result: string[] = [];
  for (const { segment } of words.segment(text)) {
    if (/^\s+$/.test(segment) && result.length) result[result.length - 1] += segment;
    else result.push(segment);
  }
  return result;
}
function localDiff(left: Mapped, right: Mapped, changes: Change[]) {
  const a = tokens(left.text),
    b = tokens(right.text);
  // Bound pathological revisions. A coarse replacement is still visible and
  // honest; it must never silently turn a timed-out comparison into "equal".
  const parts = diffArrays(a, b, { timeout: 1500 }) ?? [
    { removed: true, added: false, value: a },
    { removed: false, added: true, value: b },
  ];
  let li = 0,
    ri = 0;
  for (let i = 0; i < parts.length;) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      const n = part.value.join('').length;
      li += n;
      ri += n;
      i++;
      continue;
    }
    const lstart = li,
      rstart = ri;
    let before = '',
      after = '';
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      const p = parts[i++],
        s = p.value.join('');
      if (p.removed) {
        before += s;
        li += s.length;
      } else {
        after += s;
        ri += s.length;
      }
    }
    // Refine replacements locally, including suffix edits, without a global
    // character diff that would fragment paragraph-sized changes.
    const oldWord = before.trim(),
      newWord = after.trim();
    const characterParts =
      before && after && Math.max(before.length, after.length) < 180
        ? diffChars(before, after)
        : null;
    const shared =
      characterParts
        ?.filter((p) => !p.added && !p.removed)
        .reduce((n, p) => n + p.value.trim().length, 0) ?? 0;
    const refine =
      characterParts &&
      !/\s/.test(oldWord) &&
      !/\s/.test(newWord) &&
      (shared >= Math.min(oldWord.length, newWord.length) * 0.4 ||
        /[\u3400-\u9fff]/.test(oldWord + newWord));
    let refined: { added?: boolean; removed?: boolean; value: string }[] = [
      { removed: true, value: before },
      { added: true, value: after },
    ];
    if (refine) {
      let prefix = 0,
        suffix = 0;
      while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix])
        prefix++;
      while (
        suffix < Math.min(before.length, after.length) - prefix &&
        before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
      )
        suffix++;
      refined = [
        { value: before.slice(0, prefix) },
        { removed: true, value: before.slice(prefix, before.length - suffix) },
        { added: true, value: after.slice(prefix, after.length - suffix) },
        { value: before.slice(before.length - suffix) },
      ];
    }
    let l = lstart,
      r = rstart;
    for (let j = 0; j < refined.length;) {
      const p = refined[j];
      if (!p.added && !p.removed) {
        l += p.value.length;
        r += p.value.length;
        j++;
        continue;
      }
      const ls = l,
        rs = r;
      let old = '',
        fresh = '';
      while (j < refined.length && (refined[j].added || refined[j].removed)) {
        const q = refined[j++];
        if (q.removed) {
          old += q.value;
          l += q.value.length;
        } else {
          fresh += q.value;
          r += q.value.length;
        }
      }
      if (!old.trim() && !fresh.trim()) continue;
      const trimRefs = (value: Mapped, start: number, end: number) => {
        while (start < end && /\s/.test(value.text[start])) start++;
        while (end > start && /\s/.test(value.text[end - 1])) end--;
        return spans(value.refs.slice(start, end));
      };
      const lrefs = trimRefs(left, ls, l),
        rrefs = trimRefs(right, rs, r);
      if (!lrefs.length && !rrefs.length) continue;
      changes.push({
        id: 0,
        kind: old.trim() && fresh.trim() ? 'replaced' : old.trim() ? 'removed' : 'added',
        before: old.trim(),
        after: fresh.trim(),
        left: lrefs,
        right: rrefs,
      });
    }
  }
}

export function compare(left: Page[], right: Page[]): Comparison {
  const a = blocksOf(left),
    b = blocksOf(right);
  const parts = diffArrays(
    a.map((x) => x.text),
    b.map((x) => x.text),
    { timeout: 2000 },
  ) ?? [
    { removed: true, added: false, value: a.map((x) => x.text) },
    { removed: false, added: true, value: b.map((x) => x.text) },
  ];
  const gaps: { left: Block[]; right: Block[] }[] = [],
    anchors: Anchor[] = [];
  let ai = 0,
    bi = 0;
  for (let i = 0; i < parts.length;) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      for (let k = 0; k < part.value.length; k++)
        anchors.push({
          left: { page: a[ai + k].page, y: a[ai + k].y },
          right: { page: b[bi + k].page, y: b[bi + k].y },
        });
      ai += part.value.length;
      bi += part.value.length;
      i++;
    } else {
      const gap: { left: Block[]; right: Block[] } = { left: [], right: [] };
      while (i < parts.length && (parts[i].added || parts[i].removed)) {
        const p = parts[i++];
        if (p.removed) {
          gap.left.push(...a.slice(ai, ai + p.value.length));
          ai += p.value.length;
        } else {
          gap.right.push(...b.slice(bi, bi + p.value.length));
          bi += p.value.length;
        }
      }
      gaps.push(gap);
    }
  }
  const counts = (blocks: Block[]) => {
    const map = new Map<string, Block[]>();
    for (const block of blocks) map.set(block.text, [...(map.get(block.text) ?? []), block]);
    return map;
  };
  const allA = counts(a),
    allB = counts(b),
    deleted = counts(gaps.flatMap((g) => g.left)),
    inserted = counts(gaps.flatMap((g) => g.right));
  const moved = new Set<Block>(),
    changes: Change[] = [];
  for (const [text, list] of deleted) {
    const other = inserted.get(text);
    if (
      text.replace(/[\s\p{P}]/gu, '').length < 24 ||
      list.length !== 1 ||
      other?.length !== 1 ||
      allA.get(text)?.length !== 1 ||
      allB.get(text)?.length !== 1
    )
      continue;
    moved.add(list[0]);
    moved.add(other[0]);
    changes.push({
      id: 0,
      kind: 'moved',
      before: text,
      after: text,
      left: spans(list[0].refs),
      right: spans(other[0].refs),
    });
  }
  for (const gap of gaps)
    localDiff(
      join(gap.left.filter((x) => !moved.has(x))),
      join(gap.right.filter((x) => !moved.has(x))),
      changes,
    );
  // Stable document order, using the corresponding side's page and position.
  changes.sort((x, y) => {
    const position = (c: Change) => {
      const s = c.right[0] ?? c.left[0],
        pages = c.right.length ? right : left;
      return s.page * 100000 + pages[s.page].items[s.item].y * 100 + pages[s.page].items[s.item].x;
    };
    return position(x) - position(y);
  });
  changes.forEach((c, i) => (c.id = i + 1));
  return { changes, anchors, pagePairs: pairPages(left.length, right.length, anchors) };
}

export function pairPages(
  n: number,
  m: number,
  anchors: Anchor[],
): [number | null, number | null][] {
  const votes = new Map<string, number>();
  for (const a of anchors) {
    const key = `${a.left.page},${a.right.page}`;
    votes.set(key, (votes.get(key) ?? 0) + 1);
  }
  // Sparse monotonic anchors avoid quadratic page matrices on long documents.
  const candidates = [...votes]
    .map(([key, count]) => ({ pair: key.split(',').map(Number), count }))
    .sort((a, b) => b.count - a.count);
  const selected: [number, number][] = [];
  for (const {
    pair: [l, r],
  } of candidates)
    if (selected.every(([a, b]) => (l < a && r < b) || (l > a && r > b))) selected.push([l, r]);
  selected.sort((a, b) => a[0] - b[0]);
  const result: [number | null, number | null][] = [];
  let l = 0,
    r = 0;
  const fill = (endL: number, endR: number) => {
    while (l < endL || r < endR) result.push([l < endL ? l++ : null, r < endR ? r++ : null]);
  };
  for (const [a, b] of selected) {
    fill(a, b);
    result.push([l++, r++]);
  }
  fill(n, m);
  return result;
}
