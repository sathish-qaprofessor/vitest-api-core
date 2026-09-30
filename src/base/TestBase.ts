import { LoggerService } from '../logger/LoggerService.js';
import { SoftAssert } from '../asserts/SoftAssert.js';
import { Messages } from '../constants/Messages.js';

export type TestStepAction = () => Promise<void>;

export interface TestStepOptions {
  /** Number of additional attempts if the step throws or records soft-assertion failures. Default: 0 (no retry). */
  retries?: number;
}

/**
 * TestBase provides test lifecycle helpers:
 * - testStep() with execution timing, conditional skip and optional retry
 * - Soft assertion failure tracking
 */
export class TestBase {
  private readonly loggerService: LoggerService;
  private readonly softAssert: SoftAssert;
  private _softAssertionFailed = false;
  private _stepNumber = 0;

  constructor(loggerService?: LoggerService) {
    this.loggerService = loggerService ?? new LoggerService('TestBase');
    this.softAssert = new SoftAssert(this.loggerService);
  }

  get assertions(): SoftAssert {
    return this.softAssert;
  }

  get softAssertionFailed(): boolean {
    return this._softAssertionFailed;
  }

  /**
   * Execute a named test step with timing.
   * Supports conditional skipping via overloads:
   *
   * ```ts
   * await testStep('Always runs', async () => { ... });
   * await testStep('Skip if true', condition, async () => { ... });
   * await testStep('Skip if true', condition, 'reason', async () => { ... });
   *
   * // Optional trailing options enable retry when the step throws or a soft assertion fails:
   * await testStep('Flaky call', async () => { ... }, { retries: 2 });
   * await testStep('Flaky call', condition, async () => { ... }, { retries: 2 });
   * await testStep('Flaky call', condition, 'reason', async () => { ... }, { retries: 2 });
   * ```
   */
  async testStep(stepName: string, action: TestStepAction, options?: TestStepOptions): Promise<void>;
  async testStep(stepName: string, skip: boolean, action: TestStepAction, options?: TestStepOptions): Promise<void>;
  async testStep(
    stepName: string,
    skip: boolean,
    skipReason: string,
    action: TestStepAction,
    options?: TestStepOptions,
  ): Promise<void>;
  async testStep(
    stepName: string,
    skipOrAction: boolean | TestStepAction,
    arg3?: string | TestStepAction | TestStepOptions,
    arg4?: TestStepAction | TestStepOptions,
    arg5?: TestStepOptions,
  ): Promise<void> {
    const { skip, skipReason, action, options } = TestBase.parseStepArgs(skipOrAction, arg3, arg4, arg5);

    const retries = options?.retries ?? 0;
    if (!Number.isInteger(retries) || retries < 0) {
      throw new Error(`testStep '${stepName}': retries must be a non-negative integer, got ${retries}`);
    }

    this._stepNumber++;

    if (skip) {
      const reason = skipReason ? ` (${skipReason})` : '';
      this.loggerService.info('TESTSTEP :: {} skipped{}', stepName, reason);
      return;
    }

    this.loggerService.info(Messages.TESTSTEP_START, stepName);
    await this.runWithRetry(stepName, action, retries + 1);
  }

  private static parseStepArgs(
    skipOrAction: boolean | TestStepAction,
    arg3?: string | TestStepAction | TestStepOptions,
    arg4?: TestStepAction | TestStepOptions,
    arg5?: TestStepOptions,
  ): { skip: boolean; skipReason?: string; action: TestStepAction; options?: TestStepOptions } {
    if (typeof skipOrAction === 'function') {
      // testStep(name, action, options?)
      return { skip: false, action: skipOrAction, options: arg3 as TestStepOptions | undefined };
    }
    if (typeof arg3 === 'function') {
      // testStep(name, skip, action, options?)
      return { skip: skipOrAction, action: arg3, options: arg4 as TestStepOptions | undefined };
    }
    // testStep(name, skip, skipReason, action, options?)
    return {
      skip: skipOrAction,
      skipReason: arg3 as string | undefined,
      action: arg4 as TestStepAction,
      options: arg5,
    };
  }

  private async runWithRetry(stepName: string, action: TestStepAction, maxAttempts: number): Promise<void> {
    const startTime = performance.now();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const checkpoint = this.softAssert.checkpoint();
      const isLastAttempt = attempt === maxAttempts;
      let softFailures: number;

      try {
        await action();
        softFailures = this.softAssert.failuresSince(checkpoint);
      } catch (error) {
        if (isLastAttempt) {
          this.logStepFailure(stepName, startTime, error);
          throw error;
        }
        this.prepareRetry(stepName, attempt, maxAttempts, checkpoint, error instanceof Error ? error.message : String(error));
        continue;
      }

      if (softFailures > 0 && !isLastAttempt) {
        this.prepareRetry(stepName, attempt, maxAttempts, checkpoint, `${softFailures} soft assertion(s) failed`);
        continue;
      }

      if (attempt > 1 && softFailures === 0) {
        this.loggerService.info(Messages.TESTSTEP_RETRY_PASSED, stepName, attempt, maxAttempts);
      }
      this.loggerService.info(Messages.TESTSTEP_END, stepName, TestBase.formatElapsed(performance.now() - startTime));
      process.stdout.write('\n');
      return;
    }
  }

  /** Discards soft assertions from the failed attempt so they don't leak into the retry. */
  private prepareRetry(stepName: string, attempt: number, maxAttempts: number, checkpoint: number, reason: string): void {
    this.softAssert.rollbackTo(checkpoint);
    this.loggerService.warn(Messages.TESTSTEP_RETRY, stepName, attempt, maxAttempts, reason);
  }

  private logStepFailure(stepName: string, startTime: number, error: unknown): void {
    const elapsed = performance.now() - startTime;
    this._softAssertionFailed = true;
    this.loggerService.error(Messages.TESTSTEP_EXCEPTION, stepName, TestBase.formatElapsed(elapsed), error as Error);
    process.stdout.write('\n');
  }

  private static formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(2)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(2)} sec`;
    return `${(ms / 60_000).toFixed(2)} min`;
  }

  /**
   * Reset test state for a new test method.
   */
  reset(): void {
    this._softAssertionFailed = false;
    this._stepNumber = 0;
    this.softAssert.reset();
  }
}
