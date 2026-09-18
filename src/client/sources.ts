import type { SourceHistory } from '../server/source-model';
import {
  arxivPdfUrls,
  arxivVersionUrls,
  loadArxivPdfs,
  loadArxivVersions,
  type ArxivPair,
} from './arxiv-web';
import { ArxivRateLimit } from '../shared/arxiv-rate-limit';
import { RecentSources, type RecentKind } from './recent-sources';

type Mode = 'files' | 'arxiv' | 'git';
const WEB = import.meta.env.MODE === 'web';
const DEFAULT_ARXIV = 'https://arxiv.org/abs/1706.03762';
const sourceIcon = (path: string) =>
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
interface SourceState {
  input: string;
  history: SourceHistory | null;
  selected: [string, string];
  range: string;
  scroll: number;
  message: string;
  error: boolean;
  webPair: ArxivPair | null;
}
export interface VersionDownloadProgress {
  index: number;
  label: string;
  loaded: number;
  total?: number;
  complete: boolean;
  cached?: boolean;
}
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const date = (value: string, kind: SourceHistory['kind']) =>
  value
    ? new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: kind === 'arxiv' ? 'UTC' : undefined,
        timeZoneName: 'short',
      }).format(new Date(value))
    : '';
export class SourcePicker {
  private mode: Mode = 'files';
  private history: SourceHistory | null = null;
  private selected: [string, string] = ['', ''];
  private loading = false;
  private generation = 0;
  private saved = new Map<Mode, SourceState>();
  private webPair: ArxivPair | null = null;
  private download?: AbortController;
  private downloaded = new Map<string, File>();
  private rateLimit = new ArxivRateLimit();
  private recent = new RecentSources(WEB ? 'web' : 'local');
  constructor(
    private root: HTMLElement,
    private changed: () => void,
  ) {
    root.innerHTML = `
      <div class="source-tabs segmented" role="group" aria-label="PDF source">
        <button data-source="files" aria-pressed="true">Local files</button>
        <button data-source="arxiv" aria-pressed="false">arXiv</button>
        ${WEB ? '' : '<button data-source="git" aria-pressed="false">Git history</button>'}
      </div>
      <section class="source-panel" id="version-source" hidden>
        <form id="source-form">
          <label for="source-input" id="source-label">arXiv link or ID</label>
          <div class="source-input-row"><input id="source-input" type="text" autocomplete="off" spellcheck="false" placeholder="${DEFAULT_ARXIV}"/>
            <button type="button" id="recent-toggle" class="source-icon-button" title="Recent links" aria-label="Recent links" aria-haspopup="dialog" aria-expanded="false" aria-controls="recent-sources">${sourceIcon('<path d="M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7M12 7v5l3 2"/>')}</button>
            <button type="button" id="git-pick" class="source-icon-button" title="Choose PDF" aria-label="Choose PDF" hidden>${sourceIcon('<path d="M3 8V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v2M3 20h16l3-9H6l-3 9-1-9"/>')}</button>
            <button id="load-history" type="submit">${WEB ? 'Load PDFs' : 'Find versions'} <span aria-hidden="true">→</span></button>
            <div id="recent-sources" class="recent-popover" role="dialog" aria-label="Recent links" hidden></div>
          </div>
        </form>
        <p class="source-hint" id="source-hint"></p>
        <p class="source-status" id="source-status" role="status" aria-live="polite"></p>
        <progress class="source-progress" id="source-progress" aria-labelledby="source-status" hidden></progress>
        <div id="version-choices" hidden></div>
        <p id="web-downloads" class="source-hint" hidden></p>
      </section>`;
    root.querySelectorAll<HTMLButtonElement>('[data-source]').forEach((button) => {
      button.onclick = () => this.setMode(button.dataset.source as Mode);
    });
    this.el<HTMLFormElement>('source-form').onsubmit = (e) => {
      e.preventDefault();
      this.closeRecent();
      if (this.mode === 'arxiv' && !this.input.value.trim()) this.input.value = DEFAULT_ARXIV;
      if (WEB) {
        void this.loadWeb();
        return;
      }
      void this.load(
        this.mode === 'arxiv' ? 'arxiv' : 'git',
        this.mode === 'arxiv' ? { url: this.input.value } : { path: this.input.value },
      );
    };
    this.input.oninput = () => this.invalidateInput();
    this.el('recent-toggle').onclick = () => {
      if (!this.el('recent-sources').hidden) return this.closeRecent(true);
      this.renderRecent();
      this.el('recent-sources').hidden = false;
      this.el('recent-toggle').setAttribute('aria-expanded', 'true');
      this.el('recent-sources').querySelector<HTMLButtonElement>('[data-recent-select]')?.focus();
    };
    document.addEventListener('pointerdown', (e) => {
      if (
        !this.el('recent-sources').contains(e.target as Node) &&
        !this.el('recent-toggle').contains(e.target as Node)
      )
        this.closeRecent();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el('recent-sources').hidden) {
        e.preventDefault();
        this.closeRecent(true);
      }
    });
    this.el('recent-sources').addEventListener('focusout', (e) => {
      if (
        e.relatedTarget &&
        !this.el('recent-sources').contains(e.relatedTarget as Node) &&
        e.relatedTarget !== this.el('recent-toggle')
      )
        this.closeRecent();
    });
    this.el('recent-sources').onkeydown = (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const buttons = [...this.root.querySelectorAll<HTMLButtonElement>('[data-recent-select]')];
      if (!buttons.length) return;
      e.preventDefault();
      const index = buttons.findIndex((button) => button.parentElement!.contains(e.target as Node));
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? buttons.length - 1
            : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    this.el('git-pick').onclick = () => {
      this.closeRecent();
      void this.load('git/pick', {});
    };
    const panel = this.el('version-source');
    panel.ondragover = (e) => {
      if (this.mode === 'git') {
        e.preventDefault();
        panel.classList.add('dragging');
      }
    };
    panel.ondragleave = (e) => {
      if (!panel.contains(e.relatedTarget as Node)) panel.classList.remove('dragging');
    };
    panel.ondrop = (e) => {
      e.preventDefault();
      panel.classList.remove('dragging');
      if (this.mode !== 'git') return;
      const file = e.dataTransfer?.files[0];
      if (file) void this.drop(file);
      else {
        const path =
          e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
        if (path) {
          this.input.value = path.trim();
          void this.load('git', { path: path.trim() });
        }
      }
    };
  }
  get local() {
    return this.mode === 'files';
  }
  get ready() {
    if (WEB) return !this.loading && !!this.webPair;
    return (
      !this.loading &&
      !!this.history &&
      !!this.selected[0] &&
      !!this.selected[1] &&
      this.selected[0] !== this.selected[1]
    );
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) {
    return this.root.querySelector<T>(`#${id}`)!;
  }
  private get input() {
    return this.el<HTMLInputElement>('source-input');
  }
  private invalidateInput() {
    this.generation++;
    this.download?.abort();
    this.webPair = null;
    this.history = null;
    this.selected = ['', ''];
    this.loading = false;
    this.el('version-choices').hidden = true;
    this.el('web-downloads').hidden = true;
    this.status('');
    this.controls();
  }
  private closeRecent(focus = false) {
    this.el('recent-sources').hidden = true;
    this.el('recent-toggle').setAttribute('aria-expanded', 'false');
    if (focus) this.el('recent-toggle').focus();
  }
  private renderRecent() {
    const kind = this.mode as RecentKind;
    const entries = this.recent.list(kind);
    const label = kind === 'arxiv' ? 'Recent links' : 'Recent paths';
    const popup = this.el('recent-sources');
    popup.setAttribute('aria-label', label);
    popup.innerHTML = `<div class="recent-heading"><strong>${label}</strong><button type="button" id="recent-clear" ${entries.length ? '' : 'hidden'}>Clear all</button></div>
      ${entries.length ? `<ul>${entries.map((entry, i) => `<li><button type="button" class="recent-select" data-recent-select="${i}" title="${escape(entry.value)}"><strong>${escape(entry.name || (kind === 'git' ? entry.value.split(/[\\/]/).at(-1)! : entry.value))}</strong>${entry.name || kind === 'git' ? `<small>${escape(entry.value)}</small>` : ''}</button><button type="button" class="recent-remove" data-recent-remove="${i}" title="Remove from history" aria-label="Remove ${escape(entry.value)} from history">${sourceIcon('<path d="m7 7 10 10M7 17 17 7"/>')}</button></li>`).join('')}</ul>` : `<p class="recent-empty">No recent ${kind === 'arxiv' ? 'links' : 'paths'} yet.</p>`}`;
    popup.querySelectorAll<HTMLButtonElement>('[data-recent-select]').forEach((button) => {
      button.onclick = () => {
        this.input.value = entries[Number(button.dataset.recentSelect)].value;
        this.invalidateInput();
        this.closeRecent();
        this.input.focus();
      };
    });
    popup.querySelectorAll<HTMLButtonElement>('[data-recent-remove]').forEach((button) => {
      button.onclick = () => {
        const index = Number(button.dataset.recentRemove);
        this.recent.remove(kind, entries[index].value);
        this.renderRecent();
        const remaining = popup.querySelectorAll<HTMLButtonElement>('[data-recent-remove]');
        (remaining[Math.min(index, remaining.length - 1)] ?? this.el('recent-toggle')).focus();
      };
    });
    this.el('recent-clear').onclick = () => {
      this.recent.clear(kind);
      this.renderRecent();
      this.el('recent-toggle').focus();
    };
  }
  private status(text: string, error = false, progress = false) {
    this.el('source-status').textContent = text;
    this.el('source-status').classList.toggle('error', error);
    this.el('source-progress').hidden = !progress;
  }
  private controls() {
    this.el<HTMLButtonElement>('load-history').disabled = this.loading;
    this.el<HTMLButtonElement>('git-pick').disabled = this.loading;
    this.changed();
  }
  private setMode(mode: Mode) {
    if (WEB && mode === 'git') return;
    if (this.mode === mode) return;
    this.closeRecent();
    this.saved.set(this.mode, {
      input: this.input.value,
      history: this.history,
      selected: [...this.selected],
      range: this.el<HTMLSelectElement>('history-range')?.value ?? '20',
      scroll: this.el('revision-timeline')?.scrollTop ?? 0,
      message: this.loading ? '' : (this.el('source-status').textContent ?? ''),
      error: !this.loading && this.el('source-status').classList.contains('error'),
      webPair: this.webPair,
    });
    this.download?.abort();
    this.mode = mode;
    const saved = this.saved.get(mode);
    this.history = saved?.history ?? null;
    this.webPair = saved?.webPair ?? null;
    this.selected = saved ? [...saved.selected] : ['', ''];
    this.loading = false;
    this.generation++;
    this.root
      .querySelectorAll<HTMLButtonElement>('[data-source]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.source === mode)));
    this.el('version-source').hidden = this.local;
    this.el('version-choices').hidden = true;
    this.el('web-downloads').hidden = true;
    this.el('git-pick').hidden = mode !== 'git';
    for (const attr of ['title', 'aria-label'])
      this.el('recent-toggle').setAttribute(attr, mode === 'git' ? 'Recent paths' : 'Recent links');
    this.el('source-label').textContent =
      mode === 'arxiv' ? 'arXiv link or ID' : 'PDF in a local Git repository';
    this.el('source-hint').textContent =
      mode === 'arxiv'
        ? WEB
          ? 'Compare a specified version (or v1) with Latest. PDFs download directly from arXiv to your browser.'
          : 'Choose two published versions. PDFs download directly from arXiv to your browser.'
        : 'Choose a PDF, paste its path, or drop a PDF from the project where you started this app.';
    this.input.value = saved?.input ?? '';
    this.input.required = mode === 'git';
    this.input.placeholder = mode === 'arxiv' ? DEFAULT_ARXIV : '/path/to/your/paper.pdf';
    if (this.history) {
      this.render();
      this.el<HTMLSelectElement>('history-range').value = saved?.range ?? '20';
      this.timeline();
      this.el('revision-timeline').scrollTop = saved?.scroll ?? 0;
    }
    if (WEB && mode === 'arxiv') {
      if (this.webPair) this.renderWeb();
      this.webDownloads();
    }
    if (!WEB && mode === 'arxiv' && saved?.error && this.history) this.webDownloads();
    this.status(saved?.message ?? '', saved?.error ?? false);
    this.controls();
    if (!this.local) this.input.focus();
  }
  private async request<T>(endpoint: string, body: unknown, signal: AbortSignal): Promise<T> {
    if (WEB) throw new Error('Local sources are unavailable in the web edition.');
    const response = await fetch(new URL(`api/${endpoint}`, location.href), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load these versions.');
    return data as T;
  }
  private webDownloads() {
    const target = this.el('web-downloads');
    target.hidden = true;
    try {
      const source = WEB
        ? arxivVersionUrls(this.input.value, [arxivPdfUrls(this.input.value).version, undefined])
        : arxivVersionUrls(
            this.history!.arxivId!,
            this.selected.map((id) => Number(id.slice(1))) as [number, number],
          );
      target.innerHTML = `Or download <a href="${source.urls[0]}" target="_blank" rel="noreferrer">${source.labels[0]}</a> and <a href="${source.urls[1]}" target="_blank" rel="noreferrer">${source.labels[1]}</a> manually, then drag them into Local files.`;
      target.hidden = false;
    } catch {
      /* Invalid drafts do not have download links. */
    }
  }
  private renderWeb() {
    const pair = this.webPair!;
    const target = this.el('version-choices');
    target.innerHTML = `<div class="revision-pair web-pdf-summary">${pair.files.map((file, side) => `<div><span class="revision-side"><i class="side-dot ${side ? 'green' : 'red'}"></i>${side ? 'Modified · Latest' : `Original · v${pair.version}`}</span><strong>${escape(file.name)}</strong><small>${(file.size / 1024 / 1024).toFixed(2)} MB · Ready to compare</small></div>`).join('')}</div>`;
    target.hidden = false;
  }
  private async loadWeb() {
    if (this.loading) return;
    const generation = ++this.generation;
    this.download?.abort();
    const controller = (this.download = new AbortController());
    this.webPair = null;
    this.loading = true;
    this.el('version-choices').hidden = true;
    this.webDownloads();
    this.status('Downloading two PDFs from arXiv…', false, true);
    this.controls();
    try {
      const pair = await loadArxivPdfs(this.input.value, {
        signal: controller.signal,
        rateLimit: this.rateLimit,
      });
      if (generation !== this.generation) return;
      this.webPair = pair;
      this.recent.add('arxiv', this.input.value);
      this.renderWeb();
      this.status('Both PDFs are ready.');
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted)
        this.status((error as Error).message, true);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.controls();
      }
    }
  }
  private async load(endpoint: string, body: unknown) {
    const generation = ++this.generation;
    this.download?.abort();
    const controller = (this.download = new AbortController());
    const input = this.input.value;
    this.loading = true;
    this.el('web-downloads').hidden = true;
    if (endpoint !== 'git/pick') {
      this.history = null;
      this.selected = ['', ''];
      this.el('version-choices').hidden = true;
    }
    this.status(
      endpoint === 'git/pick'
        ? 'Choose a PDF in the system file picker…'
        : 'Loading version history…',
      false,
      endpoint !== 'git/pick',
    );
    this.controls();
    try {
      const history = await this.request<SourceHistory | null>(endpoint, body, controller.signal);
      if (generation !== this.generation) return;
      if (!history) {
        this.status('');
        return;
      }
      this.history = history;
      if (history.path) this.input.value = history.path;
      if (history.kind === 'arxiv') this.recent.add('arxiv', input, history.title);
      else if (history.path) this.recent.add('git', history.path, history.title);
      this.selected = [history.original, history.modified];
      this.render();
      this.status(
        history.revisions.length < 2
          ? 'This paper has only one published version. Choose a paper with at least two versions.'
          : '',
        history.revisions.length < 2,
      );
    } catch (e) {
      if (generation === this.generation) this.status((e as Error).message, true);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.controls();
      }
    }
  }
  private async drop(file: File) {
    this.closeRecent();
    this.download?.abort();
    if (!/\.pdf$/i.test(file.name) || file.size > 100 * 1024 * 1024) {
      this.status('Please drop a PDF smaller than 100 MB.', true);
      return;
    }
    const generation = ++this.generation;
    this.history = null;
    this.loading = true;
    this.el('version-choices').hidden = true;
    this.status('Locating this PDF in the current project…');
    this.controls();
    try {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      if (generation !== this.generation) return;
      await this.load('git/drop', {
        name: file.name,
        size: file.size,
        sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      });
    } catch (e) {
      if (generation === this.generation) {
        this.loading = false;
        this.status((e as Error).message, true);
        this.controls();
      }
    }
  }
  private render() {
    const history = this.history!;
    const target = this.el('version-choices');
    target.hidden = false;
    target.innerHTML = `<div class="history-title"><strong>${escape(history.title)}</strong><span>${escape(history.subtitle)}</span></div>
      <div class="revision-pair">${([0, 1] as const).map((side) => `<label><span class="revision-side"><i class="side-dot ${side ? 'green' : 'red'}"></i>${side ? 'Modified' : 'Original'}</span><select id="revision-${side}" aria-label="${side ? 'Modified' : 'Original'} version">${history.revisions.map((r, index) => `<option value="${r.id}">${escape(r.label)}${!index && history.kind === 'arxiv' ? ' · Latest' : ''}${r.date ? ' · ' + escape(date(r.date, history.kind)) : ''}</option>`).join('')}</select></label>`).join('')}</div>
      <div class="timeline-columns"><div class="timeline-label"><span>Timeline</span><select id="history-range" aria-label="History range" ${history.revisions.length <= 20 ? 'hidden' : ''}><option value="20">Recent 20</option><option value="100">Recent 100</option><option value="all">All history</option></select></div><span>Original</span><span>Modified</span></div><div id="revision-timeline" class="revision-timeline" role="group" aria-label="${history.kind === 'git' ? 'Git' : 'arXiv'} revision timeline"></div><p id="timeline-count" class="source-hint"></p>`;
    for (const side of [0, 1] as const) {
      const select = this.el<HTMLSelectElement>(`revision-${side}`);
      select.value = this.selected[side];
      select.onchange = () => this.select(side, select.value);
    }
    this.el<HTMLSelectElement>('history-range').onchange = () => this.timeline();
    this.timeline();
  }
  private select(side: 0 | 1, id: string) {
    const previous = this.selected[side];
    if (this.selected[1 - side] === id) this.selected[1 - side] = previous;
    this.selected[side] = id;
    for (const s of [0, 1] as const)
      this.el<HTMLSelectElement>(`revision-${s}`).value = this.selected[s];
    this.timeline();
    if (!this.el('web-downloads').hidden) this.webDownloads();
    this.changed();
  }
  private timeline() {
    const history = this.history!;
    const range = this.el<HTMLSelectElement>('history-range').value;
    const working = history.kind === 'git' ? 1 : 0;
    const count = range === 'all' ? history.revisions.length : Number(range) + working;
    const visible = new Set(history.revisions.slice(0, count).map((r) => r.id));
    this.selected.forEach((id) => visible.add(id));
    const revisions = history.revisions.filter((r) => visible.has(r.id));
    this.el('revision-timeline').innerHTML = revisions
      .map(
        (r) =>
          `<div class="timeline-row"><div class="timeline-description"><strong>${escape(history.kind === 'arxiv' ? r.label + (r === history.revisions[0] ? ' · Latest' : '') : r.id === 'working' ? 'Current file' : r.detail || 'Untitled commit')}</strong><small>${escape(date(r.date, history.kind))}${history.kind === 'arxiv' ? '' : r.id !== 'working' ? ' · ' + r.label : ' · On disk'}</small></div>${([0, 1] as const).map((side) => `<label class="timeline-radio" title="${side ? 'Modified' : 'Original'}: ${escape(r.label)}"><input type="radio" class="timeline-choice" name="timeline-${side}" data-side="${side}" value="${r.id}" aria-label="${side ? 'Modified' : 'Original'} ${escape(r.label)}" ${this.selected[side] === r.id ? 'checked' : ''}/></label>`).join('')}</div>`,
      )
      .join('');
    this.root.querySelectorAll<HTMLInputElement>('.timeline-choice').forEach((input) => {
      input.onchange = () => this.select(Number(input.dataset.side) as 0 | 1, input.value);
    });
    this.el('timeline-count').textContent =
      `${revisions.length - working} of ${history.revisions.length - working} ${history.kind === 'git' ? 'commits · Current file included' : 'published versions'}${history.truncated ? ' · Limited to the latest 2,500 commits' : ''}`;
  }
  async files(onProgress?: (progress: VersionDownloadProgress) => void): Promise<[File, File]> {
    if (!this.ready) throw new Error('Choose two different versions first.');
    if (WEB) return this.webPair!.files;
    const history = this.history!;
    if (history.kind === 'arxiv') {
      if (!history.arxivId) throw new Error('Please load the arXiv version history again.');
      const versions = this.selected.map((id) => Number(id.slice(1))) as [number, number];
      const { urls, labels } = arxivVersionUrls(history.arxivId, versions);
      const cached = urls.map((url) => {
        const file = this.downloaded.get(url);
        if (file) {
          this.downloaded.delete(url);
          this.downloaded.set(url, file);
        }
        return file;
      }) as [File | undefined, File | undefined];
      const controller = (this.download = new AbortController());
      this.status('');
      try {
        const files = await loadArxivVersions(history.arxivId, versions, {
          signal: controller.signal,
          rateLimit: this.rateLimit,
          cached,
          onProgress: (index, progress) =>
            onProgress?.({ ...progress, index, label: labels[index] }),
          onFile: (index, file) => {
            this.downloaded.set(urls[index], file);
            while (
              this.downloaded.size > 4 ||
              [...this.downloaded.values()].reduce((sum, f) => sum + f.size, 0) > 200 * 1024 * 1024
            )
              this.downloaded.delete(this.downloaded.keys().next().value!);
          },
        });
        return files.map(
          (file, index) =>
            new File(
              [file],
              `${history.title.replace(/\.pdf$/i, '').replace(/[/\\:*?"<>|]/g, '_')} (${labels[index]}).pdf`,
              { type: 'application/pdf' },
            ),
        ) as [File, File];
      } catch (error) {
        this.status((error as Error).message, true);
        this.webDownloads();
        throw error;
      }
    }
    const files: File[] = [];
    for (const id of this.selected) {
      const label = history.revisions.find((r) => r.id === id)!.label;
      const progress: VersionDownloadProgress = {
        index: files.length,
        label,
        loaded: 0,
        complete: false,
      };
      onProgress?.(progress);
      const response = await fetch(new URL(`api/pdf/${history.token}/${id}`, location.href));
      if (!response.ok)
        throw new Error((await response.json()).error || 'Could not read this PDF version.');
      if (!response.body) throw new Error('This PDF version returned an empty response.');
      const total = Number(response.headers.get('content-length'));
      if (Number.isSafeInteger(total) && total > 0) progress.total = total;
      const reader = response.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          progress.loaded += value.length;
          onProgress?.(progress);
        }
      } catch {
        await reader.cancel().catch(() => {});
        throw new Error('The PDF download was interrupted. Please try again.');
      } finally {
        reader.releaseLock();
      }
      progress.complete = true;
      onProgress?.(progress);
      const name = `${history.title.replace(/\.pdf$/i, '').replace(/[/\\:*?"<>|]/g, '_')} (${label}).pdf`;
      const file = new File(chunks, name, { type: 'application/pdf' });
      files.push(file);
    }
    return files as [File, File];
  }
}
