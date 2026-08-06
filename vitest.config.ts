import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const editmameiSrc = resolve(__dirname, 'src');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      '@editmamei': editmameiSrc,
    },
  },
});
