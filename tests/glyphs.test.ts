import { describe, it, expect } from 'vitest';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import { positionGlyphs, glyphRanges } from '../src/client/glyphs';

const ops = Object.fromEntries(
  [
    'beginText',
    'setFont',
    'setTextMatrix',
    'showText',
    'setCharSpacing',
    'setWordSpacing',
    'setHScale',
    'setTextRise',
    'save',
    'transform',
    'restore',
    'paintFormXObjectBegin',
    'paintFormXObjectEnd',
    'moveText',
    'setLeadingMoveText',
    'setLeading',
    'nextLine',
    'setGState',
    'beginGroup',
    'endGroup',
    'showSpacedText',
    'nextLineShowText',
    'nextLineSetSpacingShowText',
  ].map((name, i) => [name, i + 1]),
);
const font = () => ({ fontMatrix: [0.001, 0, 0, 0.001, 0, 0], ascent: 0.7, descent: -0.2 });
const glyph = (unicode: string, width = 500) => ({ unicode, width, isSpace: unicode === ' ' });
function run(commands: [string, any[]][]) {
  return positionGlyphs(
    { fnArray: commands.map(([key]) => ops[key]), argsArray: commands.map(([, args]) => args) },
    ops,
    font,
  );
}
function content(str: string, width: number, transform = [10, 0, 0, 10, 100, 200]): TextContent {
  return {
    items: [{ str, transform, width, height: 10, fontName: 'font', dir: 'ltr', hasEOL: true }],
    styles: {},
    lang: null,
  };
}
describe('PDF glyph geometry', () => {
  it('uses TJ spacing instead of stretching a browser font across the line', () => {
    const placed = run([
      ['beginText', []],
      ['setFont', ['font', 10]],
      ['setTextMatrix', [[1, 0, 0, 1, 100, 200]]],
      ['showText', [[glyph('d'), glyph('o'), -300, glyph('e'), glyph('s'), -700, glyph('n')]]],
    ]);
    const ranges = glyphRanges(
      placed,
      content('do es n', 35),
      new Set([0]),
      [1, 0, 0, -1, 0, 800],
      0,
    ).get(0)!;
    expect(ranges.map((g) => [g.start, g.x, g.width])).toEqual([
      [0, 100, 5],
      [1, 105, 5],
      [3, 113, 5],
      [4, 118, 5],
      [6, 130, 5],
    ]);
    expect(ranges[0].height).toBeLessThan(10);
  });
  it('keeps Unicode ligatures mapped to their original source offsets', () => {
    const placed = run([
      ['setFont', ['font', 10]],
      ['setTextMatrix', [[1, 0, 0, 1, 100, 200]]],
      ['showText', [[glyph('ﬁ', 800), glyph('n'), glyph('d')]]],
    ]);
    const ranges = glyphRanges(
      placed,
      content('find', 18),
      new Set([0]),
      [1, 0, 0, -1, 0, 800],
      0,
    ).get(0)!;
    expect(ranges.map((g) => [g.start, g.end, g.x])).toEqual([
      [0, 1, 100],
      [1, 2, 100],
      [2, 3, 108],
      [3, 4, 113],
    ]);
  });
  it('applies graphics transforms, spacing, text rise and rotated/cropped viewports', () => {
    const placed = run([
      ['save', []],
      ['transform', [2, 0, 0, 2, 10, 20]],
      ['setFont', ['font', 10]],
      ['setTextMatrix', [[1, 0, 0, 1, 100, 200]]],
      ['setCharSpacing', [1]],
      ['setWordSpacing', [2]],
      ['setHScale', [80]],
      ['setTextRise', [3]],
      ['showText', [[glyph('a'), glyph(' '), glyph('b')]]],
      ['restore', []],
    ]);
    // a advance = (5+1)*.8*2; space = (5+1+2)*.8*2.
    const ranges = glyphRanges(
      placed,
      content('a b', 30, [16, 0, 0, 20, 210, 426]),
      new Set([0]),
      [0, 1, 1, 0, -20, -10],
      0,
    ).get(0)!;
    expect(ranges[0].y).toBeCloseTo(200);
    expect(ranges[1].y).toBeCloseTo(222.4);
    expect(ranges[0].height).toBeCloseTo(8);
  });
  it('declines a run whose extracted text disagrees instead of guessing', () => {
    const placed = run([
      ['setFont', ['font', 10]],
      ['setTextMatrix', [[1, 0, 0, 1, 100, 200]]],
      ['showText', [[glyph('a'), glyph('b')]]],
    ]);
    expect(
      glyphRanges(placed, content('ac', 10), new Set([0]), [1, 0, 0, -1, 0, 800], 0).size,
    ).toBe(0);
  });
  it('locates a zero-advance combining accent by its glyph origin', () => {
    const placed = run([
      ['setFont', ['font', 10]],
      ['setTextMatrix', [[1, 0, 0, 1, 100, 200]]],
      ['showText', [[glyph('\u0302')]]],
    ]);
    const ranges = glyphRanges(
      placed,
      content('\u0302', 0),
      new Set([0]),
      [1, 0, 0, -1, 0, 800],
      0,
    ).get(0)!;
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ start: 0, end: 1, x: 100, width: 5 });
  });
  it('keeps superscripts distinct when matching extracted text to glyphs', () => {
    const placed = run([
      ['setFont', ['font', 10]],
      ['setTextMatrix', [[1, 0, 0, 1, 100, 200]]],
      ['showText', [[glyph('²')]]],
    ]);
    expect(glyphRanges(placed, content('2', 5), new Set([0]), [1, 0, 0, -1, 0, 800], 0).size).toBe(
      0,
    );
  });
});

it('uses glyph ink below the origin for a TeX radical instead of the font-wide ascent', () => {
  const commands: [string, any[]][] = [
    ['beginText', []],
    ['setFont', ['math', 10]],
    ['setTextMatrix', [1, 0, 0, 1, 100, 50]],
    ['showText', [[{ ...glyph('√'), fontChar: 'p' }]]],
  ];
  const measured: string[] = [];
  const placed = positionGlyphs(
    { fnArray: commands.map(([name]) => ops[name]), argsArray: commands.map(([, args]) => args) },
    ops,
    font,
    (name, char) => {
      measured.push(name + ':' + char);
      return { ascent: -0.1, descent: 0.9 };
    },
  );
  expect(measured).toEqual(['math:p']);
  expect(placed[0].corners.map((c) => c[1])).toEqual([41, 41, 49, 49]);
  expect(placed[0].origin).toEqual([100, 50]);
});
