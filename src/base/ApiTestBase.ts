import {
  describe as vitestDescribe,
  test as vitestTest,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';
import type { RunnerTask as Task } from 'vitest';
import { LoggerService } from '../logger/LoggerService.js';
import { ConfigReader } from '../config/ConfigReader.js';
import { ConfigResolver } from '../config/ConfigResolver.js';
import { ServiceClient } from './ServiceClient.js';
import { ServiceBase } from './ServiceBase.js';
import { TestBase } from './TestBase.js';
import { SoftAssert } from '../asserts/SoftAssert.js';
import { JsonReporter } from '../reports/JsonReporter.js';
import { JunitReporter } from '../reports/JunitReporter.js';
import { extractCaseId } from '../reports/consolidate.js';
import type { TestResult } from '../reports/types.js';
import { createHash } from 'node:crypto';

const COLOR_RESET = '\x1b[0m';
const COLOR_CYAN = '\x1b[36m';
const COLOR_GREEN = '\x1b[32m';
const COLOR_RED = '\x1b[31m';
const COLOR_YELLOW = '\x1b[33m';
type TestStatus = TestResult['status'];

function formatMs(ms: number): string {
  if (ms >= 60000) return `${(ms / 60000).toFixed(2)} min`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.max(0, Math.round(ms))}ms`;
}

function isLiveProgressEnabled(): boolean {
  return ConfigResolver.resolveBoolean('reporting.liveProgress');
}

function emitLiveStart(suiteName: string, testName: string): void {
  if (!isLiveProgressEnabled()) return;
  process.stdout.write(`${COLOR_CYAN}> RUN ${suiteName} :: ${testName}${COLOR_RESET}\n`);
}

function emitLiveEnd(suiteName: string, testName: string, state: string | undefined, elapsedMs: number): void {
  if (!isLiveProgressEnabled()) return;
  const normalized = toTestStatus(state);
  const { icon, color } = getStatusDisplay(normalized);
  process.stdout.write(`${color}${icon} DONE ${suiteName} :: ${testName} (${formatMs(elapsedMs)})${COLOR_RESET}\n`);
}

function toTestStatus(state: string | undefined): TestStatus {
  if (state === 'fail') return 'failed';
  if (state === 'skip') return 'skipped';
  return 'passed';
}

function getStatusDisplay(status: TestStatus): { icon: string; color: string } {
  if (status === 'failed') return { icon: '✗', color: COLOR_RED };
  if (status === 'skipped') return { icon: '↓', color: COLOR_YELLOW };
  return { icon: '✓', color: COLOR_GREEN };
}

export interface SuiteContext {
  service: ServiceBase;
  testBase: TestBase;
  softAssert: SoftAssert;
  loggerService: LoggerService;
  testStep: TestBase['testStep'];
}

function createLiveProxy<T extends object>(getTarget: () => T | undefined, label: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const current = getTarget();
      if (!current) {
        throw new Error(`${label} is not initialized. Access it inside an active test.`);
      }
      const value = (current as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? (value as Function).bind(current) : value;
    },
  });
}

/**
 * Extract tags from a Vitest task.
 *
 * Vitest 4.x: tags are stored directly as `task.tags?: string[]` (from TaskBase).
 * Earlier fallback: `task.options.tags` and `task.annotations[].type === 'tag'`.
 */
function extractTaskTags(task: Task): string[] {
  const raw = task as unknown as Record<string, unknown>;
  // Vitest 4.x: TaskBase.tags
  const directTags = (raw['tags'] as string[] | undefined) ?? [];
  // Vitest 2.x fallback: task.options.tags
  const optionsTags = ((raw['options'] as Record<string, unknown> | undefined)?.['tags'] as string[] | undefined) ?? [];
  // Vitest 3.x fallback: task.annotations with type 'tag', field 'value' or 'description'
  type Annotation = Record<string, unknown>;
  const annotations = (raw['annotations'] as Annotation[] | undefined) ?? [];
  const annotationTags = annotations
    .filter(a => a['type'] === 'tag')
    .map(a => a['value'] ?? a['description'])
    .filter((tag): tag is string => typeof tag === 'string')
    .filter(Boolean);
  return [...new Set([...directTags, ...optionsTags, ...annotationTags])];
}

/**
 * Attach console logs directly to the task's allure runtime messages.
 * Each log line is emitted as an inline step so logs appear as test body
 * content rather than a file attachment.
 */
function attachAllureLogs(task: Task, testName: string): void {
  const logs = LoggerService.getTestLogs(testName);
  if (logs.length === 0) return;

  const meta = task.meta as Record<string, unknown>;
  if (!meta.allureRuntimeMessages) meta.allureRuntimeMessages = [];
  const messages = meta.allureRuntimeMessages as unknown[];
  const now = Date.now();

  for (const line of logs) {
    const subLines = line.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (subLines.length === 0) continue;
    let status = 'passed';
    if (line.startsWith('ERROR:')) status = 'failed';
    else if (line.startsWith('WARN:')) status = 'broken';

    messages.push({ type: 'step_start', data: { name: subLines[0], start: now } });

    // Remaining sub-lines (e.g. "Request Body: {...}") as nested child steps —
    // Allure renders child steps indented under the parent without a top-level ✓
    for (let i = 1; i < subLines.length; i++) {
      messages.push(
        { type: 'step_start', data: { name: `   ${subLines[i]}`, start: now } },
        { type: 'step_stop', data: { status, stop: now, stage: 'finished' } },
      );
    }

    messages.push({ type: 'step_stop', data: { status, stop: now, stage: 'finished' } });
  }
}

/**
 * Give all data-driven iterations that share a TestRail case id the same Allure
 * `testCaseId`/`historyId`, so Allure groups them under a single test case
 * instead of showing one entry per data set. Tests without a case id, and
 * distinct case ids, keep Allure's default (name-derived) identity — so the
 * multiple-case-id data-driven pattern is unaffected.
 */
function attachAllureCaseGrouping(task: Task, tags: string[], suiteName: string): void {
  if (!ConfigResolver.resolveBoolean('reporting.consolidateDataDriven')) return;
  const caseId = extractCaseId(tags);
  if (!caseId) return;

  const groupId = createHash('sha256').update(`${suiteName}#${caseId}`).digest('hex');
  const meta = task.meta as Record<string, unknown>;
  if (!meta.allureRuntimeMessages) meta.allureRuntimeMessages = [];
  const messages = meta.allureRuntimeMessages as unknown[];
  messages.push({
    type: 'metadata',
    data: {
      testCaseId: groupId,
      historyId: groupId,
      labels: [{ name: 'caseId', value: caseId }],
    },
  });
}

