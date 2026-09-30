import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/reporter/allureConsolidation.ts',
    'src/reporter/non-tty-reporter.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  shims: true,
  outDir: 'dist',
  target: 'es2022',
  external: ['vitest', 'allure-vitest', 'winston', 'winston-transport'],
});
