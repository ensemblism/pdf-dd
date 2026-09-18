import { afterEach, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rename, mkdir, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArxiv, Sources } from '../src/server/sources';
import { parseArxivInput } from '../src/shared/arxiv';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const html = `<meta name="citation_title" content="Attention &amp; a paper's revisions"><div class="submission-history"><h2>Submission history</h2><strong><a href="/abs/1706.03762v1">[v1]</a></strong> Mon, 12 Jun 2017 17:57:34 UTC (1,102 KB)<br/><strong>[v2]</strong> Wed, 2 Aug 2023 00:41:18 UTC (1,124 KB)<br/></div>`;
const pdf = (text: string) => Buffer.from(`%PDF-1.7\n${text}`);
async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'pdf-discerner-git-'));
  directories.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  return { root, git };
}
describe('arXiv sources', () => {
  test('normalizes abstract, PDF, versioned and legacy IDs; rejects arbitrary hosts and paths', () => {
    for (const input of [
      '1706.03762',
      'arXiv:1706.03762v6',
      'https://arxiv.org/abs/1706.03762v7',
      'https://arxiv.org/pdf/1706.03762v6.pdf?download=1',
    ])
      expect(parseArxivInput(input).id).toBe('1706.03762');
    expect(parseArxivInput('https://arxiv.org/abs/hep-th/9901001v2').id).toBe('hep-th/9901001');
    for (const input of [
      'https://evil.test/abs/1706.03762',
      'https://arxiv.org.evil.test/abs/1706.03762',
      'https://arxiv.org:123/abs/1706.03762',
      'https://user@arxiv.org/abs/1706.03762',
      '../../etc/passwd',
      'file:///tmp/test.pdf',
      'https://arxiv.org/help',
    ])
      expect(() => parseArxivInput(input).id).toThrow();
  });
  test('reads every published version, including the unlinked latest version', () => {
    const result = parseArxiv(html, '1706.03762');
    expect(result.title).toBe("Attention & a paper's revisions");
    expect(result.revisions.map((r) => r.id)).toEqual(['v2', 'v1']);
    expect(result.revisions[0].date).toBe('2023-08-02T00:41:18.000Z');
    expect(() => parseArxiv('<h1>Not found</h1>', '1706.03762')).toThrow();
  });
  test('returns the base ID for browser downloads, disables the PDF proxy and rejects unsafe redirects', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(html));
    const sources = new Sources();
    const history = await sources.arxivHistory('1706.03762');
    expect(history.original).toBe('v1');
    expect(history.modified).toBe('v2');
    await expect(sources.pdf(history.token, 'v999')).rejects.toThrow('expired');
    expect(history.arxivId).toBe('1706.03762');
    await expect(sources.pdf(history.token, 'v2')).rejects.toThrow('directly in the browser');
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
    );
    await expect(new Sources().arxivHistory('1706.03762')).rejects.toThrow('unsupported host');
  });
  test.each([1, 2, 7, 25])(
    'defaults to earliest and latest when %i published versions are available',
    async (count) => {
      const historyHtml = `<div class="submission-history">${Array.from(
        { length: count },
        (_, index) => `[v${index + 1}] Wed, 2 Aug 2023 00:41:18 UTC<br/>`,
      ).join('')}</div>`;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(historyHtml));
      const sources = new Sources();
      for (const input of ['1706.03762', `1706.03762v${count}`]) {
        const history = await sources.arxivHistory(input);
        expect(history.original).toBe(count > 1 ? 'v1' : '');
        expect(history.modified).toBe(`v${count}`);
      }
    },
  );
  test.each(['12', 'Fri, 18 Sep 2026 00:00:12 GMT'])(
    'honors Retry-After %s and makes no upstream requests during the pause',
    async (retryAfter) => {
      let now = Date.parse('2026-09-18T00:00:00Z');
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(html));
      const sources = new Sources();
      await sources.arxivHistory('1706.03762');
      fetch.mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'Retry-After': retryAfter } }),
      );
      await expect(sources.arxivHistory('1706.03762')).rejects.toMatchObject({ retryAfter: 12 });
      now += 5000;
      await expect(sources.arxivHistory('1706.03762')).rejects.toMatchObject({ retryAfter: 7 });
      await expect(sources.arxivHistory('1706.03762')).rejects.toMatchObject({ retryAfter: 7 });
      expect(fetch).toHaveBeenCalledTimes(2);
      now += 7000;
      fetch.mockResolvedValueOnce(new Response(html));
      expect((await sources.arxivHistory('1706.03762')).arxivId).toBe('1706.03762');
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );
  test('backs off only after 429, caps the fallback, and resets after a successful history request', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(html));
    const sources = new Sources();
    await sources.arxivHistory('1706.03762');
    for (const seconds of [15, 30, 60, 120, 120]) {
      fetch.mockResolvedValueOnce(new Response('', { status: 429 }));
      await expect(sources.arxivHistory('1706.03762')).rejects.toMatchObject({
        retryAfter: seconds,
      });
      const calls = fetch.mock.calls.length;
      await expect(sources.arxivHistory('1706.03762')).rejects.toMatchObject({
        retryAfter: seconds,
      });
      expect(fetch).toHaveBeenCalledTimes(calls);
      now += seconds * 1000;
    }
    fetch.mockResolvedValueOnce(new Response(html));
    await sources.arxivHistory('1706.03762');
    // The next version starts immediately at the same clock time; there is no fixed interval.
    fetch.mockResolvedValueOnce(new Response(html));
    expect((await sources.arxivHistory('1706.03762')).arxivId).toBe('1706.03762');
    fetch.mockResolvedValueOnce(
      new Response('', { status: 429, headers: { 'Retry-After': 'invalid' } }),
    );
    await expect(sources.arxivHistory('1706.03762')).rejects.toMatchObject({ retryAfter: 15 });
  });
});
describe('Git sources', () => {
  test('reads nested, renamed PDF history and current bytes without altering the repository', async () => {
    const { root, git } = await repo();
    const old = join(root, 'old [draft].pdf');
    await writeFile(old, pdf('First'));
    git('add', '.');
    git('commit', '-qm', 'First draft');
    const first = git('rev-parse', 'HEAD');
    await writeFile(old, pdf('Second'));
    git('add', '.');
    git('commit', '-qm', 'Revised draft');
    await mkdir(join(root, 'papers', 'nested'), { recursive: true });
    const path = join(root, 'papers', 'nested', 'paper [final].pdf');
    await rename(old, path);
    git('add', '-A');
    git('commit', '-qm', 'Rename the paper');
    await writeFile(path, pdf('Uncommitted edits'));
    const before = git('status', '--porcelain');
    const sources = new Sources(root);
    const history = await sources.gitHistory(path);
    expect(history.revisions.map((r) => r.detail)).toEqual([
      'On disk · includes uncommitted changes',
      'Rename the paper',
      'Revised draft',
      'First draft',
    ]);
    expect(history.original).toBe(git('rev-parse', 'HEAD'));
    expect(history.modified).toBe('working');
    expect(await sources.pdf(history.token, first)).toEqual(pdf('First'));
    expect(await sources.pdf(history.token, 'working')).toEqual(pdf('Uncommitted edits'));
    await expect(sources.pdf(history.token, '../HEAD')).rejects.toThrow('expired');
    expect(git('status', '--porcelain')).toBe(before);
    const bytes = await readFile(path);
    const dropped = await sources.findDropped(
      'paper [final].pdf',
      bytes.length,
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(dropped.path).toBe(await realpath(path));
    await expect(
      sources.findDropped('paper [final].pdf', bytes.length, '0'.repeat(64)),
    ).rejects.toThrow('full file path');
  });
  test('fails clearly for untracked files, missing history, and LFS pointer versions', async () => {
    const { root, git } = await repo();
    const path = join(root, 'paper.pdf');
    await writeFile(path, pdf('Not tracked'));
    const sources = new Sources(root);
    await expect(sources.gitHistory(path)).rejects.toThrow('tracked');
    git('add', '.');
    await expect(sources.gitHistory(path)).rejects.toThrow('commits');
    await writeFile(path, 'version https://git-lfs.github.com/spec/v1\noid sha256:123\nsize 100');
    git('add', '.');
    git('commit', '-qm', 'LFS pointer');
    const history = await sources.gitHistory(path);
    await expect(sources.pdf(history.token, history.original)).rejects.toThrow('Git LFS');
    await expect(sources.gitHistory(join(root, 'missing.pdf'))).rejects.toThrow('not found');
    await expect(sources.gitHistory(join(root, '.git/config'))).rejects.toThrow('PDF');
  });
});
