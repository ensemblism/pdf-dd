import path from 'node:path';

/** Resolve a decoded URL route only when it stays inside the static directory. */
export function resolveStaticPath(root: string, route: string, paths = path): string | null {
  const file = paths.resolve(root, route || 'index.html');
  const relative = paths.relative(root, file);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + paths.sep) ||
    paths.isAbsolute(relative)
  )
    return null;
  return file;
}
