// Optional real-paper regressions; PDFs and reports stay in the ignored tmp folder.
// npm run test:papers -- --download [--baseline]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const fixtureIndex = process.argv.indexOf('--fixture');
if (fixtureIndex >= 0 && !process.argv[fixtureIndex + 1])
  throw new Error('--fixture needs a path.');
const annotations = JSON.parse(
  await readFile(
    fixtureIndex >= 0 ? process.argv[fixtureIndex + 1] : 'tests/fixtures/paper-passages.json',
    'utf8',
  ),
);
const papers: { name: string; id: string; versions: number[]; group: string }[] =
  annotations.samples.map((sample: any) => ({
    name: sample.name,
    id: new URL(sample.files[0].url).pathname.match(/\/pdf\/([\d.]+)v\d+$/)![1],
    versions: sample.files.map((file: any) => file.version),
    group: 'regression',
  }));
const root = resolve('tmp/accuracy');
const outputIndex = process.argv.indexOf('--output-dir');
if (outputIndex >= 0 && !process.argv[outputIndex + 1])
  throw new Error('--output-dir needs a path.');
const resultsRoot = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : `${root}/results`;
await mkdir(`${root}/papers`, { recursive: true });
await mkdir(resultsRoot, { recursive: true });
const baseline = process.argv.includes('--baseline');
const label = baseline ? 'baseline' : 'optimized';
const manifest = [];
for (const paper of papers) {
  const files = [];
  for (const version of paper.versions) {
    const url = `https://arxiv.org/pdf/${paper.id}v${version}`;
    const path = `${root}/papers/${paper.id}v${version}.pdf`;
    let bytes = await readFile(path).catch(() => null);
    if (!bytes && process.argv.includes('--download')) {
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error(`${url}: not a PDF`);
      await writeFile(path, bytes);
      await new Promise((done) => setTimeout(done, 3000));
    }
    if (!bytes) throw new Error(`Missing ${path}; run with --download.`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const expected = annotations.samples
      .flatMap((p: any) => p.files)
      .find((f: any) => f.url === url)?.sha256;
    if (expected !== sha256) throw new Error(`Sample checksum changed or missing: ${url}`);
    files.push({ version, url, path, sha256, pages: 0 });
  }
  manifest.push({ ...paper, files });
}

const server = await createServer({
  configFile: false,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
const browser = await chromium
  .launch({ channel: 'chrome', headless: true })
  .catch(async (error) => {
    await server.close();
    throw error;
  });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route('**/pdf-assets/**', async (route) => {
    const asset = new URL(route.request().url()).pathname.split('/pdf-assets/')[1];
    await route.fulfill({ body: await readFile(resolve('node_modules/pdfjs-dist', asset)) });
  });
  const address = server.httpServer!.address() as { port: number };
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const reports = [];
  for (const paper of manifest) {
    const files = await Promise.all(
      paper.files.map(async (f) => (await readFile(f.path)).toString('base64')),
    );
    const report = await page.evaluate(
      async ({ files, baseline, cases }) => {
        const base = baseline ? '/tmp/accuracy/baseline/src/client' : '/src/client';
        const { Document, Locations } = await import(`${base}/pdf.ts`);
        const { compare } = await import(`${base}/core.ts`);
        const textModule = '/src/client/text.ts';
        const { normalizeText } = await import(textModule);
        const docs = [];
        try {
          for (const file of files) {
            const bytes = Uint8Array.from(atob(file), (c) => c.charCodeAt(0));
            docs.push(await Document.load(new File([bytes], 'paper.pdf'), () => {}));
          }
          const start = performance.now();
          const comparison = compare(docs[0].pages, docs[1].pages);
          const compareMs = Math.round(performance.now() - start);
          const identical = docs.map((doc) => compare(doc.pages, doc.pages).changes.length);
          const covered = [new Set<string>(), new Set<string>()];
          const edited = [new Set<string>(), new Set<string>()];
          for (const change of comparison.changes)
            for (const side of [0, 1])
              for (const ref of change[side ? 'right' : 'left'])
                for (let i = ref.start; i < ref.end; i++) {
                  const key = `${ref.page},${ref.item},${i}`;
                  covered[side].add(key);
                  if (change.kind !== 'moved') edited[side].add(key);
                }
          const passages = [];
          for (const c of cases) {
            const sides = [];
            for (const side of [0, 1]) {
              const range = c.sides[side];
              if (!range) {
                sides.push(null);
                continue;
              }
              const { start, end } = range;
              let source = '',
                total = 0,
                highlighted = 0;
              for (let p = start.page; p <= end.page; p++)
                for (
                  let item = p === start.page ? start.item : 0;
                  item <= (p === end.page ? end.item : docs[side].pages[p].items.length - 1);
                  item++
                ) {
                  const text = docs[side].pages[p].items[item].str;
                  const from = p === start.page && item === start.item ? start.offset : 0;
                  const to = p === end.page && item === end.item ? end.offset : text.length;
                  source += text.slice(from, to);
                  for (let i = from; i < to; i++)
                    if (/[\p{L}\p{N}]/u.test(text[i])) {
                      total++;
                      if ((c.mayMove ? edited : covered)[side].has(`${p},${item},${i}`))
                        highlighted++;
                    }
                }
              const canonical = normalizeText(source)
                .replace(/[^\p{L}\p{N}]/gu, '')
                .toLowerCase();
              const digest = await crypto.subtle.digest(
                'SHA-256',
                new TextEncoder().encode(canonical),
              );
              const sha = [...new Uint8Array(digest)]
                .map((v) => v.toString(16).padStart(2, '0'))
                .join('');
              if (sha !== range.sha256)
                throw new Error(`Passage source changed: ${c.label}, side ${side}`);
              sides.push({ total, highlighted });
            }
            passages.push({
              label: c.label,
              expect: c.expect,
              sides,
              passed: sides.every(
                (s) =>
                  !s ||
                  (c.expect === 'unchanged'
                    ? s.highlighted === 0
                    : s.total > 0 && s.highlighted === s.total),
              ),
            });
          }
          const locations = new Locations(docs, comparison.changes);
          await locations.ensureAll(() => {});
          const missing = comparison.changes.flatMap((change: any) =>
            [0, 1].flatMap((side) =>
              [...new Set(change[side ? 'right' : 'left'].map((s: any) => s.page))]
                .filter(
                  (p) =>
                    !(locations.geometry[side ? 'right' : 'left'][change.id] ?? []).some(
                      (r: any) => r.page === p,
                    ),
                )
                .map((p) => ({ id: change.id, side, page: p })),
            ),
          );
          return {
            pages: docs.map((doc) => doc.pages.length),
            compareMs,
            identical,
            changes: comparison.changes,
            coarse: comparison.coarse ?? false,
            pagePairs: comparison.pagePairs,
            missing,
            geometryIssues: locations.issues ? [...locations.issues] : [],
            passages,
          };
        } finally {
          for (const doc of docs) await doc.destroy();
        }
      },
      {
        files,
        baseline,
        cases: baseline ? [] : annotations.cases.filter((c: any) => c.paper === paper.name),
      },
    );
    if (report.identical.some((count: number) => count !== 0))
      throw new Error(`${paper.name}: false self-diff`);
    if (!baseline && (report.missing.length || report.geometryIssues.length || report.coarse))
      throw new Error(
        `${paper.name}: incomplete comparison; inspect missing highlights and geometry issues.`,
      );
    if (report.passages.some((c: any) => !c.passed))
      throw new Error(
        `${paper.name}: passage regression: ${JSON.stringify(report.passages.filter((c: any) => !c.passed))}`,
      );
    paper.files.forEach((file, index) => {
      file.pages = report.pages[index];
    });
    reports.push({ ...paper, ...report });
    await writeFile(`${resultsRoot}/${label}.json`, JSON.stringify(reports, null, 2) + '\n');
    console.log(
      JSON.stringify({
        name: paper.name,
        pages: report.pages,
        changes: report.changes.length,
        compareMs: report.compareMs,
        coarse: report.coarse,
        missing: report.missing.length,
        geometryIssues: report.geometryIssues.length,
        passages: report.passages.filter((c: any) => c.passed).length,
      }),
    );
  }
  await writeFile(
    `${outputIndex >= 0 ? resultsRoot : `${root}/papers`}/manifest.json`,
    JSON.stringify(manifest, null, 2) + '\n',
  );
} finally {
  await browser.close();
  await server.close();
}
