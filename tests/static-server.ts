import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { resolveStaticPath } from '../src/server/static-path';

/** Serve only the static output, deliberately under a repository subpath and without any APIs. */
export async function startStaticSite() {
  const root = resolve('dist/site');
  const prefix = '/pdf-dd/';
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
  };
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url!, 'http://127.0.0.1').pathname);
      if (!pathname.startsWith(prefix) || !['GET', 'HEAD'].includes(req.method!)) {
        res.writeHead(404).end();
        return;
      }
      const path = resolveStaticPath(root, pathname.slice(prefix.length));
      if (path === null) {
        res.writeHead(403).end();
        return;
      }
      const bytes = await readFile(path);
      res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}${prefix}`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
