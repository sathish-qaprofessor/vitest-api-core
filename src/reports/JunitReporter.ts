import * as fs from 'fs';
import { RequestLog, SuiteResult, TestResult } from './types.js';
import { LoggerService } from '../logger/LoggerService.js';
import { ConfigResolver } from '../config/ConfigResolver.js';
import { PathUtils } from '../utils/PathUtils.js';
import { consolidateByCaseId } from './consolidate.js';

/** A single rendered `<testsuite>` block plus its roll-up counters. */
interface SuiteBlock {
  name: string;
  xml: string;
  tests: number;
  passed: number;
  failures: number;
  skipped: number;
  time: number;
  timestamp: string;
}

/**
 * JUnit XML reporter.
 *
 * Produces a standards-compliant JUnit report (`<testsuites>` → `<testsuite>` →
 * `<testcase>`) for the **consumer test project**. All paths and toggles are
 * resolved through {@link ConfigResolver}, so configuration comes from the
 * consumer project's `config/*.yaml` (or env vars), never from this package.
 *
 * The report is fully customizable via config flags:
 * - `reporting.enableJunitReport`        — master toggle (default false)
 * - `reporting.junitReportPath`          — output file (default reports/junit-report.xml)
 * - `reporting.junit.includeTags`        — emit tags as attribute + properties (default true)
 * - `reporting.junit.includeProperties`  — emit per-test `<properties>` (default true)
 * - `reporting.junit.includeLogs`        — embed captured logs in `system-out` (default false)
 * - `reporting.junit.includeRequests`    — embed request/response logs in `system-out` (default false)
 *
 * Run metadata under the `run.*` config keys (or `--<name>=` CLI args / `RUN_*`
 * env vars) is emitted once as `<testsuites>` properties: `run.hostName`, `run.testRun`,
 * `run.mileStone`, `run.runType`, `run.product`, `run.version`, `run.release`,
 * `run.servicePack`, `run.interface` (plus the resolved `environment`).
 *
 * Driven entirely by the existing ApiTestBase lifecycle — no test-side changes.
 */
export class JunitReporter {
  private static readonly loggerService = new LoggerService('JunitReporter');
  private static runSummary: SuiteResult | null = null;
  private static pendingRequests: RequestLog[] = [];

  private constructor() {}

  private static isEnabled(): boolean {
    return ConfigResolver.resolveBoolean('reporting.enableJunitReport');
  }

