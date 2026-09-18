import type { IncomingMessage, ServerResponse } from 'node:http';
import { Sources } from './sources.js';
import { ArxivRateLimitError } from '../shared/arxiv-rate-limit.js';

export async function sourceApi(
  sources: Sources,
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  };
  try {
    if (req.method === 'GET') {
      const match = /^api\/pdf\/([a-f0-9]{32})\/([a-zA-Z0-9]+)$/.exec(route);
      if (!match) return json({ error: 'Unknown source endpoint.' }, 404);
      const bytes = await sources.pdf(match[1], match[2]);
      res
        .writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length })
        .end(bytes);
      return;
    }
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    if (!req.headers['content-type']?.startsWith('application/json'))
      return json({ error: 'JSON input required.' }, 415);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) return json({ error: 'Input too large.' }, 413);
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
      string,
      unknown
    >;
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Invalid input.');
    const string = (key: string) => {
      if (typeof input[key] !== 'string' || !input[key]) throw new Error(`Please provide ${key}.`);
      return input[key] as string;
    };
    switch (route) {
      case 'api/arxiv':
        return json(await sources.arxivHistory(string('url')));
      case 'api/git':
        return json(await sources.gitHistory(string('path')));
      case 'api/git/drop':
        return json(
          await sources.findDropped(string('name'), Number(input.size), string('sha256')),
        );
      case 'api/git/pick': {
        const path = await sources.chooseFile();
        return json(path ? await sources.gitHistory(path) : null);
      }
      default:
        return json({ error: 'Unknown source endpoint.' }, 404);
    }
  } catch (e) {
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    if (e instanceof ArxivRateLimitError) {
      res.setHeader('Retry-After', e.retryAfter!);
      json({ error: e.message, code: 'ARXIV_RATE_LIMITED', retryAfter: e.retryAfter }, 429);
      return;
    }
    const error = e as Error & { code?: string };
    const message =
      error.name === 'TimeoutError' || error.name === 'AbortError'
        ? 'The request timed out. Please try again.'
        : error.message === 'fetch failed'
          ? 'Could not reach arXiv. Check your connection and try again.'
          : error.message;
    json({ error: message, code: error.code }, 400);
  }
}
