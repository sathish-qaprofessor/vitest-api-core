#!/usr/bin/env node
'use strict';

/**
 * CLI wrapper for data-driven Allure results consolidation.
 *
 * Prefer registering `AllureConsolidationReporter` in your Vitest `reporters`
 * (after `allure-vitest/reporter`) so this runs automatically. This script is
 * for pipelines that generate the Allure report as a separate step: run it
 * BEFORE `allure generate`. Disable with REPORTING_CONSOLIDATEDATADRIVEN=false.
 *
 * Merges every `*-result.json` that shares the same `caseId` label into ONE
 * Allure test (test count 1), with each data set nested as its own subset step.
 */

const { join } = require('node:path');

if (String(process.env.REPORTING_CONSOLIDATEDATADRIVEN).toLowerCase() === 'false') {
  process.exit(0);
}

const resultsDir = join(process.cwd(), 'reports', 'allure-results');

try {
  const { consolidateAllureResults } = require('../../dist/reporter/allureConsolidation.js');
  const merged = consolidateAllureResults(resultsDir);
  // eslint-disable-next-line no-console
  console.log(
    merged > 0
      ? `Consolidated data-driven Allure results for ${merged} case(s).`
      : 'No data-driven Allure results to consolidate.',
  );
} catch (err) {
  const errorMessage = err instanceof Error ? err.message : err;
  // eslint-disable-next-line no-console
  console.error('Allure consolidation skipped:', errorMessage);
}
