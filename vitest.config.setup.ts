import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';

/**
 * Config Setup File
 * Loads configuration from YAML files in the config/ directory
 */

const projectRoot = resolve(__dirname);
const configDir = join(projectRoot, 'config');
const defaultConfigPath = join(configDir, 'default.config.yaml');

let defaultEnvironment = 'dev';

if (existsSync(defaultConfigPath)) {
  const defaultConfigContent = readFileSync(defaultConfigPath, 'utf8');
  const defaultConfig = yaml.load(defaultConfigContent) as Record<string, any>;
  defaultEnvironment = defaultConfig?.environment || defaultEnvironment;
}

// Determine environment from env vars first, then fall back to default.config.yaml
const environment = process.env.CONFIG_ENV || process.env.ENVIRONMENT || defaultEnvironment;

// Load default config first
const envConfigPath = join(configDir, `${environment}.config.yaml`);

try {
  // Load default config
  if (existsSync(defaultConfigPath)) {
    console.log(`[Config Setup] Loaded default configuration from ${defaultConfigPath}`);
  }

  // Load environment-specific config
  if (existsSync(envConfigPath)) {
    const envConfigContent = readFileSync(envConfigPath, 'utf8');
    const envConfig = yaml.load(envConfigContent) as Record<string, any>;

    // Set environment variables from config for backward compatibility
    if (envConfig?.api?.baseUrl) {
      process.env.API_BASEURL = envConfig.api.baseUrl;
    }

    console.log(`[Config Setup] Loaded configuration for environment '${environment}' from ${envConfigPath}`);
    console.log(`[Config Setup] API Base URL: ${envConfig?.api?.baseUrl}`);
  } else {
    console.warn(`[Config Setup] Warning: Config file not found: ${envConfigPath}`);
    console.log(`[Config Setup] Available environments in config/:`,
      readdirSync(configDir)
        .filter(f => f.endsWith('.config.yaml') && f !== 'default.config.yaml')
        .map(f => f.replace('.config.yaml', ''))
    );
  }
} catch (error) {
  console.error('[Config Setup] Error loading configuration:', error);
  throw new Error(`Failed to load configuration from ${envConfigPath}`);
}