export class ApiTestBase {
  service!: ServiceBase;
  serviceClient!: ServiceClient;
  testBase!: TestBase;
  loggerService!: LoggerService;

  get assertions(): SoftAssert {
    return this.testBase.assertions;
  }

  describe(suiteName: string, tests: (ctx: SuiteContext) => void): void {
    const ctx: SuiteContext = {
      service: createLiveProxy(() => this.service, 'ServiceBase'),
      testBase: createLiveProxy(() => this.testBase, 'TestBase'),
      softAssert: createLiveProxy(() => this.testBase?.assertions, 'SoftAssert'),
      loggerService: createLiveProxy(() => this.loggerService, 'LoggerService'),
      testStep: (...args: [string, ...unknown[]]) => {
        if (!this.testBase) {
          throw new Error('TestBase is not initialized. Call testStep inside an active test.');
        }
        return (this.testBase.testStep as Function).apply(this.testBase, args);
      },
    };

    let currentTestName = '';
    let currentTestStartTime = 0;

    vitestDescribe(suiteName, () => {
      beforeAll(async () => {
        const env = ConfigResolver.resolve('environment') ?? 'dev';
        const logger = new LoggerService('ApiTestBase');
        logger.info('Initializing suite for environment: {}', env);
        LoggerService.setFileLoggingEnabled(
          ConfigResolver.resolveBoolean('logging.enableFileLogging'),
        );

        JsonReporter.reset();
        JsonReporter.initSuite(suiteName);
        JunitReporter.reset();
        JunitReporter.initSuite(suiteName);

        await this.onBeforeAll();
      });

      beforeEach(async (context) => {
        currentTestName = context.task.name ?? `test_${Date.now()}`;
        currentTestStartTime = Date.now();
        const suiteTags = extractTaskTags(context.task.suite as unknown as Task);
        const testTags = extractTaskTags(context.task);
        const tags = [...new Set([...suiteTags, ...testTags])].filter(Boolean);

        this.loggerService = new LoggerService(currentTestName);
        LoggerService.setCurrentTestId(currentTestName);
        LoggerService.initTestContext(currentTestName, tags);
        LoggerService.initTestFileLogging(suiteName, currentTestName, undefined, tags);
        emitLiveStart(suiteName, currentTestName);
        this.loggerService.info('Setting up test: {}', currentTestName);

        this.serviceClient = new ServiceClient();
        this.service = this.serviceClient.initService(this.loggerService);
        this.testBase = new TestBase(this.loggerService);

        await this.onBeforeEach();
      });

      afterEach(async (context) => {
        await this.onAfterEach();

        this.loggerService.info('Tearing down test');
        if (ConfigResolver.resolveBoolean('reporting.allure.includeInlineLogs')) {
          attachAllureLogs(context.task, currentTestName);
        }

        const state = context.task.result?.state;
        const suiteLevelTags = ((context.task.suite as unknown as Record<string, unknown>)?.['options'] as Record<string, unknown> | undefined)?.['tags'] as string[] | undefined;
        const testLevelTags = ((context.task as unknown as Record<string, unknown>)['options'] as Record<string, unknown> | undefined)?.['tags'] as string[] | undefined;
        const taskTags = [...new Set([...(suiteLevelTags ?? []), ...(testLevelTags ?? [])])].filter(Boolean);
        attachAllureCaseGrouping(context.task, taskTags, suiteName);
        const status = toTestStatus(state);
        const testResult = {
          name: currentTestName,
          suiteName,
          status,
          duration: context.task.result?.duration ?? Math.max(0, Date.now() - currentTestStartTime),
          startTime: new Date(currentTestStartTime).toISOString(),
          endTime: new Date().toISOString(),
          error: context.task.result?.errors?.[0]?.message,
          tags: taskTags.length > 0 ? taskTags : undefined,
          logs: LoggerService.getTestLogs(currentTestName),
        };
        emitLiveEnd(suiteName, currentTestName, state, testResult.duration);
        JsonReporter.addTestResult(testResult);
        JunitReporter.addTestResult(testResult);
        this.serviceClient.clearService();
        this.testBase.reset();
        LoggerService.finalizeTestFileLogging(currentTestName, status);
        LoggerService.closeTestFileLogging();
        LoggerService.setCurrentTestId(null);
      });

      afterAll(async () => {
        await this.onAfterAll();
        JsonReporter.flush();
        JunitReporter.flush();
        LoggerService.closeAllTestFileLogging();
      });

      tests(ctx);
    });
  }

