import { test, expect, type Page, type Route } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pdf } from './helpers';

const history = `<meta name="citation_title" content="Download fixture"><div class="submission-history">${Array.from(
  { length: 7 },
  (_, index) => `[v${index + 1}] Wed, 2 Aug 2023 00:41:18 UTC<br/>`,
).join('')}</div>`;
let child: ChildProcess, url: string, temporary: string, bytes: Buffer;
const localPdfRequests: string[] = [];
test.beforeAll(async () => {
  bytes = Buffer.concat([await pdf('A paper downloaded in stages.'), Buffer.alloc(16384, 32)]);
  temporary = await mkdtemp(join(tmpdir(), 'pdf-dd-download-'));
  const preload = join(temporary, 'arxiv-fixture.mjs');
  await writeFile(
    preload,
    `const realFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input);
  if(url.hostname !== 'arxiv.org') return realFetch(input, options);
  if(!url.pathname.startsWith('/abs/')) throw new Error('Node must never download an arXiv PDF');
  return Promise.resolve(new Response(${JSON.stringify(history)}));
};`,
  );
  child = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(preload).href,
      'dist/local/server/cli.js',
      '--port',
      '0',
      '--no-open',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  url = await new Promise<string>((done, reject) => {
    child.stdout!.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\/pdf-dd\//);
      if (match) done(match[0]);
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`Server exited ${code}`)));
  });
});
test.afterAll(async () => {
  child?.kill('SIGTERM');
  if (child && child.exitCode === null) await once(child, 'exit');
  await rm(temporary, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  localPdfRequests.length = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/pdf/')) localPdfRequests.push(r.url());
  });
  await page.route('https://arxiv.org/**', (route) => route.abort());
});
test.afterEach(() => {
  expect(localPdfRequests).toEqual([]);
});
async function select(page: Page) {
  await page.goto(url);
  await page.getByRole('button', { name: 'arXiv', exact: true }).click();
  await page.getByRole('button', { name: 'Find versions' }).click();
  await expect(page.locator('#compare')).toBeEnabled();
  await expect(page.getByLabel('Original version')).toHaveValue('v1');
  await expect(page.getByLabel('Modified version')).toHaveValue('v7');
  await expect(page.getByRole('radio', { name: 'Original v1', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Modified v7', exact: true })).toBeChecked();
}

test('the full edition downloads exact selected versions directly and in parallel, then reuses them', async ({
  page,
}) => {
  const held: Route[] = [];
  await page.route('https://arxiv.org/pdf/**', (route) => {
    held.push(route);
  });
  await select(page);
  await page.evaluate(() => {
    const b = document.querySelector<HTMLButtonElement>('#compare')!;
    b.click();
    b.click();
  });
  await expect.poll(() => held.length).toBe(2); // Both requests started before either response arrives.
  expect(held.map((r) => r.request().url()).sort()).toEqual([
    'https://arxiv.org/pdf/1706.03762v1',
    'https://arxiv.org/pdf/1706.03762v7',
  ]);
  await held[0].fulfill({ contentType: 'application/pdf', body: bytes });
  await expect(page.locator('#busy-detail')).toContainText('Download complete');
  await expect(page.locator('#result-screen')).toBeHidden();
  await held[1].fulfill({ contentType: 'application/pdf', body: bytes });
  await expect(page.locator('#reader-0 .rendered').first()).toBeVisible();
  await page.locator('#brand').click();
  await page.getByLabel('Original version').selectOption('v7');
  await page.getByRole('button', { name: 'Local files', exact: true }).click();
  await page.getByRole('button', { name: 'arXiv', exact: true }).click();
  await page.locator('#compare').click();
  await expect(page.locator('#reader-0 .rendered').first()).toBeVisible();
  await expect(page.locator('#name-0')).toContainText('(v7)');
  await expect(page.locator('#name-1')).toContainText('(v1)');
  expect(held).toHaveLength(2);
});

for (const known of [true, false]) {
  test(`parallel browser downloads show ${known ? 'known' : 'unknown'} size progress`, async ({
    page,
  }) => {
    // Controlled browser response bodies let us pause individual chunks; ordinary route.fulfill buffers a whole response.
    await page.addInitScript(
      ({ data, known }) => {
        const fetch = window.fetch.bind(window);
        const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
        window.addEventListener('message', (event) => {
          if (event.data?.type !== 'pdf-test-chunk') return;
          const { version, start, end, done } = event.data;
          const stream = streams.get(version)!;
          stream.enqueue(new Uint8Array(data.slice(start, end)));
          if (done) stream.close();
        });
        window.fetch = (input, options) => {
          const address = String(input);
          if (!address.startsWith('https://arxiv.org/pdf/')) return fetch(input, options);
          const version = /v\d+$/.exec(address)![0];
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              streams.set(version, controller);
              options?.signal?.addEventListener(
                'abort',
                () => controller.error(options.signal!.reason),
                { once: true },
              );
            },
          });
          return Promise.resolve(
            new Response(body, {
              headers: {
                'Content-Type': 'application/pdf',
                ...(known ? { 'Content-Length': String(data.length) } : {}),
              },
            }),
          );
        };
      },
      { data: [...bytes], known },
    );
    await select(page);
    await page.locator('#compare').click();
    await expect(page.locator('#busy-detail')).toContainText('v7 · Waiting');
    const half = Math.floor(bytes.length / 2);
    for (const version of ['v1', 'v7'])
      await page.evaluate(
        ({ version, end }) =>
          window.postMessage({ type: 'pdf-test-chunk', version, start: 0, end }, '*'),
        { version, end: half },
      );
    if (known) {
      await expect(page.locator('#progress')).toHaveAttribute(
        'value',
        String(Math.floor((half / bytes.length) * 100)),
      );
      await expect(page.locator('#busy-detail')).toContainText('MB /');
    } else {
      await expect(page.locator('#progress')).not.toHaveAttribute('value');
      await expect(page.locator('#busy-detail')).toContainText('Total size unknown');
    }
    await page.screenshot({ path: `tmp/test-results/download-${known ? 'known' : 'unknown'}.png` });
    for (const version of ['v1', 'v7'])
      await page.evaluate(
        ({ version, start, end }) =>
          window.postMessage({ type: 'pdf-test-chunk', version, start, end, done: true }, '*'),
        { version, start: half, end: bytes.length },
      );
    await expect(page.locator('#busy')).toBeHidden();
    await expect(page.locator('#reader-0 .rendered').first()).toBeVisible();
  });
}

