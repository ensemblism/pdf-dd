import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile, readdir } from 'node:fs/promises';
import { startStaticSite } from '../static-server';
import { pdf, upload } from './helpers';

let site: Awaited<ReturnType<typeof startStaticSite>>;
test.beforeAll(async () => {
  site = await startStaticSite();
});
test.afterAll(async () => {
  await site.close();
});
test.beforeEach(async ({ page }) => {
  // All automatic arXiv checks are mocked. Unhandled arXiv requests must never reach the network.
  await page.route('https://arxiv.org/**', (route) => route.abort());
});

test('static subpath supports local selection, replacement, drag/drop, navigation, sync, zoom and export', async ({
  page,
}) => {
  const requests: string[] = [],
    errors: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(site.url);
  await expect(page.locator('[data-source]')).toHaveText(['Local files', 'arXiv']);
  await expect(page.locator('#toast')).toBeHidden();
  const left = await pdf('This experiment measures a stable variable.', 3);
  for (const name of ['draft.pdf', 'original.pdf']) {
    const picking = page.waitForEvent('filechooser');
    await page.locator('[data-upload="0"]').click();
    await (await picking).setFiles({ name, mimeType: 'application/pdf', buffer: left });
    await expect(page.locator('#file-info-0')).toContainText(name);
  }
  const right = await pdf('This experiment measures two stable variables.', 3);
  await page.locator('[data-side="1"].drop-card').evaluate(
    (el, bytes) => {
      const data = new DataTransfer();
      data.items.add(
        new File([new Uint8Array(bytes)], 'modified.pdf', { type: 'application/pdf' }),
      );
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data }));
    },
    [...right],
  );
  await page.locator('#compare').click();
  await expect(page.locator('#result-screen')).toBeVisible();
  await expect(page.locator('.mark.removed').first()).toBeVisible();
  await expect(page.locator('.mark.added').first()).toBeVisible();
  await page.locator('#next-change').click();
  await expect(page.locator('.change-card.active')).toHaveCount(1);
  await page.getByRole('button', { name: 'Original', exact: true }).click();
  await expect(page.locator('#pane-1')).toBeHidden();
  await page.getByRole('button', { name: 'Modified', exact: true }).click();
  await expect(page.locator('#pane-0')).toBeHidden();
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.locator('#page-0').fill('3');
  await page.locator('#page-0').press('Enter');
  await expect(page.locator('#page-1')).toHaveValue('3');
  await page.locator('#zoom-0').fill('200');
  await expect(page.locator('#zoom-label-1')).toHaveText('200%');
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await page.locator('#reader-0').evaluate((el) => (el.scrollLeft = 100));
  await expect
    .poll(() => page.locator('#reader-1').evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(90);
  const downloading = page.waitForEvent('download');
  await page.locator('#export').click();
  const doc = await PDFDocument.load(await readFile((await (await downloading).path())!), {
    updateMetadata: false,
  });
  expect(doc.getPageCount()).toBe(3);
  expect(doc.getProducer()).toBe('PDF Diff Discerner');
  for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
    const name = (await readdir(`dist/site/pdf-assets/${dir}`)).find((n) => !/license/i.test(n))!;
    const result = await page.evaluate(async (path) => {
      const response = await fetch(path);
      return { ok: response.ok, bytes: (await response.arrayBuffer()).byteLength };
    }, `pdf-assets/${dir}/${name}`);
    expect(result.ok).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
  }
  expect(requests.some((r) => r.includes('pdf.worker'))).toBe(true);
  expect(requests.some((r) => r.includes('compute.worker'))).toBe(true);
  expect(requests.some((r) => r.includes('/api/') || r.includes('session.json'))).toBe(false);
  expect(requests.every((r) => r.startsWith(site.url) || /^(blob|data):/.test(r))).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/web-comparison.png' });
  const blank = await page.locator('.brand strong').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const x = rect.right + 24,
      y = rect.top + rect.height / 2;
    return { x, y, clickable: !!document.elementFromPoint(x, y)?.closest('a, button') };
  });
  expect(blank.clickable).toBe(false);
  await page.mouse.click(blank.x, blank.y);
  await expect(page.locator('#result-screen')).toBeVisible();
  await page.locator('.brand strong').click();
  await expect(page.locator('#upload-screen')).toBeVisible();
  await expect(page.locator('#file-info-0')).toContainText('original.pdf');
  await expect(page.locator('#file-info-1')).toContainText('modified.pdf');
  await expect(page.locator('#compare')).toBeEnabled();
  expect(requests.filter((request) => request === site.url)).toHaveLength(1);
});

