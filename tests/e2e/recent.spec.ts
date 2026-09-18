import { test, expect, chromium, type Page, type Route } from '@playwright/test';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStaticSite } from '../static-server';
import { parseArxivInput } from '../../src/shared/arxiv';
import { pdf } from './helpers';

let child: ChildProcess, localUrl: string, site: Awaited<ReturnType<typeof startStaticSite>>;
async function start(port = 0) {
  const process = spawn(globalThis.process.execPath, [
    'dist/local/server/cli.js',
    '--port',
    String(port),
    '--no-open',
  ]);
  const url = await new Promise<string>((done, reject) => {
    process.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\/pdf-dd\//);
      if (match) done(match[0]);
    });
    process.on('error', reject);
    process.on('exit', (code) => reject(new Error(`Server exited ${code}`)));
  });
  return { process, url };
}
async function stop(process: ChildProcess) {
  if (process.exitCode === null && process.signalCode === null) {
    process.kill();
    await once(process, 'exit');
  }
}
test.beforeAll(async () => {
  ({ process: child, url: localUrl } = await start());
  site = await startStaticSite();
});
test.afterAll(async () => {
  await stop(child);
  await site.close();
});

const arxivHistory = (id: string) => ({
  kind: 'arxiv',
  token: 'a'.repeat(32),
  arxivId: id,
  title: 'A sample paper',
  subtitle: '2 versions',
  original: 'v1',
  modified: 'v2',
  revisions: [2, 1].map((v) => ({ id: `v${v}`, label: `v${v}`, date: '', detail: '' })),
});
async function mockArxiv(page: Page) {
  const bytes = await pdf('A browser history fixture.');
  await page.route('https://arxiv.org/**', (route) =>
    route.fulfill({ contentType: 'application/pdf', body: bytes }),
  );
  await page.route('**/api/arxiv', (route) => {
    try {
      return route.fulfill({
        json: arxivHistory(parseArxivInput(route.request().postDataJSON().url).id),
      });
    } catch {
      return route.fulfill({
        status: 400,
        json: { error: 'Please enter a valid arXiv link or ID.' },
      });
    }
  });
}
async function arxiv(page: Page) {
  await page.getByRole('button', { name: 'arXiv', exact: true }).click();
}
async function load(page: Page, value: string) {
  await page.locator('#source-input').fill(value);
  await page.locator('#load-history').click();
  await expect(page.locator('#compare')).toBeEnabled();
}
const entries = (page: Page) => page.locator('[data-recent-select]');

