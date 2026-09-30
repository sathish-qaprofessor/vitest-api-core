import type { Reporter, TestRunEndReason } from 'vitest/reporters';
import type { TestCase, TestModule } from 'vitest/node';
import type { SerializedError } from '@vitest/utils';
import path from 'node:path';
import { extractCaseId } from '../reports/consolidate.js';
import { ConfigResolver } from '../config/ConfigResolver.js';

export interface NonTtyReporterOptions {
  /** Interval (ms) between live "still running" progress lines. Default 5000. */
  interval?: number;
  /** Print a `[START] <file>` line when a test file starts. Default true. */
  showFileStart?: boolean;
  /**
   * Window (ms) used to group `[START]` lines from workers starting at nearly the
   * same time into one block with a single trailing `Run elapsed`. `0` flushes each
   * start immediately. Default 50.
   */
  startBatchWindow?: number;
  /** Print `Duration: HH:MM:SS` for every completed file. Default true. */
  showFileDuration?: boolean;
  /** Print aggregate `Progress:` / `Total Tests:` lines while the run is active. Default true. */
  showLiveCounts?: boolean;
  /** Print the final summary. Default true. */
  showSummary?: boolean;
  /**
   * Collapse same-`caseId` data-set iterations into one result so live and final
   * counts match the summary, JUnit, Allure and TestRail sync. Defaults to the
   * resolved `reporting.consolidateDataDriven` config (true when unset).
   */
  consolidateDataDriven?: boolean;
  /** Emit GitHub Actions `::error` annotations for failures. Defaults to `GITHUB_ACTIONS === 'true'`. */
  githubActions?: boolean;
  /**
   * Wrap each failure in a collapsible `::group::...::endgroup::` block (collapsed by
   * default in the GitHub Actions log UI) instead of leaving the raw error/stack
   * inline in the stream. Defaults to the resolved `githubActions` value.
   */
  groupFailures?: boolean;
  /** Max stack frames kept per failure before truncating with a `... N more` line. Default 2. */
  maxStackFrames?: number;
  /** Print a compact `Failed Tests` digest after the final summary. Defaults to the resolved `githubActions` value. */
  showFailedTestsDigest?: boolean;
  /** Max entries listed in the failed-tests digest before truncating with a `... N more` line. Default 25. */
  maxDigestEntries?: number;
  /** Prefix every emitted line with an ISO timestamp. Default false. */
  timestamps?: boolean;
  /** Sink for output. Defaults to `process.stdout.write`. */
  write?: (chunk: string) => void;
  /** Monotonic clock. Defaults to `performance.now()` with a `Date.now()` fallback. */
  now?: () => number;
}

type CaseState = 'passed' | 'failed' | 'skipped';

interface FileStats {
  label: string;
  start: number;
  raw: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Worst-case state per `caseId` in this file, used to collapse data-driven iterations. */
  groups: Map<string, CaseState>;
}

interface FailureRecord {
  caseId: string | null;
  label: string;
  location: string;
  message: string;
}

