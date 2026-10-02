import { getDocument, GlobalWorkerOptions, TextLayer, Util, OPS } from 'pdfjs-dist';
import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
  PDFPageProxy,
  TextContent,
  TextItem as PDFTextItem,
  RenderTask,
} from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Change, Geometry, Page, Rect, Side } from './model';
import { glyphRanges, positionGlyphs, type GlyphRange } from './glyphs';
import { boundingRect, joinHighlightLines, padHighlight } from './highlights';

GlobalWorkerOptions.workerSrc = workerUrl;
// A font's ascent is not a glyph's ink bound. TeX radicals can be drawn below
// their origin; a font-wide box would highlight text on the preceding row.
export function glyphInk(page: PDFPageProxy) {
  const context = document.createElement('canvas').getContext('2d')!;
  const loaded = new Set(
    [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
  );
  const cache = new Map<string, { ascent: number; descent: number }>();
  return (name: string, character: string) => {
    const font = page.commonObjs.get(name);
    if (!loaded.has(font.loadedName)) return undefined;
    const key = name + character;
    if (!cache.has(key)) {
      context.font = `100px "${font.loadedName}"`;
      const metrics = context.measureText(character);
      let ascent = metrics.actualBoundingBoxAscent / 100,
        descent = metrics.actualBoundingBoxDescent / 100;
      if (!Number.isFinite(ascent + descent) || ascent + descent <= 0) return undefined;
      const pad = Math.max(0, 0.3 - ascent - descent) / 2;
      cache.set(key, { ascent: ascent + pad, descent: descent + pad });
    }
    return cache.get(key);
  };
}
export class Document {
  private constructor(
    public name: string,
    public bytes: Uint8Array,
    public pdf: PDFDocumentProxy,
    public pages: Page[],
    public content: TextContent[],
    private task: PDFDocumentLoadingTask,
  ) {}
  static async load(file: File, onProgress: (p: number) => void) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const assets = new URL('pdf-assets/', location.href).href;
    const task = getDocument({
      data: bytes.slice(),
      cMapUrl: assets + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: assets + 'standard_fonts/',
      wasmUrl: assets + 'wasm/',
    });
    let pdf: PDFDocumentProxy;
    try {
      pdf = await task.promise;
    } catch (e) {
      await task.destroy();
      if ((e as Error).name === 'PasswordException')
        throw new Error(`${file.name}: password-protected PDFs are not supported yet.`);
      throw new Error(`${file.name}: could not read this PDF.`);
    }
    const pages: Page[] = [],
      content: TextContent[] = [];
    try {
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p),
          viewport = page.getViewport({ scale: 1 });
        const text = await page.getTextContent({ disableNormalization: true });
        content.push(text);
        const items = text.items
          .filter((item): item is PDFTextItem => 'str' in item)
          .map((item) => {
            const t = Util.transform(viewport.transform, item.transform),
              h = Math.hypot(t[2], t[3]);
            const ascent = text.styles[item.fontName]?.ascent ?? 0.8;
            const angle = Math.atan2(t[1], t[0]);
            const w = item.width;
            const corners = [
              [0, -ascent * h],
              [w, -ascent * h],
              [0, (1 - ascent) * h],
              [w, (1 - ascent) * h],
            ].map(([x, y]) => [
              t[4] + x * Math.cos(angle) - y * Math.sin(angle),
              t[5] + x * Math.sin(angle) + y * Math.cos(angle),
            ]);
            const xs = corners.map((c) => c[0]),
              ys = corners.map((c) => c[1]);
            return {
              str: item.str,
              x: Math.min(...xs),
              y: Math.min(...ys),
              width: Math.max(...xs) - Math.min(...xs),
              height: Math.max(...ys) - Math.min(...ys),
              baseline: [t[4], t[5]] as [number, number],
            };
          });
        pages.push({
          width: viewport.width,
          height: viewport.height,
          rotation: viewport.rotation,
          view: [...page.view],
          items,
        });
        onProgress(p / pdf.numPages);
      }
      return new Document(file.name, bytes, pdf, pages, content, task);
    } catch (e) {
      await task.destroy();
      throw e;
    }
  }
  destroy() {
    return this.task.destroy();
  }
}

