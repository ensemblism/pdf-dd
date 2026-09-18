import { describe, it, expect } from 'vitest';
import { compare, blocksOf, pairPages } from '../src/client/core';
import { exportComparison } from '../src/client/export';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import type { Page, TextItem } from '../src/client/model';

function page(lines: string[], overrides: Partial<Page> = {}): Page {
  return {
    width: 612,
    height: 792,
    rotation: 0,
    view: [0, 0, 612, 792],
    items: lines.map((str, i) => ({
      str,
      x: 40,
      y: 50 + i * 30,
      width: str.length * 6,
      height: 12,
    })),
    ...overrides,
  };
}
describe('text comparison', () => {
  it('excludes adjacent whitespace from highlighted source spans', () => {
    const left = page(['The result is useful for everyone.']);
    const right = page(['The result is helpful for everyone.']);
    const result = compare([left], [right]);
    for (const change of result.changes)
      for (const [refs, source] of [
        [change.left, left],
        [change.right, right],
      ] as const) {
        const text = refs
          .map((ref) => source.items[ref.item].str.slice(ref.start, ref.end))
          .join('');
        expect(text).toBe(text.trim());
      }
    const addition = compare(
      [page(['effect of intervention'])],
      [page(['effect of an intervention'])],
    ).changes[0];
    expect(addition.right).toEqual([{ page: 0, item: 0, start: 10, end: 12 }]);
  });
  it('does not flag identical PDFs or line wrapping', () => {
    expect(compare([page(['A small example'])], [page(['A small example'])]).changes).toEqual([]);
    const a = page(['A paragraph that wraps across lines.']);
    const b = page(['A paragraph that', 'wraps across lines.']);
    b.items[1].y = 64;
    expect(compare([a], [b]).changes).toEqual([]);
  });
  it('locates a suffix addition at its original character offset', () => {
    const result = compare([page(['A variable'])], [page(['A variables'])]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      kind: 'added',
      after: 's',
      right: [{ page: 0, item: 0, start: 10, end: 11 }],
    });
  });
  it('handles CJK replacements and punctuation', () => {
    const result = compare([page(['模型是可靠的。'])], [page(['模型是准确的！'])]);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes.some((c) => c.before.includes('可靠') && c.after.includes('准确'))).toBe(
      true,
    );
    expect(result.changes.some((c) => c.before.includes('。') && c.after.includes('!'))).toBe(true);
  });
  it('finds an unchanged paragraph moved across pages', () => {
    const a = 'This long paragraph uniquely describes the first experiment.';
    const b = 'Another paragraph provides a completely different discussion.';
    const c = 'The conclusion contains enough unique words to be an anchor.';
    const result = compare([page([a, b]), page([c])], [page([b]), page([c, a])]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      kind: 'moved',
      before: a,
      left: [{ page: 0 }],
      right: [{ page: 1 }],
    });
  });
  it('does not identify ambiguous duplicate paragraphs as moves', () => {
    const a = 'A repeated paragraph appears multiple times in this document.';
    const b = 'A second paragraph provides unique content for stable anchors.';
    const result = compare([page([a, a, b])], [page([b, a, a])]);
    expect(result.changes.some((c) => c.kind === 'moved' && c.before === a)).toBe(false);
  });
  it('ignores repagination and aligns inserted pages', () => {
    const a = 'First independent paragraph with sufficient descriptive text.';
    const b = 'Second independent paragraph with some other descriptive text.';
    expect(compare([page([a, b])], [page([a]), page([b])]).changes).toHaveLength(0);
    const result = compare(
      [page([a]), page([b])],
      [page(['A newly inserted standalone page.']), page([a]), page([b])],
    );
    expect(result.pagePairs).toEqual([
      [null, 0],
      [0, 1],
      [1, 2],
    ]);
    expect(result.changes.every((c) => c.kind === 'added')).toBe(true);
  });
  it('reads each column vertically instead of interleaving columns', () => {
    const items: TextItem[] = [];
    for (let i = 0; i < 4; i++)
      for (const x of [40, 330])
        items.push({
          str: `${x === 40 ? 'Left' : 'Right'} ${i}`,
          x,
          y: 100 + i * 14,
          width: 150,
          height: 12,
        });
    const blocks = blocksOf([page([], { items })]);
    expect(blocks.map((b) => b.text).join(' ')).toBe(
      'Left 0 Left 1 Left 2 Left 3 Right 0 Right 1 Right 2 Right 3',
    );
  });
  it('keeps real hyphens and normalizes ligatures without losing source offsets', () => {
    expect(compare([page(['re-sign'])], [page(['resign'])]).changes[0]).toMatchObject({
      kind: 'removed',
      before: '-',
    });
    expect(compare([page(['ﬁnd'])], [page(['find'])]).changes).toHaveLength(0);
  });
  it('handles empty documents without pretending to produce differences', () => {
    expect(compare([page([])], [page([])]).changes).toEqual([]);
    expect(pairPages(2, 1, [])).toEqual([
      [0, 0],
      [1, null],
    ]);
  });
  it('compares 100 pages with sparse edits without whole-document character matching', () => {
    const a = Array.from({ length: 100 }, (_, i) =>
      page([
        `Section ${i}. This is a unique paragraph describing experiment ${i}.`,
        `Results for ${i}: accuracy is 95 percent.`,
      ]),
    );
    const b = structuredClone(a);
    b[70].items[1].str = 'Results for 70: accuracy is 98 percent.';
    const start = performance.now(),
      result = compare(a, b);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].left[0].page).toBe(70);
    expect(performance.now() - start).toBeLessThan(3000);
  });
});
it('exports original vector pages into a paired comparison with missing sides', async () => {
  const original = await PDFDocument.create(),
    font = await original.embedFont(StandardFonts.Helvetica);
  original.addPage([300, 400]).drawText('Original text', { x: 30, y: 350, font });
  const bytes = await original.save();
  const result = await exportComparison({
    files: [bytes, bytes],
    pages: [
      [page([], { width: 300, height: 400, view: [0, 0, 300, 400] })],
      [page([], { width: 300, height: 400, view: [0, 0, 300, 400] })],
    ],
    comparison: {
      changes: [],
      anchors: [],
      pagePairs: [
        [0, 0],
        [null, 0],
      ],
    },
    geometry: { left: {}, right: {} },
  });
  const pdf = await PDFDocument.load(result);
  expect(pdf.getPageCount()).toBe(2);
  expect(pdf.getPage(0).getSize()).toEqual({ width: 656, height: 456 });
  expect(pdf.getPage(0).node.Resources()?.toString()).toContain('XObject');
});