test('web edition uses the shared moved-paragraph comparison', async ({ page }) => {
  async function paragraphs(lines: string[][]) {
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.Helvetica);
    for (const group of lines) {
      const p = doc.addPage([612, 792]);
      group.forEach((text, i) => p.drawText(text, { x: 60, y: 700 - i * 80, font, size: 12 }));
    }
    return Buffer.from(await doc.save());
  }
  const a = 'This long paragraph uniquely describes the first experiment.';
  const b = 'Another paragraph provides a completely different discussion.';
  const c = 'The conclusion contains enough unique words to be an anchor.';
  await page.goto(site.url);
  await upload(page, await paragraphs([[a, b], [c]]), await paragraphs([[b], [c, a]]));
  await page.locator('#filter').selectOption('moved');
  await expect(page.locator('.change-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Go to target ↗', exact: true }).click();
  await expect(page.locator('#page-1')).toHaveValue('2');
  await expect(page.locator('#reader-1 .mark.moved.selected').first()).toBeVisible();
});

test('default paper loads two PDFs once, preserves results across sources and reuses them after comparison', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const bytes = await pdf('The same document in both versions.');
  await page.route('https://arxiv.org/pdf/**', (route) =>
    route.fulfill({ body: bytes, contentType: 'application/pdf' }),
  );
  await page.goto(site.url);
  await page.getByRole('button', { name: 'arXiv', exact: true }).click();
  await page.getByRole('button', { name: 'Load PDFs' }).click();
  await expect(page.locator('#source-input')).toHaveValue('https://arxiv.org/abs/1706.03762');
  await expect(page.locator('#compare')).toBeEnabled();
  await expect(page.locator('.web-pdf-summary')).toContainText('Original · v1');
  await expect(page.locator('.web-pdf-summary')).toContainText('Modified · Latest');
  await expect(page.locator('#revision-timeline')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/web-arxiv.png' });
  await page.getByRole('button', { name: 'Local files', exact: true }).click();
  await page.getByRole('button', { name: 'arXiv', exact: true }).click();
  await expect(page.locator('#compare')).toBeEnabled();
  for (let i = 0; i < 2; i++) {
    await page.locator('#compare').click();
    await expect(page.locator('.empty-changes')).toContainText('No text differences');
    await page.locator(i === 0 ? '.brand strong' : '.brand-icon').click();
    await expect(page.locator('#compare')).toBeEnabled();
  }
  expect(requests.filter((r) => r.startsWith('https://arxiv.org'))).toEqual([
    'https://arxiv.org/pdf/1706.03762v1',
    'https://arxiv.org/pdf/1706.03762',
  ]);
  expect(requests.some((r) => r.includes('session.json') || r.includes('/api/'))).toBe(false);
  await expect(page.locator('#source-status')).not.toContainText('only one');
});

for (const [input, id, version] of [
  ['1706.03762', '1706.03762', 1],
  ['https://arxiv.org/pdf/1706.03762v6', '1706.03762', 6],
  ['arXiv:hep-th/9901001v2', 'hep-th/9901001', 2],
] as const) {
  test(`version selection from ${input}`, async ({ page }) => {
    const requests: string[] = [],
      bytes = await pdf('A paper.');
    await page.route('https://arxiv.org/pdf/**', (route) => {
      requests.push(route.request().url());
      return route.fulfill({ body: bytes, contentType: 'application/pdf' });
    });
    await page.goto(site.url);
    await page.getByRole('button', { name: 'arXiv', exact: true }).click();
    await page.locator('#source-input').fill(input);
    await page.locator('#load-history').click();
    await expect(page.locator('#compare')).toBeEnabled();
    expect(requests).toEqual([
      `https://arxiv.org/pdf/${id}v${version}`,
      `https://arxiv.org/pdf/${id}`,
    ]);
    await page.locator('#compare').click();
    await expect(page.locator('#name-0')).toContainText(`(v${version})`);
    await expect(page.locator('#name-1')).toContainText('(Latest)');
    expect(requests).toHaveLength(2);
  });
}

