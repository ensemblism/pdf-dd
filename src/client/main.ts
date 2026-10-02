import './style.css';
import { SourcePicker, type VersionDownloadProgress } from './sources';
import { Document, Locations, Reader, type ZoomPoint } from './pdf';
import type { Comparison, ExportInput, Side } from './model';

const unmappedCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/;

const app = document.querySelector<HTMLDivElement>('#app')!;
const icons = {
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M3 16v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4"/>',
  swap: '<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
  sync: '<path d="M6 3v18M3 6l3-3 3 3M3 18l3 3 3-3M18 3v18M15 6l3-3 3 3M15 18l3 3 3-3"/><path d="M9 12h6" stroke-dasharray="2 2" stroke-linecap="butt"/>',
  down: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  arrow: '<path d="m6 10 6 6 6-6"/>',
};
function icon(name: keyof typeof icons) {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}
app.innerHTML = `
<header class="brandbar">
  <button type="button" id="brand" class="brand" title="Back to file selection"><img class="brand-icon" src="./discerner.svg" alt="" width="34" height="34"/><strong>PDF <span>D</span>iff <span>D</span>iscerner</strong></button>
  <div id="header-tagline" class="eyebrow">A CLOSER LOOK AT WHAT CHANGED</div>
  <div id="header-center" hidden><div id="header-view" class="segmented" role="group" aria-label="Document view"><button data-view="original" aria-pressed="false">Original</button><button data-view="split" aria-pressed="true">Split</button><button data-view="modified" aria-pressed="false">Modified</button></div><div class="toolbar-actions"><button id="sync" aria-pressed="true" title="Synchronize scrolling">${icon('sync')}<span>Sync</span></button></div></div>
  <div id="header-right" hidden><div class="toolbar-actions"><button id="export" title="Export comparison PDF">${icon('down')}<span>Export</span></button></div></div>
</header>
<main id="upload-screen">
  <div class="intro"><h1>Two PDFs. Every difference.</h1><p>Compare documents side by side, right on your computer.</p></div>
  <div id="source-picker"></div>
  <div id="local-files" class="drop-grid">
    ${([0, 1] as const).map((side) => `<section class="drop-card" data-side="${side}"><div class="drop-title"><span class="side-dot ${side ? 'green' : 'red'}"></span><h2>${side ? 'Modified' : 'Original'}</h2></div><button class="dropzone" data-upload="${side}"><span class="upload-icon">${icon('upload')}</span><strong>Drop a PDF here</strong><span>or click to browse</span></button><input type="file" id="file-${side}" accept=".pdf,application/pdf" hidden/><div class="file-info" id="file-info-${side}" hidden><span>${icon('file')}</span><div><strong></strong><small></small></div><button class="remove icon-button" data-remove="${side}" aria-label="Remove ${side ? 'modified' : 'original'} PDF">×</button></div><p class="file-error" id="file-error-${side}" role="alert"></p></section>`).join('')}
    <button id="swap" class="swap-button icon-button" aria-label="Swap original and modified files" title="Swap files">${icon('swap')}</button>
  </div>
  <button id="compare" class="primary compare-button" disabled>Make a difference! <span>→</span></button>
  <p class="privacy-note">${icon('lock')} Your documents stay on this device. No uploads. No account.</p>
</main>
<section id="result-screen" hidden>
  <div id="notice" role="status" hidden></div>
  <div id="workspace" data-view="split">
    ${([0, 1] as const).map((side) => `<section class="pane" id="pane-${side}"><div class="reader-toolbar"><div class="pane-filename">${icon('file')}<strong id="name-${side}"></strong></div><div class="page-controls"><label>Page <input class="page-input" id="page-${side}" aria-label="${side ? 'Modified' : 'Original'} page" type="number" min="1" value="1"/> <span id="pages-${side}"></span></label><button class="icon-button page-prev" data-side="${side}" aria-label="Previous ${side ? 'modified' : 'original'} page">${icon('up')}</button><button class="icon-button page-next" data-side="${side}" aria-label="Next ${side ? 'modified' : 'original'} page">${icon('arrow')}</button></div><div class="zoom-controls"><button class="zoom-less icon-button" data-side="${side}" aria-label="Zoom out">−</button><output id="zoom-label-${side}">100%</output><input id="zoom-${side}" aria-label="${side ? 'Modified' : 'Original'} zoom" type="range" min="25" max="300" step="5" value="100"/><button class="zoom-more icon-button" data-side="${side}" aria-label="Zoom in">+</button><button class="fit" data-side="${side}" title="Fit to width">Fit</button></div></div><div class="pdf-scroll" id="reader-${side}" tabindex="0" aria-label="${side ? 'Modified' : 'Original'} PDF"></div></section>`).join('')}
    <aside class="changes-panel"><div class="changes-heading"><h2>Differences</h2><div class="changes-controls"><div class="changes-navigation"><span id="current-change"></span><button id="previous-change" class="icon-button" aria-label="Previous difference">${icon('up')}</button><button id="next-change" class="icon-button" aria-label="Next difference">${icon('arrow')}</button></div><select id="filter" aria-label="Filter differences"><option value="all">All</option><option value="added">Added</option><option value="removed">Removed</option><option value="replaced">Replaced</option><option value="moved">Moved</option></select></div></div><div id="changes-list" tabindex="0"></div></aside>
  </div>
</section>
<div id="busy" hidden role="status" aria-live="polite"><div class="busy-card"><span class="spinner"></span><h2 id="busy-title">Reading your PDFs</h2><p id="busy-detail">Preparing comparison…</p><progress id="progress" max="100" value="0"></progress></div></div>
<div id="toast" role="alert" hidden></div>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let files: [File | null, File | null] = [null, null],
  docs: [Document, Document] | null = null,
  readers: [Reader, Reader] | null = null,
  locations: Locations | null = null,
  result: Comparison | null = null;
let view: 'original' | 'split' | 'modified' = 'split',
  selected = 0,
  filter = 'all',
  sync = true,
  listLimit = 60;
type ScrollPosition = { left: number; top: number };
const expectedScroll: [ScrollPosition | null, ScrollPosition | null] = [null, null];
const lastScroll: [ScrollPosition | null, ScrollPosition | null] = [null, null];
function scrollPosition(side: Side): ScrollPosition {
  const scroller = readers![side].scroller;
  return { left: scroller.scrollLeft, top: scroller.scrollTop };
}
function rememberScroll(side: Side) {
  expectedScroll[side] = lastScroll[side] = scrollPosition(side);
}
const editingPage = [false, false];
let offsets: [number[], number[]] = [[], []],
  scrollPoints: [{ x: number; y: number }[], { x: number; y: number }[]] = [[], []];
let worker: Worker | undefined,
  requestId = 0;
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    progress?: (n: number) => void;
  }
>();
function compute<T>(
  type: 'compare' | 'export',
  payload: Record<string, unknown>,
  progress?: (n: number) => void,
): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./compute.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      if ('progress' in data) {
        p.progress?.(data.progress);
        return;
      }
      pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.result);
    };
    worker.onerror = () => {
      for (const p of pending.values())
        p.reject(new Error('The comparison worker could not finish. Try smaller PDFs.'));
      pending.clear();
      worker?.terminate();
      worker = undefined;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve: (value) => resolve(value as T), reject, progress });
    worker!.postMessage({ id, type, ...payload });
  });
}
let toastTimer = 0;
function toast(message: string) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ($('toast').hidden = true), 8000);
}
function busy(show: boolean, title = '', detail = '', progress: number | null = 0) {
  $('busy').hidden = !show;
  $('busy-title').textContent = title;
  $('busy-detail').textContent = detail;
  if (progress === null) $('progress').removeAttribute('value');
  else $<HTMLProgressElement>('progress').value = progress;
}
function accept(side: Side, file?: File) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    $(`file-error-${side}`).textContent = 'Please choose a PDF file.';
    return;
  }
  files[side] = file;
  $(`file-error-${side}`).textContent = '';
  refreshFiles();
}
function refreshFiles() {
  for (const side of [0, 1] as const) {
    const file = files[side],
      info = $(`file-info-${side}`);
    info.hidden = !file;
    const zone = document.querySelector<HTMLElement>(`[data-upload="${side}"]`)!;
    zone.classList.toggle('has-file', !!file);
    zone.querySelector('strong')!.textContent = file ? 'Replace PDF' : 'Drop a PDF here';
    if (file) {
      info.querySelector('strong')!.textContent = file.name;
      info.querySelector('small')!.textContent =
        `${(file.size / 1024 / 1024).toFixed(2)} MB · Ready to compare`;
    }
  }
  $<HTMLButtonElement>('compare').disabled = sourcePicker.local
    ? !files[0] || !files[1]
    : !sourcePicker.ready;
}
for (const side of [0, 1] as const) {
  const input = $<HTMLInputElement>(`file-${side}`),
    zone = document.querySelector<HTMLButtonElement>(`[data-upload="${side}"]`)!;
  zone.onclick = () => input.click();
  input.onchange = () => {
    accept(side, input.files?.[0]);
    input.value = '';
  };
  const card = zone.closest<HTMLElement>('.drop-card')!;
  card.ondragover = (e) => {
    e.preventDefault();
    card.classList.add('dragging');
  };
  card.ondragleave = (e) => {
    if (!card.contains(e.relatedTarget as Node)) card.classList.remove('dragging');
  };
  card.ondrop = (e) => {
    e.preventDefault();
    card.classList.remove('dragging');
    accept(side, e.dataTransfer?.files[0]);
  };
  document.querySelector<HTMLButtonElement>(`[data-remove="${side}"]`)!.onclick = () => {
    files[side] = null;
    refreshFiles();
  };
}
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
$('swap').onclick = () => {
  files = [files[1], files[0]];
  refreshFiles();
};
const sourcePicker = new SourcePicker($('source-picker'), () => {
  $('local-files').hidden = !sourcePicker.local;
  refreshFiles();
});
$('compare').onclick = async () => {
  if (!$('busy').hidden) return;
  if (!sourcePicker.local) {
    busy(true, 'Loading selected versions', 'Preparing two PDFs for local comparison…', null);
    try {
      const downloads: (VersionDownloadProgress | undefined)[] = [undefined, undefined];
      files = await sourcePicker.files((progress) => {
        downloads[progress.index] = progress;
        const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
        const known = downloads.every((p) => p && (p.complete || p.total));
        const total = downloads.reduce((n, p) => n + (p?.complete ? p.loaded : (p?.total ?? 0)), 0);
        const loaded = downloads.reduce((n, p) => n + (p?.loaded ?? 0), 0);
        const percent = known && total ? Math.min(100, Math.floor((loaded / total) * 100)) : null;
        const detail = downloads
          .map((p, i) => {
            if (!p) return `PDF ${i + 1} of 2 · Waiting for download…`;
            const state = p.complete
              ? `${size(p.loaded)} · ${p.cached ? 'Using downloaded PDF' : 'Download complete'}`
              : p.loaded === 0
                ? 'Waiting for download…'
                : p.total
                  ? `${size(p.loaded)} / ${size(p.total)} · ${Math.min(100, Math.floor((p.loaded / p.total) * 100))}%`
                  : `${size(p.loaded)} downloaded · Total size unknown`;
            return `PDF ${i + 1} of 2 · ${p.label} · ${state}`;
          })
          .join('\n');
        busy(true, 'Loading selected versions', detail, percent);
      });
    } catch (e) {
      busy(false);
      toast((e as Error).message);
      return;
    }
  }
  await run();
};

async function run() {
  if (!files[0] || !files[1]) return;
  const loaded: Document[] = [];
  busy(true, 'Reading your PDFs', 'Extracting text and page positions…');
  try {
    for (const side of [0, 1] as const)
      loaded.push(
        await Document.load(files[side]!, (fraction) =>
          busy(true, 'Reading your PDFs', files[side]!.name, side * 30 + fraction * 30),
        ),
      );
    docs = loaded as [Document, Document];
    busy(true, 'Finding the differences', 'Matching paragraphs, words and moved content…', 65);
    const start = performance.now();
    result = await compute<Comparison>('compare', { pages: docs.map((d) => d.pages) });
    locations = new Locations(docs, result.changes);
    locations.onIssues = updateNotice;
    selected = 0;
    filter = 'all';
    $<HTMLSelectElement>('filter').value = 'all';
    offsets = docs.map((d) => {
      const values = [0];
      for (const p of d.pages) values.push(values.at(-1)! + p.height + 20);
      return values;
    }) as [number[], number[]];
    const monotonic = result.anchors.reduce<typeof result.anchors>((all, a) => {
      const last = all.at(-1);
      if (
        !last ||
        (offsets[0][a.left.page] + a.left.y > offsets[0][last.left.page] + last.left.y &&
          offsets[1][a.right.page] + a.right.y > offsets[1][last.right.page] + last.right.y)
      )
        all.push(a);
      return all;
    }, []);
    scrollPoints = ([0, 1] as const).map((side) => [
      { x: 0, y: 0 },
      ...monotonic.map((a) => {
        const from = side ? a.right : a.left,
          to = side ? a.left : a.right;
        return { x: offsets[side][from.page] + from.y, y: offsets[1 - side][to.page] + to.y };
      }),
      { x: offsets[side].at(-1)!, y: offsets[1 - side].at(-1)! },
    ]) as typeof scrollPoints;
    $('upload-screen').hidden = true;
    $('result-screen').hidden = false;
    $('header-center').hidden = $('header-right').hidden = false;
    $('header-tagline').hidden = true;
    readers = [
      new Reader(0, docs[0], $('reader-0'), locations),
      new Reader(1, docs[1], $('reader-1'), locations),
    ];
    for (const side of [0, 1] as const) {
      editingPage[side] = false;
      $(`name-${side}`).textContent = docs[side].name;
      $(`pages-${side}`).textContent = `of ${docs[side].pages.length}`;
      $<HTMLInputElement>(`page-${side}`).max = String(docs[side].pages.length);
      readers[side].onPage = (p) => {
        if (!editingPage[side]) $<HTMLInputElement>(`page-${side}`).value = String(p + 1);
      };
      readers[side].onScroll = () => syncScroll(side);
      readers[side].onSelect = (id) => selectChange(id, false);
      readers[side].onError = toast;
    }
    updateNotice();
    $('result-screen').dataset.compareMs = String(Math.round(performance.now() - start));
    setView('split');
    renderList();
    busy(false);
  } catch (error) {
    busy(false);
    toast(error instanceof Error ? error.message : String(error));
    for (const doc of loaded) await doc.destroy();
    docs = null;
  }
}
function updateNotice() {
  if (!docs || !result) return;
  const empty = docs.flatMap((d, s) =>
    d.pages.flatMap((p, i) =>
      p.items.some((t) => t.str.trim()) ? [] : [`${s ? 'Modified' : 'Original'} ${i + 1}`],
    ),
  );
  const messages = [];
  const unmapped = docs.flatMap((d, s) =>
    d.pages.flatMap((p, i) =>
      p.items.some((t) => unmappedCharacters.test(t.str))
        ? [`${s ? 'Modified' : 'Original'} ${i + 1}`]
        : [],
    ),
  );
  if (empty.length)
    messages.push(
      `Text comparison is incomplete on pages without extractable text: ${empty.join(', ')}. OCR is not included.`,
    );
  if (result.coarse)
    messages.push(
      'Some changes are shown as whole text blocks because detailed comparison reached its time limit.',
    );
  if (unmapped.length)
    messages.push(
      `Some characters have unusable text mappings on pages: ${unmapped.join(', ')}. Their visible symbols may compare incorrectly; review these pages.`,
    );
  messages.push(...(locations?.issues ?? []));
  $('notice').hidden = !messages.length;
  $('notice').textContent = messages.join(' ');
}
async function reset() {
  readers?.forEach((r) => r.destroy());
  readers = null;
  if (docs) await Promise.all(docs.map((d) => d.destroy()));
  docs = null;
  locations = null;
  result = null;
  $('result-screen').hidden = true;
  $('upload-screen').hidden = false;
  $('header-center').hidden = $('header-right').hidden = true;
  $('header-tagline').hidden = false;
  refreshFiles();
}
$('brand').onclick = () => void reset();
function setView(next: typeof view) {
  view = next;
  $('workspace').dataset.view = view;
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
    if (button.tagName === 'BUTTON')
      button.setAttribute('aria-pressed', String(button.dataset.view === view));
  });
  requestAnimationFrame(() => {
    if (!readers) return;
    const visible = ([0, 1] as const).filter(
      (s) => view === 'split' || (view === 'original' ? s === 0 : s === 1),
    );
    const fit = Math.min(...visible.map((s) => readers![s].fitScale()));
    for (const s of visible) {
      if (readers[s].fit) readers[s].setScale(fit, true);
      else readers[s].schedule();
      rememberScroll(s);
      updateZoom(s);
    }
  });
}
document
  .querySelectorAll<HTMLButtonElement>('button[data-view]')
  .forEach((b) => (b.onclick = () => setView(b.dataset.view as typeof view)));
function updateZoom(side: Side) {
  const pct = Math.round(readers![side].scale * 100);
  $(`zoom-label-${side}`).textContent = `${pct}%`;
  $<HTMLInputElement>(`zoom-${side}`).value = String(pct);
}
function zoom(side: Side, value: number, fit = false, focus?: ZoomPoint) {
  if (!readers) return;
  const scale = Math.max(0.25, Math.min(3, value));
  for (const s of view === 'split' ? ([0, 1] as const) : [side]) {
    let point = focus;
    if (focus && s !== side) {
      const from = readers[side].scroller.getBoundingClientRect(),
        to = readers[s].scroller.getBoundingClientRect();
      point = {
        clientX: to.left + ((focus.clientX - from.left) * to.width) / from.width,
        clientY: to.top + ((focus.clientY - from.top) * to.height) / from.height,
      };
    }
    readers[s].setScale(scale, fit, point, !!point);
    rememberScroll(s);
    updateZoom(s);
  }
}
let zoomFrame = 0,
  queuedZoom: { side: Side; value: number; point: ZoomPoint } | null = null;
function gestureZoom(side: Side, factor: number, point: ZoomPoint) {
  if (!readers) return;
  const value = Math.max(0.25, Math.min(3, (queuedZoom?.value ?? readers[side].scale) * factor));
  queuedZoom = { side, value, point };
  if (!zoomFrame)
    zoomFrame = requestAnimationFrame(() => {
      zoomFrame = 0;
      const pending = queuedZoom;
      queuedZoom = null;
      if (pending) zoom(pending.side, pending.value, false, pending.point);
    });
}
function jumpPage(side: Side, page: number) {
  if (!readers) return;
  readers[side].jump(page);
  expectedScroll[side] = null;
  syncScroll(side, true);
}
for (const side of [0, 1] as const) {
  const scroller = $(`reader-${side}`);
  let gestureScale = 0;
  scroller.addEventListener(
    'wheel',
    (e) => {
      if (!readers || (!e.ctrlKey && !e.metaKey)) return;
      e.preventDefault();
      if (gestureScale) return;
      const delta =
        e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroller.clientHeight : 1);
      gestureZoom(side, Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.003), e);
    },
    { passive: false },
  );
  // Safari exposes trackpad pinches as gesture events instead of ctrl+wheel.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend'])
    scroller.addEventListener(
      type,
      (event) => {
        if (!readers) return;
        event.preventDefault();
        const e = event as Event & ZoomPoint & { scale: number };
        if (type === 'gesturestart') gestureScale = e.scale;
        else if (type === 'gestureend') gestureScale = 0;
        else if (gestureScale) {
          const bounds = scroller.getBoundingClientRect();
          gestureZoom(side, e.scale / gestureScale, {
            clientX: e.clientX || bounds.left + bounds.width / 2,
            clientY: e.clientY || bounds.top + bounds.height / 2,
          });
          gestureScale = e.scale;
        }
      },
      { passive: false },
    );
  $<HTMLInputElement>(`zoom-${side}`).oninput = (e) =>
    zoom(side, Number((e.target as HTMLInputElement).value) / 100);
  $<HTMLInputElement>(`page-${side}`).oninput = () => {
    editingPage[side] = true;
  };
  $<HTMLInputElement>(`page-${side}`).onchange = (e) => {
    editingPage[side] = false;
    jumpPage(side, Number((e.target as HTMLInputElement).value) - 1);
  };
  document.querySelector<HTMLButtonElement>(`.page-prev[data-side="${side}"]`)!.onclick = () =>
    readers && jumpPage(side, readers[side].currentPage() - 1);
  document.querySelector<HTMLButtonElement>(`.page-next[data-side="${side}"]`)!.onclick = () =>
    readers && jumpPage(side, readers[side].currentPage() + 1);
  document.querySelector<HTMLButtonElement>(`.zoom-less[data-side="${side}"]`)!.onclick = () =>
    readers && zoom(side, readers[side].scale - 0.1);
  document.querySelector<HTMLButtonElement>(`.zoom-more[data-side="${side}"]`)!.onclick = () =>
    readers && zoom(side, readers[side].scale + 0.1);
  document.querySelector<HTMLButtonElement>(`.fit[data-side="${side}"]`)!.onclick = () =>
    readers &&
    zoom(
      side,
      view === 'split' ? Math.min(...readers.map((r) => r.fitScale())) : readers[side].fitScale(),
      true,
    );
}
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => setView(view), 150);
});
$('sync').onclick = () => {
  sync = !sync;
  $('sync').setAttribute('aria-pressed', String(sync));
  if (sync) syncScroll(0, true);
};
function syncScroll(side: Side, force = false) {
  if (!readers) return;
  const current = scrollPosition(side),
    previous = lastScroll[side],
    expected = expectedScroll[side];
  lastScroll[side] = current;
  expectedScroll[side] = null;
  if (
    !force &&
    expected &&
    Math.abs(current.top - expected.top) < 0.01 &&
    Math.abs(current.left - expected.left) < 0.01
  )
    return;
  if (!sync || view !== 'split' || !result || !docs) return;
  const vertical = force || !previous || Math.abs(current.top - previous.top) > 0.01;
  const horizontal = force || !previous || Math.abs(current.left - previous.left) > 0.01;
  if (!vertical && !horizontal) return;
  const other = (1 - side) as Side;
  if (vertical) {
    const pos = readers[side].position();
    const points = scrollPoints[side],
      x = offsets[side][pos.page] + pos.y;
    let i = 0;
    while (i < points.length - 2 && points[i + 1].x <= x) i++;
    const a = points[i],
      b = points[i + 1],
      fraction = Math.max(0, Math.min(1, (x - a.x) / Math.max(1, b.x - a.x)));
    let target = a.y + (b.y - a.y) * fraction,
      p = 0;
    while (p < docs[other].pages.length - 1 && target > docs[other].pages[p].height + 20) {
      target -= docs[other].pages[p].height + 20;
      p++;
    }
    readers[other].jump(p, target);
  }
  if (horizontal) {
    const from = readers[side].scroller,
      to = readers[other].scroller;
    const range = from.scrollWidth - from.clientWidth;
    const fraction = range > 0 ? Math.max(0, Math.min(1, current.left / range)) : 0;
    to.scrollLeft = fraction * Math.max(0, to.scrollWidth - to.clientWidth);
  }
  rememberScroll(other);
}
const filtered = () => result?.changes.filter((c) => filter === 'all' || c.kind === filter) ?? [];
function makeCard(change: NonNullable<typeof result>['changes'][number]) {
  const card = document.createElement('button');
  card.className = `change-card${selected === change.id ? ' active' : ''}`;
  card.dataset.id = String(change.id);
  const heading = document.createElement('div');
  heading.className = 'card-heading';
  const badge = document.createElement('span');
  badge.className = `badge ${change.kind}`;
  badge.textContent = change.kind[0].toUpperCase() + change.kind.slice(1);
  const number = document.createElement('span');
  number.className = 'change-number';
  number.textContent = String(change.id);
  heading.append(badge, number);
  card.append(heading);
  const add = (label: string, text: string, kind: string) => {
    if (label) {
      const title = document.createElement('small');
      title.textContent = label;
      card.append(title);
    }
    const content = document.createElement('p');
    content.className = kind;
    content.textContent = text.length > 280 ? text.slice(0, 280) + '…' : text;
    card.append(content);
  };
  if (change.kind === 'replaced') {
    add('Before', change.before, 'removed');
    add('After', change.after, 'added');
  } else if (change.kind === 'moved') {
    add(`Page ${change.left[0].page + 1} → ${change.right[0].page + 1}`, change.after, 'moved');
    const links = document.createElement('div');
    links.className = 'move-links';
    for (const side of [0, 1] as const) {
      const link = document.createElement('span');
      link.textContent = side ? 'Go to target ↗' : 'Go to source ↗';
      link.tabIndex = 0;
      link.setAttribute('role', 'button');
      const go = (e: Event) => {
        e.stopPropagation();
        selectChange(change.id, true, side);
      };
      link.onclick = go;
      link.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go(e);
        }
      };
      links.append(link);
    }
    card.append(links);
  } else add('', change.after || change.before, change.kind);
  card.onclick = () => selectChange(change.id);
  return card;
}
function renderList(keepScroll = false) {
  const list = $('changes-list'),
    top = list.scrollTop,
    items = filtered();
  listLimit = Math.max(60, items.findIndex((c) => c.id === selected) + 20);
  list.replaceChildren();
  for (const c of items.slice(0, listLimit)) list.append(makeCard(c));
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-changes';
    empty.textContent = result?.changes.length
      ? 'No changes in this category.'
      : $('notice').hidden
        ? 'No text differences found in the extractable text.'
        : 'No text differences found in the readable pages. See the warning above.';
    list.append(empty);
  }
  if (keepScroll) list.scrollTop = top;
  updateSelection();
}
$('changes-list').onscroll = () => {
  const list = $('changes-list'),
    items = filtered();
  if (list.scrollTop + list.clientHeight > list.scrollHeight - 400 && listLimit < items.length) {
    const next = items.slice(listLimit, listLimit + 60);
    listLimit += next.length;
    for (const c of next) list.append(makeCard(c));
  }
};
function updateSelection() {
  const items = filtered(),
    idx = items.findIndex((c) => c.id === selected);
  $('current-change').textContent = items.length
    ? `${idx < 0 ? '–' : idx + 1} of ${items.length}`
    : '0';
  for (const id of ['previous-change', 'next-change'])
    $<HTMLButtonElement>(id).disabled = !items.length;
  document.querySelectorAll<HTMLElement>('.change-card').forEach((c) => {
    c.classList.toggle('active', Number(c.dataset.id) === selected);
    c.setAttribute('aria-pressed', String(Number(c.dataset.id) === selected));
  });
  const kinds =
    filter === 'all' ? new Set(['added', 'removed', 'replaced', 'moved']) : new Set([filter]);
  readers?.forEach((r) => r.setMarks(selected, kinds));
}
function selectChange(id: number, locate = true, onlySide?: Side) {
  if (!result || !readers || !docs) return;
  const change = result.changes.find((c) => c.id === id);
  if (!change) return;
  selected = id;
  if (filter !== 'all' && filter !== change.kind) {
    filter = 'all';
    $<HTMLSelectElement>('filter').value = 'all';
    renderList();
  }
  if (!document.querySelector(`.change-card[data-id="${id}"]`)) renderList(true);
  else updateSelection();
  document.querySelector(`.change-card[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  if (!locate) return;
  if ((view === 'original' && !change.left.length) || (view === 'modified' && !change.right.length))
    setView(change.left.length ? 'original' : 'modified');
  if (onlySide !== undefined && view !== 'split') setView(onlySide ? 'modified' : 'original');
  requestAnimationFrame(() => {
    for (const side of [0, 1] as const) {
      if (onlySide !== undefined && side !== onlySide) continue;
      const ref = (side ? change.right : change.left)[0];
      if (ref) {
        readers![side].locate(ref.page, docs![side].pages[ref.page].items[ref.item].y);
        rememberScroll(side);
      }
    }
  });
}
function nextChange(delta: number) {
  const items = filtered();
  if (!items.length) return;
  const i = items.findIndex((c) => c.id === selected);
  selectChange(
    items[i < 0 ? (delta > 0 ? 0 : items.length - 1) : (i + delta + items.length) % items.length]
      .id,
  );
}
$('previous-change').onclick = () => nextChange(-1);
$('next-change').onclick = () => nextChange(1);
$<HTMLSelectElement>('filter').onchange = (e) => {
  filter = (e.target as HTMLSelectElement).value;
  selected = 0;
  renderList();
};
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input,select,textarea') || !result || !$('busy').hidden)
    return;
  if (e.key === 'j' || e.key === 'k') {
    e.preventDefault();
    nextChange(e.key === 'j' ? 1 : -1);
  }
});
$('export').onclick = async () => {
  if (!locations || !docs || !result) return;
  busy(true, 'Preparing comparison PDF', 'Measuring the remaining highlights…');
  try {
    await locations.ensureAll((p) =>
      busy(true, 'Preparing comparison PDF', 'Measuring highlights…', p * 40),
    );
    const input: ExportInput = {
      files: [docs[0].bytes, docs[1].bytes],
      pages: [docs[0].pages, docs[1].pages],
      comparison: result,
      geometry: locations.geometry,
      incomplete:
        locations.issues.size > 0 ||
        docs.some((doc) =>
          doc.pages.some(
            (page) =>
              !page.items.some((item) => item.str.trim()) ||
              page.items.some((item) => unmappedCharacters.test(item.str)),
          ),
        ),
    };
    const bytes = await compute<Uint8Array>('export', { input }, (p) =>
      busy(
        true,
        'Exporting comparison PDF',
        'Preserving original pages and difference markers…',
        40 + p * 0.6,
      ),
    );
    const url = URL.createObjectURL(
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = `${docs[0].name.replace(/\.pdf$/i, '')}-comparison.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    busy(false);
    toast('Comparison PDF exported.');
  } catch (e) {
    busy(false);
    toast(`Export failed: ${(e as Error).message}`);
  }
};

async function init() {
  try {
    const session = (await fetch(new URL('session.json', location.href)).then((r) => r.json())) as {
      files: { name: string; url: string }[];
    };
    if (session.files.length === 2) {
      for (const side of [0, 1] as const) {
        const f = session.files[side],
          bytes = await fetch(new URL(f.url, location.href)).then((r) => {
            if (!r.ok) throw new Error('Could not read input file.');
            return r.blob();
          });
        files[side] = new File([bytes], f.name, { type: 'application/pdf' });
      }
      refreshFiles();
      await run();
    }
  } catch (e) {
    toast((e as Error).message);
  }
}
if (import.meta.env.MODE !== 'web') void init();