  protected onBeforeAll(): void | Promise<void> {}

  protected onBeforeEach(): void | Promise<void> {}

  protected onAfterEach(): void | Promise<void> {}

  protected onAfterAll(): void | Promise<void> {}
}

export interface ApiSuiteOptions {
  configDir?: string;
  concurrent?: boolean;
  environment?: string;
  tags?: string[];
  beforeAll?: () => void | Promise<void>;
  beforeEach?: () => void | Promise<void>;
  afterEach?: () => void | Promise<void>;
  afterAll?: () => void | Promise<void>;
}

/**
 * Helper function to create describe implementation with given vitest describe variant
 */
function createDescribeImpl(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vitestDescribeFn: any,
): (
  name: string,
  optionsOrTests?: ApiSuiteOptions | ((ctx: SuiteContext) => void),
  maybeTests?: (ctx: SuiteContext) => void,
) => void {
  return (name, optionsOrTests, maybeTests) => {
    const options: ApiSuiteOptions = typeof optionsOrTests === 'function' ? {} : (optionsOrTests ?? {});
    const tests = typeof optionsOrTests === 'function' ? optionsOrTests : maybeTests;

    if (!tests) {
      throw new Error('describe() requires a test callback.');
    }

    let serviceClient: ServiceClient;
    let service: ServiceBase;
    let testBase: TestBase;
    let loggerService: LoggerService;
    let currentTestName = '';
    let currentTestStartTime = 0;

    const ctx: SuiteContext = {
      service: createLiveProxy(() => service, 'ServiceBase'),
      testBase: createLiveProxy(() => testBase, 'TestBase'),
      softAssert: createLiveProxy(() => testBase?.assertions, 'SoftAssert'),
      loggerService: createLiveProxy(() => loggerService, 'LoggerService'),
      testStep: (...args: [string, ...unknown[]]) => {
        if (!testBase) {
          throw new Error('TestBase is not initialized. Call testStep inside an active test.');
        }
        return (testBase.testStep as Function).apply(testBase, args);
      },
    };

    vitestDescribeFn(name, options.tags ? { tags: options.tags } : {}, () => {
      if (options.configDir) {
        ConfigReader.setConfigDir(options.configDir);
        ConfigReader.reset();
      }
      if (options.environment) {
        process.env['ENVIRONMENT'] = options.environment;
      }

      beforeAll(async () => {
        const env = ConfigResolver.resolve('environment') ?? 'dev';
        const logger = new LoggerService('ApiTestBase');
        logger.info('Initializing suite for environment: {}', env);
        LoggerService.setFileLoggingEnabled(
          ConfigResolver.resolveBoolean('logging.enableFileLogging'),
        );

        JsonReporter.reset();
        JsonReporter.initSuite(name);
        JunitReporter.reset();
        JunitReporter.initSuite(name);

        await options.beforeAll?.();
      });

      beforeEach(async (context) => {
        currentTestName = context.task.name ?? `test_${Date.now()}`;
        currentTestStartTime = Date.now();
        const itTags = extractTaskTags(context.task);
        // options.tags covers tags passed directly to describe(); also check suite-level annotations
        const suiteTags = [...(options.tags ?? []), ...extractTaskTags(context.task.suite as unknown as Task)];
        const tags = [...new Set([...suiteTags, ...itTags])].filter(Boolean);

        loggerService = new LoggerService(currentTestName);
        LoggerService.setCurrentTestId(currentTestName);
        LoggerService.initTestContext(currentTestName, tags);
        LoggerService.initTestFileLogging(name, currentTestName, undefined, tags);
        loggerService.info('Setting up test: {}', currentTestName);

        serviceClient = new ServiceClient();
        service = serviceClient.initService(loggerService);
        testBase = new TestBase(loggerService);

        await options.beforeEach?.();
      });

      afterEach(async (context) => {
        await options.afterEach?.();

        loggerService.info('Tearing down test');
        attachAllureLogs(context.task, currentTestName);

        const state = context.task.result?.state;
        const itTags = extractTaskTags(context.task);
        // options.tags covers tags passed directly to describe(); also check suite-level annotations
        const suiteTags = [...(options.tags ?? []), ...extractTaskTags(context.task.suite as unknown as Task)];
        const tags = [...new Set([...suiteTags, ...itTags])].filter(Boolean);
        attachAllureCaseGrouping(context.task, tags, name);
        const status = toTestStatus(state);
        const testResult = {
          name: currentTestName,
          suiteName: name,
          status,
          duration: context.task.result?.duration ?? Math.max(0, Date.now() - currentTestStartTime),
          startTime: new Date(currentTestStartTime).toISOString(),
          endTime: new Date().toISOString(),
          error: context.task.result?.errors?.[0]?.message,
          tags: tags.length > 0 ? tags : undefined,
          logs: LoggerService.getTestLogs(currentTestName),
        };
        JsonReporter.addTestResult(testResult);
        JunitReporter.addTestResult(testResult);

        console.log();
        serviceClient.clearService();
        testBase.reset();
        LoggerService.finalizeTestFileLogging(currentTestName, status);
        LoggerService.closeTestFileLogging();
        LoggerService.setCurrentTestId(null);
      });

      afterAll(async () => {
        await options.afterAll?.();
        JsonReporter.flush();
        JunitReporter.flush();
        LoggerService.closeAllTestFileLogging();
      });

      tests(ctx);
    });
  };
}