test('invalid input, HTTP errors and non-PDF responses remain retryable with manual download links', async ({
  page,
}) => {
  let response: 'missing' | 'html' | 'pdf' = 'missing';
  const requests: string[] = [],
    bytes = await pdf('Recovered download.');
  await page.route('https://arxiv.org/pdf/**', (route) => {
    requests.push(route.request().url());
    return route.fulfill(
      response === 'pdf'
        ? { body: bytes, contentType: 'application/pdf' }
        : response === 'missing'
          ? { status: 404, body: 'Not found' }
          : { body: '<html>Error</html>', contentType: 'text/html' },
    );
  });
  await page.goto(site.url);
  await page.getByRole('button', { name: 'arXiv', exact: true }).click();
  await page.locator('#source-input').fill('https://example.com/paper');
  await page.locator('#load-history').click();
  await expect(page.locator('#source-status.error')).toContainText('valid arXiv');
  expect(requests).toHaveLength(0);
  await page.locator('#source-input').fill('1706.03762v999');
  await page.locator('#load-history').click();
  await expect(page.locator('#source-status.error')).toContainText('404');
  await expect(page.locator('#source-progress')).toBeHidden();
  await expect(page.locator('#web-downloads a')).toHaveCount(2);
  await expect(page.locator('#compare')).toBeDisabled();
  response = 'html';
  await page.locator('#load-history').click();
  await expect(page.locator('#source-status.error')).toContainText('non-PDF');
  response = 'pdf';
  await page.locator('#load-history').click();
  await expect(page.locator('#compare')).toBeEnabled();
  await page.locator('#source-input').fill('1706.03762v6');
  await expect(page.locator('#version-choices')).toBeHidden();
  await expect(page.locator('#compare')).toBeDisabled();
});

test('editing input aborts in-flight requests; old responses cannot replace a newer result', async ({
  page,
}) => {
  const bytes = await pdf('A current result.');
  const failed: string[] = [],
    started: string[] = [];
  page.on('requestfailed', (r) => failed.push(r.url()));
  let release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  await page.route('https://arxiv.org/pdf/**', async (route) => {
    const url = route.request().url();
    started.push(url);
    if (url.includes('1706.03762')) await held;
    await route.fulfill({ body: bytes, contentType: 'application/pdf' }).catch(() => {});
  });
  await page.goto(site.url);
  await page.getByRole('button', { name: 'arXiv', exact: true }).click();
  await page.locator('#load-history').click();
  await expect.poll(() => started.length).toBe(2);
  await expect(
    page.getByRole('progressbar', { name: 'Downloading two PDFs from arXiv…' }),
  ).toBeVisible();
  await expect(page.locator('#source-progress')).not.toHaveAttribute('value');
  await page.screenshot({ path: 'test-results/web-download-progress.png' });
  await expect(page.locator('#load-history')).toBeDisabled();
  await expect(page.locator('#compare')).toBeDisabled();
  await page.locator('#source-input').fill('2401.01234v3');
  await expect(page.locator('#source-progress')).toBeHidden();
  await expect.poll(() => failed.length).toBe(2);
  await page.locator('#load-history').click();
  await expect(page.locator('#compare')).toBeEnabled();
  release();
  await expect(page.locator('.web-pdf-summary')).toContainText('2401.01234 (v3).pdf');
  await expect(page.locator('#source-progress')).toBeHidden();
});

test('switching away during a download aborts both requests and keeps the input for retry', async ({
  page,
}) => {
  let started = 0,
    failed = 0,
    release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  const bytes = await pdf('A retried download.');
  page.on('requestfailed', (r) => {
    if (r.url().startsWith('https://arxiv.org/')) failed++;
  });
  await page.route('https://arxiv.org/pdf/**', async (route) => {
    started++;
    await held;
    await route.fulfill({ body: bytes, contentType: 'application/pdf' }).catch(() => {});
  });
  await page.goto(site.url);
  await page.getByRole('button', { name: 'arXiv', exact: true }).click();
  await page.locator('#source-input').fill('1706.03762v2');
  await page.locator('#load-history').click();
  await expect.poll(() => started).toBe(2);
  await expect(page.locator('#source-progress')).toBeVisible();
  await page.getByRole('button', { name: 'Local files', exact: true }).click();
  await expect.poll(() => failed).toBe(2);
  release();
  await page.getByRole('button', { name: 'arXiv', exact: true }).click();
  await expect(page.locator('#source-input')).toHaveValue('1706.03762v2');
  await expect(page.locator('#source-progress')).toBeHidden();
  await expect(page.locator('#compare')).toBeDisabled();
  await expect(page.locator('#version-choices')).toBeHidden();
  await expect(page.locator('#load-history')).toBeEnabled();
  await page.locator('#load-history').click();
  await expect(page.locator('#compare')).toBeEnabled();
  expect(started).toBe(4);
});

test('a timed-out browser download offers retry without retaining partial PDFs', async ({
  page,
}) => {
  await page.clock.install();
  let release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  let requests = 0;
  await page.route('https://arxiv.org/pdf/**', async (route) => {
    requests++;
    await held;
    await route.abort().catch(() => {});
  });
  await page.goto(site.url);
  await page.getByRole('button', { name: 'arXiv', exact: true }).click();
  await page.locator('#load-history').click();
  await expect.poll(() => requests).toBe(2);
  await page.clock.fastForward(60001);
  await expect(page.locator('#source-status.error')).toContainText('timed out');
  await expect(page.locator('#load-history')).toBeEnabled();
  await expect(page.locator('#compare')).toBeDisabled();
  release();
});
