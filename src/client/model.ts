export type Side = 0 | 1;
export type Kind = 'added' | 'removed' | 'replaced' | 'moved';
export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  baseline?: [number, number];
}
export interface Page {
  width: number;
  height: number;
  rotation: number;
  view: number[];
  items: TextItem[];
}
export interface Span {
  page: number;
  item: number;
  start: number;
  end: number;
}
export interface Rect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Change {
  id: number;
  kind: Kind;
  before: string;
  after: string;
  left: Span[];
  right: Span[];
}
export interface Anchor {
  left: { page: number; y: number };
  right: { page: number; y: number };
}
export interface Comparison {
  changes: Change[];
  anchors: Anchor[];
  pagePairs: [number | null, number | null][];
  coarse?: boolean;
}
export interface Geometry {
  left: Record<number, Rect[]>;
  right: Record<number, Rect[]>;
}
export interface ExportInput {
  files: [Uint8Array, Uint8Array];
  pages: [Page[], Page[]];
  comparison: Comparison;
  geometry: Geometry;
  incomplete?: boolean;
}

export const colors = {
  added: '#168c71',
  removed: '#d04d4b',
  replaced: '#ad6229',
  moved: '#3479c7',
};
