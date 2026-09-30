import { TestResult } from './types.js';

/** Matches a TestRail case id tag in either `C123` or `@C123` form. */
const CASE_ID_PATTERN = /^@?(C\d+)$/;

/** Extract the first TestRail case id from a tag list, normalized to `C123`. */
export function extractCaseId(tags: string[] | undefined): string | null {
  if (!tags) return null;
  for (const raw of tags) {
    const match = CASE_ID_PATTERN.exec(raw.trim());
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Consolidate data-driven iterations that share a single TestRail case id into
 * one result, so downstream reporting (and the TestRail sync that reads it)
 * posts a single result per case instead of one per data set.
 *
 * Rules:
 * - Tests are grouped by case id. Tests without a case id, and case ids that
 *   appear only once, are returned untouched (preserves the multiple-case-id
 *   data-driven pattern where each data set maps to its own case).
 * - A group of 2+ iterations collapses to one result:
 *   - status: `failed` if any iteration failed, else `skipped` if all skipped,
 *     otherwise `passed` (a single failing data set fails the case).
 *   - duration: summed; startTime: earliest; endTime: latest.
 *   - logs/requests/errors: concatenated in iteration order, each prefixed with
 *     a data-set header so full traceability is retained.
 *   - tags: unioned.
 * - First-seen order of case-id groups is preserved.
 */
export function consolidateByCaseId(tests: TestResult[]): TestResult[] {
  const order: string[] = [];
  const groups = new Map<string, TestResult[]>();
  let standaloneSeq = 0;

  for (const test of tests) {
    const caseId = extractCaseId(test.tags);
    const key = caseId ? `case:${caseId}` : `nocase:${standaloneSeq++}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(test);
    } else {
      groups.set(key, [test]);
      order.push(key);
    }
  }

  const consolidated: TestResult[] = [];
  for (const key of order) {
    const bucket = groups.get(key)!;
    consolidated.push(bucket.length === 1 ? bucket[0]! : mergeIterations(bucket));
  }
  return consolidated;
}

/** Merge 2+ iterations that share a case id into a single consolidated result. */
function mergeIterations(iterations: TestResult[]): TestResult {
  const base = iterations[0]!;

  const status: TestResult['status'] = iterations.some(t => t.status === 'failed')
    ? 'failed'
    : iterations.every(t => t.status === 'skipped')
      ? 'skipped'
      : 'passed';

  const duration = iterations.reduce((sum, t) => sum + (t.duration ?? 0), 0);

  const startTime = iterations.reduce(
    (min, t) => (t.startTime && t.startTime < min ? t.startTime : min),
    base.startTime,
  );
  const endTime = iterations.reduce(
    (max, t) => (t.endTime && t.endTime > max ? t.endTime : max),
    base.endTime ?? '',
  );

  const tags = [...new Set(iterations.flatMap(t => t.tags ?? []))];

  const logs: string[] = [];
  const requests: NonNullable<TestResult['requests']> = [];
  const errors: string[] = [];

  iterations.forEach((iteration, index) => {
    const header = `─── Data set ${index + 1}: ${iteration.name} [${iteration.status}] ───`;
    if (iteration.logs?.length) logs.push(header, ...iteration.logs);
    if (iteration.requests?.length) requests.push(...iteration.requests);
    if (iteration.error) errors.push(`[Data set ${index + 1}: ${iteration.name}] ${iteration.error}`);
  });

  const extra = iterations.length - 1;

  return {
    ...base,
    name: `${base.name} (+${extra} data set${extra === 1 ? '' : 's'})`,
    status,
    duration,
    startTime,
    endTime: endTime || base.endTime,
    error: errors.length > 0 ? errors.join('\n') : undefined,
    tags: tags.length > 0 ? tags : undefined,
    logs: logs.length > 0 ? logs : base.logs,
    requests: requests.length > 0 ? requests : undefined,
  };
}
