import type { Reporter, TestRunEndReason } from 'vitest/reporters';
import type { TestModule, TestCase, TestSuite } from 'vitest/node';
import type { SerializedError } from '@vitest/utils';
import { ConfigResolver } from '../config/ConfigResolver.js';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const SKIP = '\x1b[33m↓\x1b[0m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

type State = 'passed' | 'failed' | 'skipped';
type DisplayItem =
  | { kind: 'suite'; suite: TestSuite }
  | { kind: 'group'; tests: TestCase[] };

interface StateCounts {
  passed: number;
  failed: number;
  skipped: number;
}

function duration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms >= 60000) return ` ${DIM}${(ms / 60000).toFixed(2)} min${RESET}`;
  if (ms >= 1000) return ` ${DIM}${(ms / 1000).toFixed(2)}s${RESET}`;
  return ` ${DIM}${Math.round(ms)}ms${RESET}`;
}

function extractCaseId(testCase: TestCase): string | null {
  // Tags are stored internally in vitest's test case
  // Access via type casting since they're not exposed in public API
  const tags = (testCase as unknown as { tags?: string[] }).tags;
  if (!tags || tags.length === 0) return null;
  // Accept both `C123` and `@C123` tag formats; normalize to `C123`.
  const caseIdPattern = /^@?(C\d+)$/;
  for (const rawTag of tags) {
    const tag = rawTag.trim();
    const match = caseIdPattern.exec(tag);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Worst-case roll-up across data sets: failed > passed > skipped. */
function worstState(states: State[]): State {
  if (states.includes('failed')) return 'failed';
  if (states.includes('passed')) return 'passed';
  return 'skipped';
}

function iconForState(state: State): string {
  if (state === 'passed') return PASS;
  if (state === 'failed') return FAIL;
  return SKIP;
}

function iconForCase(testCase: TestCase): string {
  return iconForState(testCase.result().state as State);
}

function iconForSuite(suite: TestSuite): string {
  const state = suite.state();
  if (state === 'skipped') return SKIP;
  return suite.ok() ? PASS : FAIL;
}

function iconForModule(mod: TestModule): string {
  const state = mod.state();
  if (state === 'skipped') return SKIP;
  return mod.ok() ? PASS : FAIL;
}

/**
 * Count tests in a suite, collapsing same-caseId data sets into one when
 * consolidation is enabled (mirrors the JUnit/JSON/Allure reports).
 */
function countTests(suite: TestSuite, consolidate: boolean): number {
  let count = 0;
  const seenCaseIds = new Set<string>();
  for (const child of suite.children) {
    if (child.type === 'test') {
      const caseId = consolidate ? extractCaseId(child) : null;
      if (caseId) {
        if (seenCaseIds.has(caseId)) continue;
        seenCaseIds.add(caseId);
      }
      count++;
    } else {
      count += countTests(child, consolidate);
    }
  }
  return count;
}

function groupChildren(
  children: ReadonlyArray<TestCase | TestSuite>,
  consolidate: boolean,
): DisplayItem[] {
  const groups = new Map<string, Extract<DisplayItem, { kind: 'group' }>>();
  const items: DisplayItem[] = [];
  let uniq = 0;

  for (const child of children) {
    if (child.type === 'suite') {
      items.push({ kind: 'suite', suite: child });
      continue;
    }
    const caseId = consolidate ? extractCaseId(child) : null;
    const key = caseId ?? `__uniq_${uniq++}`;
    const group = groups.get(key);
    if (group) {
      group.tests.push(child);
    } else {
      const newGroup: Extract<DisplayItem, { kind: 'group' }> = { kind: 'group', tests: [child] };
      groups.set(key, newGroup);
      items.push(newGroup);
    }
  }
  return items;
}

function printTestGroup(group: TestCase[], indent: string): void {
  const first = group[0]!;
  if (group.length === 1) {
    const diag = first.diagnostic();
    const caseId = extractCaseId(first);
    const label = caseId ? `${first.name} - ${caseId}` : first.name;
    process.stdout.write(`${indent}${iconForCase(first)} ${label}${duration(diag?.duration)}\n`);
    return;
  }

  const state = worstState(group.map((testCase) => testCase.result().state as State));
  const caseId = extractCaseId(first);
  const totalMs = group.reduce((sum, testCase) => sum + (testCase.diagnostic()?.duration ?? 0), 0);
  const extra = group.length - 1;
  const suffix = `${DIM}(+${extra} data set${extra === 1 ? '' : 's'})${RESET}`;
  process.stdout.write(
    `${indent}${iconForState(state)} ${first.name} - ${caseId} ${suffix}${duration(totalMs)}\n`,
  );
}

/**
 * Print a suite's children, merging same-caseId data sets into a single line
 * (`… - C123 (+N data sets)`) with a worst-case status.
 */
function printChildren(
  children: ReadonlyArray<TestCase | TestSuite>,
  indent: string,
  consolidate: boolean,
): void {
  const items = groupChildren(children, consolidate);

  for (const item of items) {
    if (item.kind === 'suite') {
      const count = countTests(item.suite, consolidate);
      process.stdout.write(`${indent}${iconForSuite(item.suite)} ${item.suite.name} (${count})\n`);
      printChildren([...item.suite.children], indent + '  ', consolidate);
      continue;
    }
    printTestGroup(item.tests, indent);
  }
}

function countTestStates(allTests: TestCase[], consolidate: boolean): StateCounts {
  const groups = new Map<string, State[]>();
  let uniq = 0;
  for (const testCase of allTests) {
    const caseId = consolidate ? extractCaseId(testCase) : null;
    const key = caseId ?? `__uniq_${uniq++}`;
    const states = groups.get(key);
    if (states) states.push(testCase.result().state as State);
    else groups.set(key, [testCase.result().state as State]);
  }

  const counts: StateCounts = { passed: 0, failed: 0, skipped: 0 };
  for (const states of groups.values()) {
    counts[worstState(states)]++;
  }
  return counts;
}

function hasExecutedTest(allTests: TestCase[]): boolean {
  return allTests.some((testCase) => {
    const state = testCase.result().state;
    return state === 'passed' || state === 'failed';
  });
}

function isConsolidationEnabled(): boolean {
  try {
    return ConfigResolver.resolveBoolean('reporting.consolidateDataDriven');
  } catch {
    return true;
  }
}

export class SummaryReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>, _unhandledErrors: ReadonlyArray<SerializedError>, _reason: TestRunEndReason): void {
    const consolidate = isConsolidationEnabled();
    let totalPass = 0, totalFail = 0, totalSkip = 0;

    process.stdout.write('\n\x1b[1m── Test Summary ──\x1b[0m\n\n');

    if (testModules.length === 0) {
      process.stdout.write(`${SKIP} No test files found.\n\n`);
      return;
    }

    for (const mod of testModules) {
      const allTests = [...mod.children.allTests()];
      const counts = countTestStates(allTests, consolidate);
      totalPass += counts.passed;
      totalFail += counts.failed;
      totalSkip += counts.skipped;

      if (!hasExecutedTest(allTests)) continue;

      const diag = mod.diagnostic();
      process.stdout.write(`${iconForModule(mod)} ${mod.relativeModuleId}${duration(diag?.duration)}\n`);
      printChildren([...mod.children], '  ', consolidate);
      process.stdout.write('\n');
    }

    const total = totalPass + totalFail + totalSkip;
    const color = totalFail > 0 ? '\x1b[31m' : '\x1b[32m';
    process.stdout.write(
      `${color}Total Tests: ${total}, Passed: ${totalPass}, Failed: ${totalFail}, Skipped: ${totalSkip}\x1b[0m\n\n`
    );
  }
}