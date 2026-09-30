import winston from 'winston';
import Transport from 'winston-transport';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { PathUtils } from '../utils/PathUtils.js';
import { ConfigResolver } from '../config/ConfigResolver.js';

/**
 * Custom Winston transport that writes directly to process.stdout/stderr,
 * bypassing console interception so output is always synchronous and in-order
 * with any subsequent process.stdout.write() calls (e.g. blank lines in TestBase).
 */
class VitestConsoleTransport extends Transport {
  log(info: winston.Logform.TransformableInfo, callback: () => void): void {
    setImmediate(() => this.emit('logged', info));
    // Winston stores the fully-formatted string in Symbol.for('message') after applying formats
    const formattedValue = (info as Record<string | symbol, unknown>)[Symbol.for('message')] ?? info.message;
    const formatted = typeof formattedValue === 'string' ? formattedValue : JSON.stringify(formattedValue);
    const compact = formatted
      .replaceAll('\r\n', '\n')
      .trimEnd()
      .replace(/\n{3,}/g, '\n\n');
    process.stdout.write(compact + '\n');
    callback();
  }
}

/**
 * Multi-transport Winston logger with per-test file writers.
 * Ported from Java LoggerService.java.
 *
 * Transports:
 * - Console: colorized with timestamps
 * - Per-test file: structured log per test method
 */
export class LoggerService {
  private readonly logger: winston.Logger;
  private readonly instanceTestId: string | null;
  private static readonly LOG_DIR = 'logs';
  private static readonly MAX_LOG_MESSAGE_SIZE = 50_000; // Limit individual log messages to 50KB
  private static readonly testLogFiles: Map<string, string> = new Map();
  private static readonly testLogs: Map<string, string[]> = new Map();
  private static readonly testCaseIds: Map<string, string> = new Map();
  private static readonly testMetadata: Map<
    string,
    { suiteName: string; testName: string; tags?: string[]; dataSetIndex?: number; dataSetKey?: string }
  > = new Map();
  // Tracks data sets that share one case ID (single-caseId data-driven tests) so
  // their log files can be numbered DS-1, DS-2, ... Key: `<suite>|<caseId>`.
  private static readonly dataSetRegistry: Map<string, { testId: string; filePath: string }[]> = new Map();
  private static currentTestId: string | null = null;
  private static fileLoggingEnabled = false;
  private static readonly closingTestIds: Set<string> = new Set(); // Track loggers being closed