  /** Resolve a boolean flag with an explicit fallback when the key is absent. */
  private static flag(key: string, fallback: boolean): boolean {
    const raw = ConfigResolver.resolve(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    return raw.trim().toLowerCase() === 'true';
  }

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

  /**
   * Run-level metadata emitted as `<testsuites>` properties. Each value is
   * resolved with precedence: command-line `--<name>=value` > environment
   * variable / config file (via {@link ConfigResolver}). Every property is
   * always emitted; an unresolved value becomes an empty `value=""`.
   */
  private static readonly RUN_PROPERTY_DEFS: ReadonlyArray<{ name: string; configKey: string; cli: string[] }> = [
    { name: 'hostname', configKey: 'run.hostName', cli: ['hostName', 'hostname'] },
    { name: 'testrun', configKey: 'run.testRun', cli: ['testRun', 'testrun'] },
    { name: 'milestone', configKey: 'run.mileStone', cli: ['mileStone', 'milestone'] },
    { name: 'runType', configKey: 'run.runType', cli: ['runType', 'runtype'] },
    { name: 'product', configKey: 'run.product', cli: ['product'] },
    { name: 'version', configKey: 'run.version', cli: ['version', 'productVersion'] },
    { name: 'release', configKey: 'run.release', cli: ['release'] },
    { name: 'servicePack', configKey: 'run.servicePack', cli: ['servicePack', 'servicepack'] },
    { name: 'interface', configKey: 'run.interface', cli: ['interface'] },
  ];

  /** Read a `--<name>=value` or `--<name> value` argument from the CLI (case-insensitive). */
  private static parseCliArg(names: string[]): string | undefined {
    const wanted = names.map(n => n.toLowerCase());
    const argv = process.argv;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (!arg || !arg.startsWith('--')) continue;
      const eq = arg.indexOf('=');
      if (eq > 2) {
        if (wanted.includes(arg.slice(2, eq).toLowerCase())) {
          const val = arg.slice(eq + 1).trim();
          if (val) return val;
        }
      } else if (wanted.includes(arg.slice(2).toLowerCase())) {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          const val = next.trim();
          if (val) return val;
        }
      }
    }
    return undefined;
  }

  /** Ordered run-metadata properties, resolving each from CLI or config/env. */
  private static resolveRunProperties(environment: string): Array<{ name: string; value: string }> {
    const props: Array<{ name: string; value: string }> = [];
    props.push({ name: 'environment', value: environment?.trim() ?? '' });
    for (const def of this.RUN_PROPERTY_DEFS) {
      const value = this.parseCliArg(def.cli) ?? ConfigResolver.resolve(def.configKey);
      props.push({ name: def.name, value: value?.trim() ?? '' });
    }
    return props;
  }

  static initSuite(_suiteName: string): void {
    if (!this.isEnabled()) return;

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
  }

  static addTestResult(result: TestResult): void {
    if (!this.isEnabled() || !this.runSummary) return;

    const normalized: TestResult = { ...result };

    if (this.pendingRequests.length > 0) {
      normalized.requests = [...this.pendingRequests];
      this.pendingRequests = [];
    }

    this.runSummary.tests.push(normalized);
    this.runSummary.totalTests++;
    switch (normalized.status) {
      case 'passed':
        this.runSummary.passed++;
        break;
      case 'failed':
        this.runSummary.failed++;
        break;
      case 'skipped':
        this.runSummary.skipped++;
        break;
    }
    this.runSummary.duration += normalized.duration;
  }

  static recordRequest(_testId: string, log: RequestLog): void {
    if (!this.isEnabled()) return;
    this.pendingRequests.push(log);
  }

  static flush(): void {
    if (!this.isEnabled() || !this.runSummary) return;

    this.runSummary.endTime = new Date().toISOString();

    const reportPath =
      ConfigResolver.resolve('reporting.junitReportPath') ?? 'reports/junit-report.xml';
    const fullPath = PathUtils.resolveFromConsumerRoot(reportPath);
    const dir = PathUtils.dirname(fullPath);
    PathUtils.ensureDirectory(dir);

    // Vitest isolates module state per test file, so this reporter only ever
    // holds the current file's results. Merge with any `<testsuite>` blocks
    // already written by previously-run files so the report aggregates the
    // whole run (mirrors JsonReporter's disk-merge behaviour).
    const merged = new Map<string, SuiteBlock>();
    if (PathUtils.exists(fullPath)) {
      try {
        const existingRaw = fs.readFileSync(fullPath, 'utf-8');
        for (const block of this.parseExistingBlocks(existingRaw)) {
          merged.set(block.name, block);
        }
      } catch {
        // Unreadable or foreign file — the current run overwrites it.
      }
    }
    for (const block of this.buildSuiteBlocks(this.summaryForBuild())) {
      merged.set(block.name, block);
    }

    const xml = this.assembleXml([...merged.values()], this.runSummary);
    fs.writeFileSync(fullPath, xml, 'utf-8');
    this.loggerService.info('JUnit report written to: {}', fullPath);
  }

  static reset(): void {
    this.pendingRequests = [];
  }

  /**
   * Return the run summary used to build suite blocks, collapsing data-driven
   * iterations that share a TestRail case id into a single `<testcase>` so the
   * TestRail sync posts one result per case instead of one per data set.
   */
  private static summaryForBuild(): SuiteResult {
    if (!this.runSummary) throw new Error('JunitReporter run summary is not initialized.');
    if (!ConfigResolver.resolveBoolean('reporting.consolidateDataDriven')) return this.runSummary;
    return { ...this.runSummary, tests: consolidateByCaseId(this.runSummary.tests) };
  }

  // ------------------------------------------------------------------ XML build

  /** Assemble the full document from the merged set of suite blocks. */
  private static assembleXml(blocks: SuiteBlock[], summary: SuiteResult): string {
    const tests = blocks.reduce((acc, b) => acc + b.tests, 0);
    const passed = blocks.reduce((acc, b) => acc + b.passed, 0);
    const failures = blocks.reduce((acc, b) => acc + b.failures, 0);
    const skipped = blocks.reduce((acc, b) => acc + b.skipped, 0);
    const time = blocks.reduce((acc, b) => acc + b.time, 0);
    const timestamp = blocks.reduce(
      (min, b) => (b.timestamp && b.timestamp < min ? b.timestamp : min),
      blocks[0]?.timestamp ?? new Date().toISOString(),
    );

    const lines: string[] = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push(
      `<testsuites name="vitest-api-core" tests="${tests}" passed="${passed}" failures="${failures}" skipped="${skipped}" time="${time.toFixed(3)}" timestamp="${this.attr(timestamp)}">`,
    );

    // Run metadata is identical across the whole run, so emit it once here
    // rather than repeating it inside every <testsuite>.
    if (this.flag('reporting.junit.includeProperties', true)) {
      lines.push('  <properties>');
      for (const prop of this.resolveRunProperties(summary.environment)) {
        lines.push(`    <property name="${this.attr(prop.name)}" value="${this.attr(prop.value)}"/>`);
      }
      if (summary.executionFilter?.tags?.length) {
        lines.push(`    <property name="executionTags" value="${this.attr(summary.executionFilter.tags.join(','))}"/>`);
      }
      lines.push('  </properties>');
    }

    for (const block of blocks) lines.push(block.xml);
    lines.push('</testsuites>');
    return lines.join('\n') + '\n';
  }

  /** Render one `<testsuite>` block (with counters) per distinct suite name. */
  private static buildSuiteBlocks(summary: SuiteResult): SuiteBlock[] {
    const includeTags = this.flag('reporting.junit.includeTags', true);
    const includeProperties = this.flag('reporting.junit.includeProperties', true);
    const includeLogs = this.flag('reporting.junit.includeLogs', false);
    const includeRequests = this.flag('reporting.junit.includeRequests', false);

    const groups = this.groupBySuite(summary.tests);
    const blocks: SuiteBlock[] = [];

    for (const [suiteName, tests] of groups) {
      const failures = tests.filter(t => t.status === 'failed').length;
      const skipped = tests.filter(t => t.status === 'skipped').length;
      const passed = tests.length - failures - skipped;
      const timeMs = tests.reduce((acc, t) => acc + (t.duration ?? 0), 0);
      const timestamp = tests.reduce(
        (min, t) => (t.startTime < min ? t.startTime : min),
        tests[0]?.startTime ?? summary.startTime,
      );

      const lines: string[] = [];
      lines.push(
        `  <testsuite name="${this.attr(suiteName)}" tests="${tests.length}" passed="${passed}" failures="${failures}" skipped="${skipped}" time="${this.seconds(timeMs)}" timestamp="${this.attr(timestamp)}" hostname="${this.attr(summary.environment)}">`,
      );

      for (const test of tests) {
        this.appendTestCase(lines, test, { includeTags, includeProperties, includeLogs, includeRequests });
      }

      lines.push('  </testsuite>');

      blocks.push({
        name: suiteName,
        xml: lines.join('\n'),
        tests: tests.length,
        passed,
        failures,
        skipped,
        time: timeMs / 1000,
        timestamp,
      });
    }

    return blocks;
  }

  /**
   * Extract previously-written `<testsuite>` blocks from an existing report.
   * Blocks are treated as opaque strings; only the roll-up attributes are
   * parsed so the document totals can be recomputed. Suites can't nest, so a
   * non-greedy match up to the first closing tag is safe.
   */
  private static parseExistingBlocks(raw: string): SuiteBlock[] {
    const blocks: SuiteBlock[] = [];
    const blockPattern = /[ \t]*<testsuite\b[\s\S]*?<\/testsuite>/g;
    const matches = raw.match(blockPattern);
    if (!matches) return blocks;

    for (const block of matches) {
      const openTag = block.slice(0, block.indexOf('>') + 1);
      const name = this.unescapeAttr(this.readAttr(openTag, 'name') ?? '');
      const tests = Number(this.readAttr(openTag, 'tests') ?? 0);
      const failures = Number(this.readAttr(openTag, 'failures') ?? 0);
      const skipped = Number(this.readAttr(openTag, 'skipped') ?? 0);
      const passedAttr = this.readAttr(openTag, 'passed');
      blocks.push({
        name,
        xml: block,
        tests,
        passed: passedAttr !== undefined ? Number(passedAttr) : tests - failures - skipped,
        failures,
        skipped,
        time: Number(this.readAttr(openTag, 'time') ?? 0),
        timestamp: this.readAttr(openTag, 'timestamp') ?? '',
      });
    }
    return blocks;
  }

  private static readAttr(openTag: string, name: string): string | undefined {
    const match = new RegExp(`${name}="([^"]*)"`).exec(openTag);
    return match?.[1];
  }

  private static appendTestCase(
    lines: string[],
    test: TestResult,
    opts: { includeTags: boolean; includeProperties: boolean; includeLogs: boolean; includeRequests: boolean },
  ): void {
    const tags = test.tags ?? [];
    const caseId = this.extractCaseId(tags);
    const tagAttr =
      opts.includeTags && tags.length > 0 ? ` tags="${this.attr(tags.join(','))}"` : '';

    const open = `    <testcase name="${this.attr(test.name)}" classname="${this.attr(test.suiteName ?? '')}" time="${this.seconds(test.duration)}"${tagAttr}>`;
    lines.push(open);

    if (opts.includeProperties) {
      const props: string[] = [];
      if (caseId) props.push(`        <property name="caseId" value="${this.attr(caseId)}"/>`);
      if (opts.includeTags && tags.length > 0) {
        props.push(`        <property name="tags" value="${this.attr(tags.join(','))}"/>`);
      }
      if (test.startTime) props.push(`        <property name="startTime" value="${this.attr(test.startTime)}"/>`);
      if (test.endTime) props.push(`        <property name="endTime" value="${this.attr(test.endTime)}"/>`);
      if (props.length > 0) {
        lines.push('      <properties>');
        lines.push(...props);
        lines.push('      </properties>');
      }
    }

    if (test.status === 'failed') {
      const message = test.error ?? 'Test failed';
      const attrMessage = message.replace(/\s+/g, ' ').trim();
      lines.push(`      <failure message="${this.attr(attrMessage)}" type="AssertionError">${this.cdata(message)}</failure>`);
    } else if (test.status === 'skipped') {
      lines.push('      <skipped message="Test skipped"/>');
    }

    const out: string[] = [];
    if (opts.includeLogs && test.logs?.length) {
      out.push(...test.logs);
    }
    if (opts.includeRequests && test.requests?.length) {
      for (const req of test.requests) {
        out.push(`${req.method} ${req.url} -> ${req.statusCode} | ${req.responseBody}`);
      }
    }
    if (out.length > 0) {
      lines.push(`      <system-out>${this.cdata(out.join('\n'))}</system-out>`);
    }

    lines.push('    </testcase>');
  }

  private static groupBySuite(tests: TestResult[]): Map<string, TestResult[]> {
    const groups = new Map<string, TestResult[]>();
    for (const test of tests) {
      const key = test.suiteName ?? 'Unknown Suite';
      const bucket = groups.get(key);
      if (bucket) bucket.push(test);
      else groups.set(key, [test]);
    }
    return groups;
  }

  private static extractCaseId(tags: string[]): string | null {
    const caseIdPattern = /^@?(C\d+)$/;
    for (const rawTag of tags) {
      const match = caseIdPattern.exec(rawTag.trim());
      if (match?.[1]) return match[1];
    }
    return null;
  }

  private static seconds(ms: number | undefined): string {
    return ((ms ?? 0) / 1000).toFixed(3);
  }

  /** Escape a value for use inside an XML attribute. */
  private static attr(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /** Wrap text in a CDATA section, escaping any nested CDATA terminators. */
  private static cdata(value: string): string {
    const safe = value.replace(/]]>/g, ']]]]><![CDATA[>');
    return `<![CDATA[${safe}]]>`;
  }

  /** Reverse of {@link attr} — decode XML entities from a parsed attribute. */
  private static unescapeAttr(value: string): string {
    return value
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&');
  }
}
