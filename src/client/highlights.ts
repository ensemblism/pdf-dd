import type { Rect } from './model';

export function padHighlight(rect: Rect, rotation: number): Rect {
  const vertical = rotation % 180 !== 0;
  const pad = (vertical ? rect.width : rect.height) * 0.02;
  return vertical
    ? { ...rect, x: rect.x - pad, width: rect.width + pad * 2 }
    : { ...rect, y: rect.y - pad, height: rect.height + pad * 2 };
}

export function boundingRect(rects: Rect[]): Rect | undefined {
  if (!rects.length) return;
  const x = Math.min(...rects.map((r) => r.x)),
    y = Math.min(...rects.map((r) => r.y));
  return {
    page: rects[0].page,
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}

// Group by a shared line before ordering along it. Tiny baseline differences
// must not sort right-hand glyphs before left-hand ones and truncate the union.
export function joinHighlightLines(rects: Rect[], rotation = 0): Rect[] {
  const vertical = rotation % 180 !== 0;
  const start = (r: Rect) => (vertical ? r.y : r.x);
  const length = (r: Rect) => (vertical ? r.height : r.width);
  const cross = (r: Rect) => (vertical ? r.x : r.y);
  const thickness = (r: Rect) => (vertical ? r.width : r.height);
  const rows: Rect[][] = [];
  for (const rect of rects) {
    const row = rows.find((group) => {
      const r = group[0],
        overlap =
          Math.min(cross(r) + thickness(r), cross(rect) + thickness(rect)) -
          Math.max(cross(r), cross(rect));
      return r.page === rect.page && overlap > Math.min(thickness(r), thickness(rect)) * 0.5;
    });
    if (row) row.push(rect);
    else rows.push([rect]);
  }
  const result: Rect[] = [];
  for (const row of rows) {
    row.sort((a, b) => start(a) - start(b));
    let current = { ...row[0] };
    for (const rect of row.slice(1)) {
      const gap = start(rect) - start(current) - length(current);
      // Spans already cover interior spaces. Join adjacent font runs (including
      // inline math), but do not bridge a column gutter or another text line.
      if (gap <= Math.max(2, Math.min(thickness(current), thickness(rect)) * 0.9))
        current = boundingRect([current, rect])!;
      else {
        result.push(current);
        current = { ...rect };
      }
    }
    result.push(current);
  }
  return result;
}
