import { describe, expect, test } from 'vitest';
import { posix, win32 } from 'node:path';
import { resolveStaticPath } from '../src/server/static-path';

describe.each([
  { name: 'POSIX', paths: posix, root: '/package/web' },
  { name: 'Windows drive', paths: win32, root: String.raw`C:\package\web` },
  { name: 'Windows UNC', paths: win32, root: String.raw`\\server\share\package\web` },
])('static paths on $name', ({ paths, root }) => {
  test.each([
    ['', 'index.html'],
    ['index.html', 'index.html'],
    ['assets/main.js', 'assets/main.js'],
    ['pdf-assets/wasm/openjpeg.wasm', 'pdf-assets/wasm/openjpeg.wasm'],
    ['assets/../index.html', 'index.html'],
    ['..notes.txt', '..notes.txt'],
  ])('serves the contained route %j', (route, expected) => {
    expect(resolveStaticPath(root, route, paths)).toBe(paths.join(root, expected));
  });

  test.each(['..', '.', 'assets/..', '../server/cli.js', '../web-private/secret', '../../secret'])(
    'rejects the route %j outside the static directory',
    (route) => {
      expect(resolveStaticPath(root, route, paths)).toBeNull();
    },
  );
});

test('Windows rejects backslash traversal, other drives and other UNC shares', () => {
  const root = String.raw`C:\package\web`;
  for (const route of [
    String.raw`..\server\cli.js`,
    String.raw`..\web-private\secret`,
    String.raw`D:\private\secret`,
    String.raw`\\other\share\secret`,
  ])
    expect(resolveStaticPath(root, route, win32)).toBeNull();
  expect(
    resolveStaticPath(String.raw`\\server\share\web`, String.raw`\\server\other\secret`, win32),
  ).toBeNull();
});
