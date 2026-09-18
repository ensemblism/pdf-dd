import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseArxivInput } from '../src/shared/arxiv';
import { ArxivRateLimit } from '../src/shared/arxiv-rate-limit';
import {
  arxivPdfUrls,
  loadArxivPdfs,
  loadArxivVersions,
  type PdfDownloadProgress,
} from '../src/client/arxiv-web';

afterEach(() => vi.restoreAllMocks());
const pdf = () =>
  new Response('%PDF-1.7\nfixture', { headers: { 'Content-Type': 'application/pdf' } });

describe('shared arXiv input', () => {
  test.each([
    ['1706.03762', '1706.03762', undefined],
    ['https://arxiv.org/abs/1706.03762', '1706.03762', undefined],
    ['1706.03762v6', '1706.03762', 6],
    ['https://arxiv.org/pdf/1706.03762v6', '1706.03762', 6],
    ['https://arxiv.org/pdf/1706.03762v6.pdf?download=1', '1706.03762', 6],
    [' arXiv:hep-th/9901001v2 ', 'hep-th/9901001', 2],
    ['https://export.arxiv.org/abs/math.GT/0309136v1', 'math.GT/0309136', 1],
  ])('parses %s', (input, id, version) => {
    expect(parseArxivInput(input)).toEqual(version ? { id, version } : { id });
    expect(arxivPdfUrls(input).urls).toEqual([
      `https://arxiv.org/pdf/${id}v${version ?? 1}`,
      `https://arxiv.org/pdf/${id}`,
    ]);
  });
  test.each([
    '1706.03762v0',
    '1706.03762v-1',
    '1706.03762v1.5',
    '1706.03762v9007199254740992',
    'https://evil.test/abs/1706.03762',
    'https://arxiv.org/help/1706.03762',
    'file:///tmp/paper.pdf',
    '',
  ])('rejects %s without network requests', async (input) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(loadArxivPdfs(input)).rejects.toThrow('valid arXiv');
    expect(fetch).not.toHaveBeenCalled();
  });
});

test('downloads exactly the specified version and latest, accepting identical PDFs', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => pdf());
  const pair = await loadArxivPdfs('hep-th/9901001v2');
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(pair.urls);
  expect(pair.files.map((f) => f.name)).toEqual([
    'hep-th_9901001 (v2).pdf',
    'hep-th_9901001 (Latest).pdf',
  ]);
  expect(await pair.files[0].text()).toEqual(await pair.files[1].text());
  expect(fetch.mock.calls[0][1]).toMatchObject({
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
});

test('downloads exact timeline selections concurrently and preserves their order', async () => {
  const pending: Array<(response: Response) => void> = [];
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  const onFile = vi.fn();
  const loading = loadArxivVersions('1706.03762', [6, 3], { onFile });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://arxiv.org/pdf/1706.03762v6',
    'https://arxiv.org/pdf/1706.03762v3',
  ]);
  pending[1](pdf());
  await vi.waitFor(() => expect(onFile).toHaveBeenCalledWith(1, expect.any(File)));
  pending[0](pdf());
  expect((await loading).map((file) => file.name)).toEqual([
    '1706.03762 (v6).pdf',
    '1706.03762 (v3).pdf',
  ]);
});

test('reports streamed bytes and reuses a successful file after the other request is rate limited', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const rateLimit = new ArxivRateLimit();
  const cache: [File | undefined, File | undefined] = [undefined, undefined];
  const progress: Array<[number, PdfDownloadProgress]> = [];
  let rejectSecond!: (response: Response) => void;
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('%PDF-'));
            controller.enqueue(new TextEncoder().encode('1.7'));
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'application/pdf', 'Content-Length': '8' } },
      ),
    )
    .mockImplementationOnce(() => new Promise((resolve) => (rejectSecond = resolve)));
  const loading = loadArxivVersions('1706.03762', [1, 2], {
    rateLimit,
    onFile: (index, file) => (cache[index] = file),
    onProgress: (index, update) => progress.push([index, update]),
  });
  const rejected = expect(loading).rejects.toMatchObject({ retryAfter: 30 });
  await vi.waitFor(() => expect(cache[0]).toBeInstanceOf(File));
  expect(progress).toContainEqual([0, { loaded: 5, total: 8, complete: false }]);
  expect(progress).toContainEqual([0, { loaded: 8, total: 8, complete: true }]);
  rejectSecond(new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
  await rejected;
  await expect(
    loadArxivVersions('1706.03762', [1, 2], { cached: cache, rateLimit }),
  ).rejects.toMatchObject({ retryAfter: 30 });
  expect(fetch).toHaveBeenCalledTimes(2);
  // Fully cached comparisons remain usable during the cooldown.
  const ready = [cache[0]!, cache[0]!] as [File, File];
  expect(await loadArxivVersions('1706.03762', [1, 1], { cached: ready, rateLimit })).toEqual(
    ready,
  );
  now += 31000;
  fetch.mockResolvedValueOnce(pdf());
  const retry = await loadArxivVersions('1706.03762', [1, 2], { cached: cache, rateLimit });
  expect(retry[0]).toBe(cache[0]);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch.mock.calls[2][0]).toBe('https://arxiv.org/pdf/1706.03762v2');
});

test.each([
  [() => new Response('missing', { status: 404 }), /version was not found/],
  [() => new Response('busy', { status: 429 }), /rate limiting/],
  [
    () => new Response('<html>error</html>', { headers: { 'Content-Type': 'application/pdf' } }),
    /does not contain a PDF/,
  ],
  [() => new Response('%PDF-1.7', { headers: { 'Content-Type': 'text/html' } }), /non-PDF/],
  [() => new Response(null), /empty response/],
  [() => new Response('%PDF-1.7', { headers: { 'Content-Length': '1000' } }), /size limit/],
  [
    () =>
      new Response('%PDF-1.7' + 'x'.repeat(100), {
        headers: { 'Content-Type': 'application/pdf' },
      }),
    /size limit/,
  ],
])('validates the response and stops the other request', async (response, error) => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response());
  await expect(loadArxivPdfs('1706.03762', { maxBytes: 32 })).rejects.toThrow(error);
  expect((fetch.mock.calls[1][1]!.signal as AbortSignal).aborted).toBe(true);
});

test('reports network/CORS errors with the manual file fallback', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(loadArxivPdfs('1706.03762')).rejects.toThrow('Local files');
});

test('times out and aborts both downloads', async () => {
  const signals: AbortSignal[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        const signal = options!.signal!;
        signals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  await expect(loadArxivPdfs('1706.03762', { timeoutMs: 10 })).rejects.toThrow('timed out');
  expect(signals).toHaveLength(2);
  expect(signals.every((s) => s.aborted)).toBe(true);
});

test('caller cancellation propagates, including cancellation before a request starts', async () => {
  const controller = new AbortController();
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), {
          once: true,
        });
      }),
  );
  const loading = loadArxivPdfs('1706.03762', { signal: controller.signal });
  controller.abort();
  await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  fetch.mockClear();
  await expect(loadArxivPdfs('1706.03762', { signal: controller.signal })).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(fetch).not.toHaveBeenCalled();
});
