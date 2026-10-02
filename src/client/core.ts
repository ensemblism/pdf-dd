import { diffArrays, diffChars } from 'diff';
import type { Anchor, Change, Comparison, Page, Span, TextItem } from './model';
import { normalizeText } from './text';

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
  runs: { item: TextItem; ids: number[] }[];
  x: number;
  y: number;
  right: number;
  height: number;
  baseline: number;
  fontHeight: number;
}
const words = new Intl.Segmenter('zh', { granularity: 'word' });
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });
const alignmentText = (text: string) => text.replace(/(?<=\p{L})[-‐‑](?=\p{L})/gu, '');
const isCitation = (text: string) =>
  /^\([^()]{0,200},\s*(?:19|20)\d{2}[a-z]?[^()]{0,200}\)$/.test(text.trim());
const numericRow = (text: string) =>
  (text.match(/\d+(?:\.\d+)?/g)?.length ?? 0) >= 6 &&
  (text.match(/\d/g)?.length ?? 0) > (text.match(/\p{L}/gu)?.length ?? 0) / 2;

// Text runs are arbitrary PDF extraction fragments. Weight by painted width,
// so splitting one run into many does not change the inferred body font size.
function bodyHeight(page: Page): number {
  const horizontal = page.items.filter(
    (item) => item.str.trim() && !(item.height > 40 && item.height > item.width * 2),
  );
  const body = horizontal.filter((item) => item.y < page.height * 0.8);
  const sizes = (body.length ? body : horizontal)
    .map((item) => ({ height: item.height, weight: item.width }))
    .sort((a, b) => a.height - b.height);
  let remaining = sizes.reduce((sum, item) => sum + item.weight, 0) / 2;
  for (const item of sizes) {
    remaining -= item.weight;
    if (remaining <= 0) return item.height;
  }
  return 0;
}