export function describe(name: string, tests: (ctx: SuiteContext) => void): void;
export function describe(name: string, tests: (ctx: SuiteContext) => void): void;
export function describe(name: string, options: ApiSuiteOptions, tests: (ctx: SuiteContext) => void): void;
export function describe(
  name: string,
  optionsOrTests: ApiSuiteOptions | ((ctx: SuiteContext) => void),
  maybeTests?: (ctx: SuiteContext) => void,
): void {
  createDescribeImpl(vitestDescribe)(name, optionsOrTests as any, maybeTests);
}

describe.skip = function (
  name: string,
  optionsOrTests?: ApiSuiteOptions | ((ctx: SuiteContext) => void),
  maybeTests?: (ctx: SuiteContext) => void,
): void {
  createDescribeImpl(vitestDescribe.skip)(name, optionsOrTests as any, maybeTests);
};

describe.only = function (
  name: string,
  optionsOrTests?: ApiSuiteOptions | ((ctx: SuiteContext) => void),
  maybeTests?: (ctx: SuiteContext) => void,
): void {
  createDescribeImpl(vitestDescribe.only)(name, optionsOrTests as any, maybeTests);
};

describe.skipIf = function (condition: boolean) {
  const selectedDescribe = condition ? describe.skip : describe;
  return function (
    name: string,
    optionsOrTests?: ApiSuiteOptions | ((ctx: SuiteContext) => void),
    maybeTests?: (ctx: SuiteContext) => void,
  ): void {
    selectedDescribe(name, optionsOrTests as any, maybeTests as any);
  };
};

