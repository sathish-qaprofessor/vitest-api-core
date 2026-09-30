import { LoggerService } from '../logger/LoggerService.js';

/**
 * Assertion result detail.
 */
interface AssertionResult {
  passed: boolean;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

/**
 * Soft assertion class that collects all assertion failures and reports them together at the end.
 *
 * Features:
 * - Visual ✓/✗ logging per assertion
 * - Field-level diff reporting for object comparisons
 * - Passed/failed assertion counts
 * - assertAll() throws collected failures
 */
export class SoftAssert {
  private readonly loggerService: LoggerService;
  private readonly results: AssertionResult[] = [];
  private _passedCount = 0;
  private _failedCount = 0;
  private _hasFailures = false;

  constructor(loggerService?: LoggerService) {
    this.loggerService = loggerService ?? new LoggerService('SoftAssert');
  }

  get passedCount(): number {
    return this._passedCount;
  }

  get failedCount(): number {
    return this._failedCount;
  }

  get hasFailures(): boolean {
    return this._hasFailures;
  }

  get totalAssertions(): number {
    return this._passedCount + this._failedCount;
  }

  // ====================== ASSERTION METHODS ======================

  assertEquals<T>(actual: T, expected: T, message?: string): void {
    if (this.deepEquals(actual, expected)) {
      this.recordPass('Assert-Equals is validated and passed');
    } else {
      this.recordFail(
        message || `expected [${this.stringify(expected)}], but got [${this.stringify(actual)}]`,
        expected,
        actual,
      );
    }
  }

  assertNotEquals<T>(actual: T, expected: T, message?: string): void {
    if (!this.deepEquals(actual, expected)) {
      this.recordPass('Assert-NotEquals is validated and passed');
    } else {
      this.recordFail(
        message || `expected values to differ, but both are [${this.stringify(actual)}]`,
        expected,
        actual,
      );
    }
  }

  assertTrue(condition: boolean, message?: string): void {
    if (condition) { // NOSONAR - the caller-provided condition is the assertion value.
      this.recordPass('Assert-True is validated and passed');
    } else {
      this.recordFail(message || 'expected true, but got false', true, false);
    }
  }

  assertFalse(condition: boolean, message?: string): void {
    if (!condition) { // NOSONAR - the caller-provided condition is the assertion value.
      this.recordPass('Assert-False is validated and passed');
    } else {
      this.recordFail(message || 'expected false, but got true', false, true);
    }
  }

  assertNull(value: unknown, message?: string): void {
    if (value == null) {
      this.recordPass('Assert-Null is validated and passed');
    } else {
      this.recordFail(message || `expected null/undefined, but got [${this.stringify(value)}]`, null, value);
    }
  }

  assertNotNull(value: unknown, message?: string): void {
    if (value != null) {
      this.recordPass('Assert-NotNull is validated and passed');
    } else {
      this.recordFail(message || 'expected a non-null value, but got null/undefined', 'non-null', value);
    }
  }

  assertContains(actual: string, expected: string, message?: string): void {
    if (actual?.includes(expected)) {
      this.recordPass('Assert-Contains is validated and passed');
    } else {
      this.recordFail(message || `"${actual}" does not contain "${expected}"`, expected, actual);
    }
  }

  assertNotContains(actual: string, unexpected: string, message?: string): void {
    if (actual && !actual.includes(unexpected)) {
      this.recordPass('Assert-NotContains is validated and passed');
    } else {
      this.recordFail(message || `"${actual}" contains unexpected "${unexpected}"`, undefined, actual);
    }
  }

  assertGreaterThan(actual: number, expected: number, message?: string): void {
    if (actual > expected) {
      this.recordPass('Assert-GreaterThan is validated and passed');
    } else {
      this.recordFail(message || `expected ${actual} > ${expected}`, `> ${expected}`, actual);
    }
  }

  assertGreaterOrEqual(actual: number, expected: number, message?: string): void {
    if (actual >= expected) {
      this.recordPass('Assert-GreaterOrEqual is validated and passed');
    } else {
      this.recordFail(message || `expected ${actual} >= ${expected}`, `>= ${expected}`, actual);
    }
  }

  assertLessThan(actual: number, expected: number, message?: string): void {
    if (actual < expected) {
      this.recordPass('Assert-LessThan is validated and passed');
    } else {
      this.recordFail(message || `expected ${actual} < ${expected}`, `< ${expected}`, actual);
    }
  }