test('browser failures offer the exact manual download links and allow retry without a server fallback', async ({
  page,
}) => {
  await select(page);
  await page.locator('#compare').click(); // beforeEach aborts external PDF requests.
  await expect(page.locator('#busy')).toBeHidden();
  await expect(page.locator('#source-status')).toContainText('Local files');
  await expect(page.locator('#web-downloads a')).toHaveText(['v1', 'v7']);
  await expect(page.locator('#web-downloads a').last()).toHaveAttribute(
    'href',
    'https://arxiv.org/pdf/1706.03762v7',
  );
  await page.route('https://arxiv.org/pdf/**', (route) =>
    route.fulfill({ contentType: 'application/pdf', body: bytes }),
  );
  await page.locator('#compare').click();
  await expect(page.locator('#reader-0 .rendered').first()).toBeVisible();
});

test('a browser 429 pauses retries while retaining the already downloaded PDF', async ({
  page,
}) => {
  const time = new Date('2026-09-18T00:00:00Z');
  await page.clock.setFixedTime(time);
  const held: Route[] = [];
  const requested: string[] = [];
  await page.route('https://arxiv.org/pdf/**', (route) => {
    requested.push(route.request().url());
    held.push(route);
  });
  await select(page);
  await page.locator('#compare').click();
  await expect.poll(() => held.length).toBe(2);
  await held
    .find((r) => r.request().url().endsWith('v1'))!
    .fulfill({ contentType: 'application/pdf', body: bytes });
  await expect(page.locator('#busy-detail')).toContainText('Download complete');
  await held
    .find((r) => r.request().url().endsWith('v7'))!
    .fulfill({
      status: 429,
      headers: { 'Retry-After': '30', 'Access-Control-Expose-Headers': 'Retry-After' },
      body: '',
    });
  await expect(page.locator('#busy')).toBeHidden();
  await expect(page.locator('#source-status')).toContainText('30 seconds');
  await page.locator('#compare').click();
  await expect(page.locator('#busy')).toBeHidden();
  expect(requested).toHaveLength(2);
  await page.clock.setFixedTime(new Date(time.getTime() + 31000));
  await page.locator('#compare').click();
  await expect.poll(() => held.length).toBe(3);
  expect(requested[2]).toBe('https://arxiv.org/pdf/1706.03762v7');
  await held[2].fulfill({ contentType: 'application/pdf', body: bytes });
  await expect(page.locator('#reader-0 .rendered').first()).toBeVisible();
});