for (const edition of ['web', 'local'] as const) {
  test(`${edition}: successful arXiv history persists, deduplicates versions, and supports keyboard selection and deletion`, async ({
    page,
    context,
  }) => {
    await mockArxiv(page);
    let requests = 0;
    page.on('request', (r) => {
      if (/arxiv\.org\/pdf\/|\/api\/arxiv$/.test(r.url())) requests++;
    });
    const url = edition === 'web' ? site.url : localUrl;
    await page.goto(url);
    await arxiv(page);
    await page.getByRole('button', { name: 'Recent links', exact: true }).click();
    await expect(page.getByText('No recent links yet.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#recent-toggle')).toBeFocused();
    for (const input of ['1706.03762v6', '1706.03762v7', 'https://arxiv.org/pdf/1706.03762v6.pdf'])
      await load(page, input);
    await page.locator('#source-input').fill('not-an-id');
    await page.locator('#load-history').click();
    await expect(page.locator('#source-status.error')).toBeVisible();
    await page.reload();
    await arxiv(page);
    await expect(page.locator('#source-input')).toHaveValue('');
    const panel = await page.locator('#version-source').boundingBox();
    await page.locator('#recent-toggle').click();
    expect(await page.locator('#version-source').boundingBox()).toEqual(panel);
    await expect(entries(page)).toHaveCount(2);
    await expect(entries(page).first()).toHaveAttribute('title', '1706.03762v6');
    await expect(entries(page).last()).toHaveAttribute('title', '1706.03762v7');
    await expect(entries(page).first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(entries(page).last()).toBeFocused();
    const before = requests;
    await page.keyboard.press('Enter');
    await expect(page.locator('#source-input')).toHaveValue('1706.03762v7');
    await expect(page.locator('#compare')).toBeDisabled();
    await expect(page.locator('#version-choices')).toBeHidden();
    expect(requests).toBe(before);
    await page.locator('#recent-toggle').click();
    await page.getByRole('heading', { name: 'Two PDFs. Every difference.' }).click();
    await expect(page.locator('#recent-sources')).toBeHidden();
    await page.locator('#recent-toggle').click();
    await page
      .getByRole('button', { name: 'Remove 1706.03762v6 from history', exact: true })
      .click();
    await expect(entries(page)).toHaveCount(1);
    // Another page in this browser sees the persisted deletion, without a source request.
    const reopened = await context.newPage();
    await reopened.goto(url);
    await arxiv(reopened);
    await reopened.locator('#recent-toggle').click();
    await expect(entries(reopened)).toHaveCount(1);
    await expect(entries(reopened).first()).toHaveAttribute('title', '1706.03762v7');
    await reopened.getByRole('button', { name: 'Clear all', exact: true }).click();
    await expect(reopened.getByText('No recent links yet.')).toBeVisible();
    await reopened.close();
    await page.reload();
    await arxiv(page);
    await page.locator('#recent-toggle').click();
    await expect(entries(page)).toHaveCount(0);
    expect(requests).toBe(before);
  });
  test(`${edition}: picking a recent source cancels old requests and invalidates their results`, async ({
    page,
  }) => {
    await mockArxiv(page);
    await page.goto(edition === 'web' ? site.url : localUrl);
    await arxiv(page);
    await load(page, '1706.03762v6');
    const held: Route[] = [];
    let cancelled = 0;
    page.on('requestfailed', (r) => {
      if (/arxiv\.org\/pdf\/|\/api\/arxiv$/.test(r.url())) cancelled++;
    });
    await page.route(edition === 'web' ? 'https://arxiv.org/**' : '**/api/arxiv', (route) => {
      held.push(route);
    });
    await page.locator('#source-input').fill('2401.00001');
    await page.locator('#load-history').click();
    await expect.poll(() => held.length).toBe(edition === 'web' ? 2 : 1);
    await page.locator('#recent-toggle').click();
    await entries(page).first().click();
    await expect(page.locator('#source-input')).toHaveValue('1706.03762v6');
    await expect(page.locator('#compare')).toBeDisabled();
    await expect(page.locator('#load-history')).toBeEnabled();
    await expect.poll(() => cancelled).toBe(edition === 'web' ? 2 : 1);
    const bytes = await pdf('A stale response.');
    await Promise.all(
      held.map((route) =>
        route
          .fulfill(
            edition === 'web'
              ? { contentType: 'application/pdf', body: bytes }
              : { json: arxivHistory('2401.00001') },
          )
          .catch(() => {}),
      ),
    );
    await expect(page.locator('#version-choices')).toBeHidden();
    await page.locator('#recent-toggle').click();
    await expect(entries(page)).toHaveCount(1);
    await expect(entries(page).first()).toHaveAttribute('title', '1706.03762v6');
  });
  test(`${edition}: unavailable storage keeps working in-memory history and comparison`, async ({
    page,
  }) => {
    await page.addInitScript(() =>
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('Blocked', 'SecurityError');
        },
      }),
    );
    await mockArxiv(page);
    await page.goto(edition === 'web' ? site.url : localUrl);
    await arxiv(page);
    await load(page, '1706.03762');
    await page.locator('#recent-toggle').click();
    await expect(entries(page)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.locator('#compare').click();
    await expect(page.locator('#reader-0 .rendered').first()).toBeVisible();
  });
}

