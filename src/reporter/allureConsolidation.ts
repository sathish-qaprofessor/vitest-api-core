import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { Reporter } from 'vitest/reporters';

/**
 * Consolidation of data-driven Allure results.
 *
 * allure-vitest writes one result file per `it()`. When several data sets map
 * to a single TestRail case (same `caseId` label, injected by the framework at
 * runtime), this collapses them into ONE Allure test — so the test count is 1 —
 * with each data set nested as its own subset step:
 *
 *   ▸ Data set 1: <iteration name>   [passed]
 *       ...original steps...
 *   ▸ Data set 2: <iteration name>   [failed]
 *       ...original steps + failure...
 *
 * Must run AFTER allure-vitest has flushed its result files (it writes them in
 * its own `onTestRunEnd`), which is why {@link AllureConsolidationReporter} has
 * to be registered *after* the allure reporter in the `reporters` array.
 */

interface AllureLabel {
  name: string;
  value: string;
}

interface AllureStep {
  name?: string;
  status?: string;
  statusDetails?: unknown;
  stage?: string;
  steps?: AllureStep[];
  attachments?: unknown[];
  parameters?: unknown[];
  start?: number;
  stop?: number;
}

interface AllureResult {
  uuid: string;
  name?: string;
  fullName?: string;
  titlePath?: unknown;
  historyId?: string;
  testCaseId?: string;
  status?: string;
  statusDetails?: { message?: string; trace?: string };
  stage?: string;
  steps?: AllureStep[];
  attachments?: unknown[];
  parameters?: unknown[];
  labels?: AllureLabel[];
  links?: unknown[];
  start?: number;
  stop?: number;
}

/** Worst-case status roll-up across data sets. */
function worstStatus(statuses: string[]): string {
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('broken')) return 'broken';
  if (statuses.includes('passed')) return 'passed';
  return 'skipped';
}

function labelValue(result: AllureResult, name: string): string | null {
  const label = (result.labels ?? []).find(l => l && l.name === name);
  return label ? String(label.value) : null;
}

function dedupe<T extends { name?: string; value?: unknown }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (!item || !item.name) continue;
    const key = `${item.name}::${String(item.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Merge every `*-result.json` that shares a `caseId` label into a single test.
 * Returns the number of cases that were consolidated. Idempotent; results with
 * no `caseId` label and single-data-set cases are left untouched.
 */
export function consolidateAllureResults(resultsDir: string): number {
  if (!fs.existsSync(resultsDir)) return 0;

  const files = fs.readdirSync(resultsDir).filter(f => f.endsWith('-result.json'));
  const groups = new Map<string, { file: string; result: AllureResult }[]>();

  for (const file of files) {
    const full = path.join(resultsDir, file);
    let result: AllureResult;
    try {
      result = JSON.parse(fs.readFileSync(full, 'utf8')) as AllureResult;
    } catch {
      continue;
    }
    const caseId = labelValue(result, 'caseId');
    if (!caseId) continue;
    const bucket = groups.get(caseId);
    if (bucket) bucket.push({ file: full, result });
    else groups.set(caseId, [{ file: full, result }]);
  }

  let mergedCount = 0;

  for (const [caseId, entries] of groups) {
    if (entries.length < 2) continue;

    entries.sort((a, b) => (a.result.start ?? 0) - (b.result.start ?? 0));
    const results = entries.map(e => e.result);

    const status = worstStatus(results.map(r => r.status ?? 'unknown'));
    const start = Math.min(...results.map(r => r.start ?? 0));
    const stop = Math.max(...results.map(r => r.stop ?? 0));

    const steps: AllureStep[] = results.map((r, i) => ({
      name: `Data set ${i + 1}: ${r.name ?? ''}`,
      status: r.status,
      statusDetails: r.statusDetails ?? {},
      stage: 'finished',
      start: r.start,
      stop: r.stop,
      steps: Array.isArray(r.steps) ? r.steps : [],
      attachments: Array.isArray(r.attachments) ? r.attachments : [],
      parameters: [],
    }));

    const failingIndex = results.findIndex(r => r.status === 'failed' || r.status === 'broken');
    let statusDetails: { message?: string; trace?: string } = {};
    if (failingIndex >= 0) {
      const failing = results[failingIndex]!;
      const details = failing.statusDetails ?? {};
      statusDetails = {
        message: `[Data set ${failingIndex + 1}: ${failing.name ?? ''}] ${details.message ?? ''}`.trim(),
        trace: details.trace,
      };
    }

    const base = results[0]!;
    const parentSuite = labelValue(base, 'parentSuite') ?? base.fullName ?? base.name ?? '';
    const groupId = createHash('md5').update(`${parentSuite}#${caseId}`).digest('hex');

    const merged: AllureResult = {
      uuid: randomUUID(),
      name: base.name,
      fullName: base.fullName,
      titlePath: base.titlePath,
      historyId: groupId,
      testCaseId: groupId,
      status,
      statusDetails,
      stage: 'finished',
      steps,
      attachments: [],
      parameters: [],
      labels: dedupe(results.flatMap(r => (Array.isArray(r.labels) ? r.labels : []))),
      links: dedupe(results.flatMap(r => (Array.isArray(r.links) ? (r.links as { name?: string; value?: unknown }[]) : []))),
      start,
      stop,
    };

    fs.writeFileSync(path.join(resultsDir, `${merged.uuid}-result.json`), JSON.stringify(merged), 'utf8');

    // Remove the per-data-set originals so the test count collapses to 1.
    for (const entry of entries) {
      try {
        fs.unlinkSync(entry.file);
      } catch {
        // already gone — ignore
      }
    }

    mergedCount++;
  }

  return mergedCount;
}

export interface AllureConsolidationOptions {
  /** Allure results directory. Defaults to `<cwd>/reports/allure-results`. */
  resultsDir?: string;
}

/**
 * Vitest reporter that consolidates data-driven Allure results at run end.
 *
 * Register it AFTER `allure-vitest/reporter` in the `reporters` array so it runs
 * once allure-vitest has written its result files. Disable with
 * `REPORTING_CONSOLIDATEDATADRIVEN=false`.
 */
export class AllureConsolidationReporter implements Reporter {
  private readonly resultsDir: string;

  constructor(options: AllureConsolidationOptions = {}) {
    this.resultsDir = options.resultsDir ?? path.resolve(process.cwd(), 'reports', 'allure-results');
  }

  onTestRunEnd(): void {
    if (String(process.env['REPORTING_CONSOLIDATEDATADRIVEN']).toLowerCase() === 'false') return;
    try {
      const merged = consolidateAllureResults(this.resultsDir);
      if (merged > 0) {
        process.stdout.write(`\nConsolidated data-driven Allure results for ${merged} case(s).\n`);
      }
    } catch {
      // Never break the test run because of report post-processing.
    }
  }
}