  assertLesserOrEqual(actual: number, expected: number, message?: string): void {
    if (actual <= expected) {
      this.recordPass('Assert-LesserOrEqual is validated and passed');
    } else {
      this.recordFail(message || `expected ${actual} <= ${expected}`, `<= ${expected}`, actual);
    }
  }

  /**
   * Compare two arrays (or any deeply nested values) for deep equality.
   * Reports a diff of mismatched indices for arrays.
   */
  assertDeepEquals<T>(actual: T[], expected: T[], message?: string): void {
    if (this.deepEquals(actual, expected)) {
      this.recordPass('Assert-DeepEquals is validated and passed');
      return;
    }

    if (Array.isArray(actual) && Array.isArray(expected)) {
      const maxLen = Math.max(actual.length, expected.length);
      for (let i = 0; i < maxLen; i++) {
        if (!this.deepEquals(actual[i], expected[i])) {
          this.recordFail(
            message || `[${i}]: expected [${this.stringify(expected[i])}], but got [${this.stringify(actual[i])}]`,
            expected[i],
            actual[i],
          );
        }
      }
    } else {
      this.recordFail(
        message || `expected [${this.stringify(expected)}], but got [${this.stringify(actual)}]`,
        expected,
        actual,
      );
    }
  }

  /**
   * Compare two objects field-by-field and report diffs.
   * Ported from Java's field-level diff with Jackson.
   */
  assertObjectEquals(actual: unknown, expected: unknown, message?: string): void {
    if (this.deepEquals(actual, expected)) {
      this.recordPass('Assert-ObjectEquals is validated and passed');
      return;
    }

    // Field-level diff
    if (typeof actual === 'object' && typeof expected === 'object' && actual != null && expected != null) {
      const actualObj = actual as Record<string, unknown>;
      const expectedObj = expected as Record<string, unknown>;
      const allKeys = new Set([...Object.keys(actualObj), ...Object.keys(expectedObj)]);

      for (const key of allKeys) {
        const actualVal = actualObj[key];
        const expectedVal = expectedObj[key];
        if (!this.deepEquals(actualVal, expectedVal)) {
          this.recordFail(
            message || `${key}: expected [${this.stringify(expectedVal)}], but got [${this.stringify(actualVal)}]`,
            expectedVal,
            actualVal,
          );
        }
      }
    } else {
      this.recordFail(
        message || `expected [${this.stringify(expected)}], but got [${this.stringify(actual)}]`,
        expected,
        actual,
      );
    }
  }

  // ====================== ARRAY / COLLECTION ======================

  assertArrayContains<T>(actual: T[], item: T, message?: string): void {
    if (actual.some((el) => this.deepEquals(el, item))) {
      this.recordPass('Assert-ArrayContains is validated and passed');
    } else {
      this.recordFail(
        message || `array does not contain [${this.stringify(item)}]`,
        item,
        actual,
      );
    }
  }

  assertArrayNotContains<T>(actual: T[], item: T, message?: string): void {
    if (!actual.some((el) => this.deepEquals(el, item))) {
      this.recordPass('Assert-ArrayNotContains is validated and passed');
    } else {
      this.recordFail(
        message || `array unexpectedly contains [${this.stringify(item)}]`,
        undefined,
        actual,
      );
    }
  }

  assertArrayLength(actual: unknown[], expected: number, message?: string): void {
    if (actual.length === expected) {
      this.recordPass('Assert-ArrayLength is validated and passed');
    } else {
      this.recordFail(
        message || `expected array length ${expected}, but got ${actual.length}`,
        expected,
        actual.length,
      );
    }
  }

  assertArrayEmpty(actual: unknown[], message?: string): void {
    if (actual.length === 0) {
      this.recordPass('Assert-ArrayEmpty is validated and passed');
    } else {
      this.recordFail(
        message || `expected empty array, but got ${actual.length} element(s)`,
        [],
        actual,
      );
    }
  }

  assertArrayNotEmpty(actual: unknown[], message?: string): void {
    if (actual.length > 0) {
      this.recordPass('Assert-ArrayNotEmpty is validated and passed');
    } else {
      this.recordFail(message || 'expected non-empty array, but got []', 'non-empty array', actual);
    }
  }

