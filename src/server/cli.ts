#!/usr/bin/env node
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, access, readFile } from 'node:fs/promises';
import { resolve, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import open from 'open';
import { Sources } from './sources.js';
import { sourceApi } from './source-api.js';
import { resolveStaticPath } from './static-path.js';

const help = `pdf-dd [original.pdf modified.pdf] [--port PORT] [--no-open]

No files: open the local drag-and-drop comparison page.
Two files: compare them automatically (original on the left).
Default address: http://127.0.0.1:8765/pdf-dd/
Use --port PORT to choose another port, or --port 0 for a temporary port.
Everything is processed on your computer. Press Ctrl+C to stop.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  if (values.version) {
    const pkg = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    );
    console.log(pkg.version);
    return;
  }
  if (positionals.length !== 0 && positionals.length !== 2)
    throw new Error('Provide either zero or two PDF files.\n' + help);
  const port = values.port === undefined ? 8765 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Port must be an integer between 0 and 65535.');
  const files = positionals.map((p) => resolve(p));
  for (const file of files) {
    await access(file);
    if (!(await stat(file)).isFile()) throw new Error(`Not a file: ${file}`);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../web');
  await access(resolve(root, 'index.html'));
  const prefix = '/pdf-dd/';
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.json': 'application/json',
  };
  const sources = new Sources();
  const server = createServer(async (req, res) => {
    try {
      const expectedHost = `127.0.0.1:${(server.address() as { port: number }).port}`;
      if (
        req.headers.host !== expectedHost ||
        (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)
      ) {
        res.writeHead(403).end();
        return;
      }
      const address = new URL(req.url ?? '/', `http://${expectedHost}`);
      const pathname = address.pathname;
      if (pathname === '/pdf-dd' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(308, { Location: prefix + address.search }).end();
        return;
      }
      if (!pathname.startsWith(prefix)) {
        res.writeHead(404).end();
        return;
      }
      const route = decodeURIComponent(pathname.slice(prefix.length));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' blob: https://arxiv.org https://www.arxiv.org https://export.arxiv.org; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
      );
      // The page URL is public. Sensitive reads must not be embedded or navigated to
      // from another site (including another loopback port); JSON POSTs also require
      // same-origin browser access via the Origin check and existing content-type check.
      if (
        /^(api\/|input\/|session\.json$)/.test(route) &&
        req.headers['sec-fetch-site'] &&
        req.headers['sec-fetch-site'] !== 'same-origin'
      ) {
        res.writeHead(403).end();
        return;
      }
      if (route.startsWith('api/')) {
        await sourceApi(sources, route, req, res);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      if (route === 'session.json') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            files: files.map((file, i) => ({ name: basename(file), url: `input/${i}.pdf` })),
          }),
        );
        return;
      }
      const input = /^input\/([01])\.pdf$/.exec(route);
      let path: string;
      if (input) {
        path = files[Number(input[1])];
        if (!path) {
          res.writeHead(404).end();
          return;
        }
      } else {
        const staticPath = resolveStaticPath(root, route);
        if (staticPath === null) {
          res.writeHead(403).end();
          return;
        }
        path = staticPath;
      }
      const info = await stat(path);
      if (!info.isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader(
        'Content-Type',
        input ? 'application/pdf' : (types[extname(path)] ?? 'application/octet-stream'),
      );
      res.setHeader('Content-Length', info.size);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(path);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(
      error.code === 'EADDRINUSE'
        ? `pdf-dd: Port ${port} is already in use. Close the previous instance or use --port with another port. A different port has separate browser history storage.`
        : `pdf-dd: ${error.message}`,
    );
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', async () => {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${prefix}`;
    console.log(`\nPDF Diff Discerner  ·  Local & private\n${url}\n\nPress Ctrl+C to stop.\n`);
    if (!values['no-open'])
      await open(url).catch(() => console.log('Open the URL above in your browser.'));
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      server.closeAllConnections();
      server.close();
    });
}
main().catch((error) => {
  console.error(`pdf-dd: ${error.message}`);
  process.exitCode = 1;
});