  private static normalizeLevel(raw: string | null | undefined): 'debug' | 'info' | 'warn' | 'error' {
    const level = String(raw ?? '').trim().toLowerCase();
    if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
      return level;
    }
    return 'info';
  }

  constructor(context?: string) {
    this.instanceTestId = context ?? null;
    const level = LoggerService.normalizeLevel(ConfigResolver.resolve('logging.consoleLevel') ?? ConfigResolver.resolve('logging.logLevel'));
    this.logger = winston.createLogger({
      defaultMeta: { context: context ?? 'Framework' },
      level,
      transports: [
        new VitestConsoleTransport({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ level, message }) => {
              const formattedLevel = typeof level === 'string' ? level : JSON.stringify(level);
              const formattedMessage = typeof message === 'string' ? message : JSON.stringify(message);
              return `${formattedLevel}: ${formattedMessage}`;
            }),
          ),
        }),
      ],
    });
  }

  // ====================== Static Test File Logging ======================

  static setFileLoggingEnabled(enabled: boolean): void {
    this.fileLoggingEnabled = enabled;
  }

  static setCurrentTestId(testId: string | null): void {
    this.currentTestId = testId;
    if (testId && !this.testLogs.has(testId)) {
      this.testLogs.set(testId, []);
    }
  }

  static getCurrentTestId(): string | null {
    return this.currentTestId;
  }

  static initTestContext(testId: string, tags?: string[]): void {
    if (!testId) return;
    this.initTestLogsFor(testId);
    const caseId = this.extractCaseIdFromTags(tags);
    if (caseId) this.testCaseIds.set(testId, caseId);
    else this.testCaseIds.delete(testId);
  }

  /**
   * Extract case ID from test tags (must be uppercase 'C' followed by digits, e.g., C55322983).
   * Strict validation ensures we don't match other tags that happen to start with 'C'.
   */
  private static extractCaseIdFromTags(tags?: string[]): string | null {
    if (!tags || tags.length === 0) return null;
    // Accept both `C123` and `@C123` tag formats; normalize to `C123`.
    const caseIdPattern = /^@?(C\d+)$/;
    for (const rawTag of tags) {
      const tag = rawTag.trim();
      const match = caseIdPattern.exec(tag);
      if (match?.[1]) {
        return match[1];
      }
    }
    return null;
  }

  /**
   * Format log file name based on configuration.
   * Supports: 'TestName' | 'CaseId' | 'TestName_CaseId'
   */
  private static formatLogFileName(
    suiteName: string,
    testName: string,
    tags?: string[],
    status?: string,
  ): string {
    const format = ConfigResolver.resolve('logging.fileNameFormat') ?? 'TestName';
    const includeTimestamp = ConfigResolver.resolve('logging.includeTimestamp') ?? 'true';
    const includeStatus = ConfigResolver.resolve('logging.includeStatus') ?? 'false';

    const sanitizedSuite = this.sanitizeSuiteName(suiteName || 'TestRun');
    const sanitizedTest = this.sanitizeName(testName);
    const caseId = this.extractCaseIdFromTags(tags);

    let nameComponent = '';
    if (format === 'CaseId') {
      nameComponent = caseId ? `${caseId}` : sanitizedTest;
    } else if (format === 'TestName_CaseId') {
      nameComponent = caseId ? `${sanitizedTest}_${caseId}` : sanitizedTest;
    } else {
      // Default: 'TestName'
      nameComponent = sanitizedTest;
    }

    let fileName = `${sanitizedSuite}_${nameComponent}`;

    if (includeStatus === 'true' && status) {
      fileName = `[${status}]${fileName}`;
    }

    if (includeTimestamp === 'true') {
      const ts = this.buildCompactTimestamp();
      fileName = `${fileName}_${ts}`;
    }

    return `${fileName}.log`;
  }

  /**
   * Insert a `_DS-<index>` data-set marker into a log file name, right after the
   * name component and before the trailing timestamp (or extension). Idempotent.
   */
  private static insertDataSetMarker(fileName: string, index: number): string {
    if (/_DS-\d+(?=[._])/.test(fileName)) return fileName;
    if (/_(\d{14})[.]log$/.test(fileName)) {
      return fileName.replace(/_(\d{14})[.]log$/, `_DS-${index}_$1.log`);
    }
    return fileName.replace(/[.]log$/, `_DS-${index}.log`);
  }

  /**
   * Rename an already-written data-set log file to add its `_DS-<index>` marker.
   * Used to retroactively number the first data set once a second one appears.
   */
  private static markDataSetFile(entry: { testId: string; filePath: string }, index: number): void {
    const current = entry.filePath;
    if (!current) return;
    const marked = this.insertDataSetMarker(path.basename(current), index);
    const newPath = path.join(path.dirname(current), marked);
    if (newPath === current) return;
    try {
      if (fs.existsSync(current)) {
        fs.renameSync(current, newPath);
        entry.filePath = newPath;
        if (this.testLogFiles.has(entry.testId)) {
          this.testLogFiles.set(entry.testId, newPath);
        }
      }
    } catch (error) {
      console.error(`Failed to add data set marker to ${current}:`, error);
    }
  }
  static initTestFileLogging(suiteName: string, testName: string, testId?: string, tags?: string[]): void {
    const effectiveTestId = testId ?? this.currentTestId;
    if (!testName || !effectiveTestId) return;
    this.initTestContext(effectiveTestId, tags);
    if (!this.fileLoggingEnabled) return;
    if (this.testLogFiles.has(effectiveTestId)) return;
    if (!this.testLogs.has(effectiveTestId)) {
      this.testLogs.set(effectiveTestId, []);
    }

    const configuredLogDir = ConfigResolver.resolve('logging.logDirectory') ?? this.LOG_DIR;
    const logDir = PathUtils.resolveFromConsumerRoot(configuredLogDir);
    PathUtils.ensureDirectory(logDir);

    // Format file name without status (status is only available after test completes)
    let logFileName = this.formatLogFileName(suiteName, testName, tags);

    // Single-caseId data-driven tests: number the shared-caseId data sets DS-1,
    // DS-2, ... A group only becomes "data-driven" once its second data set runs,
    // so the first file is marked retroactively at that point.
    const caseId = this.extractCaseIdFromTags(tags);
    let dataSetIndex: number | undefined;
    let dataSetKey: string | undefined;
    if (caseId) {
      dataSetKey = `${this.sanitizeSuiteName(suiteName || 'TestRun')}|${caseId}`;
      const group = this.dataSetRegistry.get(dataSetKey) ?? [];
      const index = group.length + 1;
      if (index >= 2) {
        dataSetIndex = index;
        logFileName = this.insertDataSetMarker(logFileName, index);
        if (group.length === 1) {
          this.markDataSetFile(group[0]!, 1);
        }
      }
      group.push({ testId: effectiveTestId, filePath: '' });
      this.dataSetRegistry.set(dataSetKey, group);
    }

    const filePath = path.join(logDir, logFileName);
    // Ensure the log file exists so append operations are safe.
    fs.closeSync(fs.openSync(filePath, 'a'));
    this.testLogFiles.set(effectiveTestId, filePath);
    if (dataSetKey) {
      const group = this.dataSetRegistry.get(dataSetKey)!;
      group.at(-1)!.filePath = filePath;
    }

    // Store metadata for later use when finalizing with status
    this.testMetadata.set(effectiveTestId, { suiteName, testName, tags, dataSetIndex, dataSetKey });
  }

  /**
   * Finalize log file naming with test status and rename if needed.
   * Call this after test completes to update log file name with [status] prefix if configured.
   */
  static finalizeTestFileLogging(testId: string, status: 'passed' | 'failed' | 'skipped'): void {
    if (!this.fileLoggingEnabled || !testId) return;

    const currentPath = this.testLogFiles.get(testId);
    const metadata = this.testMetadata.get(testId);

    if (!currentPath || !metadata) return;

    const finalPath = this.renameLogFileWithStatus(testId, currentPath, metadata, status);

    // Keep the data-set registry pointing at the final path so a later data set
    // in the same caseId group can retroactively mark this (the first) file.
    if (metadata.dataSetKey) {
      const group = this.dataSetRegistry.get(metadata.dataSetKey);
      const entry = group?.find((e) => e.testId === testId);
      if (entry) entry.filePath = finalPath;
    }

    try {
      if (fs.existsSync(finalPath)) {
        const statusLine = `\n=== TEST STATUS: ${status.toUpperCase()} ===\n`;
        fs.appendFileSync(finalPath, statusLine, 'utf8');
      }
    } catch (error) {
      console.error(`Failed to append test status to log file ${finalPath}:`, error);
    }
  }

  private static renameLogFileWithStatus(
    testId: string,
    currentPath: string,
    metadata: { suiteName: string; testName: string; tags?: string[]; dataSetIndex?: number },
    status: 'passed' | 'failed' | 'skipped',
  ): string {
    if (ConfigResolver.resolve('logging.includeStatus') !== 'true') return currentPath;

    let newFileName = this.formatLogFileName(metadata.suiteName, metadata.testName, metadata.tags, status);
    if (metadata.dataSetIndex) newFileName = this.insertDataSetMarker(newFileName, metadata.dataSetIndex);
    const newPath = path.join(path.dirname(currentPath), newFileName);
    if (currentPath === newPath || !fs.existsSync(currentPath)) return currentPath;

    try {
      fs.renameSync(currentPath, newPath);
      this.testLogFiles.set(testId, newPath);
      return newPath;
    } catch (error) {
      console.error(`Failed to rename log file from ${currentPath} to ${newPath}:`, error);
      return currentPath;
    }
  }

  /**
   * Close file logging for the current test.
   */
  static closeTestFileLogging(): void {
    const testId = this.currentTestId;
    if (!testId) return;
    this.closeTestFileLoggingFor(testId);
  }

  /**
   * Close file logging for a specific test by ID (concurrent-safe).
   */
  static closeTestFileLoggingFor(testId: string): void {
    if (!testId || this.closingTestIds.has(testId)) return;

    this.closingTestIds.add(testId);

    this.testLogFiles.delete(testId);
    this.testLogs.delete(testId);
    this.testCaseIds.delete(testId);
    this.testMetadata.delete(testId);
    this.closingTestIds.delete(testId);
  }

  /**
   * Close all test file loggers.
   */
  static closeAllTestFileLogging(): void {
    for (const testId of this.testLogFiles.keys()) {
      if (!this.closingTestIds.has(testId)) {
        this.closeTestFileLoggingFor(testId);
      }
    }
    this.testLogFiles.clear();
    this.testLogs.clear();
    this.testCaseIds.clear();
    this.testMetadata.clear();
    this.closingTestIds.clear();
    this.dataSetRegistry.clear();
  }

  /**
   * Initialize test log storage for a specific test ID (concurrent-safe).
   * Unlike setCurrentTestId, this does NOT change the shared static field.
   */
  static initTestLogsFor(testId: string): void {
    if (testId && !this.testLogs.has(testId)) {
      this.testLogs.set(testId, []);
    }
  }

  static getTestLogs(testId?: string): string[] {
    const id = testId ?? this.currentTestId;
    if (!id) return [];
    return [...(this.testLogs.get(id) ?? [])];
  }

  static getTestLogsFor(testId: string): string[] {
    if (!testId) return [];
    return [...(this.testLogs.get(testId) ?? [])];
  }

  private static sanitizeName(name: string): string {
    if (!name) return 'TestRun';
    return name.replace(/[\\/:*?"<>|]/g, '_');
  }

  private static sanitizeSuiteName(name: string): string {
    const sanitized = this.sanitizeName(name);
    const withoutSpaces = sanitized.replace(/\s+/g, '');
    return withoutSpaces || 'TestRun';
  }

  private static buildCompactTimestamp(): string {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = (now.getMonth() + 1).toString().padStart(2, '0');
    const dd = now.getDate().toString().padStart(2, '0');
    const hh = now.getHours().toString().padStart(2, '0');
    const min = now.getMinutes().toString().padStart(2, '0');
    const ss = now.getSeconds().toString().padStart(2, '0');
    return `${yyyy}${mm}${dd}${hh}${min}${ss}`;
  }

  // ====================== Instance Logging Methods ======================

  private formatMessage(message: string, ...params: unknown[]): string {
    let formatted = message;
    for (const param of params) {
      let value = '';
      if (typeof param === 'string') value = param;
      else if (param != null) value = JSON.stringify(param);
      formatted = formatted.replace('{}', value);
    }
    return formatted;
  }

  private getEffectiveTestId(): string | null {
    return (this.instanceTestId && LoggerService.testLogs.has(this.instanceTestId))
      ? this.instanceTestId
      : LoggerService.getCurrentTestId();
  }

  private static isParallelFileExecution(): boolean {
    const workerState = (globalThis as Record<string, unknown>)['__vitest_worker__'] as
      | { config?: { maxWorkers?: number } }
      | undefined;
    return (workerState?.config?.maxWorkers ?? 1) > 1;
  }

  private formatConsoleError(message: string): string {
    if (!LoggerService.isParallelFileExecution()) return message;
    const testId = this.getEffectiveTestId();
    const caseId = testId ? LoggerService.testCaseIds.get(testId) : undefined;
    return caseId ? `Test with ${caseId} has failed with below error:\n${message}` : message;
  }

  private writeToTestFile(level: string, message: string): void {
    // Use instanceTestId only when it has an active entry in testLogs (i.e. it was
    // initialised as a test-scoped logger, not as a service-name logger from an
    // external package).  Fall back to the shared currentTestId so that loggers
    // created with a service name (e.g. "CasesApiService") still route their
    // output into the correct test's log buffer.
    const testId = this.getEffectiveTestId();
    if (!testId) return;

    // Truncate very large messages to prevent stream buffer overflow
    let truncatedMessage = message;
    if (message && message.length > LoggerService.MAX_LOG_MESSAGE_SIZE) {
      truncatedMessage = message.substring(0, LoggerService.MAX_LOG_MESSAGE_SIZE) +
                        `\n... [message truncated, ${(message.length / 1024).toFixed(1)}KB total]`;
    }

    const logs = LoggerService.testLogs.get(testId);
    if (logs) {
      const line = `${level.toUpperCase()}: ${truncatedMessage}`;
      logs.push(line);
    }

    // Check if this logger is already being closed to prevent ERR_STREAM_WRITE_AFTER_END
    if (LoggerService.closingTestIds.has(testId)) {
      return;
    }

    const logFilePath = LoggerService.testLogFiles.get(testId);
    if (logFilePath) {
      try {
        fs.appendFileSync(logFilePath, `${level.toUpperCase()}: ${truncatedMessage}\n`, 'utf8');
      } catch (err) {
        const typedError = err as NodeJS.ErrnoException;
        const ignoredCodes = new Set(['ERR_STREAM_WRITE_AFTER_END', 'ERR_STREAM_DESTROYED', 'EBADF']);
        if (LoggerService.currentTestId === testId && !ignoredCodes.has(typedError.code ?? '')) {
          console.error(`Unexpected error writing to test log:`, err);
        }
      }
    }
  }

  debug(message: string, ...params: unknown[]): void {
    const formatted = this.formatMessage(message, ...params);
    this.logger.debug(formatted);
    // debug messages are intentionally not written to the test log file
  }

  info(message: string, ...params: unknown[]): void {
    const formatted = this.formatMessage(message, ...params);
    this.logger.info(formatted);
    this.writeToTestFile('info', formatted);
  }

  warn(message: string, ...params: unknown[]): void {
    const formatted = this.formatMessage(message, ...params);
    this.logger.warn(formatted);
    this.writeToTestFile('warn', formatted);
  }

  error(message: string, ...params: unknown[]): void {
    // Check if last param is an Error (throwable)
    let throwable: Error | null = null;
    let messageParams = params;
    if (params.length > 0 && params.at(-1) instanceof Error) {
      throwable = params.at(-1) as Error;
      messageParams = params.slice(0, -1);
    }

    const formatted = this.formatMessage(message, ...messageParams);
    const consoleMessage = this.formatConsoleError(
      throwable ? `${formatted}\n${throwable.stack ?? throwable.message}` : formatted,
    );
    if (throwable) {
      this.logger.error(consoleMessage);
      this.writeToTestFile('error', `${formatted}\n${throwable.stack ?? throwable.message}`);
    } else {
      this.logger.error(consoleMessage);
      this.writeToTestFile('error', formatted);
    }
  }

  getTestId(): string | null {
    return this.getEffectiveTestId();
  }
}