  assertArrayContainsAll<T>(actual: T[], expected: T[], message?: string): void {
    const missing = expected.filter((item) => !actual.some((el) => this.deepEquals(el, item)));
    if (missing.length === 0) {
      this.recordPass('Assert-ArrayContainsAll is validated and passed');
    } else {
      this.recordFail(
        message || `array is missing element(s): [${missing.map((m) => this.stringify(m)).join(', ')}]`,
        expected,
        actual,
      );
    }
  }

  // ====================== STRING ======================

  assertStartsWith(actual: string, prefix: string, message?: string): void {
    if (actual.startsWith(prefix)) {
      this.recordPass('Assert-StartsWith is validated and passed');
    } else {
      this.recordFail(
        message || `"${actual}" does not start with "${prefix}"`,
        prefix,
        actual,
      );
    }
  }

  assertEndsWith(actual: string, suffix: string, message?: string): void {
    if (actual.endsWith(suffix)) {
      this.recordPass('Assert-EndsWith is validated and passed');
    } else {
      this.recordFail(
        message || `"${actual}" does not end with "${suffix}"`,
        suffix,
        actual,
      );
    }
  }

  assertMatches(actual: string, pattern: RegExp, message?: string): void {
    if (pattern.test(actual)) {
      this.recordPass('Assert-Matches is validated and passed');
    } else {
      this.recordFail(
        message || `"${actual}" does not match pattern ${pattern}`,
        pattern.toString(),
        actual,
      );
    }
  }

  assertNotMatches(actual: string, pattern: RegExp, message?: string): void {
    if (!pattern.test(actual)) {
      this.recordPass('Assert-NotMatches is validated and passed');
    } else {
      this.recordFail(
        message || `"${actual}" unexpectedly matches pattern ${pattern}`,
        undefined,
        actual,
      );
    }
  }

  assertStringLength(actual: string, expected: number, message?: string): void {
    if (actual.length === expected) {
      this.recordPass('Assert-StringLength is validated and passed');
    } else {
      this.recordFail(
        message || `expected string length ${expected}, but got ${actual.length}`,
        expected,
        actual.length,
      );
    }
  }

  assertEmpty(actual: string, message?: string): void {
    if (actual === '') {
      this.recordPass('Assert-Empty is validated and passed');
    } else {
      this.recordFail(
        message || `expected empty string, but got "${actual}"`,
        '',
        actual,
      );
    }
  }

  assertNotEmpty(actual: string, message?: string): void {
    if (actual !== '') {
      this.recordPass('Assert-NotEmpty is validated and passed');
    } else {
      this.recordFail(message || 'expected non-empty string, but got ""', 'non-empty string', actual);
    }
  }

  // ====================== NUMBER / RANGE ======================

  assertBetween(actual: number, min: number, max: number, message?: string): void {
    if (actual >= min && actual <= max) {
      this.recordPass('Assert-Between is validated and passed');
    } else {
      this.recordFail(
        message || `expected ${actual} to be between ${min} and ${max} (inclusive)`,
        `[${min}, ${max}]`,
        actual,
      );
    }
  }

  assertPositive(actual: number, message?: string): void {
    if (actual > 0) {
      this.recordPass('Assert-Positive is validated and passed');
    } else {
      this.recordFail(message || `expected a positive number, but got ${actual}`, '> 0', actual);
    }
  }

  assertNegative(actual: number, message?: string): void {
    if (actual < 0) {
      this.recordPass('Assert-Negative is validated and passed');
    } else {
      this.recordFail(message || `expected a negative number, but got ${actual}`, '< 0', actual);
    }
  }

  assertZero(actual: number, message?: string): void {
    if (actual === 0) {
      this.recordPass('Assert-Zero is validated and passed');
    } else {
      this.recordFail(message || `expected 0, but got ${actual}`, 0, actual);
    }
  }

  // ====================== TYPE / SHAPE ======================

  assertInstanceOf(actual: unknown, ctor: new (...args: unknown[]) => unknown, message?: string): void {
    if (actual instanceof ctor) {
      this.recordPass('Assert-InstanceOf is validated and passed');
    } else {
      this.recordFail(
        message || `expected instance of ${ctor.name}, but got ${this.stringify(actual)}`,
        ctor.name,
        actual,
      );
    }
  }

