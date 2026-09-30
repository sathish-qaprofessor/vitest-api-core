import * as fs from 'fs';
import { RequestLog, SuiteResult, TestResult } from './types.js';
import { LoggerService } from '../logger/LoggerService.js';
import { ConfigResolver } from '../config/ConfigResolver.js';
import { PathUtils } from '../utils/PathUtils.js';
import { consolidateByCaseId } from './consolidate.js';

/**
 * JSON reporter that writes execution summary to a JSON file.
 * Ported from Java's ExtentReporters.java (reporting portion).
 */
export class JsonReporter {
  private static readonly loggerService = new LoggerService('JsonReporter');
  private static suite: SuiteResult | null = null;
  private static runSummary: SuiteResult | null = null;
  private static pendingRequests: RequestLog[] = [];

  private constructor() {}

  private static parseExecutionTags(): string[] | undefined {
    const argv = process.argv;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg?.startsWith('--tags=')) {
        const val = arg.slice(7).split(',').map(t => t.trim()).filter(Boolean);
        return val.length > 0 ? val : undefined;
      }
      if (arg === '--tags' && argv[i + 1] && !argv[i + 1]!.startsWith('-')) {
        const val = argv[i + 1]!.split(',').map(t => t.trim()).filter(Boolean);
        return val.length > 0 ? val : undefined;
      }
    }
    return undefined;
  }

  static initSuite(suiteName: string): void {
    const enabled = ConfigResolver.resolveBoolean('reporting.enableJsonReport');
    if (!enabled) return;

    if (!this.runSummary) {
      const executionTags = this.parseExecutionTags();
      this.runSummary = {
        suiteName: 'Execution Summary',
        environment: ConfigResolver.resolve('environment') ?? 'dev',
        startTime: new Date().toISOString(),
        totalTests: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0,
        ...(executionTags ? { executionFilter: { tags: executionTags } } : {}),
        tests: [],
      };
    }

    this.suite = {
      suiteName,
      environment: ConfigResolver.resolve('environment') ?? 'dev',
      startTime: new Date().toISOString(),
      totalTests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      tests: [],
    };
  }

  static addTestResult(result: TestResult): void {
    if (!this.suite || !this.runSummary) return;

    const normalized: TestResult = {
      ...result,
      suiteName: result.suiteName ?? this.suite.suiteName,
    };

    if (this.pendingRequests.length > 0) {
      normalized.requests = [...this.pendingRequests];
      this.pendingRequests = [];
    }

    this.addToSummary(this.suite, normalized);
    this.addToSummary(this.runSummary, normalized);
  }

  private static addToSummary(summary: SuiteResult, result: TestResult): void {
    summary.tests.push(result);
    summary.totalTests++;

    switch (result.status) {
      case 'passed':
        summary.passed++;
        break;
      case 'failed':
        summary.failed++;
        break;
      case 'skipped':
        summary.skipped++;
        break;
    }

    summary.duration += result.duration;
  }

  static recordRequest(_testId: string, log: RequestLog): void {
    this.pendingRequests.push(log);
  }

  static flush(): void {
    if (!this.suite || !this.runSummary) return;

    this.suite.endTime = new Date().toISOString();
    this.runSummary.endTime = new Date().toISOString();

    const reportPath =
      ConfigResolver.resolve('reporting.jsonReportPath') ?? 'reports/execution-summary.json';
    const fullPath = PathUtils.resolveFromConsumerRoot(reportPath);
    const dir = PathUtils.dirname(fullPath);
    PathUtils.ensureDirectory(dir);

    let output = this.runSummary;
    if (PathUtils.exists(fullPath)) {
      try {
        const existingRaw = fs.readFileSync(fullPath, 'utf-8');
        const existing = JSON.parse(existingRaw) as SuiteResult;
        output = this.mergeSummaries(existing, this.runSummary);
      } catch {
        // If existing report is invalid, overwrite with current summary.
      }
    }

    if (ConfigResolver.resolveBoolean('reporting.consolidateDataDriven')) {
      output = this.applyConsolidation(output);
    }

    fs.writeFileSync(fullPath, JSON.stringify(output, null, 2), 'utf-8');
    this.loggerService.info('JSON report written to: {}', fullPath);
  }

  private static mergeSummaries(existing: SuiteResult, current: SuiteResult): SuiteResult {
    const combined = [...(existing.tests ?? []), ...(current.tests ?? [])];
    const deduped: TestResult[] = [];
    const seen = new Set<string>();

    for (const test of combined) {
      const key = `${test.suiteName ?? ''}|${test.name}|${test.startTime}|${test.status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(test);
    }

    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let duration = 0;

    for (const test of deduped) {
      duration += test.duration ?? 0;
      if (test.status === 'passed') passed++;
      else if (test.status === 'failed') failed++;
      else skipped++;
    }

    const startTime =
      new Date(existing.startTime).getTime() <= new Date(current.startTime).getTime()
        ? existing.startTime
        : current.startTime;

    const executionFilter = current.executionFilter ?? existing.executionFilter;

    return {
      suiteName: 'Execution Summary',
      environment: current.environment || existing.environment,
      startTime,
      endTime: new Date().toISOString(),
      totalTests: deduped.length,
      passed,
      failed,
      skipped,
      duration,
      ...(executionFilter ? { executionFilter } : {}),
      tests: deduped,
    };
  }

  static reset(): void {
    this.suite = null;
    this.pendingRequests = [];
  }

  /**
   * Collapse data-driven iterations sharing a TestRail case id into one result
   * and recompute the roll-up counters accordingly.
   */
  private static applyConsolidation(summary: SuiteResult): SuiteResult {
    const tests = consolidateByCaseId(summary.tests);

    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let duration = 0;
    for (const test of tests) {
      duration += test.duration ?? 0;
      if (test.status === 'passed') passed++;
      else if (test.status === 'failed') failed++;
      else skipped++;
    }

    return {
      ...summary,
      totalTests: tests.length,
      passed,
      failed,
      skipped,
      duration,
      tests,
    };
  }
}
