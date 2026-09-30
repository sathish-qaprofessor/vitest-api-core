import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { SummaryReporter } from './src/reporter/summary-reporter.js';
import { AllureConsolidationReporter } from './src/reporter/allureConsolidation.js';

/* Suite/file-level parallelism:
 * how many test files (suites) can run at the same time
 * fileParallelism: true,
 * maxWorkers: 3, // or '50%'
 * Within-suite parallelism:
 * max number of it.concurrent / describe.concurrent tasks running at once (per worker)
 * maxConcurrency: 2,
 */

export default defineConfig({
  resolve: {
    alias: {
      '@jsi/vitest-api-core': path.resolve(__dirname, 'node_modules/@jsi-staging/vitest-api-core/dist/index.mjs'),
    },
  },
  test: {
    root: path.resolve(__dirname),
    globals: false,
    server: {
      deps: {
        inline: ['@jsi-staging/vitest-api-core'],
      },
    },
    testTimeout: 60000,
    hookTimeout: 30000,
    pool: 'threads',
    fileParallelism: false,
    maxWorkers: 1,
    maxConcurrency: 1,
    include: ['tests/**/*.test.ts'],
    tags: [
      { name: 'smoke' },
      { name: 'regression' },
      { name: 'sanity' }
    ],
    strictTags: false,
    globalSetup: ['./vitest.globalSetup.ts'],
    setupFiles: ['./vitest.config.setup.ts', 'allure-vitest/setup'],
    reporters: [
      new SummaryReporter(),
      ['allure-vitest/reporter', {
        resultsDir: path.resolve(__dirname, 'reports/allure-results'),
      }],
      // Must run AFTER allure-vitest so its result files are already written.
      new AllureConsolidationReporter({
        resultsDir: path.resolve(__dirname, 'reports/allure-results'),
      }),
    ],
    includeTaskLocation: true,
  },
});