  assertTypeOf(actual: unknown, expected: string, message?: string): void {
    const type = typeof actual;
    if (type === expected) {
      this.recordPass('Assert-TypeOf is validated and passed');
    } else {
      this.recordFail(
        message || `expected typeof "${expected}", but got "${type}"`,
        expected,
        type,
      );
    }
  }

  assertHasProperty(actual: object, key: string, message?: string): void {
    if (Object.hasOwn(actual, key)) {
      this.recordPass('Assert-HasProperty is validated and passed');
    } else {
      this.recordFail(
        message || `expected object to have property "${key}"`,
        key,
        Object.keys(actual),
      );
    }
  }

  assertHasProperties(actual: object, keys: string[], message?: string): void {
    const missing = keys.filter((key) => !Object.hasOwn(actual, key));
    if (missing.length === 0) {
      this.recordPass('Assert-HasProperties is validated and passed');
    } else {
      const propertyLabel = missing.length > 1 ? 'properties' : 'property';
      this.recordFail(
        message || `object is missing ${propertyLabel}: [${missing.join(', ')}]`,
        keys,
        Object.keys(actual),
      );
    }
  }

  // ====================== STATUS CODE / HTTP ======================

  assertStatusCode(actual: number, expected: number, message?: string): void {
    if (actual === expected) {
      this.recordPass('Assert-StatusCode is validated and passed');
    } else {
      this.recordFail(
        message || `expected HTTP status ${expected}, but got ${actual}`,
        expected,
        actual,
      );
    }
  }

  assertStatusOk(actual: number, message?: string): void {
    if (actual >= 200 && actual <= 299) {
      this.recordPass('Assert-StatusOk is validated and passed');
    } else {
      this.recordFail(
        message || `expected HTTP status in 200–299 range, but got ${actual}`,
        '200–299',
        actual,
      );
    }
  }

  // ====================== COLLECT & REPORT ======================

  /**
   * Throws an error with all collected failures.
   * Call at the end of a test to report soft assertion results.
   */
  assertAll(): void {
    this.loggerService.info(`Assertion Summary: ${this._passedCount} passed, ${this._failedCount} failed`);
    if (!this._hasFailures) return;

    const failures = this.results.filter((r) => !r.passed);
    const errorMessage = [
      `${this._failedCount} assertion(s) failed out of ${this.totalAssertions}:`,
      ...failures.map((f, i) => `  ${i + 1}. ${f.message}`),
    ].join('\n');

    throw new Error(errorMessage);
  }

  /**
   * Reset assertion state.
   */
  reset(): void {
    this.results.length = 0;
    this._passedCount = 0;
    this._failedCount = 0;
    this._hasFailures = false;
  }

  /** @internal Marker of the current assertion count, used by testStep retry. */
  checkpoint(): number {
    return this.results.length;
  }

  /** @internal Number of failed assertions recorded after the given checkpoint. */
  failuresSince(checkpoint: number): number {
    return this.results.slice(checkpoint).filter((r) => !r.passed).length;
  }

  /** @internal Drop assertions recorded after the given checkpoint. */
  rollbackTo(checkpoint: number): void {
    this.results.length = checkpoint;
    this._passedCount = this.results.filter((r) => r.passed).length;
    this._failedCount = this.results.length - this._passedCount;
    this._hasFailures = this._failedCount > 0;
  }

  // ====================== PRIVATE HELPERS ======================

  private recordPass(message: string): void {
    this._passedCount++;
    this.results.push({ passed: true, message });
    this.loggerService.info(`  ✓ ${message}`);
  }

  private recordFail(message: string, expected?: unknown, actual?: unknown): void {
    this._failedCount++;
    this._hasFailures = true;
    this.results.push({ passed: false, message, expected, actual });
    this.loggerService.error(`  ✗ ${message}`);
  }

  private deepEquals(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a == b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;

    const aStr = JSON.stringify(this.sortKeysDeep(a));
    const bStr = JSON.stringify(this.sortKeysDeep(b));
    return aStr === bStr;
  }

  private sortKeysDeep(obj: unknown): unknown {
    if (obj == null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map((item) => this.sortKeysDeep(item));
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort((left, right) => left.localeCompare(right))) {
      sorted[key] = this.sortKeysDeep((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  private stringify(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }

}
