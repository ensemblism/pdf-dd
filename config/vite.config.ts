import { defineConfig } from 'vite';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const outDir = mode === 'web' ? 'dist/site' : 'dist/local/web';
  return {
    tsconfig: 'config/tsconfig.json',
    base: './',
    build: { outDir, emptyOutDir: true },
    worker: { format: 'es' },
    plugins: [
      {
        name: 'offline-pdf-assets',
        closeBundle() {
          for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
            const target = resolve(outDir, 'pdf-assets', dir);
            mkdirSync(target, { recursive: true });
            cpSync(resolve('node_modules/pdfjs-dist', dir), target, { recursive: true });
          }
          const licenses = [
            ['pdfjs-dist', 'LICENSE'],
            ['diff', 'LICENSE'],
            ['pdf-lib', 'LICENSE.md'],
            ['@pdf-lib/standard-fonts', 'LICENSE.md'],
            ['@pdf-lib/upng', 'LICENSE'],
            ['pako', 'LICENSE'],
            ['tslib', 'LICENSE.txt'],
          ];
          writeFileSync(
            resolve(outDir, 'THIRD_PARTY_NOTICES.txt'),
            licenses
              .map(
                ([pkg, file]) =>
                  `${pkg}\n${readFileSync(resolve('node_modules', pkg, file), 'utf8')}`,
              )
              .join('\n\n'),
          );
        },
      },
    ],
  };
});
