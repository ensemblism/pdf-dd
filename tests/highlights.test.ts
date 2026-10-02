import { describe, it, expect } from 'vitest';
import { boundingRect, joinHighlightLines } from '../src/client/highlights';
import type { Rect } from '../src/client/model';
const rect = (x: number, y: number, width: number, height = 8.5): Rect => ({
  page: 0,
  x,
  y,
  width,
  height,
});
describe('continuous highlights', () => {
  it('covers internal word spaces up to the last changed glyph', () => {
    const glyphs = [rect(10, 50, 5), rect(15, 50, 5), rect(25, 50, 5), rect(30, 50, 4)];
    expect(boundingRect(glyphs)).toEqual(rect(10, 50, 24));
  });
  it('preserves the left side when baselines differ by a fraction of a pixel', () => {
    const input = [rect(116, 50, 14), rect(100, 50.0000001, 14)];
    const result = joinHighlightLines(input);
    expect(result).toHaveLength(1);
    expect(result[0].x).toBe(100);
    expect(result[0].width).toBe(30);
    for (const r of input)
      expect(result[0].x + result[0].width).toBeGreaterThanOrEqual(r.x + r.width);
  });
  it('joins a multiline sentence with inline math without filling line gaps or columns', () => {
    const result = joinHighlightLines([
      rect(60, 100, 190),
      rect(254, 99.3, 8, 9),
      rect(266, 100, 90),
      rect(60, 111, 55),
      rect(119, 110.4, 8, 9),
      rect(131, 111, 225),
      rect(60, 122, 9, 9),
      rect(73, 122.1, 100),
      rect(390, 111, 50),
    ]);
    expect(result).toHaveLength(4);
    expect(result.map((r) => [r.x, r.width])).toEqual([
      [60, 296],
      [60, 296],
      [390, 50],
      [60, 113],
    ]);
  });
  it('keeps separate changes separate and works with rotated lines', () => {
    expect(joinHighlightLines([rect(10, 20, 10), rect(60, 20, 10)])).toHaveLength(2);
    const result = joinHighlightLines([rect(100, 10, 8, 12), rect(100.0001, 25, 8, 12)], 90);
    expect(result).toHaveLength(1);
    expect(result[0].y).toBe(10);
    expect(result[0].height).toBe(27);
  });
});

it('does not merge highlights across an unchanged mathematical glyph', () => {
  const input = [rect(10, 20, 10), rect(27, 20, 12)];
  const unchanged = [rect(21, 22, 4, 7)];
  expect(joinHighlightLines(input, 0, unchanged)).toEqual(input);
  expect(joinHighlightLines(input)).toHaveLength(1);
});
it('preserves an unchanged glyph between highlights on a rotated page', () => {
  const input = [rect(100, 10, 8, 10), rect(100, 27, 8, 10)];
  const unchanged = [rect(101, 21, 6, 4)];
  expect(joinHighlightLines(input, 90, unchanged)).toEqual(input);
});
