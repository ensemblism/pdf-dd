import { test, expect } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pdf, upload } from './helpers';

let child: ChildProcess, url: string;
test.beforeAll(async () => {
  child = spawn(process.execPath, ['dist/local/server/cli.js', '--port', '0', '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  url = await new Promise<string>((resolve, reject) => {
    child.stdout!.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\/pdf-dd\//);
      if (match) resolve(match[0]);
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`Server exited ${code}`)));
  });
});
test.afterAll(() => child.kill('SIGTERM'));
test('upload, navigate, change views, zoom, export and compare again', async ({ page }) => {
  const errors: string[] = [],
    remote: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (!r.url().startsWith(url) && !r.url().startsWith('blob:') && !r.url().startsWith('data:'))
      remote.push(r.url());
  });
  await page.goto(url);
  await expect(page).toHaveTitle('PDF Diff Discerner');
  await expect(page.locator('.brand')).toHaveText('PDF Diff Discerner');
  await expect(page.locator('.brandbar #header-tagline')).toBeVisible();
  await expect(page.getByText('Local & private')).toHaveCount(0);
  await expect(page.locator('#upload-screen .features')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Make a difference!' })).toBeDisabled();
  await page.screenshot({ path: 'test-results/upload.png' });
  await upload(
    page,
    await pdf('This experiment measures a stable variable.', 3),
    await pdf('This experiment measures two stable variables.', 3),
  );
  await expect(page.getByText('Document comparison', { exact: true })).toHaveCount(0);
  await expect(page.locator('.legend')).toHaveCount(0);
  await expect(page.locator('#header-tagline')).toBeHidden();
  await expect(page.locator('#summary, #change-count')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Differences', exact: true })).toBeVisible();
  await expect(page.locator('.pane-filename')).toHaveText(['original.pdf', 'modified.pdf']);
  await expect(page.locator('.changes-controls #filter')).toBeVisible();
  await expect(page.locator('#filter option').first()).toHaveText('All');
  await expect(page.locator('#header-right .toolbar-actions button')).toHaveText(['Export']);
  await expect(page.locator('#header-center .toolbar-actions button')).toHaveText(['Sync']);
  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const header = bounds('.brandbar'),
      view = bounds('#header-view'),
      sync = bounds('#sync'),
      heading = bounds('.changes-heading h2'),
      filter = bounds('#filter'),
      navigation = bounds('.changes-navigation'),
      reader = bounds('#reader-0');
    const controls = ['#brand', '#sync', '#export'].map(bounds);
    const row = ['.pane-filename', '.page-controls', '.zoom-controls'].map((selector) =>
      bounds(`#pane-0 ${selector}`),
    );
    return {
      center: (view.left + view.right) / 2,
      width: innerWidth,
      readerTop: reader.top,
      headerAligned: controls.every((r) => r.top >= header.top && r.bottom <= header.bottom),
      syncGap: sync.left - view.right,
      differencesOneRow:
        Math.abs(heading.top + heading.height / 2 - filter.top - filter.height / 2) < 1 &&
        heading.right < navigation.left &&
        Math.abs(filter.top + filter.height / 2 - navigation.top - navigation.height / 2) < 1 &&
        navigation.right < filter.left,
      oneRow: Math.max(...row.map((r) => r.top)) < Math.min(...row.map((r) => r.bottom)),
    };
  });
  expect(layout.center).toBeCloseTo(layout.width / 2, 0);
  expect(layout.readerTop).toBeLessThan(115);
  expect(layout.headerAligned).toBe(true);
  expect(layout.syncGap).toBe(10);
  expect(layout.differencesOneRow).toBe(true);
  expect(layout.oneRow).toBe(true);
  expect(await page.locator('.change-card').count()).toBeGreaterThan(0);
  await page.locator('.change-card').first().click();
  await expect(page.locator('.mark.selected').first()).toBeVisible();
  await page.getByRole('button', { name: 'Original', exact: true }).click();
  await expect(page.locator('#pane-1')).toBeHidden();
  await page.getByRole('button', { name: 'Modified', exact: true }).click();
  await expect(page.locator('#pane-0')).toBeHidden();
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.locator('#page-0').fill('3');
  await page.locator('#reader-0').dispatchEvent('scroll');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  await expect(page.locator('#page-0')).toHaveValue('3');
  await page.locator('#page-0').press('Enter');
  await expect(page.locator('#page-1')).toHaveValue('3');
  await page.locator('#zoom-0').fill('125');
  await expect(page.locator('#zoom-label-1')).toHaveText('125%');
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await expect(page.locator('#sync')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#filter').selectOption('added');
  await expect(page.locator('.change-card .badge').first()).toHaveText('Added');
  await page.locator('#filter').selectOption('all');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadPromise;
  const output = await download.path();
  const exported = await PDFDocument.load(await readFile(output!));
  expect(exported.getPageCount()).toBe(3);
  await download.saveAs('test-results/comparison.pdf');
  await page.locator('#brand').click();
  await expect(page.locator('#header-tagline')).toBeVisible();
  await expect(page.locator('#sync')).toBeHidden();
  await expect(page.locator('#upload-screen')).toBeVisible();
  const same = await pdf('Exactly the same text.');
  await upload(page, same, same);
  await expect(page.locator('.empty-changes')).toContainText('No text differences');
  const blank = await page.locator('.brand strong').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const x = rect.right + 24,
      y = rect.top + rect.height / 2;
    return { x, y, clickable: !!document.elementFromPoint(x, y)?.closest('a, button') };
  });
  expect(blank.clickable).toBe(false);
  await page.mouse.click(blank.x, blank.y);
  await expect(page.locator('#result-screen')).toBeVisible();
  await page.locator('.brand-icon').click();
  await expect(page.locator('#upload-screen')).toBeVisible();
  await expect(page.locator('#file-info-0')).toContainText('original.pdf');
  await expect(page.locator('#file-info-1')).toContainText('modified.pdf');
  await expect(page.locator('#compare')).toBeEnabled();
  expect(errors).toEqual([]);
  expect(remote).toEqual([]);
});
test('real 14-page papers render and export with bounded canvas cache', async ({ page }) => {
  test.skip(
    !existsSync('influence1.pdf') || !existsSync('influence2.pdf'),
    'Optional local paper fixtures are not present.',
  );
  await page.goto(url);
  await page.locator('#file-0').setInputFiles(resolve('influence1.pdf'));
  await page.locator('#file-1').setInputFiles(resolve('influence2.pdf'));
  await page.getByRole('button', { name: 'Make a difference!' }).click();
  await expect(page.locator('#busy')).toBeHidden({ timeout: 60000 });
  await expect(page.locator('#reader-0 .rendered').first()).toBeVisible();
  await expect(page.locator('#reader-1 .rendered').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/papers.png' });
  expect(await page.locator('.change-card').count()).toBeGreaterThan(0);
  await page.locator('#page-0').fill('7');
  await page.locator('#page-0').press('Enter');
  await expect(page.locator('#reader-0 .paper[data-page="7"].rendered')).toBeVisible();
  await page.screenshot({ path: 'test-results/papers-page7.png' });
  expect(await page.locator('.paper canvas').count()).toBeLessThanOrEqual(12);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export').click();
  const download = await downloadPromise;
  await download.saveAs('test-results/papers-comparison.pdf');
  const exported = await PDFDocument.load(await readFile((await download.path())!));
  expect(exported.getPageCount()).toBeGreaterThanOrEqual(14);
  console.log(
    'Paper comparison',
    'compute ms:',
    await page.locator('#result-screen').getAttribute('data-compare-ms'),
  );
});
test('moved paragraphs link their source and target pages', async ({ page }) => {
  const a = 'This long paragraph uniquely describes the first experiment.';
  const b = 'Another paragraph provides a completely different discussion.';
  const c = 'The conclusion contains enough unique words to be an anchor.';
  async function paragraphs(pages: string[][]) {
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.Helvetica);
    for (const lines of pages) {
      const p = doc.addPage([612, 792]);
      lines.forEach((text, i) => p.drawText(text, { x: 60, y: 700 - i * 80, font, size: 12 }));
    }
    return Buffer.from(await doc.save());
  }
  await page.goto(url);
  await upload(page, await paragraphs([[a, b], [c]]), await paragraphs([[b], [c, a]]));
  await page.locator('#filter').selectOption('moved');
  await expect(page.locator('.change-card')).toHaveCount(1);
  await expect(page.locator('.change-card')).toContainText('Page 1 → 2');
  await page.getByRole('button', { name: 'Go to source ↗', exact: true }).click();
  await expect(page.locator('#page-0')).toHaveValue('1');
  await page.getByRole('button', { name: 'Go to target ↗', exact: true }).click();
  await expect(page.locator('#page-1')).toHaveValue('2');
  await expect(page.locator('#reader-1 .mark.moved.selected').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/moved.png' });
});
test('difference navigation stays fixed across one, two and three digit positions', async ({
  page,
}) => {
  await page.goto(url);
  await upload(
    page,
    await pdf('An important result uses the original method.', 101),
    await pdf('An important result uses the revised method.', 101),
  );
  const total = Number((await page.locator('#current-change').innerText()).split(' of ')[1]);
  expect(total).toBeGreaterThanOrEqual(100);
  await page.locator('#changes-list').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect.poll(() => page.locator('.change-card').count()).toBeGreaterThanOrEqual(100);
  const positions = () =>
    page.locator('#current-change, #previous-change, #next-change, #filter').evaluateAll((els) =>
      els.map((el) => {
        const { x, width } = el.getBoundingClientRect();
        return { x, width };
      }),
    );
  for (const width of [1440, 1000]) {
    await page.setViewportSize({ width, height: 1000 });
    const baseline = await positions();
    for (const index of [1, 9, 99]) {
      await page
        .locator('.change-card')
        .nth(index - 1)
        .click();
      await expect(page.locator('#current-change')).toHaveText(`${index} of ${total}`);
      expect(await positions()).toEqual(baseline);
      await page.locator('#next-change').click();
      await expect(page.locator('#current-change')).toHaveText(`${index + 1} of ${total}`);
      expect(await positions()).toEqual(baseline);
    }
  }
});

test('100-page documents stay navigable at both fit and low zoom', async ({ page }) => {
  await page.goto(url);
  const bytes = await pdf('An unchanged paragraph within a long document.', 100);
  await upload(page, bytes, bytes);
  for (const target of [50, 100, 1]) {
    await page.locator('#page-0').fill(String(target));
    await page.locator('#page-0').press('Enter');
    await expect(page.locator(`#reader-0 .paper[data-page="${target}"].rendered`)).toBeVisible();
    await expect(page.locator('#page-1')).toHaveValue(String(target));
    await expect.poll(() => page.locator('.paper canvas').count()).toBeLessThanOrEqual(12);
  }
  await page.locator('#zoom-0').fill('25');
  await expect(page.locator('#reader-0 .rendered').first()).toBeVisible();
  await expect.poll(() => page.locator('.paper canvas').count()).toBeLessThanOrEqual(12);
  await page.locator('#page-0').fill('70');
  await page.locator('#page-0').press('Enter');
  await expect(page.locator('#reader-0 .paper[data-page="70"].rendered')).toBeVisible();
  await expect.poll(() => page.locator('.paper canvas').count()).toBeLessThanOrEqual(12);
});
test('horizontal and diagonal scrolling sync in both directions and respect the toggle', async ({
  page,
}) => {
  await page.goto(url);
  const bytes = await pdf('The same content in both documents.', 3);
  await upload(page, bytes, bytes);
  await page.locator('#zoom-0').fill('200');
  await page.locator('#page-0').fill('2');
  await page.locator('#page-0').press('Enter');
  await expect(page.locator('#page-1')).toHaveValue('2');
  const positions = () =>
    page
      .locator('.pdf-scroll')
      .evaluateAll((es) => es.map((e) => ({ left: e.scrollLeft, top: e.scrollTop })));
  const before = await positions();
  await page.locator('#reader-0').hover();
  await page.mouse.wheel(220, 0);
  await expect.poll(async () => (await positions())[0].left).toBeGreaterThan(200);
  await expect
    .poll(async () => {
      const [a, b] = await positions();
      return Math.abs(a.left - b.left);
    })
    .toBeLessThan(1);
  expect((await positions()).map((p) => p.top)).toEqual(before.map((p) => p.top));
  const left = (await positions())[0].left;
  await page.locator('#reader-1').hover();
  await page.mouse.wheel(-100, 0);
  await expect.poll(async () => (await positions())[0].left).toBeLessThan(left - 90);
  expect((await positions()).map((p) => p.top)).toEqual(before.map((p) => p.top));
  await page.locator('#sync').click();
  const independent = (await positions())[1].left;
  await page.locator('#reader-0').evaluate(async (e) => {
    e.scrollLeft += 100;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  expect((await positions())[1].left).toBe(independent);
  await page.locator('#sync').click();
  await expect
    .poll(async () => {
      const [a, b] = await positions();
      return Math.abs(a.left - b.left);
    })
    .toBeLessThan(1);
  await page.locator('#reader-1').hover();
  await page.mouse.wheel(100, 100);
  await expect.poll(async () => (await positions())[0].top).toBeGreaterThan(before[0].top + 90);
  await expect
    .poll(async () => {
      const [a, b] = await positions();
      return Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top));
    })
    .toBeLessThan(1);
});
test('horizontal sync follows the scrollable fraction for different page widths', async ({
  page,
}) => {
  await page.goto(url);
  await upload(page, await pdf('Identical text.'), await pdf('Identical text.', 1, 0, 800));
  await page.locator('#zoom-0').fill('200');
  for (const [side, fraction] of [
    [0, 0.4],
    [1, 0.8],
  ]) {
    await page.locator(`#reader-${side}`).evaluate((e, fraction) => {
      e.scrollLeft = (e.scrollWidth - e.clientWidth) * fraction;
    }, fraction);
    await expect
      .poll(() =>
        page
          .locator(`#reader-${1 - side}`)
          .evaluate((e) => e.scrollLeft / (e.scrollWidth - e.clientWidth)),
      )
      .toBeCloseTo(fraction, 2);
  }
});
test('pinch and modified wheel zoom only the PDF and preserve the pointer position', async ({
  page,
}) => {
  await page.goto(url);
  await upload(
    page,
    await pdf('Original content to zoom.', 3),
    await pdf('Modified content to zoom.', 3),
  );
  await page.locator('#zoom-0').fill('125');
  const scroller = page.locator('#reader-0');
  const bounds = (await scroller.boundingBox())!;
  const point = { x: bounds.x + bounds.width * 0.6, y: bounds.y + bounds.height * 0.4 };
  const position = () =>
    page.evaluate(({ x, y }) => {
      const paper = document.querySelector<HTMLElement>('#reader-0 .paper')!,
        r = paper.getBoundingClientRect(),
        scale = r.width / 612;
      return {
        x: (x - r.left) / scale,
        y: (y - r.top) / scale,
        windowWidth: innerWidth,
        viewportScale: visualViewport!.scale,
        dpr: devicePixelRatio,
      };
    }, point);
  const before = await position();
  await page.mouse.move(point.x, point.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect(page.locator('#zoom-label-0')).not.toHaveText('125%');
  await expect(page.locator('#reader-0 .paper.rendered').first()).toBeVisible();
  const after = await position();
  expect(after.windowWidth).toBe(before.windowWidth);
  expect(after.viewportScale).toBe(before.viewportScale);
  expect(after.dpr).toBe(before.dpr);
  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  expect(await page.locator('#zoom-label-0').textContent()).toEqual(
    await page.locator('#zoom-label-1').textContent(),
  );
  const scale = await page.locator('#zoom-label-0').textContent();
  const top = await scroller.evaluate((e) => e.scrollTop);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeGreaterThan(top);
  await expect(page.locator('#zoom-label-0')).toHaveText(scale!);
  const cancelled = await scroller.evaluate((e) => {
    let cancelled = true;
    for (const [type, scale] of [
      ['gesturestart', 1],
      ['gesturechange', 0.8],
      ['gestureend', 0.8],
    ] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { scale, clientX: 250, clientY: 400 });
      cancelled = !e.dispatchEvent(event) && cancelled;
    }
    return cancelled;
  });
  expect(cancelled).toBe(true);
  await expect(page.locator('#zoom-label-0')).not.toHaveText(scale!);
});
test('paper highlights follow PDF glyph positions for es and an without borders', async ({
  page,
}) => {
  test.skip(
    !existsSync('influence1.pdf') || !existsSync('influence2.pdf'),
    'Optional local paper fixtures are not present.',
  );
  await page.goto(url);
  await page.locator('#file-0').setInputFiles(resolve('influence1.pdf'));
  await page.locator('#file-1').setInputFiles(resolve('influence2.pdf'));
  await page.locator('#compare').click();
  await expect(page.locator('#busy')).toBeHidden();
  for (const [side, word, x, width] of [
    [0, 'es', 376.27728, 8.13287],
    [1, 'an', 337.93661, 9.2166],
  ] as const) {
    const card = page
      .locator('.change-card')
      .filter({ has: page.locator('p').filter({ hasText: new RegExp(`^${word}$`) }) })
      .first();
    await card.click();
    const mark = page.locator(`#reader-${side} .mark.selected`).first();
    await expect(mark).toBeVisible();
    const geometry = await mark.evaluate((e) => {
      const paper = e.closest('.paper')!,
        r = paper.getBoundingClientRect(),
        box = e.getBoundingClientRect(),
        scale = r.width / 612,
        css = getComputedStyle(e);
      return {
        x: (box.left - r.left) / scale,
        width: box.width / scale,
        height: box.height / scale,
        border: css.borderBottomWidth,
        outline: css.outlineWidth,
      };
    });
    expect(geometry.x).toBeCloseTo(x, 1);
    expect(geometry.width).toBeCloseTo(width, 1);
    expect(geometry.height).toBeLessThan(9);
    expect(geometry.border).toBe('0px');
    expect(geometry.outline).toBe('0px');
  }
  await page.screenshot({ path: 'test-results/corrected-highlights.png' });
});
test('the complete added sentence stays highlighted across spaces and inline math', async ({
  page,
}) => {
  test.skip(
    !existsSync('influence1.pdf') || !existsSync('influence2.pdf'),
    'Optional local paper fixtures are not present.',
  );
  await page.goto(url);
  await page.locator('#file-0').setInputFiles(resolve('influence1.pdf'));
  await page.locator('#file-1').setInputFiles(resolve('influence2.pdf'));
  await page.locator('#compare').click();
  await expect(page.locator('#busy')).toBeHidden();
  const card = page
    .locator('.change-card')
    .filter({ has: page.locator('.badge.added') })
    .filter({ hasText: 'this positive influence manifests' });
  await card.click();
  await expect(page.locator('#reader-1 .paper[data-page="6"].rendered')).toBeVisible();
  const id = await card.getAttribute('data-id');
  const marks = page.locator(`#reader-1 [data-change="${id}"]`);
  await expect(marks).toHaveCount(3);
  const coverage = await page.evaluate((id) => {
    const paper = document.querySelector('#reader-1 .paper[data-page="6"]')!;
    const rects = [...paper.querySelectorAll(`[data-change="${id}"]`)].map((e) =>
      e.getBoundingClientRect(),
    );
    const phrases = [
      'can help',
      'reveal information about',
      ', which facilitates a more informed alteration of',
      ', ultimately benefiting',
    ];
    return phrases.map((text) => {
      const span = [...paper.querySelectorAll('.textLayer span')].find(
        (e) => e.textContent === text,
      )!;
      const r = span.getBoundingClientRect(),
        y = (r.top + r.bottom) / 2;
      return {
        text,
        covered: rects.some(
          (b) => b.left <= r.left + 1 && b.right >= r.right - 1 && b.top <= y && b.bottom >= y,
        ),
      };
    });
  }, id);
  expect(coverage.filter((r) => !r.covered)).toEqual([]);
  const widths = await marks.evaluateAll((es) =>
    es.map(
      (e) =>
        parseFloat((e as HTMLElement).style.width) /
        (e.closest('.paper')!.getBoundingClientRect().width / 612),
    ),
  );
  expect(widths[0]).toBeGreaterThan(250);
  expect(widths[1]).toBeGreaterThan(390);
  expect(widths[2]).toBeGreaterThan(125);
  await page.getByRole('button', { name: 'Modified', exact: true }).click();
  await page.locator('#zoom-1').fill('125');
  await card.click();
  await expect(page.locator('#reader-1 .paper[data-page="6"].rendered')).toBeVisible();
  await expect(marks).toHaveCount(3);
  await page.screenshot({ path: 'test-results/full-sentence.png' });
});
test('rotated pages, drag-and-drop, and pages without a text layer', async ({ page }) => {
  await page.goto(url);
  const original = await pdf('Old text on a rotated page.', 1, 90),
    modified = await pdf('New text on a rotated page.', 1, 90);
  const data = await page.evaluateHandle(
    ({ bytes }) => {
      const d = new DataTransfer();
      d.items.add(new File([new Uint8Array(bytes)], 'rotated.pdf', { type: 'application/pdf' }));
      return d;
    },
    { bytes: [...original] },
  );
  await page.locator('[data-upload="0"]').dispatchEvent('drop', { dataTransfer: data });
  await page
    .locator('#file-1')
    .setInputFiles({ name: 'modified.pdf', mimeType: 'application/pdf', buffer: modified });
  await page.locator('#compare').click();
  await expect(page.locator('#busy')).toBeHidden();
  await expect(page.locator('#reader-0 .rendered').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/rotated.png' });
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export').click();
  await (await downloadPromise).saveAs('test-results/rotated-comparison.pdf');
  await page.locator('#brand').click();
  const blank = await PDFDocument.create();
  blank
    .addPage([612, 792])
    .drawRectangle({ x: 30, y: 30, width: 100, height: 100, color: rgb(1, 0, 0) });
  const bytes = Buffer.from(await blank.save());
  await upload(page, bytes, bytes);
  await expect(page.locator('#notice')).toContainText('incomplete');
  await expect(page.locator('.empty-changes')).toContainText('readable pages');
});
test('local server rejects wrong hosts and arbitrary paths', async ({ request }) => {
  expect(new URL(url).pathname).toBe('/pdf-dd/');
  const redirect = await request.get(url.slice(0, -1), { maxRedirects: 0 });
  expect(redirect.status()).toBe(308);
  expect(redirect.headers().location).toBe('/pdf-dd/');
  expect((await request.get(url + 'session.json')).status()).toBe(200);
  const index = await request.get(url);
  expect(index.status()).toBe(200);
  expect(index.headers()['cross-origin-resource-policy']).toBe('same-origin');
  expect((await request.get(url + 'discerner.svg')).status()).toBe(200);
  for (const route of ['..%2fserver%2fcli.js', '..%2fweb-private%2fsecret'])
    expect((await request.get(url + route)).status()).toBe(403);
  for (const site of ['cross-site', 'same-site', 'none']) {
    for (const route of ['session.json', 'input/0.pdf', 'api/pdf/' + 'a'.repeat(32) + '/working']) {
      expect(
        (await request.get(url + route, { headers: { 'sec-fetch-site': site } })).status(),
      ).toBe(403);
    }
    expect(
      (
        await request.post(url + 'api/git/pick', { headers: { 'sec-fetch-site': site }, data: {} })
      ).status(),
    ).toBe(403);
  }
  expect(
    (
      await request.get(url + 'session.json', {
        headers: { host: `localhost:${new URL(url).port}` },
      })
    ).status(),
  ).toBe(403);
  expect(
    (await request.get(url + 'session.json', { headers: { host: 'evil.example' } })).status(),
  ).toBe(403);
  expect(
    (
      await request.get(url + 'session.json', { headers: { origin: 'https://evil.example' } })
    ).status(),
  ).toBe(403);
  expect((await request.get(new URL('/etc/passwd', url).href)).status()).toBe(404);
  expect((await request.post(url + 'session.json')).status()).toBe(405);
  expect(
    (
      await request.post(url + 'api/git', {
        headers: { origin: 'https://evil.example' },
        data: { path: '/tmp/paper.pdf' },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post(url + 'api/git', { headers: { 'Content-Type': 'text/plain' }, data: '{}' })
    ).status(),
  ).toBe(415);
  expect((await request.get(url + 'api/pdf/' + 'a'.repeat(32) + '/working')).status()).toBe(400);
});

test('arXiv versions feed the existing comparison and keep the chosen order', async ({ page }) => {
  const history = {
    token: 'a'.repeat(32),
    kind: 'arxiv',
    title: 'Attention & revisions',
    arxivId: '1706.03762',
    subtitle: 'arXiv:1706.03762 · 3 published versions',
    revisions: [3, 2, 1].map((v) => ({
      id: `v${v}`,
      label: `v${v}`,
      date: `2023-08-0${v}T00:00:00Z`,
      detail: '',
    })),
    original: 'v1',
    modified: 'v3',
  };
  const requested: string[] = [];
  await page.route('**/api/arxiv', (route) => route.fulfill({ json: history }));
  await page.route('https://arxiv.org/pdf/**', async (route) => {
    const version = /v\d+$/.exec(route.request().url())![0];
    requested.push(version);
    await route.fulfill({
      contentType: 'application/pdf',
      body: await pdf(`Content in ${version}.`),
    });
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'arXiv', exact: true }).click();
  await expect(page.locator('#local-files')).toBeHidden();
  const lookup = page.waitForRequest('**/api/arxiv');
  await page.getByRole('button', { name: 'Find versions' }).click();
  expect((await lookup).postDataJSON()).toEqual({ url: 'https://arxiv.org/abs/1706.03762' });
  await expect(page.getByLabel('Original version')).toHaveValue('v1');
  await expect(page.getByLabel('Modified version')).toHaveValue('v3');
  await page.getByRole('radio', { name: 'Original v2', exact: true }).check();
  await expect(page.getByLabel('Original version')).toHaveValue('v2');
  await page.getByRole('radio', { name: 'Original v1', exact: true }).check();
  await expect(page.getByLabel('Original version')).toHaveValue('v1');
  await page.screenshot({ path: 'test-results/arxiv-source.png' });
  await page.locator('#compare').click();
  await expect(page.locator('#busy')).toBeHidden();
  await expect(page.locator('#reader-0 .rendered').first()).toBeVisible();
  await expect(page.locator('#name-0')).toContainText('(v1)');
  await expect(page.locator('#name-1')).toContainText('(v3)');
  expect(requested).toEqual(['v1', 'v3']);
  await page.locator('.brand strong').click();
  await expect(page.getByLabel('Original version')).toHaveValue('v1');
  await page.getByLabel('Original version').selectOption('v3');
  await expect(page.getByLabel('Modified version')).toHaveValue('v1');
  await page.getByRole('button', { name: 'Local files', exact: true }).click();
  await expect(page.locator('#local-files')).toBeVisible();
});
test('source errors and a single arXiv version cannot start a comparison', async ({ page }) => {
  await page.goto(url);
  await page.getByRole('button', { name: 'arXiv', exact: true }).click();
  await page.getByLabel('arXiv link or ID').fill('https://example.com/1706.03762');
  await page.getByRole('button', { name: 'Find versions' }).click();
  await expect(page.locator('#source-status')).toContainText('arxiv.org');
  await expect(page.locator('#compare')).toBeDisabled();
  await page.route('**/api/arxiv', (route) =>
    route.fulfill({
      json: {
        token: 'a'.repeat(32),
        kind: 'arxiv',
        title: 'First draft',
        subtitle: '1 published version',
        revisions: [{ id: 'v1', label: 'v1', date: '', detail: '' }],
        original: '',
        modified: 'v1',
      },
    }),
  );
  await page.getByLabel('arXiv link or ID').fill('1706.03762');
  await page.getByRole('button', { name: 'Find versions' }).click();
  await expect(page.locator('#source-status')).toContainText('only one');
  await expect(page.locator('#source-status')).toHaveClass(/error/);
  await expect(page.locator('#compare')).toBeDisabled();
  await page.getByRole('button', { name: 'Git history', exact: true }).click();
  await page.route('**/api/git/pick', (route) => route.fulfill({ json: null }));
  await page.getByRole('button', { name: 'Choose PDF', exact: true }).click();
  await expect(page.locator('#source-status')).toBeEmpty();
  await expect(page.locator('#compare')).toBeDisabled();
  await page.locator('#source-input').fill('/missing/document.pdf');
  await page.getByRole('button', { name: 'Find versions' }).click();
  await expect(page.locator('#source-status')).toContainText('not found');
});
test('real Git timeline selects historical and working PDFs without checkout', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-discerner-e2e-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    const path = join(root, 'paper.pdf');
    let first = '';
    for (let i = 1; i <= 23; i++) {
      await writeFile(path, await pdf(`Revision ${i} of the local paper.`));
      git('add', '.');
      git('commit', '-qm', `Revise paragraph ${i}`);
      if (i === 1) first = git('rev-parse', 'HEAD');
    }
    await writeFile(path, await pdf('Current uncommitted draft.'));
    const before = git('status', '--porcelain');
    await page.goto(url);
    await page.getByRole('button', { name: 'Git history', exact: true }).click();
    await page.locator('#source-input').fill(path);
    await page.getByRole('button', { name: 'Find versions' }).click();
    await expect(page.getByLabel('Modified version')).toHaveValue('working');
    await expect(page.locator('.timeline-row')).toHaveCount(21);
    await page.getByLabel('Original version').selectOption(first);
    await expect(
      page.getByRole('radio', { name: `Original ${first.slice(0, 7)}`, exact: true }),
    ).toBeChecked();

    await page.getByLabel('History range').selectOption('all');
    await expect(page.locator('.timeline-row')).toHaveCount(24);
    await page.getByRole('radio', { name: `Original ${first.slice(0, 7)}`, exact: true }).check();
    await expect(page.getByLabel('Original version')).toHaveValue(first);
    await page.getByLabel('History range').selectOption('20');
    await expect(
      page.getByRole('radio', { name: `Original ${first.slice(0, 7)}`, exact: true }),
    ).toBeChecked();
    await page.locator('#revision-timeline').evaluate((e) => {
      e.scrollTop = 0;
    });
    await page.screenshot({ path: 'test-results/git-source.png' });
    await page.locator('#compare').click();
    await expect(page.locator('#busy')).toBeHidden();
    await expect(page.locator('#reader-0 .rendered').first()).toBeVisible();
    await expect(page.locator('#name-0')).toContainText(first.slice(0, 7));
    await expect(page.locator('#name-1')).toContainText('Current file');
    expect(await page.locator('.change-card').count()).toBeGreaterThan(0);
    await page.locator('#brand').click();
    const latest = git('rev-parse', 'HEAD');
    await page.getByLabel('Modified version').selectOption(latest);
    await page.locator('#compare').click();
    await expect(page.locator('#busy')).toBeHidden();
    await expect(page.locator('#name-1')).toContainText(latest.slice(0, 7));
    expect(git('status', '--porcelain')).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.describe('source state and English dates', () => {
  test.use({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  test('preserves drafts, chosen revisions and ranges independently when switching sources', async ({
    page,
  }) => {
    const revisions = [3, 2, 1].map((v) => ({
      id: `v${v}`,
      label: `v${v}`,
      date: `2023-08-0${v}T17:42:00Z`,
      detail: '',
    }));
    const arxiv = {
      token: 'a'.repeat(32),
      kind: 'arxiv',
      title: 'Test paper',
      subtitle: '3 published versions',
      revisions,
      original: 'v1',
      modified: 'v3',
    };
    const git = {
      token: 'b'.repeat(32),
      kind: 'git',
      title: 'draft.pdf',
      path: '/example/draft.pdf',
      subtitle: '22 commits',
      revisions: [
        { id: 'working', label: 'Current file', date: '2023-08-03T17:42:00Z', detail: 'On disk' },
        { id: 'abcd123', label: 'abcd123', date: '2023-08-02T17:42:00Z', detail: 'Latest draft' },
        { id: 'abcd456', label: 'abcd456', date: '2023-08-01T17:42:00Z', detail: 'First draft' },
        ...Array.from({ length: 20 }, (_, i) => ({
          id: `older${i}`,
          label: `older${i}`,
          date: '2023-07-01T17:42:00Z',
          detail: `Earlier draft ${i}`,
        })),
      ],
      original: 'abcd123',
      modified: 'working',
    };
    await page.route('**/api/arxiv', (route) => route.fulfill({ json: arxiv }));
    await page.route('**/api/git', (route) => route.fulfill({ json: git }));
    await page.goto(url);
    for (const source of ['Local files', 'arXiv', 'Git history']) {
      await page.getByRole('button', { name: source, exact: true }).click();
      await expect(page.locator('.eyebrow')).toBeVisible();
      await expect(page.locator('.intro h1')).toHaveText('Two PDFs. Every difference.');
      await expect(page.locator('.intro p')).toBeVisible();
    }
    await page.locator('#source-input').fill('/example/draft.pdf');
    await page.getByRole('button', { name: 'arXiv', exact: true }).click();
    await page.locator('#source-input').fill('https://arxiv.org/abs/2401.01234');
    await page.getByRole('button', { name: 'Git history', exact: true }).click();
    await expect(page.locator('#source-input')).toHaveValue('/example/draft.pdf');
    await page.getByRole('button', { name: 'Find versions' }).click();
    await expect(page.getByRole('group', { name: 'Git revision timeline' })).toBeVisible();
    await page.getByRole('radio', { name: 'Original abcd456', exact: true }).check();
    await page.getByLabel('History range').selectOption('all');
    await expect(page.locator('.timeline-description small').first()).toHaveText(
      'Aug 4, 2023, 01:42 GMT+8 · On disk',
    );
    await expect(page.locator('#revision-0 option').first()).toContainText(
      'Aug 4, 2023, 01:42 GMT+8',
    );
    await page.getByRole('button', { name: 'arXiv', exact: true }).click();
    await expect(page.locator('#source-input')).toHaveValue('https://arxiv.org/abs/2401.01234');
    await page.getByRole('button', { name: 'Find versions' }).click();
    await expect(page.getByRole('group', { name: 'arXiv revision timeline' })).toBeVisible();
    await expect(page.getByLabel('Original version')).toHaveValue('v1');
    await page.getByRole('radio', { name: 'Original v2', exact: true }).check();
    await expect(page.locator('.timeline-description small').first()).toHaveText(
      'Aug 3, 2023, 17:42 UTC',
    );
    await expect(page.locator('#revision-0 option').first()).toContainText(
      'Aug 3, 2023, 17:42 UTC',
    );
    await page.getByRole('button', { name: 'Git history', exact: true }).click();
    await expect(page.getByLabel('Original version')).toHaveValue('abcd456');
    await expect(page.getByLabel('History range')).toHaveValue('all');
    await page.route('**/api/git/pick', (route) => route.fulfill({ json: null }));
    await page.getByRole('button', { name: 'Choose PDF', exact: true }).click();
    await expect(page.locator('#git-pick')).toBeEnabled();
    await expect(page.getByLabel('Original version')).toHaveValue('abcd456');
    await expect(page.getByLabel('History range')).toHaveValue('all');

    await page.getByRole('button', { name: 'Local files', exact: true }).click();
    await page.getByRole('button', { name: 'arXiv', exact: true }).click();
    await expect(page.getByLabel('Original version')).toHaveValue('v2');
    await expect(page.locator('#source-input')).toHaveValue('https://arxiv.org/abs/2401.01234');
  });
});

test.describe('source timezones with daylight saving', () => {
  test.use({ timezoneId: 'America/New_York' });
  test('keeps arXiv in UTC and converts Git dates using the offset at each revision', async ({
    page,
  }) => {
    const revisions = [
      { id: 'v2', label: 'v2', date: '2023-07-02T02:15:00Z', detail: '' },
      { id: 'v1', label: 'v1', date: '2023-01-02T02:15:00Z', detail: '' },
    ];
    for (const kind of ['arxiv', 'git']) {
      await page.route(`**/api/${kind}`, (route) =>
        route.fulfill({
          json: {
            token: 'a'.repeat(32),
            kind,
            title: 'Timezone test',
            subtitle: '2 versions',
            revisions,
            original: 'v1',
            modified: 'v2',
          },
        }),
      );
    }
    await page.goto(url);
    for (const source of ['arXiv', 'Git history']) {
      await page.getByRole('button', { name: source, exact: true }).click();
      await page.locator('#source-input').fill(source === 'arXiv' ? '1706.03762' : '/draft.pdf');
      await page.getByRole('button', { name: 'Find versions' }).click();
      const dates =
        source === 'arXiv'
          ? ['Jul 2, 2023, 02:15 UTC', 'Jan 2, 2023, 02:15 UTC']
          : ['Jul 1, 2023, 22:15 EDT', 'Jan 1, 2023, 21:15 EST'];
      for (const [index, date] of dates.entries()) {
        await expect(page.locator('.timeline-description small').nth(index)).toContainText(date);
        for (const side of [0, 1])
          await expect(page.locator(`#revision-${side} option`).nth(index)).toContainText(date);
      }
    }
  });
});

test('initial selection and replacement use the browser file picker without local API reads', async ({
  page,
}) => {
  const api: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/')) api.push(request.url());
  });
  await page.goto(url);
  const zone = page.locator('[data-upload="0"]');
  await expect(zone).toContainText('Drop a PDF here');
  for (const number of [1, 2]) {
    const choosing = page.waitForEvent('filechooser');
    await zone.click();
    const chooser = await choosing;
    expect(chooser.isMultiple()).toBe(false);
    await chooser.setFiles({
      name: `draft-${number}.pdf`,
      mimeType: 'application/pdf',
      buffer: await pdf(`Draft ${number}.`),
    });
    await expect(page.locator('#file-info-0')).toContainText(`draft-${number}.pdf`);
    await expect(zone).toContainText('Replace PDF');
  }
  // Dismissing the next picker must leave the chosen document intact.
  const choosing = page.waitForEvent('filechooser');
  await zone.click();
  await choosing;
  await page.locator('#file-0').dispatchEvent('cancel');
  await expect(page.locator('#file-info-0')).toContainText('draft-2.pdf');
  expect(api).toEqual([]);
});

test('timeline range appears only above twenty versions for both sources', async ({ page }) => {
  let count = 20;
  for (const kind of ['arxiv', 'git']) {
    await page.route(`**/api/${kind}`, (route) => {
      const revisions = Array.from({ length: count }, (_, i) => ({
        id: kind === 'git' && i === 0 ? 'working' : `v${count - i}`,
        label: kind === 'git' && i === 0 ? 'Current file' : `v${count - i}`,
        date: '2023-08-03T17:42:00Z',
        detail: `Revision ${count - i}`,
      }));
      return route.fulfill({
        json: {
          token: 'a'.repeat(32),
          kind,
          title: 'Timeline test',
          subtitle: `${count} versions`,
          revisions,
          original: kind === 'arxiv' ? revisions.at(-1)!.id : revisions[1].id,
          modified: revisions[0].id,
        },
      });
    });
  }
  await page.goto(url);
  for (const kind of ['arXiv', 'Git history']) {
    await page.getByRole('button', { name: kind, exact: true }).click();
    await page
      .locator('#source-input')
      .fill(kind === 'arXiv' ? '1706.03762' : '/example/paper.pdf');
    for (count of [20, 21]) {
      await page.getByRole('button', { name: 'Find versions' }).click();
      await expect(page.locator('.history-title > span')).toHaveText(`${count} versions`);
      if (kind === 'arXiv') {
        await expect(page.getByLabel('Original version')).toHaveValue('v1');
        await expect(page.getByRole('radio', { name: 'Original v1', exact: true })).toBeChecked();
      }
      if (count === 20) await expect(page.getByLabel('History range')).toBeHidden();
      else {
        await expect(page.locator('.timeline-label #history-range')).toBeVisible();
        await page.getByLabel('History range').selectOption('all');
        await expect(page.locator('.timeline-row')).toHaveCount(21);
      }
      await expect(page.locator('.timeline-toolbar')).toHaveCount(0);
      await expect(page.locator('.timeline-label > span')).toHaveText('Timeline');
    }
  }
});
