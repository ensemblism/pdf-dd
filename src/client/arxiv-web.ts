import { parseArxivInput } from '../shared/arxiv';
import { ArxivRateLimit } from '../shared/arxiv-rate-limit';

export const MAX_ARXIV_PDF_BYTES = 100 * 1024 * 1024;
const MANUAL = 'Try again, or download both PDFs manually and use Local files.';
export interface ArxivPair {
  id: string;
  version: number;
  files: [File, File];
  urls: [string, string];
}
export interface PdfDownloadProgress {
  loaded: number;
  total?: number;
  complete: boolean;
  cached?: boolean;
}
export interface ArxivDownloadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  rateLimit?: ArxivRateLimit;
  cached?: [File | undefined, File | undefined];
  onProgress?: (index: number, progress: PdfDownloadProgress) => void;
  onFile?: (index: number, file: File) => void;
}

/** undefined means Latest; explicit versions always use their exact version URL. */
export function arxivVersionUrls(
  input: string,
  versions: [number | undefined, number | undefined],
) {
  const { id } = parseArxivInput(input);
  versions.forEach((version) => {
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1))
      throw new Error('Please choose a valid arXiv version.');
  });
  const labels = versions.map((version) => (version === undefined ? 'Latest' : `v${version}`));
  const urls = versions.map(
    (version) => `https://arxiv.org/pdf/${id}${version === undefined ? '' : `v${version}`}`,
  ) as [string, string];
  return { id, labels, urls };
}
export function arxivPdfUrls(input: string) {
  const { version = 1 } = parseArxivInput(input);
  const { id, urls } = arxivVersionUrls(input, [version, undefined]);
  return { id, version, urls };
}

async function download(
  url: string,
  name: string,
  label: string,
  signal: AbortSignal,
  options: ArxivDownloadOptions,
  index: number,
) {
  const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  const reject = async (message: string): Promise<never> => {
    await response.body?.cancel();
    throw new Error(`${label}: ${message} ${MANUAL}`);
  };
  if (response.status === 429) {
    await response.body?.cancel();
    throw options.rateLimit!.limited(response.headers.get('retry-after'));
  }
  if (!response.ok)
    return reject(
      response.status === 404
        ? 'this paper or version was not found (HTTP 404).'
        : `arXiv returned HTTP ${response.status}.`,
    );
  const limit = options.maxBytes ?? MAX_ARXIV_PDF_BYTES;
  const length = Number(response.headers.get('content-length'));
  if (length > limit) return reject('the PDF exceeds the 100 MB size limit.');
  if (/^(text\/|application\/json)/i.test(response.headers.get('content-type') ?? ''))
    return reject('arXiv returned a non-PDF response.');
  if (!response.body) return reject('arXiv returned an empty response.');
  const encoding = response.headers.get('content-encoding');
  const total =
    Number.isSafeInteger(length) && length > 0 && (!encoding || encoding === 'identity')
      ? length
      : undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;
  options.onProgress?.(index, { loaded, total, complete: false });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.length;
      if (loaded > limit)
        throw new Error(`${label}: the PDF exceeds the 100 MB size limit. ${MANUAL}`);
      chunks.push(value);
      options.onProgress?.(index, { loaded, total, complete: false });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const file = new File(chunks, name, { type: 'application/pdf' });
  if (!(await file.slice(0, 1024).text()).includes('%PDF-'))
    throw new Error(`${label}: the response does not contain a PDF. ${MANUAL}`);
  signal.throwIfAborted();
  options.onFile?.(index, file);
  options.onProgress?.(index, { loaded, total: loaded, complete: true });
  return file;
}

/** Shared browser download path for both editions: parallel, bounded, cancellable reads. */
export async function loadArxivVersions(
  input: string,
  versions: [number | undefined, number | undefined],
  options: ArxivDownloadOptions = {},
): Promise<[File, File]> {
  const source = arxivVersionUrls(input, versions);
  const rateLimit = options.rateLimit ?? new ArxivRateLimit();
  const needsDownload = !options.cached?.every(Boolean);
  if (needsDownload) rateLimit.check();
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  signal.throwIfAborted();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Download timed out', 'TimeoutError')),
    options.timeoutMs ?? 60000,
  );
  const jobs = source.urls.map(async (url, index) => {
    const cached = options.cached?.[index];
    if (cached) {
      options.onProgress?.(index, {
        loaded: cached.size,
        total: cached.size,
        complete: true,
        cached: true,
      });
      return cached;
    }
    options.onProgress?.(index, { loaded: 0, complete: false });
    return download(
      url,
      `${source.id.replace('/', '_')} (${source.labels[index]}).pdf`,
      source.labels[index],
      signal,
      { ...options, rateLimit },
      index,
    );
  });
  try {
    const files = (await Promise.all(jobs)) as [File, File];
    if (needsDownload) rateLimit.reset();
    return files;
  } catch (error) {
    const reason = signal.reason;
    controller.abort();
    await Promise.allSettled(jobs); // Finish cancellation before a retry can start.
    if (reason?.name === 'TimeoutError') throw new Error(`arXiv download timed out. ${MANUAL}`);
    if (reason) throw reason;
    if (error instanceof TypeError)
      throw new Error(
        `Could not download from arXiv. Check your connection; arXiv may also be blocking browser access. ${MANUAL}`,
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Web edition: version in the input (or v1) versus Latest, without any metadata requests. */
export async function loadArxivPdfs(
  input: string,
  options: ArxivDownloadOptions = {},
): Promise<ArxivPair> {
  const source = arxivPdfUrls(input);
  const files = await loadArxivVersions(source.id, [source.version, undefined], options);
  return { ...source, files };
}
