import { ConfigReader } from './ConfigReader.js';
import { Defaults } from './Defaults.js';
import { ConfigurationException } from '../exceptions/ConfigurationException.js';

/**
 * Resolve configuration value from multiple sources in priority order:
 * 1. CLI arg      --env=<value>  (for 'environment' key only)
 * 2. process.env (CLI or CI/CD injected)
 * 3. YAML config file (loaded via ConfigReader — consumer project config)
 * 4. Hard defaults (from Defaults class — built-in fallback)
 *
 * Consumer projects using this as an npm package should either:
 * - Place config in {project}/config/{env}.config.yaml (auto-discovered)
 * - Set CONFIG_DIR env var pointing to their config directory
 * - Call ConfigReader.setConfigDir() before any resolve() calls
 * - Pass --env=<value> on the CLI:  vitest run -- --env=qa
 */
export class ConfigResolver {
  private constructor() {}

  /**
   * Convenience initializer for consumer projects.
   * Sets the config directory and resets any previously loaded config.
   */
  static configure(options: { configDir?: string; environment?: string }): void {
    if (options.configDir) {
      ConfigReader.setConfigDir(options.configDir);
    }
    if (options.environment) {
      process.env['ENVIRONMENT'] = options.environment;
    }
    // Reset so next resolve() picks up the new config
    ConfigReader.reset();
    Defaults.reset();
  }

  /**
   * Resolve a configuration value by key.
   * Priority: process.env → YAML config → Defaults
   */
  static resolve(key: string): string | undefined {
    // 1) Environment variables (support both dot-notation and UPPER_SNAKE_CASE)
    const envKey = key.replaceAll('.', '_').toUpperCase();
    const envValue = process.env[envKey] ?? process.env[key];
    if (this.isValid(envValue)) return envValue!.trim();

    // Special-case environment — checked before config file load to bootstrap correctly
    if (key.toLowerCase() === 'environment') {
      const envFromArgs = this.parseEnvFromArgs();
      if (this.isValid(envFromArgs)) return envFromArgs!;
      const envFromOs = process.env['ENVIRONMENT'] ?? process.env['TEST_ENVIRONMENT'];
      if (this.isValid(envFromOs)) return envFromOs!.trim();
      return Defaults.get('environment') ?? 'dev';
    }

    // 2) Config file (load lazily if needed)
    if (!ConfigReader.isLoaded()) {
      const env = this.resolve('environment') ?? 'dev';
      ConfigReader.load(env);
    }

    try {
      const configValue = ConfigReader.get(key);
      if (this.isValid(configValue)) return configValue;
    } catch {
      // Config not loaded — fall through to defaults
    }

    // 3) Hard defaults
    return Defaults.get(key);
  }

  /**
   * Resolve a boolean configuration value.
   */
  static resolveBoolean(key: string): boolean {
    const value = this.resolve(key);
    return value === 'true';
  }

  /**
   * Resolve a configuration value, optionally falling back to a default.
   * - With a default:  returns defaultValue when the key is missing.
   * - Without default: throws ConfigurationException when the key is missing,
   *                    which aborts the current test/suite immediately.
   */
  static resolveOrDefault(key: string, defaultValue?: string): string {
    const value = this.resolve(key);
    if (this.isValid(value)) return value!.trim();
    if (defaultValue !== undefined) return defaultValue;
    throw new ConfigurationException(
      `Missing required configuration key: "${key}". Add it to your config file or set the ${key.replaceAll('.', '_').toUpperCase()} environment variable.`,
    );
  }

  /**
   * Resolve a required configuration value.
   * Throws ConfigurationException when value is missing/empty.
   */
  static resolveOrThrow(key: string, message?: string): string {
    const value = this.resolve(key);
    if (this.isValid(value)) {
      return value!.trim();
    }

    throw new ConfigurationException(
      message ?? `Missing required configuration key: ${key}`,
    );
  }

  /**
   * Resolve an integer configuration value.
   */
  static resolveInt(key: string): number {
    const value = this.resolve(key);
    if (value == null) return 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  private static isValid(value: string | undefined | null): boolean {
    return value != null && value.trim() !== '' && value.toLowerCase() !== 'null';
  }

  /**
   * Parse --env=<value> from process.argv.
   * Usage: vitest run -- --env=qa
   */
  private static parseEnvFromArgs(): string | undefined {
    const environmentArgument = /^--env=(.+)$/i;
    for (const arg of process.argv) {
      const match = environmentArgument.exec(arg);
      if (match) return match[1].trim().toLowerCase();
    }
    return undefined;
  }
}
