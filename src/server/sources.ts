import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, resolve, relative, sep } from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Revision, SourceHistory } from './source-model.js';
import { parseArxivInput } from '../shared/arxiv.js';
import { ArxivRateLimit } from '../shared/arxiv-rate-limit.js';

const exec = promisify(execFile);
const MAX_PDF = 100 * 1024 * 1024;
const MAX_HISTORY = 2500;
function assertPdf(bytes: Buffer) {
  if (bytes.length > MAX_PDF) throw new Error('PDFs larger than 100 MB are not supported here.');
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    if (bytes.toString('utf8', 0, 80).includes('git-lfs'))
      throw new Error(
        'This revision is a Git LFS pointer, not a stored PDF. Export the PDF from LFS first.',
      );
    throw new Error('This version does not contain a readable PDF file.');
  }
  return bytes;
}
function plain(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
      if (entity[0] === '#') {
        const n =
          entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
      }
      return (
        { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>
      )[entity.toLowerCase()];
    })
    .replace(/\s+/g, ' ')
    .trim();
}
export function parseArxiv(html: string, id: string) {
  const section =
    /<div\b[^>]*class=["'][^"']*submission-history[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(
      html,
    )?.[1];
  if (!section)
    throw new Error('Could not read the arXiv version history. Check the link and try again.');
  const revisions: Revision[] = [];
  for (const match of plain(section.replace(/<br\s*\/?\s*>/gi, '\n')).matchAll(
    /\[v(\d+)\]\s*([^[]+)/g,
  )) {
    const date =
      /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*\d{1,2}\s+\w+\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+UTC/.exec(
        match[2],
      )?.[0];
    revisions.push({
      id: `v${match[1]}`,
      label: `v${match[1]}`,
      date: date && !isNaN(Date.parse(date)) ? new Date(date).toISOString() : '',
      detail: '',
    });
  }
  if (!revisions.length) throw new Error('No published versions were found for this arXiv paper.');
  revisions.sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)));
  const title =
    /<meta\b[^>]*name=["']citation_title["'][^>]*content=(["'])([\s\S]*?)\1/i.exec(html)?.[2] ??
    /<h1\b[^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ??
    id;
  return { title: plain(title).replace(/^Title:\s*/, ''), revisions };
}
// Only fixed arXiv hosts are reachable, including on redirects. Never proxy a user-supplied URL.
async function arxivFetch(path: string, limit: number, rateLimit: ArxivRateLimit): Promise<Buffer> {
  let url = new URL(path, 'https://arxiv.org');
  const signal = AbortSignal.timeout(60000);
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': 'PDF-Diff-Discerner/0.1 (local PDF version comparison)' },
    });
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      await response.body?.cancel();
      url = new URL(response.headers.get('location')!, url);
      if (
        url.protocol !== 'https:' ||
        !['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname) ||
        url.port ||
        url.username ||
        url.password
      )
        throw new Error('arXiv redirected to an unsupported host.');
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) throw rateLimit.limited(response.headers.get('retry-after'));
      throw new Error(`arXiv could not provide this version (HTTP ${response.status}).`);
    }
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new Error('The arXiv response is too large.');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body!) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > limit) throw new Error('The arXiv response is too large.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Too many arXiv redirects.');
}
async function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024) {
  try {
    return (
      await exec(
        'git',
        ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-C', cwd, ...args],
        {
          encoding: 'buffer',
          maxBuffer,
          timeout: 20000,
          env: {
            ...process.env,
            GIT_OPTIONAL_LOCKS: '0',
            GIT_TERMINAL_PROMPT: '0',
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_NO_LAZY_FETCH: '1',
          },
        },
      )
    ).stdout;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('Git is not installed. Install Git to read PDF history.');
    throw new Error(
      'Could not read Git history. Choose a PDF tracked by a local repository with commits.',
    );
  }
}
export function parseGitLog(output: string) {
  const tokens = output.split('\0');
  const entries: (Revision & { blob: string })[] = [];
  let commit = '',
    date = '',
    detail = '';
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'commit') {
      commit = tokens[++i];
      date = tokens[++i];
      detail = tokens[++i];
    } else {
      const raw = /^:(\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])\d*$/.exec(tokens[i].trim());
      if (!raw) continue;
      i += raw[5] === 'R' || raw[5] === 'C' ? 2 : 1; // NUL-delimited paths, including renames.
      if (commit && /^100/.test(raw[2]) && !/^0+$/.test(raw[4]))
        entries.push({ id: commit, label: commit.slice(0, 7), date, detail, blob: raw[4] });
    }
  }
  return entries;
}
type StoredSource = { history: SourceHistory } & (
  | { kind: 'arxiv'; id: string }
  | { kind: 'git'; root: string; path: string; blobs: Map<string, string> }
);
export class Sources {
  private entries = new Map<string, StoredSource>();
  private picker?: Promise<string | null>;
  private rateLimit = new ArxivRateLimit();
  private arxivQueue: Promise<unknown> = Promise.resolve();
  constructor(private cwd = process.cwd()) {}
  private arxiv(path: string, limit: number) {
    const next = this.arxivQueue
      .catch(() => {})
      .then(async () => {
        this.rateLimit.check();
        const bytes = await arxivFetch(path, limit, this.rateLimit);
        this.rateLimit.reset();
        return bytes;
      });
    this.arxivQueue = next;
    return next;
  }
  private save(source: StoredSource) {
    if (this.entries.size >= 8) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(source.history.token, source);
    return source.history;
  }
  async arxivHistory(input: string): Promise<SourceHistory> {
    const { id } = parseArxivInput(input);
    const { title, revisions } = parseArxiv(
      (await this.arxiv(`/abs/${id}`, 2 * 1024 * 1024)).toString('utf8'),
      id,
    );
    return this.save({
      kind: 'arxiv',
      id,
      history: {
        token: randomBytes(16).toString('hex'),
        kind: 'arxiv',
        arxivId: id,
        title,
        subtitle: `arXiv:${id} · ${revisions.length} published versions`,
        revisions,
        original: revisions.length > 1 ? revisions.at(-1)!.id : '',
        modified: revisions[0].id,
      },
    });
  }
  async gitHistory(input: string): Promise<SourceHistory> {
    let path = input.trim().replace(/^(["'])(.*)\1$/, '$2');
    if (path.startsWith('file://')) path = fileURLToPath(path);
    if (path.startsWith('~/')) path = resolve(homedir(), path.slice(2));
    if (!/\.pdf$/i.test(path)) throw new Error('Please choose a PDF file.');
    path = await realpath(resolve(this.cwd, path)).catch(() => {
      throw new Error('PDF not found. Paste its full local path or use Choose PDF.');
    });
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_PDF)
      throw new Error('Choose a PDF file smaller than 100 MB.');
    const root = (await git(dirname(path), ['rev-parse', '--show-toplevel']))
      .toString('utf8')
      .trim();
    const name = relative(root, path).split(sep).join('/');
    await git(root, ['ls-files', '--error-unmatch', '--', name]);
    const log = await git(root, [
      'log',
      '--follow',
      `--max-count=${MAX_HISTORY + 1}`,
      '--format=%x00commit%x00%H%x00%cI%x00%s%x00',
      '--raw',
      '--no-abbrev',
      '--no-ext-diff',
      '--no-textconv',
      '-z',
      'HEAD',
      '--',
      name,
    ]);
    const entries = parseGitLog(log.toString('utf8'));
    if (!entries.length)
      throw new Error('This PDF has no committed versions on the current branch yet.');
    const historyEntries = entries.slice(0, MAX_HISTORY);
    const revisions: Revision[] = [
      {
        id: 'working',
        label: 'Current file',
        date: info.mtime.toISOString(),
        detail: 'On disk · includes uncommitted changes',
      },
      ...historyEntries.map(({ blob: _blob, ...revision }) => revision),
    ];
    return this.save({
      kind: 'git',
      root,
      path,
      blobs: new Map(historyEntries.map((e) => [e.id, e.blob])),
      history: {
        token: randomBytes(16).toString('hex'),
        kind: 'git',
        title: basename(path),
        subtitle: `${basename(root)} · ${historyEntries.length} commits on current branch`,
        path,
        revisions,
        original: entries[0].id,
        modified: 'working',
        truncated: entries.length > MAX_HISTORY,
      },
    });
  }
  async findDropped(name: string, size: number, sha256: string): Promise<SourceHistory> {
    if (
      basename(name) !== name ||
      !/\.pdf$/i.test(name) ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAX_PDF
    )
      throw new Error('Please drop a PDF smaller than 100 MB.');
    const fallback =
      'The browser hides the full file path. Use Choose PDF or paste the full path to locate this repository.';
    const root = (
      await git(this.cwd, ['rev-parse', '--show-toplevel']).catch(() => {
        throw new Error(fallback);
      })
    )
      .toString()
      .trim();
    const paths = (await git(root, ['ls-files', '-z']))
      .toString()
      .split('\0')
      .filter((p) => basename(p) === name);
    const matches: string[] = [];
    for (const p of paths.slice(0, 50)) {
      const full = resolve(root, p),
        info = await stat(full).catch(() => null);
      if (
        info?.isFile() &&
        info.size === size &&
        createHash('sha256')
          .update(await readFile(full))
          .digest('hex') === sha256
      )
        matches.push(full);
    }
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? 'Several identical PDFs were found. Paste the full path to choose the repository.'
          : fallback,
      );
    return this.gitHistory(matches[0]);
  }
  chooseFile(): Promise<string | null> {
    if (this.picker) return this.picker;
    this.picker = (async () => {
      try {
        const command: [string, string[]] =
          process.platform === 'darwin'
            ? [
                'osascript',
                [
                  '-e',
                  'POSIX path of (choose file with prompt "Choose a PDF" of type {"com.adobe.pdf"} default location (path to home folder))',
                ],
              ]
            : process.platform === 'win32'
              ? [
                  'powershell.exe',
                  [
                    '-NoProfile',
                    '-STA',
                    '-Command',
                    'Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.OpenFileDialog; $dialog.Title = "Choose a PDF"; $dialog.InitialDirectory = [Environment]::GetFolderPath("UserProfile"); $dialog.Filter = "PDF files (*.pdf)|*.pdf"; if ($dialog.ShowDialog() -eq "OK") { [Console]::Write($dialog.FileName) }',
                  ],
                ]
              : [
                  'zenity',
                  [
                    '--file-selection',
                    '--title=Choose a PDF',
                    `--filename=${homedir()}${sep}`,
                    '--file-filter=PDF files | *.pdf',
                  ],
                ];
        return (
          (await exec(...command, { timeout: 120000, maxBuffer: 16384 })).stdout.trim() || null
        );
      } catch (e) {
        const error = e as NodeJS.ErrnoException & { stderr?: string };
        if (error.code === 'ENOENT')
          throw Object.assign(
            new Error('The system file picker is unavailable. Paste the PDF’s full path instead.'),
            { code: 'PICKER_UNAVAILABLE' },
          );
        if (process.platform === 'darwin' && !error.stderr?.includes('(-128)'))
          throw new Error('Could not open the system picker. Paste the PDF’s full path instead.');
        return null;
      }
    })().finally(() => {
      this.picker = undefined;
    });
    return this.picker;
  }
  async pdf(token: string, revision: string): Promise<Buffer> {
    const source = this.entries.get(token);
    if (!source || !source.history.revisions.some((r) => r.id === revision))
      throw new Error('This version selection has expired. Load its history again.');
    if (source.kind === 'arxiv')
      throw new Error('arXiv PDFs are downloaded directly in the browser.');
    if (revision === 'working') {
      const info = await stat(source.path);
      if (!info.isFile() || info.size > MAX_PDF)
        throw new Error('The current PDF is unavailable or larger than 100 MB.');
      return assertPdf(await readFile(source.path));
    }
    return assertPdf(
      await git(source.root, ['cat-file', 'blob', source.blobs.get(revision)!], MAX_PDF),
    );
  }
}
