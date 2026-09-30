/**
 * Report data types for JSON reporting.
 */

export interface RequestLog {
  method: string;
  url: string;
  statusCode: number;
  responseBody: string;
  timestamp: string;
}

export interface TestResult {
  testId?: string;
  name: string;
  suiteName?: string;
  status: 'passed' | 'failed' | 'skipped';
  duration: number;
  startTime: string;
  endTime?: string;
  error?: string;
  tags?: string[];
  logs?: string[];
  steps?: StepResult[];
  requests?: RequestLog[];
}

export interface StepResult {
  name: string;
  status: 'passed' | 'failed';
  duration: number;
  error?: string;
}

export interface SuiteResult {
  suiteName: string;
  environment: string;
  startTime: string;
  endTime?: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  executionFilter?: { tags: string[] };
  tests: TestResult[];
}
