import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import type { Rect } from './model';
import { normalizeText } from './text';

type Matrix = number[];
interface Font {
  fontMatrix?: number[];
  ascent?: number;
  descent?: number;
  vertical?: boolean;
  isType3Font?: boolean;
}
interface Glyph {
  unicode: string;
  fontChar?: string;
  width: number;
  isSpace?: boolean;
}
interface Positioned {
  text: string;
  font: string;
  origin: number[];
  corners: number[][];
}
export interface GlyphRange extends Rect {
  start: number;
  end: number;
}
const identity = () => [1, 0, 0, 1, 0, 0];
const point = (m: Matrix, x: number, y: number) => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
function multiply(a: Matrix, b: Matrix): Matrix {
  const o = point(a, b[4], b[5]);
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    ...o,
  ];
}

// TextLayer lays out a whole string in a substitute browser font. PDF TJ arrays
// place individual glyphs with their own kerning and justification. Read those
// advances directly; never assume browser character widths match the PDF.
export function positionGlyphs(
  list: { fnArray: number[]; argsArray: any[][] },
  ops: Record<string, number>,
  fontFor: (name: string) => Font,
  inkFor?: (font: string, character: string) => { ascent: number; descent: number } | undefined,
): Positioned[] {
  let state = {
    ctm: identity(),
    matrix: identity(),
    font: '',
    size: 0,
    direction: 1,
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
    leading: 0,
    char: 0,
    word: 0,
    hscale: 1,
    rise: 0,
  };
  const stack: (typeof state)[] = [],
    result: Positioned[] = [];
  const save = () => stack.push({ ...state });
  const restore = () => {
    state = stack.pop() ?? state;
  };
  const move = (x: number, y: number) => {
    state.x = state.lineX += x;
    state.y = state.lineY += y;
  };
  const font = (name: string, size: number) => {
    state.font = name;
    state.size = Math.abs(size);
    state.direction = size < 0 ? -1 : 1;
  };
  const show = (glyphs: (Glyph | number)[]) => {
    if (!state.font) return;
    const f = fontFor(state.font),
      widthScale = state.size * (f.fontMatrix?.[0] ?? 0.001);
    // Unusual vertical / Type 3 text keeps the existing TextLayer fallback.
    const supported = !f.vertical && !f.isType3Font;
    const transform = multiply(state.ctm, state.matrix),
      hscale = state.hscale * state.direction;
    const ascent = Math.min(0.85, f.ascent ?? 0.8) * state.size;
    const descent = Math.max(-0.18, f.descent ?? -0.15) * state.size;
    let advance = 0;
    for (const glyph of glyphs) {
      if (typeof glyph === 'number') {
        advance -= (glyph * state.size) / 1000;
        continue;
      }
      const width = glyph.width * widthScale;
      const x = state.x + advance * hscale,
        y = state.y + state.rise;
      if (supported && glyph.unicode && !/^\s+$/.test(glyph.unicode)) {
        const ink = inkFor?.(state.font, glyph.fontChar ?? glyph.unicode);
        const top = ink ? ink.ascent * state.size : ascent;
        const bottom = ink ? -ink.descent * state.size : descent;
        result.push({
          text: glyph.unicode,
          font: state.font,
          origin: point(transform, x, y),
          corners: [
            [0, bottom],
            [width * hscale, bottom],
            [0, top],
            [width * hscale, top],
          ].map(([dx, dy]) => point(transform, x + dx, y + dy)),
        });
      }
      advance += width + (state.char + (glyph.isSpace ? state.word : 0)) * state.direction;
    }
    if (f.vertical) state.y -= advance;
    else state.x += advance * hscale;
  };
  for (let i = 0; i < list.fnArray.length; i++) {
    const a = list.argsArray[i] ?? [];
    switch (list.fnArray[i]) {
      case ops.save:
        save();
        break;
      case ops.restore:
        restore();
        break;
      case ops.transform:
        state.ctm = multiply(state.ctm, a);
        break;
      case ops.paintFormXObjectBegin:
        save();
        if (a[0]) state.ctm = multiply(state.ctm, Array.from(a[0]));
        break;
      case ops.paintFormXObjectEnd:
        restore();
        break;
      case ops.beginGroup:
        save();
        break;
      case ops.endGroup:
        restore();
        break;
      case ops.beginText:
        state.matrix = identity();
        state.x = state.y = state.lineX = state.lineY = 0;
        break;
      case ops.setFont:
        font(a[0], a[1]);
        break;
      case ops.setGState:
        for (const [key, value] of a[0]) if (key === 'Font') font(value[0], value[1]);
        break;
      case ops.setTextMatrix:
        state.matrix = Array.from(typeof a[0] === 'number' ? a : a[0]);
        state.x = state.y = state.lineX = state.lineY = 0;
        break;
      case ops.moveText:
        move(a[0], a[1]);
        break;
      case ops.setLeadingMoveText:
        state.leading = a[1];
        move(a[0], a[1]);
        break;
      case ops.setLeading:
        state.leading = -a[0];
        break;
      case ops.nextLine:
        move(0, state.leading);
        break;
      case ops.setCharSpacing:
        state.char = a[0];
        break;
      case ops.setWordSpacing:
        state.word = a[0];
        break;
      case ops.setHScale:
        state.hscale = a[0] / 100;
        break;
      case ops.setTextRise:
        state.rise = a[0];
        break;
      case ops.showText:
      case ops.showSpacedText:
        show(a[0]);
        break;
      case ops.nextLineShowText:
        move(0, state.leading);
        show(a[0]);
        break;
      case ops.nextLineSetSpacingShowText:
        state.word = a[0];
        state.char = a[1];
        move(0, state.leading);
        show(a[2]);
        break;
    }
  }
  return result;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function characters(text: string) {
  return [...graphemes.segment(text)].flatMap(({ segment, index }) =>
    [...normalizeText(segment)]
      .filter((c) => !/^\s$/.test(c))
      .map((char) => ({ char, start: index, end: index + segment.length })),
  );
}

export function glyphRanges(
  glyphs: Positioned[],
  content: TextContent,
  wanted: Set<number>,
  viewport: Matrix,
  page: number,
): Map<number, GlyphRange[]> {
  const result = new Map<number, GlyphRange[]>();
  const items = content.items.filter((item): item is TextItem => 'str' in item);
  for (const id of wanted) {
    const item = items[id],
      m = item.transform as number[];
    if (item.dir !== 'ltr') continue;
    const length = Math.hypot(m[0], m[1]),
      height = Math.hypot(m[2], m[3]);
    if (!length) continue;
    const ux = m[0] / length,
      uy = m[1] / length;
    const candidates = glyphs
      .filter((g) => g.font === item.fontName)
      .map((g) => {
        const dx = g.origin[0] - m[4],
          dy = g.origin[1] - m[5];
        return { g, x: dx * ux + dy * uy, y: -dx * uy + dy * ux };
      })
      .filter(
        (g) =>
          Math.abs(g.y) < Math.max(0.2, height * 0.05) &&
          g.x >= -0.2 &&
          (item.width > 0 ? g.x < item.width - 0.05 : Math.abs(g.x) < 0.2),
      )
      .sort((a, b) => a.x - b.x);
    const source = characters(item.str),
      placed = candidates.flatMap(({ g }) => characters(g.text).map((c) => ({ char: c.char, g })));
    // Only replace the fallback when the entire run agrees, avoiding guessed
    // offsets on malformed encodings, overlapping text, or unsupported layouts.
    if (!source.length || source.map((c) => c.char).join('') !== placed.map((c) => c.char).join(''))
      continue;
    result.set(
      id,
      source.map((c, i) => {
        const corners = placed[i].g.corners.map(([x, y]) => point(viewport, x, y));
        const xs = corners.map((p) => p[0]),
          ys = corners.map((p) => p[1]);
        return {
          page,
          start: c.start,
          end: c.end,
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        };
      }),
    );
  }
  return result;
}