test('Git typed paths, the system picker and dropped files all record the returned canonical path', async ({
  page,
}) => {
  const path =
    '/Users/example/Papers/A very long research folder/document with a long filename.pdf';
  const result = {
    kind: 'git',
    token: 'b'.repeat(32),
    title: 'document with a long filename.pdf',
    path,
    subtitle: '1 commit',
    original: 'abc1234',
    modified: 'working',
    revisions: [
      { id: 'working', label: 'Current file', date: '', detail: '' },
      { id: 'abc1234', label: 'abc1234', date: '', detail: '' },
    ],
  };
  const requests: string[] = [];
  await page.route('**/api/git{,/**}', (route) => {
    requests.push(route.request().url());
    return route.fulfill({ json: result });
  });
  await mockArxiv(page);
  await page.goto(localUrl);
  await arxiv(page);
  await load(page, '1706.03762v6');
  await page.getByRole('button', { name: 'Git history', exact: true }).click();
  await load(page, '~/draft.pdf');
  await expect(page.locator('#source-input')).toHaveValue(path);
  await page.getByRole('button', { name: 'Choose PDF', exact: true }).click();
  await expect(page.locator('#compare')).toBeEnabled();
  await page.locator('#version-source').evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(new File(['%PDF-fixture'], 'document.pdf', { type: 'application/pdf' }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data }));
  });
  await expect(page.locator('#compare')).toBeEnabled();
  expect(requests.map((url) => new URL(url).pathname)).toEqual([
    '/pdf-dd/api/git',
    '/pdf-dd/api/git/pick',
    '/pdf-dd/api/git/drop',
  ]);
  // Compare both buttons at rest, after the picker's hover transition has finished.
  await page.mouse.move(0, 0);
  await expect(async () => {
    const buttons = await page.locator('.source-icon-button').evaluateAll((elements) =>
      elements.map((el) => {
        const rect = el.getBoundingClientRect(),
          css = getComputedStyle(el);
        return {
          width: rect.width,
          height: rect.height,
          radius: css.borderRadius,
          color: css.color,
          background: css.backgroundColor,
          border: css.border,
        };
      }),
    );
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toEqual(buttons[1]);
    expect(buttons[0].width).toBe(36);
    expect(buttons[0].height).toBe(36);
  }).toPass({ timeout: 5000 });
  await page.getByRole('button', { name: 'Recent paths', exact: true }).click();
  await expect(entries(page)).toHaveCount(1);
  await expect(entries(page).first()).toHaveAttribute('title', path);
  await page.screenshot({ path: 'test-results/recent-git.png' });
  await entries(page).first().click();
  await expect(page.locator('#compare')).toBeDisabled();
  expect(requests).toHaveLength(3);
  await page.locator('#recent-toggle').click();
  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  await expect(page.getByText('No recent paths yet.')).toBeVisible();
  await arxiv(page);
  await page.locator('#recent-toggle').click();
  await expect(entries(page)).toHaveCount(1);
});

test('many recent entries scroll inside the popup and support Home, End and Tab', async ({
  page,
}) => {
  await page.goto(site.url);
  await page.evaluate(() =>
    localStorage.setItem(
      'pdf-dd:recent-sources:v1:web',
      JSON.stringify({
        arxiv: Array.from({ length: 20 }, (_, i) => ({
          value: `2401.${String(i).padStart(5, '0')}`,
          name: 'A long paper title '.repeat(8),
        })),
        git: [],
      }),
    ),
  );
  await page.reload();
  await arxiv(page);
  await page.locator('#recent-toggle').click();
  await expect(entries(page)).toHaveCount(20);
  expect(
    await page
      .locator('.recent-popover ul')
      .evaluate((el) => el.scrollHeight > el.clientHeight && el.clientHeight <= 320),
  ).toBe(true);
  await page.keyboard.press('End');
  await expect(entries(page).last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(entries(page).first()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-recent-remove]').first()).toBeFocused();
  await page.screenshot({ path: 'test-results/recent-arxiv.png' });
});

test('browser and server restarts at the same address preserve only recent source metadata', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'pdf-dd-browser-history-'));
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  const options = { channel: process.env.CI ? undefined : 'chrome', headless: true };
  try {
    context = await chromium.launchPersistentContext(profile, options);
    let page = await context.newPage();
    await mockArxiv(page);
    await page.goto(localUrl);
    await arxiv(page);
    await load(page, '1706.03762v6');
    await context.close();
    context = undefined;
    const address = localUrl;
    await stop(child);
    ({ process: child, url: localUrl } = await start(Number(new URL(address).port)));
    expect(localUrl).toBe(address);
    context = await chromium.launchPersistentContext(profile, options);
    page = await context.newPage();
    await page.goto(localUrl);
    await arxiv(page);
    await expect(page.locator('#compare')).toBeDisabled();
    await page.locator('#recent-toggle').click();
    await expect(entries(page).first()).toHaveAttribute('title', '1706.03762v6');
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('pdf-dd:recent-sources:v1:local')!),
    );
    expect(saved).toEqual({ arxiv: [{ value: '1706.03762v6', name: 'A sample paper' }], git: [] });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('default port 8765 conflicts exit clearly without switching ports or stopping the listener', async () => {
  const occupied = createServer();
  let ownsPort = false;
  try {
    ownsPort = await new Promise<boolean>((done, reject) => {
      occupied.once('error', (error: NodeJS.ErrnoException) =>
        error.code === 'EADDRINUSE' ? done(false) : reject(error),
      );
      occupied.listen(8765, '127.0.0.1', () => done(true));
    });
    await expect(
      promisify(execFile)(process.execPath, ['dist/local/server/cli.js', '--no-open'], {
        timeout: 5000,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringMatching(
        /Port 8765 is already in use.*Close the previous instance.*--port.*separate browser history/,
      ),
    });
    if (ownsPort) expect(occupied.listening).toBe(true);
  } finally {
    if (ownsPort) await new Promise<void>((done) => occupied.close(() => done()));
  }
});