export class Locations {
  public geometry: Geometry = { left: {}, right: {} };
  public issues = new Set<string>();
  public onIssues = () => {};
  private done = [new Set<number>(), new Set<number>()];
  constructor(
    public docs: [Document, Document],
    public changes: Change[],
  ) {}
  async capture(
    side: Side,
    p: number,
    layer: TextLayer,
    container: HTMLElement,
    scale: number,
    page: PDFPageProxy,
  ) {
    if (this.done[side].has(p)) return;
    const wanted = new Set(
      this.changes.flatMap((c) =>
        (side ? c.right : c.left).filter((s) => s.page === p).map((s) => s.item),
      ),
    );
    if (!wanted.size) {
      this.done[side].add(p);
      return;
    }
    let precise = new Map<number, GlyphRange[]>();
    try {
      const operators = await page.getOperatorList();
      precise = glyphRanges(
        positionGlyphs(operators, OPS, (name) => page.commonObjs.get(name), glyphInk(page)),
        this.docs[side].content[p],
        new Set(this.docs[side].pages[p].items.map((_, i) => i)),
        page.getViewport({ scale: 1 }).transform,
        p,
      );
    } catch {
      // Unsupported drawing operations must still allow TextLayer measurement.
    }
    const bounds = container.getBoundingClientRect();
    const table = side ? this.geometry.right : this.geometry.left;
    const items = this.docs[side].content[p].items.filter((t): t is PDFTextItem => 'str' in t);
    const marked = new Map<number, { start: number; end: number }[]>();
    for (const change of this.changes)
      for (const ref of (side ? change.right : change.left).filter((s) => s.page === p)) {
        const ranges = marked.get(ref.item) ?? [];
        ranges.push(ref);
        marked.set(ref.item, ranges);
      }
    const unchanged = [...precise].flatMap(([item, glyphs]) =>
      glyphs.filter(
        (glyph) => !marked.get(item)?.some((ref) => glyph.end > ref.start && glyph.start < ref.end),
      ),
    );
    let missing = false;
    for (const change of this.changes) {
      const refs = (side ? change.right : change.left).filter((s) => s.page === p),
        rects: Rect[] = [];
      for (const ref of refs) {
        const item = items[ref.item];
        if (!item.str.slice(ref.start, ref.end).trim()) continue;
        const start = rects.length;
        const glyphs = precise.get(ref.item);
        if (glyphs) {
          const rect = boundingRect(glyphs.filter((g) => g.end > ref.start && g.start < ref.end));
          if (rect) {
            rects.push(rect);
            continue;
          }
        }
        const element = layer.textDivs[ref.item],
          text = element?.firstChild;
        if (!text || text.nodeType !== Node.TEXT_NODE) {
          missing = true;
          continue;
        }
        const range = document.createRange();
        range.setStart(text, Math.min(ref.start, text.textContent!.length));
        range.setEnd(text, Math.min(ref.end, text.textContent!.length));
        const transform = Util.transform(page.getViewport({ scale: 1 }).transform, item.transform);
        const vertical = Math.abs(transform[1]) > Math.abs(transform[0]);
        for (const rect of range.getClientRects())
          if (rect.width > 0.05 && rect.height > 0.05)
            rects.push({
              page: p,
              x: (rect.left - bounds.left + (vertical ? rect.width * 0.08 : 0)) / scale,
              y: (rect.top - bounds.top + (vertical ? 0 : rect.height * 0.08)) / scale,
              width: (rect.width * (vertical ? 0.84 : 1)) / scale,
              height: (rect.height * (vertical ? 1 : 0.84)) / scale,
            });
        if (rects.length === start) missing = true;
      }
      if (refs.length)
        table[change.id] = [
          ...(table[change.id] ?? []).filter((r) => r.page !== p),
          ...joinHighlightLines(rects, page.rotate, unchanged).map((rect) =>
            padHighlight(rect, page.rotate),
          ),
        ];
    }
    this.done[side].add(p);
    if (missing) {
      this.issues.add(
        `${side ? 'Modified' : 'Original'} page ${p + 1}: some text differences could not be highlighted.`,
      );
      this.onIssues();
    }
  }
  async ensureAll(onProgress: (p: number) => void) {
    const work: [Side, number][] = [];
    for (const side of [0, 1] as const)
      for (const p of new Set(
        this.changes.flatMap((c) => (side ? c.right : c.left).map((s) => s.page)),
      ))
        if (!this.done[side].has(p)) work.push([side, p]);
    for (let i = 0; i < work.length; i++) {
      const [side, p] = work[i],
        doc = this.docs[side],
        page = await doc.pdf.getPage(p + 1);
      const container = document.createElement('div');
      container.className = 'textLayer measurement';
      container.style.setProperty('--scale-factor', '1');
      container.style.setProperty('--user-unit', '1');
      container.style.setProperty('--total-scale-factor', '1');
      document.body.append(container);
      try {
        const layer = new TextLayer({
          textContentSource: doc.content[p],
          container,
          viewport: page.getViewport({ scale: 1 }),
        });
        await layer.render();
        await this.capture(side, p, layer, container, 1, page);
      } finally {
        container.remove();
      }
      onProgress((i + 1) / Math.max(1, work.length));
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
}

interface View {
  p: number;
  node: HTMLDivElement;
  canvas?: HTMLCanvasElement;
  layer?: TextLayer;
  overlay?: HTMLDivElement;
  task?: RenderTask;
  pending: boolean;
  stamp: number;
  generation: number;
  viewport?: ReturnType<PDFPageProxy['getViewport']>;
}
export interface ZoomPoint {
  clientX: number;
  clientY: number;
}
export class Reader {
  private views: View[] = [];
  private active = 0;
  private dead = false;
  private frame = 0;
  private zoomTimer = 0;
  private selected = 0;
  private kinds = new Set(['added', 'removed', 'replaced', 'moved']);
  public scale = 1;
  public fit = true;
  onScroll: () => void = () => {};
  onPage: (p: number) => void = () => {};
  onSelect: (id: number) => void = () => {};
  onError: (message: string) => void = () => {};
  constructor(
    public side: Side,
    public doc: Document,
    public scroller: HTMLElement,
    private locations: Locations,
  ) {
    scroller.replaceChildren();
    doc.pages.forEach((_page, p) => {
      const node = document.createElement('div');
      node.className = 'paper';
      node.dataset.page = String(p + 1);
      node.setAttribute('aria-label', `Page ${p + 1}`);
      node.style.width = `${_page.width}px`;
      node.style.height = `${_page.height}px`;
      scroller.append(node);
      this.views.push({ p, node, pending: false, stamp: 0, generation: 0 });
    });
    scroller.addEventListener('scroll', this.scroll, { passive: true });
    scroller.addEventListener('click', this.click);
  }
  private click = (e: MouseEvent) => {
    if (window.getSelection()?.toString()) return;
    const page = (e.target as HTMLElement).closest('.paper');
    for (const box of page?.querySelectorAll<HTMLElement>('[data-change]') ?? []) {
      const r = box.getBoundingClientRect();
      if (
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom
      ) {
        this.onSelect(Number(box.dataset.change));
        return;
      }
    }
  };
  private scroll = () => {
    if (!this.frame)
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.schedule();
        this.onPage(this.currentPage());
        this.onScroll();
      });
  };
  private clear(view: View) {
    view.task?.cancel();
    view.layer?.cancel();
    if (view.canvas) {
      view.canvas.width = 0;
      view.canvas.height = 0;
    }
    view.node.replaceChildren();
    view.node.classList.remove('rendered');
    delete view.node.dataset.error;
    view.canvas = undefined;
    view.layer = undefined;
    view.overlay = undefined;
    view.generation++;
  }
  setScale(scale: number, fit = false, focus?: ZoomPoint, preview = false) {
    const position = this.position();
    const target =
      focus &&
      (this.views.find((v) => v.node.getBoundingClientRect().bottom >= focus.clientY) ??
        this.views.at(-1)!);
    const bounds = target?.node.getBoundingClientRect();
    const anchor =
      focus && bounds
        ? {
            x: (focus.clientX - bounds.left) / this.scale,
            y: (focus.clientY - bounds.top) / this.scale,
          }
        : null;
    clearTimeout(this.zoomTimer);
    this.zoomTimer = 0;
    this.fit = fit;
    this.scale = scale;
    for (const view of this.views) {
      if (!preview || view.pending) this.clear(view);
      view.node.style.width = `${this.doc.pages[view.p].width * scale}px`;
      view.node.style.height = `${this.doc.pages[view.p].height * scale}px`;
      view.node.style.setProperty('--scale-factor', String(scale));
      view.node.style.setProperty('--user-unit', '1');
      view.node.style.setProperty('--total-scale-factor', String(scale));
      if (preview && view.canvas) {
        view.canvas.style.width = view.node.style.width;
        view.canvas.style.height = view.node.style.height;
        if (view.viewport) view.layer?.update({ viewport: view.viewport.clone({ scale }) });
        this.mark(view);
      }
    }
    if (preview) this.zoomTimer = window.setTimeout(() => this.setScale(this.scale, this.fit), 120);
    if (target && anchor && focus) {
      const rect = target.node.getBoundingClientRect();
      this.scroller.scrollLeft += rect.left + anchor.x * scale - focus.clientX;
      this.scroller.scrollTop += rect.top + anchor.y * scale - focus.clientY;
      this.onPage(this.currentPage());
    } else this.jump(position.page, position.y);
    this.schedule();
  }
  fitScale() {
    return Math.max(
      0.25,
      Math.min(
        3,
        (this.scroller.clientWidth - 48) / Math.max(...this.doc.pages.map((p) => p.width)),
      ),
    );
  }
  private top(view: View) {
    return view.node.offsetTop - this.scroller.offsetTop;
  }
  position() {
    let p = 0;
    const y = this.scroller.scrollTop + 20;
    for (let i = 0; i < this.views.length; i++) {
      if (this.top(this.views[i]) <= y) p = i;
      else break;
    }
    return { page: p, y: Math.max(0, (y - this.top(this.views[p])) / this.scale) };
  }
  currentPage() {
    const top = this.scroller.scrollTop,
      bottom = top + this.scroller.clientHeight;
    let page = 0,
      most = 0;
    for (const view of this.views) {
      const start = this.top(view),
        visible = Math.max(
          0,
          Math.min(bottom, start + this.doc.pages[view.p].height * this.scale) -
            Math.max(top, start),
        );
      if (visible > most) {
        most = visible;
        page = view.p;
      }
    }
    return page;
  }
  jump(p: number, y = 0) {
    const page = Math.max(
      0,
      Math.min(this.views.length - 1, Number.isFinite(p) ? Math.floor(p) : 0),
    );
    this.scroller.scrollTop = Math.max(0, this.top(this.views[page]) + y * this.scale - 20);
    this.schedule();
    this.onPage(this.currentPage());
  }
  locate(p: number, y: number) {
    this.scroller.scrollTop = Math.max(
      0,
      this.top(this.views[p]) + y * this.scale - this.scroller.clientHeight * 0.3,
    );
    this.schedule();
    this.onPage(p);
  }
  setMarks(id: number, kinds: Set<string>) {
    this.selected = id;
    this.kinds = kinds;
    for (const view of this.views) if (view.overlay) this.mark(view);
  }
  private mark(view: View) {
    if (!view.overlay) return;
    const table = this.side ? this.locations.geometry.right : this.locations.geometry.left;
    view.overlay.replaceChildren();
    for (const change of this.locations.changes) {
      if (!this.kinds.has(change.kind)) continue;
      const kind = change.kind === 'moved' ? 'moved' : this.side ? 'added' : 'removed';
      for (const rect of table[change.id] ?? []) {
        if (rect.page !== view.p) continue;
        const box = document.createElement('div');
        box.className = `mark ${kind}${this.selected === change.id ? ' selected' : ''}`;
        box.dataset.change = String(change.id);
        box.title = `${change.kind} · #${change.id}`;
        Object.assign(box.style, {
          left: `${rect.x * this.scale}px`,
          top: `${rect.y * this.scale}px`,
          width: `${Math.max(2, rect.width * this.scale)}px`,
          height: `${rect.height * this.scale}px`,
        });
        view.overlay.append(box);
      }
    }
  }
  schedule() {
    if (this.dead || this.zoomTimer || !this.scroller.clientWidth) return;
    const top = this.scroller.scrollTop,
      bottom = top + this.scroller.clientHeight;
    const wanted = this.views
      .filter(
        (v) =>
          this.top(v) + this.doc.pages[v.p].height * this.scale > top - 500 &&
          this.top(v) < bottom + 500,
      )
      .sort(
        (a, b) =>
          Math.abs(
            this.top(a) + (this.doc.pages[a.p].height * this.scale) / 2 - (top + bottom) / 2,
          ) -
          Math.abs(
            this.top(b) + (this.doc.pages[b.p].height * this.scale) / 2 - (top + bottom) / 2,
          ),
      )
      .slice(0, 6);
    for (const view of wanted) {
      view.stamp = performance.now();
      if (!view.canvas && !view.pending && !view.node.dataset.error && this.active < 2)
        void this.render(view);
    }
    const cached = this.views.filter((v) => v.canvas).sort((a, b) => b.stamp - a.stamp);
    let pixels = 0;
    cached.forEach((v, i) => {
      pixels += (v.canvas?.width ?? 0) * (v.canvas?.height ?? 0);
      if ((i >= 6 || pixels > 24_000_000) && !wanted.includes(v)) this.clear(v);
    });
  }
  private async render(view: View) {
    this.active++;
    view.pending = true;
    const version = view.generation,
      scale = this.scale;
    try {
      const page: PDFPageProxy = await this.doc.pdf.getPage(view.p + 1);
      if (this.dead || version !== view.generation) return;
      const viewport = page.getViewport({ scale });
      view.viewport = viewport;
      const dpr = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(6_000_000 / (viewport.width * viewport.height)),
      );
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width * dpr);
      canvas.height = Math.ceil(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      view.canvas = canvas;
      view.node.append(canvas);
      const ctx = canvas.getContext('2d', { alpha: false })!;
      view.task = page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      await view.task.promise;
      if (this.dead || version !== view.generation) return;
      const text = document.createElement('div');
      text.className = 'textLayer';
      view.node.append(text);
      const layer = new TextLayer({
        textContentSource: this.doc.content[view.p],
        container: text,
        viewport,
      });
      view.layer = layer;
      await layer.render();
      if (this.dead || version !== view.generation) return;
      await this.locations.capture(this.side, view.p, layer, text, scale, page);
      if (this.dead || version !== view.generation) return;
      const overlay = document.createElement('div');
      overlay.className = 'overlays';
      view.overlay = overlay;
      view.node.append(overlay);
      this.mark(view);
      view.node.classList.add('rendered');
    } catch (e) {
      if ((e as Error).name !== 'RenderingCancelledException' && !this.dead) {
        view.node.dataset.error = 'Page could not be rendered';
        this.onError(`Page ${view.p + 1}: ${(e as Error).message}`);
      }
    } finally {
      view.pending = false;
      this.active--;
      if (!this.dead) this.schedule();
    }
  }
  destroy() {
    this.dead = true;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.zoomTimer);
    this.scroller.removeEventListener('scroll', this.scroll);
    this.scroller.removeEventListener('click', this.click);
    for (const view of this.views) this.clear(view);
  }
}