function defaultNow(): number {
  return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

/** HH:MM:SS, or `NNNms` below one second. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.floor(ms / 1000);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

function escapeAnnotation(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeAnnotationProperty(value: string): string {
  return escapeAnnotation(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

function normalizeState(state: unknown): CaseState | undefined {
  if (state === 'passed' || state === 'failed' || state === 'skipped') return state;
  return undefined;
}

/** Worst-case roll-up matching SummaryReporter/JUnit/Allure: failed > passed > skipped. */
function worstCaseState(a: CaseState, b: CaseState): CaseState {
  if (a === 'failed' || b === 'failed') return 'failed';
  if (a === 'passed' || b === 'passed') return 'passed';
  return 'skipped';
}

function resolveConsolidateDataDriven(): boolean {
  try {
    return ConfigResolver.resolveBoolean('reporting.consolidateDataDriven');
  } catch {
    return true;
  }
}

function countsLine(raw: number, passed: number, failed: number, skipped: number): string {
  return `Total Tests: ${raw}, Passed: ${passed}, Failed: ${failed}, Skipped: ${skipped}`;
}

function completionHeadline(reason: TestRunEndReason | undefined, failedFiles: number): string {
  if (reason === 'interrupted') return 'Test run interrupted';
  if (reason === 'failed' || failedFiles > 0) return 'Test run completed with failures';
  return 'Test run completed';
}

/**
 * Streaming, plain-text progress reporter for non-TTY stdout (CI log pipes,
 * GitHub Actions, containers, redirected output). Emits append-only lines and
 * never relies on ANSI cursor movement or terminal width. When
 * `reporting.consolidateDataDriven` is enabled (default), same-`caseId` data-set
 * iterations collapse into one result so these counts match the summary, JUnit
 * and Allure reports.
 */
export class NonTtyReporter implements Reporter {
  private readonly interval: number;
  private readonly showFileStart: boolean;
  private readonly startBatchWindow: number;
  private readonly showFileDuration: boolean;
  private readonly showLiveCounts: boolean;
  private readonly showSummary: boolean;
  private readonly consolidate: boolean;
  private readonly githubActions: boolean;
  private readonly groupFailures: boolean;
  private readonly maxStackFrames: number;
  private readonly showFailedTestsDigest: boolean;
  private readonly maxDigestEntries: number;
  private readonly timestamps: boolean;
  private readonly writeChunk: (chunk: string) => void;
  private readonly now: () => number;

  private runStart = 0;
  private started = false;
  private totalFiles = 0;
  private completedFiles = 0;
  private passedFiles = 0;
  private failedFiles = 0;
  private rawTests = 0;
  private totalPassed = 0;
  private totalFailed = 0;
  private totalSkipped = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private startFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private exitHook: (() => void) | undefined;
  private pendingStarts: string[] = [];
  private readonly files = new Map<string, FileStats>();
  private failures: FailureRecord[] = [];
  private readonly failureKeys = new Set<string>();

  constructor(options: NonTtyReporterOptions = {}) {
    this.interval = options.interval ?? 5000;
    this.showFileStart = options.showFileStart ?? true;
    this.startBatchWindow = options.startBatchWindow ?? 50;
    this.showFileDuration = options.showFileDuration ?? true;
    this.showLiveCounts = options.showLiveCounts ?? true;
    this.showSummary = options.showSummary ?? true;
    this.consolidate = options.consolidateDataDriven ?? resolveConsolidateDataDriven();
    this.githubActions = options.githubActions ?? process.env['GITHUB_ACTIONS'] === 'true';
    this.groupFailures = options.groupFailures ?? this.githubActions;
    this.maxStackFrames = options.maxStackFrames ?? 2;
    this.showFailedTestsDigest = options.showFailedTestsDigest ?? this.githubActions;
    this.maxDigestEntries = options.maxDigestEntries ?? 25;
    this.timestamps = options.timestamps ?? false;
    this.writeChunk = options.write ?? ((chunk: string): void => {
      process.stdout.write(chunk);
    });
    this.now = options.now ?? defaultNow;
  }

  // ---------------------------------------------------------------- lifecycle

  onTestRunStart(specifications?: ReadonlyArray<unknown>): void {
    this.reset();
    this.runStart = this.now();
    this.started = true;
    this.totalFiles = specifications?.length ?? 0;
    this.emit(['Test run started']);
    this.startTimer();
  }

  onTestModuleStart(testModule: TestModule): void {
    const key = this.keyOf(testModule);
    const label = this.labelOf(testModule);
    if (!this.files.has(key)) {
      this.files.set(key, { label, start: this.now(), raw: 0, passed: 0, failed: 0, skipped: 0, groups: new Map() });
    }
    if (this.files.size > this.totalFiles) this.totalFiles = this.files.size;
    if (!this.showFileStart) return;
    this.queueStart(label);
  }

  onTestCaseResult(testCase: TestCase): void {
    const state = normalizeState(testCase?.result?.().state);
    const caseState: CaseState = state ?? 'skipped';
    const tags = (testCase as unknown as { tags?: string[] })?.tags;
    const caseId = this.consolidate ? extractCaseId(tags) : null;
    this.applyResult(this.statsForCase(testCase), caseId, caseState);

    if (state === 'failed') {
      this.annotateFailure(testCase);
      this.recordFailure(testCase);
      if (this.groupFailures) this.emit(this.formatFailureGroup(testCase));
    }
  }

  onTestModuleEnd(testModule: TestModule): void {
    const key = this.keyOf(testModule);
    const label = this.labelOf(testModule);
    const stats = this.files.get(key) ?? {
      label,
      start: this.runStart,
      raw: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      groups: new Map<string, CaseState>(),
    };
    this.files.delete(key);

    const duration = this.now() - stats.start;
    const ok = stats.failed === 0 && this.moduleOk(testModule);
    this.completedFiles++;
    if (ok) this.passedFiles++;
    else this.failedFiles++;

    const lines = [`[${ok ? 'PASS' : 'FAIL'}] ${label}`];
    if (this.showFileDuration) lines.push(`  Duration: ${formatDuration(duration)}`);
    lines.push(stats.raw === 0 ? '  Tests: no tests' : `  ${countsLine(stats.raw, stats.passed, stats.failed, stats.skipped)}`);
    this.emit(lines);

    if (this.showLiveCounts) this.emitProgress();
  }

  onTestRunEnd(
    testModules?: ReadonlyArray<TestModule>,
    _unhandledErrors?: ReadonlyArray<SerializedError>,
    reason?: TestRunEndReason,
  ): void {
    const elapsed = this.runElapsed();
    this.stop();
    if (this.showSummary) {
      if (testModules && testModules.length > 0) this.recountFinalTests(testModules);

      const headline = completionHeadline(reason, this.failedFiles);

      const fileParts: string[] = [];
      if (this.failedFiles > 0) fileParts.push(`${this.failedFiles} failed`);
      fileParts.push(`${this.passedFiles} passed`);

      this.emit([
        headline,
        `Test Files: ${fileParts.join(', ')}`,
        countsLine(this.rawTests, this.totalPassed, this.totalFailed, this.totalSkipped),
        `Duration: ${formatDuration(elapsed)}`,
      ]);
    }
    if (this.showFailedTestsDigest && this.failures.length > 0) {
      this.emit(this.formatFailedDigest());
    }
  }

  /** Clears the live-progress interval and the process exit hook. Idempotent. */
  stop(): void {
    this.flushStarts();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.exitHook) {
      process.off('exit', this.exitHook);
      this.exitHook = undefined;
    }
    this.started = false;
  }

  // ------------------------------------------------------------------ helpers

  private reset(): void {
    this.pendingStarts = [];
    this.stop();
    this.files.clear();
    this.failures = [];
    this.failureKeys.clear();
    this.completedFiles = 0;
    this.passedFiles = 0;
    this.failedFiles = 0;
    this.rawTests = 0;
    this.totalPassed = 0;
    this.totalFailed = 0;
    this.totalSkipped = 0;
  }

  private startTimer(): void {
    if (this.interval <= 0) return;
    this.timer = setInterval(() => {
      if (this.showLiveCounts) this.emitProgress();
      else this.emit([`Run elapsed: ${formatDuration(this.runElapsed())}`]);
    }, this.interval);
    this.timer.unref?.();
    this.exitHook = (): void => this.stop();
    process.once('exit', this.exitHook);
  }

  private emitProgress(): void {
    this.emit([
      `Progress: ${this.completedFiles}/${this.totalFiles} files completed`,
      countsLine(this.rawTests, this.totalPassed, this.totalFailed, this.totalSkipped),
      `Run elapsed: ${formatDuration(this.runElapsed())}`,
    ]);
  }

  private runElapsed(): number {
    return this.started || this.runStart > 0 ? this.now() - this.runStart : 0;
  }

  /** Groups near-simultaneous worker starts so one `Run elapsed` covers the batch. */
  private queueStart(label: string): void {
    this.pendingStarts.push(`[START] ${label}`);
    if (this.startBatchWindow <= 0) {
      this.flushStarts();
      return;
    }
    if (this.startFlushTimer) return;
    this.startFlushTimer = setTimeout(() => this.flushStarts(), this.startBatchWindow);
    this.startFlushTimer.unref?.();
  }

  private flushStarts(): void {
    if (this.startFlushTimer) {
      clearTimeout(this.startFlushTimer);
      this.startFlushTimer = undefined;
    }
    if (this.pendingStarts.length === 0) return;
    const lines = [...this.pendingStarts, `Run elapsed: ${formatDuration(this.runElapsed())}`];
    this.pendingStarts = [];
    this.writeBlock(lines);
  }

  private emit(lines: string[]): void {
    this.flushStarts();
    this.writeBlock(lines);
  }

  /** One write per block so parallel workers cannot interleave partial lines. */
  private writeBlock(lines: string[]): void {
    const prefix = this.timestamps ? `[${new Date().toISOString()}] ` : '';
    this.writeChunk(`\n${lines.map((line) => prefix + line).join('\n')}\n`);
  }

  private keyOf(testModule: TestModule): string {
    return (testModule as { moduleId?: string })?.moduleId ?? this.labelOf(testModule);
  }

  private labelOf(testModule: TestModule): string {
    const mod = testModule as { relativeModuleId?: string; moduleId?: string };
    if (mod?.relativeModuleId) return mod.relativeModuleId.split(path.sep).join('/');
    if (mod?.moduleId) return path.relative(process.cwd(), mod.moduleId).split(path.sep).join('/');
    return 'unknown file';
  }

  private moduleOk(testModule: TestModule): boolean {
    const ok = (testModule as { ok?: () => boolean })?.ok;
    return typeof ok === 'function' ? ok.call(testModule) !== false : true;
  }

  /**
   * Recompute final counts from the authoritative module tree, consolidating
   * same-`caseId` iterations per file exactly like SummaryReporter/JUnit/Allure
   * so every surface reports the same totals.
   */
  private recountFinalTests(testModules: ReadonlyArray<TestModule>): void {
    this.rawTests = 0;
    this.totalPassed = 0;
    this.totalFailed = 0;
    this.totalSkipped = 0;
    for (const testModule of testModules) {
      const groups = new Map<string, CaseState>();
      let standalone = 0;
      for (const testCase of testModule.children.allTests()) {
        const state = normalizeState(testCase.result().state) ?? 'skipped';
        const tags = (testCase as unknown as { tags?: string[] })?.tags;
        const caseId = this.consolidate ? extractCaseId(tags) : null;
        const key = caseId ?? `__standalone_${standalone++}`;
        const prev = groups.get(key);
        groups.set(key, prev === undefined ? state : worstCaseState(prev, state));
      }
      for (const state of groups.values()) {
        this.rawTests++;
        this.bumpTotals(state, 1);
      }
    }
  }

  private bumpTotals(state: CaseState, delta: number): void {
    if (state === 'passed') this.totalPassed += delta;
    else if (state === 'failed') this.totalFailed += delta;
    else this.totalSkipped += delta;
  }

  private bumpFile(stats: FileStats, state: CaseState, delta: number): void {
    if (state === 'passed') stats.passed += delta;
    else if (state === 'failed') stats.failed += delta;
    else stats.skipped += delta;
  }

  /**
   * Fold one live result into the running counters. Same-`caseId` iterations in a
   * file collapse to a single entry (worst-case state) so live counts converge to
   * the same totals the summary and report artifacts show.
   */
  private applyResult(stats: FileStats | undefined, caseId: string | null, state: CaseState): void {
    if (caseId === null || !stats) {
      this.rawTests++;
      this.bumpTotals(state, 1);
      if (stats) {
        stats.raw++;
        this.bumpFile(stats, state, 1);
      }
      return;
    }
    const prev = stats.groups.get(caseId);
    if (prev === undefined) {
      stats.groups.set(caseId, state);
      this.rawTests++;
      this.bumpTotals(state, 1);
      stats.raw++;
      this.bumpFile(stats, state, 1);
      return;
    }
    const next = worstCaseState(prev, state);
    if (next !== prev) {
      stats.groups.set(caseId, next);
      this.bumpTotals(prev, -1);
      this.bumpTotals(next, 1);
      this.bumpFile(stats, prev, -1);
      this.bumpFile(stats, next, 1);
    }
  }

  private statsForCase(testCase: TestCase): FileStats | undefined {
    const moduleId = (testCase as { module?: { moduleId?: string } })?.module?.moduleId;
    if (!moduleId) return undefined;
    let stats = this.files.get(moduleId);
    if (!stats) {
      stats = {
        label: this.labelOf((testCase as unknown as { module: TestModule }).module),
        start: this.now(),
        raw: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        groups: new Map<string, CaseState>(),
      };
      this.files.set(moduleId, stats);
      if (this.files.size > this.totalFiles) this.totalFiles = this.files.size;
    }
    return stats;
  }

  /** Shared file/location/name/case-id extraction reused by annotations, grouping and the digest. */
  private describeFailure(testCase: TestCase): { file: string; location?: { line?: number; column?: number }; name: string; caseId: string | null } {
    const file =
      (testCase as { module?: { relativeModuleId?: string } })?.module?.relativeModuleId ??
      'unknown file';
    const location = (testCase as { location?: { line?: number; column?: number } })?.location;
    const name = testCase?.fullName ?? testCase?.name ?? 'unknown test';
    const tags = (testCase as unknown as { tags?: string[] })?.tags;
    return { file, location, name, caseId: extractCaseId(tags) };
  }

  private annotateFailure(testCase: TestCase): void {
    if (!this.githubActions) return;
    this.flushStarts();
    const errors = testCase?.result?.().errors ?? [];
    const { file, location, name } = this.describeFailure(testCase);

    const message = errors.map((error) => error?.message ?? 'Unknown error').join('\n') || 'Test failed';
    const props = [`file=${escapeAnnotationProperty(file)}`];
    if (location?.line) props.push(`line=${location.line}`);
    if (location?.column) props.push(`col=${location.column}`);
    props.push(`title=${escapeAnnotationProperty(name)}`);
    this.writeChunk(`::error ${props.join(',')}::${escapeAnnotation(message)}\n`);
  }

  /** Records a failure for the end-of-run digest. Cheap; only the first error's message is kept. */
  private recordFailure(testCase: TestCase): void {
    if (!this.showFailedTestsDigest) return;
    const errors = testCase?.result?.().errors ?? [];
    const { file, location, name, caseId } = this.describeFailure(testCase);
    if (this.consolidate && caseId) {
      // Same scope as the consolidated counts: one digest entry per caseId per file.
      const moduleId = (testCase as { module?: { moduleId?: string } })?.module?.moduleId ?? file;
      const key = `${moduleId}\u0000${caseId}`;
      if (this.failureKeys.has(key)) return;
      this.failureKeys.add(key);
    }
    const message = (errors[0]?.message ?? 'Test failed').split('\n')[0] ?? 'Test failed';
    this.failures.push({
      caseId,
      label: caseId ?? name,
      location: location?.line ? `${file}:${location.line}` : file,
      message,
    });
  }

  /** Only the `at ...` frames, so the error message (already printed separately) isn't duplicated. */
  private stackFrames(stack: string | undefined): string[] {
    if (!stack) return [];
    return stack.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('at '));
  }

  /** Builds a collapsible `::group::...::endgroup::` block for one failing test. */
  private formatFailureGroup(testCase: TestCase): string[] {
    const errors = testCase?.result?.().errors ?? [];
    const { file, location, name, caseId } = this.describeFailure(testCase);
    const where = location?.line ? `${file}:${location.line}` : file;
    const title = caseId ? `${caseId} \u00b7 ${where}` : `${name} \u00b7 ${where}`;

    const lines = [`::group::\u274c FAIL  ${title}`];
    if (errors.length === 0) lines.push('  Test failed');
    for (const error of errors) {
      const message = error?.message ?? 'Unknown error';
      for (const messageLine of message.split('\n')) lines.push(`  ${messageLine}`);

      const frames = this.stackFrames(error?.stack);
      const shown = frames.slice(0, this.maxStackFrames);
      for (const frame of shown) lines.push(`    ${frame}`);
      if (frames.length > shown.length) lines.push(`    ... ${frames.length - shown.length} more frame(s)`);
    }
    lines.push('::endgroup::');
    return lines;
  }

  /** Compact `Failed Tests` summary appended after the final run summary. */
  private formatFailedDigest(): string[] {
    const shown = this.failures.slice(0, this.maxDigestEntries);
    const lines = [`Failed Tests (${this.failures.length}):`];
    for (const failure of shown) {
      lines.push(`  ${failure.label}  ${failure.message}  ${failure.location}`);
    }
    if (this.failures.length > shown.length) {
      lines.push(`  ... ${this.failures.length - shown.length} more (see junit-report.xml / allure-results for full detail)`);
    }
    return lines;
  }
}

export default NonTtyReporter;