// Split columns at real gutters, then read each column top-to-bottom. Full-width
// headings divide the page into vertical sections instead of mixing columns.
function columnSplit(
  lines: { x: number; right: number; y: number; height: number }[],
  width: number,
): number {
  // Plot labels and table cells are not evidence of prose columns. Infer a
  // gutter from substantial text lines, then order every line using that gutter.
  const body = lines.filter((l) => l.right - l.x >= width * 0.22);
  const candidates = body
    .filter((l) => l.x > width * 0.28 && l.x < width * 0.72)
    .map((l) => l.x - 5);
  let best = 0,
    split = 0;
  for (const x of candidates) {
    const left = body.filter((l) => l.right < x),
      right = body.filter((l) => l.x > x);
    const overlap = left.filter((l) =>
      right.some((r) => Math.abs(r.y - l.y) < Math.max(l.height, r.height)),
    ).length;
    const score = overlap - body.filter((l) => l.x < x && l.right > x).length * 0.2;
    if (left.length >= 3 && right.length >= 3 && score > best) {
      best = score;
      split = x;
    }
  }
  return best < 3 ? 0 : split;
}
function readingOrder(lines: Line[], width: number): Line[] {
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  const split = columnSplit(lines, width);
  if (!split) return sorted;
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
  const lines: Line[] = [];
  const margins: Line[] = [];
  // Coalesce touching runs with the same vertical geometry before clustering
  // rows. A PDF producer is free to draw a sentence as one run or 100 runs.
  const rows = new Map<string, { item: TextItem; ids: number[] }[]>();
  page.items.forEach((item, id) => {
    if (!item.str) return;
    const key = `${Math.round(item.y * 1000)},${Math.round(item.height * 1000)},${item.baseline?.[1] ?? ''}`;
    const row = rows.get(key) ?? [];
    row.push({ item, ids: [id] });
    rows.set(key, row);
  });
  const runs = [...rows.values()].flatMap((row) => {
    // TeX accents extend backwards over the next letter. Reconnect the drawing
    // sequence before sorting by x, which otherwise interleaves its fragments.
    const connected: { item: TextItem; ids: number[] }[] = [];
    for (const run of row) {
      const last = connected.at(-1);
      const gap = last ? run.item.x - last.item.x - last.item.width : Infinity;
      if (
        last &&
        (Math.abs(gap) < 0.05 ||
          (gap < 0 && gap > -run.item.height * 0.5 && /[´`ˆ¨¸]$/.test(last.item.str)))
      ) {
        last.ids.push(...run.ids);
        last.item = {
          ...last.item,
          str: last.item.str + run.item.str,
          width: run.item.x + run.item.width - last.item.x,
        };
      } else connected.push(run);
    }
    const merged: { item: TextItem; ids: number[] }[] = [];
    for (const run of connected.sort((a, b) => a.item.x - b.item.x)) {
      const last = merged.findLast(
        (value) => Math.abs(run.item.x - value.item.x - value.item.width) < 0.05,
      );
      if (last) {
        last.ids.push(...run.ids);
        last.item = {
          ...last.item,
          str: last.item.str + run.item.str,
          width: run.item.x + run.item.width - last.item.x,
        };
      } else merged.push(run);
    }
    return merged;
  });
  // Infer prose gutters before row clustering: a taller heading in the right
  // column must never bridge two body rows from the left column.
  const split = columnSplit(
    runs.map(({ item }) => ({ ...item, right: item.x + item.width })),
    page.width,
  );
  const sorted = runs
    .filter((x) => x.item.str.trim())
    .filter(({ item, ids }) => {
      // Rotated margin stamps are text, but must not interrupt body paragraphs.
      if (item.height > 40 && item.height > item.width * 2) {
        margins.push({
          ids,
          runs: [{ item, ids }],
          x: item.x,
          y: item.y,
          right: item.x + item.width,
          height: item.height,
          baseline: item.y + item.height * 0.8,
          fontHeight: item.height,
        });
        return false;
      }
      return true;
    })
    .sort((a, b) => a.item.y - b.item.y || a.item.x - b.item.x);
  const maxHeight = sorted.reduce((h, value) => Math.max(h, value.item.height), 2);
  const bodySize = bodyHeight(page) || maxHeight;
  const small = (item: TextItem) => item.height < bodySize * 0.8;
  // Place body rows before scripts: a raised ordinal can otherwise attach to
  // the previous row before its own row has been encountered.
  const ordered = [
    ...sorted.filter(({ item }) => !small(item)),
    ...sorted.filter(({ item }) => small(item)),
  ];
  for (const { item, ids } of ordered) {
    const matches: number[] = [];
    const baseline = item.baseline?.[1] ?? item.y + item.height * 0.8;
    // Cluster nearby runs within the same column. A global row can mix two
    // columns whose baselines differ slightly, even splitting one word's row.
    for (let i = lines.length - 1; i >= 0; i--) {
      const candidate = lines[i],
        dy = item.y - candidate.y;
      if (
        split &&
        ((item.x >= split && candidate.right < split) ||
          (item.x + item.width < split && candidate.x >= split))
      )
        continue;
      if (Math.abs(dy) > maxHeight) continue;
      const dx = Math.max(0, item.x - candidate.right, candidate.x - item.x - item.width);
      const inlineScript =
        Math.min(candidate.fontHeight, item.height) <
          Math.max(candidate.fontHeight, item.height) * 0.8 &&
        Math.min(candidate.y + candidate.height, item.y + item.height) -
          Math.max(candidate.y, item.y) >
          Math.min(candidate.fontHeight, item.height) * 0.2;
      if (
        (Math.abs(baseline - candidate.baseline) <
          Math.max(2, Math.min(candidate.fontHeight, item.height) * 0.65) ||
          inlineScript) &&
        dx <= Math.max(6, item.height * 0.75)
      ) {
        matches.push(i);
      }
    }
    const nearest = matches.sort(
      (a, b) => Math.abs(lines[a].baseline - baseline) - Math.abs(lines[b].baseline - baseline),
    )[0];
    let line = nearest === undefined ? undefined : lines[nearest];
    if (!line) {
      line = {
        ids: [],
        runs: [],
        x: item.x,
        y: item.y,
        right: item.x,
        height: item.height,
        baseline,
        fontHeight: item.height,
      };
      lines.push(line);
    }
    // A later run may bridge two earlier runs (e.g. mixed bold and roman text).
    for (const i of matches
      .filter((i) => {
        const other = lines[i];
        const script =
          Math.min(other.fontHeight, line.fontHeight) <
            Math.max(other.fontHeight, line.fontHeight) * 0.8 &&
          Math.min(other.y + other.height, line.y + line.height) - Math.max(other.y, line.y) >
            Math.min(other.fontHeight, line.fontHeight) * 0.2;
        return i !== nearest && (Math.abs(other.baseline - line.baseline) < 2 || script);
      })
      .sort((a, b) => b - a)) {
      const other = lines[i];
      line.ids.push(...other.ids);
      line.runs.push(...other.runs);
      line.x = Math.min(line.x, other.x);
      line.right = Math.max(line.right, other.right);
      line.height = Math.max(line.height, other.y + other.height - line.y);
      if (other.fontHeight > line.fontHeight) {
        line.baseline = other.baseline;
        line.fontHeight = other.fontHeight;
      }
      lines.splice(i, 1);
    }
    line.ids.push(...ids);
    line.runs.push({ item, ids });
    line.x = Math.min(line.x, item.x);
    line.right = Math.max(line.right, item.x + item.width);
    line.height = Math.max(line.height, item.y + item.height - line.y);
    if (item.height > line.fontHeight) {
      line.baseline = baseline;
      line.fontHeight = item.height;
    }
  }
  const runX = new Map(runs.flatMap(({ item, ids }) => ids.map((id) => [id, item.x] as const)));
  const runOrder = new Map(runs.flatMap(({ ids }) => ids).map((id, i) => [id, i]));
  for (const line of lines)
    line.ids.sort((a, b) => runX.get(a)! - runX.get(b)! || runOrder.get(a)! - runOrder.get(b)!);
  return [...readingOrder(lines, page.width), ...margins];
}

function mappedItems(page: Page, pageIndex: number, line: Line): Mapped {
  let text = '';
  const refs: (Span | null)[] = [];
  let previous: TextItem | undefined;
  const owners = new Map(line.runs.flatMap((run) => run.ids.map((id) => [id, run] as const)));
  const scripts = new Map<TextItem, boolean>();
  for (const id of line.ids) {
    const item = page.items[id];
    const run = owners.get(id)!;
    if (
      previous &&
      item.x - (previous.x + previous.width) > Math.max(0.7, item.height * 0.12) &&
      !/[\u3400-\u9fff]$/.test(text) &&
      !/^[\u3400-\u9fff]/.test(item.str)
    ) {
      text += ' ';
      refs.push(null);
    }
    const delta = run.item.baseline ? run.item.baseline[1] - line.baseline : 0;
    if (!scripts.has(run.item))
      scripts.set(
        run.item,
        run.item.height < line.fontHeight * 0.85 &&
          Math.abs(delta) > line.fontHeight * 0.2 &&
          /^[\p{L}\p{N}+−-]+$/u.test(run.item.str.trim()) &&
          !(/\d$/.test(text) && /^(st|nd|rd|th)$/.test(run.item.str.trim())),
      );
    const script = scripts.get(run.item)!;
    for (const { segment, index } of graphemes.segment(item.str)) {
      let normalized = normalizeText(segment);
      if (script) {
        if (/^\d$/.test(normalized))
          normalized = (delta < 0 ? '⁰¹²³⁴⁵⁶⁷⁸⁹' : '₀₁₂₃₄₅₆₇₈₉')[Number(normalized)];
        else if (
          index === item.str.search(/\S/) &&
          id === run.ids.find((i) => page.items[i].str.trim())
        )
          normalized = (delta < 0 ? '^' : '_') + normalized;
      }
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
// Compare in the page's reading orientation; source item IDs and display
// coordinates stay intact for navigation and highlights.
function upright(page: Page): Page {
  const rotation = ((page.rotation % 360) + 360) % 360;
  if (!rotation) return page;
  const vertical = rotation % 180 !== 0;
  return {
    ...page,
    width: vertical ? page.height : page.width,
    height: vertical ? page.width : page.height,
    items: page.items.map((item) => ({
      ...item,
      x:
        rotation === 90
          ? item.y
          : rotation === 180
            ? page.width - item.x - item.width
            : page.height - item.y - item.height,
      y:
        rotation === 90
          ? page.width - item.x - item.width
          : rotation === 180
            ? page.height - item.y - item.height
            : item.x,
      width: vertical ? item.height : item.width,
      height: vertical ? item.width : item.height,
      baseline: item.baseline
        ? ((rotation === 90
            ? [item.baseline[1], page.width - item.baseline[0]]
            : rotation === 180
              ? [page.width - item.baseline[0], page.height - item.baseline[1]]
              : [page.height - item.baseline[1], item.baseline[0]]) as [number, number])
        : undefined,
    })),
  };
}
export function blocksOf(pages: Page[]): Block[] {
  const blocks: Block[] = [];
  const codeStarts = new Set<Span>();
  const views = pages.map(upright);
  pages.forEach((source, p) => {
    const page = views[p];
    let block: Block | undefined,
      previous: Line | undefined,
      previousText = '',
      algorithm = false;
    for (const line of linesOf(page)) {
      const next = mappedItems(page, p, line);
      const gap = previous ? line.y - previous.y : Infinity;
      const indent = previous ? line.x - previous.x : 0;
      if (previous && gap > Math.max(line.fontHeight, previous.fontHeight) * 2) algorithm = false;
      if (/^Require:/.test(next.text)) algorithm = true;
      const footnote =
        /^\d+$/.test(page.items[line.ids[0]].str) &&
        page.items[line.ids[0]].height < line.fontHeight * 0.8 &&
        line.y > page.height * 0.8;
      const paragraph =
        algorithm ||
        footnote ||
        !previous ||
        numericRow(next.text) !== numericRow(previousText) ||
        gap < 0 ||
        gap > Math.max(line.fontHeight, previous.fontHeight) * 1.6 ||
        Math.abs(indent) > Math.max(18, line.height * 1.6) ||
        Math.abs(line.height - previous.height) > line.height * 0.3;
      if (!block || paragraph) {
        block = { ...next, page: p, y: source.items[line.ids[0]].y };
        blocks.push(block);
        if (algorithm) codeStarts.add(block.refs[0]!);
      } else {
        // Keep ordinary hyphens, but do not invent a space inside a word split
        // over two lines. Smart refinement can then highlight the hyphen itself.
        if (block.text.endsWith('\u00ad')) {
          block.text = block.text.slice(0, -1);
          block.refs.pop();
        } else if (
          !(/[\p{L}\p{N}][-‐‑]$/u.test(block.text) && /^\p{L}/u.test(next.text)) &&
          (!/[\u3400-\u9fff]$/.test(block.text) || !/^[\u3400-\u9fff]/.test(next.text))
        ) {
          block.text += ' ';
          block.refs.push(null);
        }
        block.text += next.text;
        block.refs.push(...next.refs);
      }
      previous = line;
      previousText = next.text;
      if (/^return\b/.test(next.text)) algorithm = false;
    }
  });
  const result = blocks.map((b) => ({ ...b, ...compact(b) })).filter((b) => b.text);
  const structural = new Set<Block>();
  const caption = (text: string) => /^(?:Figure|Fig\.|Table|Algorithm)\s+\d+[.:]/i.test(text);
  const prose = (text: string) => {
    const letters = text.replace(/[^\p{L}]/gu, '').length;
    const words = (text.match(/\p{L}{2,}/gu) ?? []).length;
    return (letters >= 40 && words >= 8) || (letters >= 12 && words >= 3 && /[.!?。]$/.test(text));
  };
  result.forEach((block, i) => {
    if (!caption(block.text)) return;
    structural.add(block);
    const items = block.refs.flatMap((ref) => (ref ? [views[ref.page].items[ref.item]] : []));
    const x = Math.min(...items.map((item) => item.x));
    const right = Math.max(...items.map((item) => item.x + item.width));
    // Labels above a side figure are separated from its caption by body rows
    // in geometric reading order. Locate them within the caption's column.
    if (right - x < views[block.page].width * 0.4)
      for (const other of result) {
        if (other.page !== block.page || prose(other.text)) continue;
        const runs = other.refs.flatMap((ref) => (ref ? [views[ref.page].items[ref.item]] : []));
        if (
          runs.every(
            (item) =>
              item.x >= x - 5 &&
              item.x + item.width <= right + 5 &&
              item.y >= block.y - views[block.page].height * 0.4 &&
              item.y <= block.y + views[block.page].height * 0.15,
          )
        )
          structural.add(other);
      }
    // Keep a figure/table's labels and caption outside the narrative flow.
    // A figure inserted at a page break must not split a continued sentence.
    for (const direction of [-1, 1])
      for (let j = i + direction; j >= 0 && j < result.length; j += direction) {
        const other = result[j];
        if (other.page !== block.page || caption(other.text) || prose(other.text)) break;
        structural.add(other);
      }
  });
  const firstItem = (b: Block) => views[b.page].items[b.refs[0]!.item];
  const bodyHeights = views.map(bodyHeight);
  const headers = new Map<string, Set<number>>();
  for (const b of result)
    if (firstItem(b).y < views[b.page].height * 0.1) {
      const pages = headers.get(b.text) ?? new Set<number>();
      pages.add(b.page);
      headers.set(b.text, pages);
    }
  const detached = (b: Block) => {
    const item = firstItem(b),
      height = views[b.page].height;
    return (
      structural.has(b) ||
      numericRow(b.text) ||
      codeStarts.has(b.refs[0]!) ||
      (item.height > 40 && item.height > item.width * 2) ||
      (item.y > height * 0.9 && /^\d+$/.test(b.text)) ||
      (item.y < height * 0.1 && (headers.get(b.text)?.size ?? 0) >= 2)
    );
  };
  // Compare running furniture too, but keep it from cutting through sentences
  // which continue over a page boundary or move to a different page.
  const body: Block[] = [],
    notes: Block[] = [],
    furniture: Block[] = [];
  const append = (list: Block[], block: Block) => {
    const previous = list.at(-1);
    if (
      previous &&
      ((!/[.!?。！？:：;；][)”’"\]]*$/.test(previous.text) &&
        /^(?:\p{Ll}|\d{3,}\s+\p{L})/u.test(block.text)) ||
        (/:$/.test(previous.text) && /^(?:\p{Lu}|[•●]\s*\p{Lu})/u.test(block.text)))
    )
      Object.assign(previous, join([previous, block]));
    else list.push(block);
  };
  for (const block of result) {
    if (detached(block)) {
      furniture.push(block);
      continue;
    }
    const item = firstItem(block);
    const small =
      Math.max(
        ...block.refs.flatMap((ref) => (ref ? [views[ref.page].items[ref.item].height] : [])),
      ) <
      bodyHeights[block.page] * 0.95;
    const numbered =
      item.height < bodyHeights[block.page] * 0.8 &&
      /^\d+$/.test(item.str) &&
      /^\d+\s*\p{L}/u.test(block.text);
    // Footnotes may continue on the next page without a repeated marker.
    append(item.y > views[block.page].height * 0.8 && (small || numbered) ? notes : body, block);
  }
  return [...body, ...notes, ...furniture].flatMap((block) => {
    // A superscript note marker after a full stop is still a sentence boundary.
    // Use an equal-length segmentation view so original source offsets survive.
    const view = block.text.replace(/([.!?][)”’"\]]*\p{N}{1,2}) (?=\p{Lu})/gu, '$1\u2029');
    return [...sentences.segment(view)].map(({ segment, index }) => {
      const value = compact({
        text: block.text.slice(index, index + segment.length),
        refs: block.refs.slice(index, index + segment.length),
      });
      const ref = value.refs[0]!;
      return { ...value, page: ref.page, y: pages[ref.page].items[ref.item].y };
    });
  });
}
function join(blocks: Mapped[]): Mapped {
  const result: Mapped = { text: '', refs: [] };
  for (const b of blocks) {
    if (result.text && !(/[\p{L}\p{N}][-‐‑]$/u.test(result.text) && /^\p{L}/u.test(b.text))) {
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
  const segments = [...words.segment(text)].map((s) => s.segment);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (
      /^[-‐‑]$/.test(segment) &&
      /[\p{L}\p{N}]$/u.test(result.at(-1) ?? '') &&
      /^[\p{L}\p{N}]/u.test(segments[i + 1] ?? '')
    ) {
      result[result.length - 1] += segment + segments[++i];
      continue;
    }
    if (/^\s+$/.test(segment) && result.length) result[result.length - 1] += segment;
    else result.push(segment);
  }
  return result;
}
interface Budget {
  deadline: number;
  coarse: boolean;
  sources: Map<Change, [Mapped, Mapped]>;
}
function compoundTokens(values: string[], other: string[]): string[] {
  const complete = new Set(other.map((v) => alignmentText(v.trim())));
  const words = new Set(other.map((v) => v.trim()));
  return values.flatMap((v) => {
    const parts = v.trim().split(/[-‐‑]/);
    return parts.length > 1 &&
      !complete.has(alignmentText(v.trim())) &&
      parts.every((p) => words.has(p))
      ? v.split(/([-‐‑])/)
      : [v];
  });
}
function localDiff(
  left: Mapped,
  right: Mapped,
  changes: Change[],
  budget: Budget,
  matchHyphens = true,
) {
  if (left.text === right.text) return;
  const old = tokens(left.text),
    fresh = tokens(right.text);
  const a = compoundTokens(old, fresh),
    b = compoundTokens(fresh, old);
  // Bound pathological revisions. A coarse replacement is still visible and
  // honest; it must never silently turn a timed-out comparison into "equal".
  const remaining = budget.deadline - performance.now();
  const exact =
    remaining > 0
      ? diffArrays(a, b, {
          timeout: Math.min(1500, remaining),
          comparator: (x, y) =>
            matchHyphens
              ? alignmentText(x.trim()) === alignmentText(y.trim())
              : x.trim() === y.trim(),
        })
      : undefined;
  if (!exact) budget.coarse = true;
  const parts = exact ?? [
    { removed: true, added: false, value: a },
    { removed: false, added: true, value: b },
  ];
  let li = 0,
    ri = 0,
    leftToken = 0,
    rightToken = 0;
  for (let i = 0; i < parts.length;) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      const count = part.value.length;
      for (let k = 0; k < count; k++) {
        const old = a[leftToken++],
          fresh = b[rightToken++];
        if (old.trim() !== fresh.trim())
          localDiff(
            { text: old, refs: left.refs.slice(li, li + old.length) },
            { text: fresh, refs: right.refs.slice(ri, ri + fresh.length) },
            changes,
            budget,
            false,
          );
        li += old.length;
        ri += fresh.length;
      }
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
        leftToken += p.value.length;
      } else {
        after += s;
        ri += s.length;
        rightToken += p.value.length;
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
    const punctuationOnly = characterParts
      ?.filter((p) => p.added || p.removed)
      .every((p) => !/[\p{L}\p{N}]/u.test(p.value));
    const citationEdit =
      isCitation(before) &&
      isCitation(after) &&
      shared >= Math.max(oldWord.length, newWord.length) * 0.6;
    const phraseEdit =
      Math.max(before.length, after.length) < 80 &&
      shared >= Math.min(oldWord.length, newWord.length) * 0.85 &&
      characterParts?.some((p) => !p.added && !p.removed && /\p{L}{8}/u.test(p.value));
    const refine =
      characterParts &&
      (punctuationOnly ||
        citationEdit ||
        phraseEdit ||
        (!/\s/.test(oldWord) &&
          !/\s/.test(newWord) &&
          (shared >= Math.max(oldWord.length, newWord.length) * 0.6 ||
            /[\u3400-\u9fff]/.test(oldWord + newWord))));
    let refined: { added?: boolean; removed?: boolean; value: string }[] = [
      { removed: true, value: before },
      { added: true, value: after },
    ];
    if (refine)
      refined = characterParts!.flatMap((p) =>
        phraseEdit &&
        !citationEdit &&
        !punctuationOnly &&
        /\s/.test(oldWord + newWord) &&
        !p.added &&
        !p.removed &&
        /\p{L}/u.test(p.value) &&
        !/\p{L}{8}/u.test(p.value)
          ? [
              { ...p, removed: true, added: false },
              { ...p, added: true, removed: false },
            ]
          : [p],
      );
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
      const change: Change = {
        id: 0,
        kind: old.trim() && fresh.trim() ? 'replaced' : old.trim() ? 'removed' : 'added',
        before: old.trim(),
        after: fresh.trim(),
        left: lrefs,
        right: rrefs,
      };
      changes.push(change);
      budget.sources.set(change, [
        { text: old, refs: left.refs.slice(ls, l) },
        { text: fresh, refs: right.refs.slice(rs, r) },
      ]);
    }
  }
}

// A revised paragraph can cross an exact anchor (e.g. a moved figure caption or
// an appendix). Pair it by substantial shared phrases before diffing its words.
// Mutual unique matches keep repeated boilerplate from pairing unrelated text.
function revisedPairs(left: Block[], right: Block[], budget: Budget): [Block[], Block[]][] {
  const phrases = (block: Block) => {
    const words =
      alignmentText(block.text)
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [];
    return new Set(
      words.length < 8 ? [] : words.slice(0, -2).map((_, i) => words.slice(i, i + 3).join(' ')),
    );
  };
  const a = left.map(phrases),
    b = right.map(phrases);
  const index = new Map<string, number[]>();
  b.forEach((features, i) =>
    features.forEach((phrase) => {
      const entries = index.get(phrase) ?? [];
      entries.push(i);
      index.set(phrase, entries);
    }),
  );
  const bestA: [number, number][][] = a.map(() => []),
    bestB: [number, number][][] = b.map(() => []);
  const rank = (list: [number, number][], score: number, i: number) => {
    list.push([score, i]);
    list.sort((x, y) => y[0] - x[0]);
    list.length = Math.min(list.length, 2);
  };
  for (let i = 0; i < a.length; i++) {
    if (performance.now() >= budget.deadline) {
      budget.coarse = true;
      break;
    }
    const shared = new Map<number, number>();
    for (const phrase of a[i])
      for (const j of index.get(phrase) ?? []) shared.set(j, (shared.get(j) ?? 0) + 1);
    for (const [j, count] of shared) {
      const score = (2 * count) / (a[i].size + b[j].size);
      if (count < 4 || score < 0.6) continue;
      rank(bestA[i], score, j);
      rank(bestB[j], score, i);
    }
  }
  const pairs: [number[], number[]][] = bestA.flatMap((list, i) => {
    const best = list[0];
    if (!best) return [];
    const [score, j] = best,
      other = bestB[j];
    return other[0]?.[1] === i &&
      score - (list[1]?.[0] ?? 0) >= 0.1 &&
      score - (other[1]?.[0] ?? 0) >= 0.1
      ? [[[i], [j]]]
      : [];
  });
  const features = [a, b],
    blocks = [left, right];
  const used = [new Set(pairs.flatMap((p) => p[0])), new Set(pairs.flatMap((p) => p[1]))];
  const union = (side: number, ids: number[]) =>
    new Set(ids.flatMap((i) => [...features[side][i]]));
  const overlap = (x: Set<string>, y: Set<string>) => [...x].filter((v) => y.has(v)).length;
  // A revised sentence may become two sentences. Include an adjacent fragment
  // only when it shares substantial phrases and improves the combined match.
  for (const pair of pairs)
    for (const side of [0, 1]) {
      if (performance.now() >= budget.deadline) break;
      const opposite = union(1 - side, pair[1 - side]);
      for (const candidate of [pair[side][0] - 1, pair[side].at(-1)! + 1]) {
        const block = blocks[side][candidate],
          seed = blocks[side][pair[side][0]];
        if (
          !block ||
          used[side].has(candidate) ||
          block.page !== seed.page ||
          Math.abs(block.y - seed.y) > 100
        )
          continue;
        const shared = overlap(features[side][candidate], opposite);
        if (shared < 4 || shared / features[side][candidate].size < 0.4) continue;
        const current = union(side, pair[side]),
          combined = new Set([...current, ...features[side][candidate]]);
        const score = (x: Set<string>) => (2 * overlap(x, opposite)) / (x.size + opposite.size);
        if (score(combined) < score(current) + 0.05) continue;
        pair[side].push(candidate);
        pair[side].sort((x, y) => x - y);
        used[side].add(candidate);
      }
    }
  return pairs.map(([x, y]) => [x.map((i) => left[i]), y.map((i) => right[i])]);
}

// Sparse literal shingles provide alignment without making PDF text runs,
// sentence boundaries, spaces, or compound-word segmentation into hard walls.
function textAnchors(
  left: Mapped,
  right: Mapped,
  sentenceWalls = true,
): {
  ranges: [number, number, number, number][];
  points: [number, number][];
  literals: [number, number, number, number][];
} {
  const documents = [left, right];
  const mapped = documents.map((doc) => {
    let key = '';
    const offsets: number[] = [];
    let offset = 0;
    for (const c of doc.text) {
      if (/[\p{L}\p{N}]/u.test(c)) {
        key += c;
        for (let k = 0; k < c.length; k++) offsets.push(offset + k);
      }
      offset += c.length;
    }
    return { key, offsets };
  });
  const length = 24;
  const indexes = mapped.map(({ key, offsets }, side) => {
    const map = new Map<string, number>();
    for (let i = 0; i + length <= key.length; i++) {
      const fragment = key.slice(i, i + length);
      if (!/\p{L}{4}/u.test(fragment)) continue;
      // Do not lend the short prefix of a removed sentence ("The ...") to the
      // next sentence. Gaps still compare freely across sentence boundaries.
      const source = documents[side].text.slice(offsets[i], offsets[i + length - 1] + 1);
      if (source.includes('\u2029')) continue;
      if (sentenceWalls && /[.!?][)”’"\]]*\s+\p{Lu}/u.test(source)) continue;
      map.set(fragment, map.has(fragment) ? -1 : i);
    }
    return map;
  });
  const candidates: [number, number][] = [];
  for (const [key, i] of indexes[0]) {
    const j = indexes[1].get(key);
    if (i >= 0 && j !== undefined && j >= 0) candidates.push([i, j]);
  }
  const tails: number[] = [],
    previous: number[] = [];
  candidates.forEach((pair, i) => {
    let lo = 0,
      hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (candidates[tails[mid]][1] < pair[1]) lo = mid + 1;
      else hi = mid;
    }
    previous[i] = lo ? tails[lo - 1] : -1;
    tails[lo] = i;
  });
  const selected: [number, number][] = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]) selected.push(candidates[i]);
  selected.reverse();
  const windows: [number, number, number, number][] = [];
  for (const [i, j] of selected) {
    const last = windows.at(-1);
    if (last && j - i === last[2] - last[0] && i <= last[1]) {
      last[1] = i + length;
      last[3] = j + length;
    } else if (!last || (i >= last[1] && j >= last[3]))
      windows.push([i, i + length, j, j + length]);
  }
  const ranges: [number, number, number, number][] = [],
    points: [number, number][] = windows.map(([i, , j]) => [
      mapped[0].offsets[i],
      mapped[1].offsets[j],
    ]);
  const sourceRange = ([i, ie, j, je]: number[]): [number, number, number, number] => {
    const start = [mapped[0].offsets[i], mapped[1].offsets[j]],
      end = [mapped[0].offsets[ie - 1] + 1, mapped[1].offsets[je - 1] + 1];
    // An alignment window is not a highlight boundary. Keep a changed number
    // or word whole even when a common shingle ends inside it (95 → 98).
    for (const side of [0, 1]) {
      const text = documents[side].text;
      while (start[side] > 0 && /[\p{L}\p{N}\p{M}]/u.test(text[start[side] - 1])) start[side]--;
      while (end[side] < text.length && /[\p{L}\p{N}\p{M}]/u.test(text[end[side]])) end[side]++;
    }
    return [start[0], end[0], start[1], end[1]];
  };
  for (const window of windows) {
    const [ls, le, rs, re] = sourceRange(window);
    const start = [ls, rs],
      end = [le, re];
    const last = ranges.at(-1);
    if (last && (start[0] <= last[1] || start[1] <= last[3])) {
      last[1] = Math.max(last[1], end[0]);
      last[3] = Math.max(last[3], end[1]);
    } else ranges.push([start[0], end[0], start[1], end[1]]);
  }
  const literalWindows: [number, number, number, number][] = [];
  for (const [i, j] of candidates) {
    const last = literalWindows.at(-1);
    if (last && i + length === last[1] + 1 && j + length === last[3] + 1) {
      last[1]++;
      last[3]++;
    } else literalWindows.push([i, i + length, j, j + length]);
  }
  const literals = literalWindows.map(sourceRange).filter(([ls, le, rs, re]) => {
    return (left.text.slice(ls, le).match(/\p{L}+/gu)?.length ?? 0) >= 4;
  });
  return { ranges, points, literals };
}
export function compare(left: Page[], right: Page[], timeout = 5000): Comparison {
  const budget: Budget = {
    deadline: performance.now() + timeout,
    coarse: false,
    sources: new Map(),
  };
  const blocks = [blocksOf(left), blocksOf(right)],
    documents = blocks.map(join);
  const positions = documents.map((doc) => {
    const byRef = new Map<Span, number>(),
      bySource = new Map<string, number>();
    doc.refs.forEach((ref, i) => {
      if (ref) {
        byRef.set(ref, i);
        const key = `${ref.page},${ref.item},${ref.start}`;
        if (!bySource.has(key)) bySource.set(key, i);
      }
    });
    return { byRef, bySource };
  });
  const seed =
    performance.now() < budget.deadline
      ? textAnchors(documents[0], documents[1])
      : { ranges: [], points: [] };
  const anchorKeys = new Set<string>();
  const anchors: Anchor[] = seed.points.flatMap(([x, y]) => {
    const l = documents[0].refs[x],
      r = documents[1].refs[y];
    const key =
      l && r
        ? `${l.page},${Math.round(left[l.page].items[l.item].y)},${r.page},${Math.round(right[r.page].items[r.item].y)}`
        : '';
    if (!key || anchorKeys.has(key)) return [];
    anchorKeys.add(key);
    return l && r
      ? [
          {
            left: { page: l.page, y: left[l.page].items[l.item].y },
            right: { page: r.page, y: right[r.page].items[r.item].y },
          },
        ]
      : [];
  });
  const used = [new Set<Block>(), new Set<Block>()],
    changes: Change[] = [];
  const bounds = (side: number, group: Block[]) => [
    positions[side].byRef.get(group[0].refs[0]!)!,
    positions[side].byRef.get(group.at(-1)!.refs.at(-1)!)! + 1,
  ];
  const cross = ([start, end]: number[], [rstart, rend]: number[]) => {
    let lo = 0,
      hi = seed.points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (seed.points[mid][0] < start) lo = mid + 1;
      else hi = mid;
    }
    if (lo && seed.points[lo - 1][1] > rend) return true;
    while (lo < seed.points.length && seed.points[lo][0] < end) lo++;
    return lo < seed.points.length && seed.points[lo][1] < rstart;
  };
  for (const [old, fresh] of revisedPairs(blocks[0], blocks[1], budget)) {
    const a = join(old),
      b = join(fresh);
    // A partial paragraph must not consume a whole revised paragraph. Only
    // reserve revised blocks which actually cross the monotonic word alignment.
    // Other revisions stay together in the word stream, across block boundaries.
    const relocated = cross(bounds(0, old), bounds(1, fresh));
    if (!relocated) continue;
    if (
      a.text === b.text &&
      relocated &&
      a.text.replace(/[^\p{L}]/gu, '').length >= 24 &&
      documents.every((doc) => doc.text.split(a.text).length === 2)
    )
      changes.push({
        id: 0,
        kind: 'moved',
        before: a.text,
        after: b.text,
        left: spans(a.refs),
        right: spans(b.refs),
      });
    else localDiff(a, b, changes, budget);
    old.forEach((block) => used[0].add(block));
    fresh.forEach((block) => used[1].add(block));
  }
  const remaining = blocks.map((bs, side) => join(bs.filter((b) => !used[side].has(b))));
  const matched =
    performance.now() < budget.deadline
      ? textAnchors(remaining[0], remaining[1])
      : { ranges: [], points: [] };
  if (performance.now() >= budget.deadline) budget.coarse = true;
  const slice = (side: number, start: number, end: number): Mapped => ({
    text: remaining[side].text.slice(start, end),
    refs: remaining[side].refs.slice(start, end),
  });
  let li = 0,
    ri = 0;
  for (const [ls, le, rs, re] of [
    ...matched.ranges,
    [
      remaining[0].text.length,
      remaining[0].text.length,
      remaining[1].text.length,
      remaining[1].text.length,
    ] as [number, number, number, number],
  ]) {
    localDiff(slice(0, li, ls), slice(1, ri, rs), changes, budget);
    localDiff(slice(0, ls, le), slice(1, rs, re), changes, budget);
    li = le;
    ri = re;
  }
  // Search only unresolved edits for common literal phrases. An unchanged
  // conclusion must not make an identical phrase in a revised abstract
  // ambiguous. Source references remain attached through this second pass.
  const edits = changes.filter((c) => c.kind !== 'moved');
  const residual = [0, 1].map((side) => {
    const value = join(
      edits
        .map((c) => budget.sources.get(c)![side])
        .filter((doc) => doc.text.trim())
        .sort((a, b) => {
          const position = (doc: Mapped) =>
            positions[side].byRef.get(doc.refs.find((ref) => ref)!) ?? 0;
          return position(a) - position(b);
        }),
    );
    let previous: number | undefined;
    const refs: (Span | null)[] = [];
    let text = '';
    value.refs.forEach((ref, i) => {
      const position = ref ? positions[side].byRef.get(ref) : undefined;
      if (
        position !== undefined &&
        previous !== undefined &&
        /[\p{L}\p{N}]/u.test(documents[side].text.slice(previous + 1, position))
      ) {
        text += '\u2029';
        refs.push(null);
      }
      text += value.text[i];
      refs.push(ref);
      if (position !== undefined) previous = position;
    });
    return { text, refs };
  });
  if (edits.length && performance.now() < budget.deadline) {
    const literals = textAnchors(residual[0], residual[1], false).literals;
    const claimed = [new Set<Span>(), new Set<Span>()];
    for (const [ls, le, rs, re] of literals.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))) {
      let refs = [residual[0].refs.slice(ls, le), residual[1].refs.slice(rs, re)];
      const location = (side: number) => {
        const rr = refs[side].filter((ref): ref is Span => !!ref);
        return [positions[side].byRef.get(rr[0])!, positions[side].byRef.get(rr.at(-1)!)! + 1];
      };
      const ranges = [location(0), location(1)];
      // Residual edits can omit already-matched punctuation or intervening
      // words. Verify the complete original intervals before cancelling edits.
      const original = ranges.map(([start, end], side) => ({
        text: documents[side].text.slice(start, end),
        refs: documents[side].refs.slice(start, end),
      }));
      if (original[0].text.replace(/\s/g, '') !== original[1].text.replace(/\s/g, '')) continue;
      refs = original.map((value) => value.refs);
      if (refs.some((rr, side) => rr.some((ref) => ref && claimed[side].has(ref)))) continue;
      if (cross(ranges[0], ranges[1]))
        changes.push({
          id: 0,
          kind: 'moved',
          before: original[0].text,
          after: original[1].text,
          left: spans(refs[0]),
          right: spans(refs[1]),
        });
      refs.forEach((rr, side) =>
        rr.forEach((ref) => {
          if (ref) claimed[side].add(ref);
        }),
      );
    }
    if (claimed.some((set) => set.size)) {
      const omit = (doc: Mapped, side: number): Mapped => {
        let text = '';
        const refs: (Span | null)[] = [];
        doc.refs.forEach((ref, i) => {
          if (ref && claimed[side].has(ref)) {
            if (!text.endsWith(' ')) {
              text += ' ';
              refs.push(null);
            }
          } else {
            text += doc.text[i];
            refs.push(ref);
          }
        });
        return compact({ text, refs });
      };
      for (let i = changes.length - 1; i >= 0; i--)
        if (changes[i].kind !== 'moved') changes.splice(i, 1);
      for (const change of edits) {
        const sources = budget.sources.get(change)!;
        localDiff(omit(sources[0], 0), omit(sources[1], 1), changes, budget);
      }
    }
  }
  // Whole unique residuals (e.g. a reordered email address) need no sentence
  // or minimum shingle length to prove that their content stayed identical.
  const additions = new Map<string, Change[]>();
  for (const change of changes.filter((c) => c.kind === 'added')) {
    const list = additions.get(change.after) ?? [];
    list.push(change);
    additions.set(change.after, list);
  }
  const paired = new Set<Change>();
  for (const change of changes.filter((c) => c.kind === 'removed')) {
    const matches = additions.get(change.before);
    if (
      matches?.length !== 1 ||
      paired.has(matches[0]) ||
      (change.before.match(/\p{L}/gu)?.length ?? 0) < 12 ||
      !documents.every((doc) => doc.text.split(change.before).length === 2)
    )
      continue;
    const fresh = matches[0];
    change.kind = 'moved';
    change.after = fresh.after;
    change.right = fresh.right;
    paired.add(fresh);
  }
  for (let i = changes.length - 1; i >= 0; i--) if (paired.has(changes[i])) changes.splice(i, 1);
  const offset = (side: number, ref: Span) =>
    positions[side].bySource.get(`${ref.page},${ref.item},${ref.start}`) ?? 0;
  const order = (c: Change) => {
    if (c.right.length) return offset(1, c.right[0]);
    const x = offset(0, c.left[0]);
    let lo = 0,
      hi = seed.points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (seed.points[mid][0] < x) lo = mid + 1;
      else hi = mid;
    }
    const point = seed.points[lo] ?? seed.points.at(-1);
    return point ? point[1] + x - point[0] : x;
  };
  changes.sort((a, b) => order(a) - order(b));
  changes.forEach((c, i) => (c.id = i + 1));
  return {
    changes,
    anchors,
    pagePairs: pairPages(left.length, right.length, anchors),
    coarse: budget.coarse,
  };
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
