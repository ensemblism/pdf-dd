import { defineConfig } from 'vitest/config';
export default defineConfig({
  tsconfig: 'config/tsconfig.json',
  test: { include: ['tests/*.test.ts'] },
});
