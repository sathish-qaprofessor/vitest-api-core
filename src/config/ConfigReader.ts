import * as fs from 'fs';
import yaml from 'js-yaml';
import { ConfigurationException } from '../exceptions/ConfigurationException.js';
import { PathUtils } from '../utils/PathUtils.js';

/**
 * Loads environment-specific YAML configuration files.
 * Supports ${ENV_VAR} interpolation from process.env.
 *
 * When used as an npm package, the consumer project provides config files.
 * Config search priority:
 * 1. CLI arg     --env=<value>  (e.g. vitest run -- --env=qa)
 * 2. CONFIG_FILE env var — absolute path override
 * 3. CONFIG_DIR env var — directory containing {env}.config.yaml
 * 4. Programmatic configDir — set via ConfigReader.setConfigDir()
 * 5. {consumerRoot}/config/{env}.config.yaml — consumer project config
 * 6. {packageRoot}/config/{env}.config.yaml — package fallback config
 */
export class ConfigReader {
  private static config: Record<string, string> | null = null;
  private static _configDir: string | null = null;

  private constructor() {}

  /** Returns true if configuration has been loaded. */
  static isLoaded(): boolean {
    return this.config !== null;
  }

  /** Clears loaded configuration (useful for tests). */
  static reset(): void {
    this.config = null;
  }

  /**
   * Set the config directory programmatically.
   * Consumer projects can call this before loading to point to their config.
   */
  static setConfigDir(dir: string): void {
    this._configDir = dir;
  }

  /**
   * Load configuration for a given environment (dev/qa/uat).
   * Searches for the config file in multiple locations (first found wins):
   * 1. CLI arg     --env=<value>
   * 2. CONFIG_FILE env var (absolute path override)
   * 3. CONFIG_DIR env var + {env}.config.yaml
   * 4. Programmatic configDir + {env}.config.yaml
   * 5. {consumerRoot}/config/{env}.config.yaml
   * 6. {packageRoot}/config/{env}.config.yaml
   */
  static load(environment: string): void {
    if (this.config !== null) return;

    let env = environment?.trim().toLowerCase() || '';
    if (!env) {
      env = this.parseEnvFromArgs()
        || process.env['ENVIRONMENT']
        || process.env['TEST_ENVIRONMENT']
        || 'dev';
    }

    // Priority 1: explicit file path from environment
    const configFileOverride = process.env['CONFIG_FILE'];
    if (configFileOverride && PathUtils.exists(configFileOverride)) {
      this.loadFromFile(configFileOverride);
      return;
    }

    // Priority 2: config dir override (env var)
    const configDirOverride = process.env['CONFIG_DIR'];
    if (configDirOverride) {
      const filePath = PathUtils.resolve(configDirOverride, `${env}.config.yaml`);
      if (PathUtils.exists(filePath)) {
        this.loadFromFile(filePath);
        return;
      }
    }

    // Priority 3: programmatic config dir
    if (this._configDir) {
      const filePath = PathUtils.resolve(this._configDir, `${env}.config.yaml`);
      if (PathUtils.exists(filePath)) {
        this.loadFromFile(filePath);
        return;
      }
    }

    // Priority 4: consumerRoot/config/{env}.config.yaml
    const candidates = [
      PathUtils.resolveFromConsumerRoot('config', `${env}.config.yaml`),
      PathUtils.resolveFromConsumerRoot('config', `${env}-config.yaml`),
    ];

    for (const filePath of candidates) {
      if (PathUtils.exists(filePath)) {
        this.loadFromFile(filePath);
        return;
      }
    }

    // Priority 5: package config fallback
    for (const packageConfigRoot of PathUtils.getPackageConfigDirs(__dirname)) {
      const packageCandidates = [
        PathUtils.resolve(packageConfigRoot, `${env}.config.yaml`),
        PathUtils.resolve(packageConfigRoot, `${env}-config.yaml`),
      ];

      for (const filePath of packageCandidates) {
        if (PathUtils.exists(filePath)) {
          this.loadFromFile(filePath);
          return;
        }
      }
    }

    // No config file found — initialize empty config (defaults will be used)
    this.config = {};
  }

  /**
   * Parse --env=<value> from process.argv.
   * Supports: --env=qa  or  -- --env=qa (after vitest's own arg separator)
   */
  private static parseEnvFromArgs(): string | undefined {
    for (const arg of process.argv) {
      const match = arg.match(/^--env=(.+)$/i);
      if (match) return match[1].trim().toLowerCase();
    }
    return undefined;
  }

  private static loadFromFile(filePath: string): void {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      // Interpolate ${ENV_VAR} references with process.env values
      const interpolated = raw.replace(/\$\{(\w+)\}/g, (_, key: string) => process.env[key] || '');
      const data = yaml.load(interpolated) as Record<string, unknown>;

      if (data && typeof data === 'object') {
        this.config = {};
        this.flattenInto(data, '', this.config);
      } else {
        this.config = {};
      }
    } catch (err) {
      throw new ConfigurationException(
        `Failed to load configuration from ${filePath}: ${(err as Error).message}`,
        err as Error,
      );
    }
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

  /**
   * Get a configuration value by dot-notation key.
   * Example: ConfigReader.get('api.baseUrl')
   */
  static get(key: string): string | undefined {
    if (this.config === null) {
      throw new ConfigurationException('Configuration not loaded. Call ConfigReader.load() first.');
    }
    return this.config[key];
  }
}
