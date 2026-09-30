#!/usr/bin/env node
'use strict';

/**
 * Self-contained Allure report builder for downloaded artifacts.
 *
 * Given only an `allure-results` folder (e.g. pulled from a GitHub Actions
 * artifact) this runs `allure generate` using the bundled `allure-commandline`
 * (no system Allure install required) and then applies the custom UI
 * (metrics bar, spec files table, themes) via `customize-allure.js`.
 *
 * Usage:
 *   pactum-report-build <results-dir> [-o <report-dir>] [--no-clean]
 *
 * Examples:
 *   pactum-report-build ./allure-results
 *   pactum-report-build ./allure-results -o ./allure-report
 *   npx --package @jsi-staging/vitest-api-core pactum-report-build ./allure-results -o ./allure-report
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const opts = { resultsDir: null, reportDir: null, clean: true };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-o' || arg === '--output') {
      opts.reportDir = argv[++i];
    } else if (arg === '--no-clean') {
      opts.clean = false;
    } else if (arg === '--clean') {
      opts.clean = true;
    } else if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else {
      positionals.push(arg);
    }
  }
  if (!opts.resultsDir && positionals.length > 0) opts.resultsDir = positionals[0];
  return opts;
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(
    [
      'Build a customized Allure report from a downloaded allure-results folder.',
      '',
      'Usage:',
      '  pactum-report-build <results-dir> [-o <report-dir>] [--no-clean]',
      '',
      'Options:',
      '  -o, --output <dir>   Output report directory (default: <results-parent>/allure-report)',
      '  --no-clean           Do not pass --clean to allure generate',
      '  -h, --help           Show this help',
    ].join('\n'),
  );
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  printHelp();
  process.exit(0);
}

if (!opts.resultsDir) {
  // eslint-disable-next-line no-console
  console.error('Error: <results-dir> is required.\n');
  printHelp();
  process.exit(1);
}

const cwd = process.cwd();
const resultsDir = path.resolve(cwd, opts.resultsDir);
const reportDir = opts.reportDir
  ? path.resolve(cwd, opts.reportDir)
  : path.join(path.dirname(resultsDir), 'allure-report');

if (!fs.existsSync(resultsDir)) {
  // eslint-disable-next-line no-console
  console.error(`Error: results directory not found: ${resultsDir}`);
  process.exit(1);
}

const hasResultFiles = fs
  .readdirSync(resultsDir)
  .some((f) => f.endsWith('-result.json') || f.endsWith('-container.json'));
if (!hasResultFiles) {
  // eslint-disable-next-line no-console
  console.error(`Error: no Allure result files (*-result.json) found in: ${resultsDir}`);
  process.exit(1);
}

const generateArgs = ['generate', resultsDir, '-o', reportDir];
if (opts.clean) generateArgs.push('--clean');

// eslint-disable-next-line no-console
console.log(`Generating Allure report -> ${reportDir}`);

const allure = require('allure-commandline');

const child = allure(generateArgs); // spawns the bundled Allure CLI (stdio: inherit)

child.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to launch bundled Allure:', err.message);
  process.exit(1);
});

child.on('exit', (code) => {
  if (code !== 0) {
    // eslint-disable-next-line no-console
    console.error(`allure generate exited with code ${code}.`);
    process.exit(code || 1);
  }

  // Apply the custom UI. Pass the results dir explicitly so source-file
  // patching works even when it is not the report's sibling folder.
  const customizeScript = path.join(__dirname, 'customize-allure.js');
  const result = spawnSync(process.execPath, [customizeScript, reportDir, resultsDir], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }

  // eslint-disable-next-line no-console
  console.log(`Done. Open with:  npx allure open "${reportDir}"`);
});
