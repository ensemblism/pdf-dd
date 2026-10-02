import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { chromium } from '@playwright/test';

const root = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), 'pdf-dd-package-'));
const npm = process.env.npm_execpath;
assert(npm, 'Run with npm run test:package.');
const runNpm = (args: string[], cwd = root) =>
  execFileSync(process.execPath, [npm, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
let child: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const site = await readFile('dist/site/index.html').catch(() => null);
  const output = runNpm(['pack', '--json', '--pack-destination', temporary]);
  const [pack] = JSON.parse(output.slice(output.indexOf('[\n'))) as {
    filename: string;
    files: { path: string; mode: number }[];
    size: number;
  }[];
  assert(
    pack.files.every(
      (f) =>
        ['package.json', 'README.md', 'LICENSE'].includes(f.path) ||
        f.path.startsWith('dist/local/'),
    ),
  );
  assert(pack.files.some((f) => f.path === 'dist/local/server/cli.js'));
  assert(pack.files.some((f) => f.path === 'dist/local/shared/arxiv.js'));
  assert(pack.files.some((f) => f.path === 'dist/local/web/THIRD_PARTY_NOTICES.txt'));
  if (site)
    assert.deepEqual(
      await readFile('dist/site/index.html'),
      site,
      'prepack must preserve the web edition',
    );
  const installed = join(temporary, 'installed');
  await mkdir(installed);
  runNpm([
    'install',
    '--prefix',
    installed,
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    join(temporary, pack.filename),
  ]);
  const cli = join(installed, 'node_modules/pdf-dd/dist/local/server/cli.js');
  assert.match(
    runNpm(['exec', '--offline', '--no', '--', 'pdf-dd', '--help'], installed),
    /pdf-dd \[original.pdf modified.pdf\]/,
  );
  assert.equal(
    runNpm(['exec', '--offline', '--no', '--', 'pdf-dd', '--version'], installed).trim(),
    JSON.parse(await readFile('package.json', 'utf8')).version,
  );
  for (const args of [['--port', '-1'], ['--port', '70000'], ['only-one.pdf']])
    assert.notEqual(spawnSync(process.execPath, [cli, ...args]).status, 0);

  const repo = join(temporary, 'repo');
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Package test');
  git('config', 'user.email', 'test@example.invalid');
  const bytes = async (text: string) => {
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage().drawText(text, { x: 50, y: 700, size: 14, font });
    return Buffer.from(await doc.save());
  };
  const old = await bytes('The earlier draft.'),
    newer = await bytes('The updated draft.');
  const paper = join(repo, 'paper with spaces.pdf');
  await writeFile(paper, old);
  git('add', '.');
  git('commit', '-qm', 'First version');
  const first = git('rev-parse', 'HEAD');
  await writeFile(paper, newer);
  git('commit', '-qam', 'Second version');
  const current = await bytes('The current working draft.');
  await writeFile(paper, current);
  const original = join(temporary, 'old paper.pdf');
  await writeFile(original, old);
  const before = git('status', '--porcelain');
  const history =
    '<meta name="citation_title" content="Package arXiv fixture"><div class="submission-history">[v1] Mon, 12 Jun 2017 17:57:34 UTC<br/>[v2] Wed, 2 Aug 2023 00:41:18 UTC<br/></div>';
  const preload = join(temporary, 'arxiv-fixture.mjs');
  await writeFile(
    preload,
    `const realFetch = globalThis.fetch; globalThis.fetch = (input, options) => {
    const url = new URL(input);
    if (url.hostname !== 'arxiv.org') return realFetch(input, options);
    return Promise.resolve(new Response(url.pathname.startsWith('/abs/') ? ${JSON.stringify(history)} : Buffer.from('${old.toString('base64')}', 'base64')));
  };`,
  );
  child = spawn(
    process.execPath,
    ['--import', pathToFileURL(preload).href, cli, original, paper, '--port', '0', '--no-open'],
    {
      cwd: installed,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const url = await new Promise<string>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged server did not start')), 15000);
    child!.on('error', reject);
    child!.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited: ${code}`));
    });
    child!.stdout!.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\/pdf-dd\//);
      if (match) {
        clearTimeout(timer);
        done(match[0]);
      }
    });
  });
  assert.equal((await fetch(url + 'session.json').then((r) => r.json())).files.length, 2);
  browser = await chromium.launch({
    channel: process.env.CI ? undefined : 'chrome',
    headless: true,
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.locator('#result-screen:not([hidden])').waitFor();
  await page.locator('#reader-0 .rendered').first().waitFor();
  assert.equal(await page.locator('#name-0').innerText(), 'old paper.pdf');
  const post = (endpoint: string, body: unknown) =>
    fetch(url + 'api/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => {
      assert(r.ok, await r.clone().text());
      return r.json();
    });
  const gitHistory = await post('git', { path: paper });
  assert.equal(gitHistory.revisions.length, 3);
  const gitBytes = await (await fetch(`${url}api/pdf/${gitHistory.token}/${first}`)).arrayBuffer();
  assert.deepEqual(Buffer.from(gitBytes), old);
  assert.equal(git('status', '--porcelain'), before);
  const arxiv = await post('arxiv', { url: '1706.03762v6' });
  assert.deepEqual(
    arxiv.revisions.map((r: { id: string }) => r.id),
    ['v2', 'v1'],
  );
  assert.equal(arxiv.arxivId, '1706.03762');
  assert.equal((await fetch(`${url}api/pdf/${arxiv.token}/v1`)).status, 400);
  const arxivRequests: string[] = [];
  await page.route('https://arxiv.org/pdf/**', (route) => {
    arxivRequests.push(route.request().url());
    return route.fulfill({ contentType: 'application/pdf', body: old });
  });
  await page.locator('#brand').click();
  await page.getByRole('button', { name: 'arXiv', exact: true }).click();
  await page.getByRole('button', { name: 'Find versions' }).click();
  await page.locator('#compare:not([disabled])').click();
  await page.locator('#result-screen:not([hidden])').waitFor();
  assert.deepEqual(arxivRequests.sort(), [
    'https://arxiv.org/pdf/1706.03762v1',
    'https://arxiv.org/pdf/1706.03762v2',
  ]);
  assert.deepEqual(errors, []);
  console.log(
    `Package smoke test passed: ${pack.filename} (${(pack.size / 1024 / 1024).toFixed(2)} MB), offline npx, CLI inputs, browser assets, arXiv and Git history.`,
  );
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  await rm(temporary, { recursive: true, force: true });
}