/**
 * Concurrent-safe test function with auto-injected fixtures.
 * Each test gets its own isolated `service`, `testStep`, and `softAssert`.
 * Setup and teardown happen automatically per test — no wrappers needed.
 *
 * Usage:
 *   itc.concurrent('my test', async ({ service, testStep, softAssert }) => { ... });
 */
type ItFixtures = {
  service: ServiceBase;
  testStep: TestBase['testStep'];
  softAssert: SoftAssert;
  _setup: { serviceClient: ServiceClient; testBase: TestBase; service: ServiceBase };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _itFixtures: any = {
  _setup: async ({ task }: any, use: (v: ItFixtures['_setup']) => Promise<void>) => {
    const testName = task.name ?? `test_${Date.now()}`;
    const suiteName = task.suite?.name ?? 'TestSuite';
    const testStartTime = Date.now();
    const suiteTags = extractTaskTags(task.suite as unknown as Task);
    const itTags = extractTaskTags(task as Task);
    const tags = [...new Set([...suiteTags, ...itTags])].filter(Boolean);
    const loggerService = new LoggerService(testName);
    JsonReporter.initSuite(suiteName);
    JunitReporter.initSuite(suiteName);
    LoggerService.setFileLoggingEnabled(
      ConfigResolver.resolveBoolean('logging.enableFileLogging'),
    );
    LoggerService.initTestFileLogging(suiteName, testName, testName, tags);
    LoggerService.initTestLogsFor(testName);

    const serviceClient = new ServiceClient();
    const service = serviceClient.initService(loggerService);
    const testBase = new TestBase(loggerService);
    await use({ serviceClient, testBase, service });

    const state = task.result?.state;
    const status = toTestStatus(state);
    const testResult = {
      name: testName,
      suiteName,
      status,
      duration: task.result?.duration ?? Math.max(0, Date.now() - testStartTime),
      startTime: new Date(testStartTime).toISOString(),
      endTime: new Date().toISOString(),
      error: task.result?.errors?.[0]?.message,
      tags: tags.length > 0 ? tags : undefined,
      logs: LoggerService.getTestLogsFor(testName),
    };
    JsonReporter.addTestResult(testResult);
    JsonReporter.flush();
    JunitReporter.addTestResult(testResult);
    JunitReporter.flush();

    attachAllureLogs(task, testName);
    attachAllureCaseGrouping(task, tags, suiteName);

    serviceClient.clearService();
    testBase.reset();
    LoggerService.finalizeTestFileLogging(testName, status);
    LoggerService.closeTestFileLoggingFor(testName);
  },
  service: async ({ _setup }: { _setup: ItFixtures['_setup'] }, use: (v: ServiceBase) => Promise<void>) => {
    await use(_setup.service);
  },
  testStep: async ({ _setup }: { _setup: ItFixtures['_setup'] }, use: (v: TestBase['testStep']) => Promise<void>) => {
    await use(_setup.testBase.testStep.bind(_setup.testBase) as TestBase['testStep']);
  },
  softAssert: async ({ _setup }: { _setup: ItFixtures['_setup'] }, use: (v: SoftAssert) => Promise<void>) => {
    await use(_setup.testBase.assertions);
  },
};

// Lazy Proxy: defers vitestTest.extend() until first access inside a test worker.
// This prevents "suite runner does not exist" errors during module initialisation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _it: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const it: any = new Proxy({}, {
  get(_, prop) {
    if (!_it) _it = vitestTest.extend(_itFixtures);
    return _it[prop];
  },
});
