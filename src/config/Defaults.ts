import * as fs from 'fs';
import yaml from 'js-yaml';
import { PathUtils } from '../utils/PathUtils.js';

/**
 * Hard-coded default configuration values.
 * These serve as the ultimate fallback when no config file is found.
 *
 * Config resolution order (first found wins):
 * 1. Explicit configDir passed to load()
 * 2. Consumer project: {consumerRoot}/config/default.config.yaml
 * 3. Package fallback: {packageRoot}/config/default.config.yaml
 * 4. Built-in defaults (below)
 */
const BUILT_IN_DEFAULTS: Record<string, string> = {
  environment: 'dev',
  'api.timeout': '20000',
  'logging.enableFileLogging': 'false',
  'logging.logDirectory': 'logs',
  'logging.logLevel': 'info',
  'logging.consoleLevel': 'info',
  'logging.fileNameFormat': 'TestName',
  'logging.includeTimestamp': 'true',
  'logging.includeStatus': 'false',
  'reporting.enableReport': 'true',
  'reporting.enableJsonReport': 'false',
  'reporting.jsonReportPath': 'reports/execution-summary.json',
  'reporting.enableJunitReport': 'false',
  'reporting.junitReportPath': 'reports/junit-report.xml',
  'reporting.junit.includeTags': 'true',
  'reporting.junit.includeProperties': 'true',
  'reporting.junit.includeLogs': 'false',
  'reporting.junit.includeRequests': 'false',
  'reporting.consolidateDataDriven': 'true',
  'reporting.allure.includeInlineLogs': 'true',
  'reporting.liveProgress': 'false',
};

export class Defaults {
  private static defaults: Record<string, string> = { ...BUILT_IN_DEFAULTS };
  private static loaded = false;

  private constructor() {}

  /**
   * Load defaults from a YAML file. If the file doesn't exist, built-in defaults are used.
   *
   * Search order:
   * 1. configDir param (if provided) — e.g. consumer or test override
   * 2. process.cwd()/config/default.config.yaml — always the consumer project root at test-run time
   * 3. {consumerRoot}/config/default.config.yaml — INIT_CWD based (npm script context)
   * 4. {packageRoot}/config/default.config.yaml — package fallback config
   * 5. Falls back to BUILT_IN_DEFAULTS
   */
  static load(configDir?: string): void {
    if (this.loaded) return;

    const yamlPaths = [
      configDir ? PathUtils.resolve(configDir, 'default.config.yaml') : null,
      PathUtils.resolve(process.cwd(), 'config', 'default.config.yaml'),
      PathUtils.resolveFromConsumerRoot('config', 'default.config.yaml'),
      ...PathUtils.getPackageDefaultConfigPaths(__dirname),
    ].filter(Boolean) as string[];

    for (const filePath of yamlPaths) {
      if (PathUtils.exists(filePath)) {
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const data = yaml.load(raw);
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            this.flattenInto(data as Record<string, unknown>, '', this.defaults);
          }
          this.loaded = true;
          break;
        } catch {
          // Ignore parse errors; fall through to built-in defaults
        }
      }
    }
    this.loaded = true;
  }

  /**
   * Flatten nested YAML object into dot-notation keys.
   */
  private static flattenInto(
    obj: Record<string, unknown>,
    prefix: string,
    target: Record<string, string>,
  ): void {
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        this.flattenInto(value as Record<string, unknown>, fullKey, target);
      } else {
        target[fullKey] = String(value);
      }
    }
  }

  static get(key: string): string | undefined {
    if (!this.loaded) {
      this.load();
    }
    return this.defaults[key];
  }

  static getBoolean(key: string): boolean {
    return this.get(key) === 'true';
  }

  static getInt(key: string): number {
    const value = this.get(key);
    if (value == null) return 0;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? 0 : parsed;
  }

  /** Reset for testing purposes */
  static reset(): void {
    this.defaults = { ...BUILT_IN_DEFAULTS };
    this.loaded = false;
  }

}
