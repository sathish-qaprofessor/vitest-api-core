# Vitest-api-core

TypeScript API testing framework built on [Pactum](https://pactumjs.github.io/) with fluent builder pattern, soft assertions, and layered configuration. Designed to be consumed as an npm package.

## Stack

| Concern | Library |
|---------|---------|
| HTTP Client | Pactum 3.x |
| Test Runner | Vitest >=2.x |
| Schema Validation | Ajv 8.x |
| Logging | Winston 3.x |
| Reporting | Allure (allure-vitest) + JSON |
| Configuration | js-yaml (.yaml) |

## Installation

```bash
npm install @jsi-staging/vitest-api-core
```

## Quick Start

### 1. Create config

Place your environment config in your project:

```
my-project/
  config/
    dev.config.yaml
    qa.config.yaml
  tests/
    my-api.test.ts
```

```yaml
# config/dev.config.yaml
environment: dev

api:
  baseUrl: https://api.example.com
  timeout: 30000

logging:
  enableFileLogging: false
  logLevel: info
```

### 2. Write tests

Use the `describe()` function — lifecycle hooks are automatic:

```typescript
import * as path from 'path';
import { describe, it, ConfigResolver } from '@jsi-staging/vitest-api-core';

describe('My API Tests', { configDir: path.resolve(__dirname, 'config') },
  ({ service, testStep, softAssert }) => {

  const baseUrl = ConfigResolver.resolve('api.baseUrl') ?? 'https://api.example.com';

  it('should fetch items', async () => {
    await testStep('GET items', async () => {
      await service
        .setBaseUri(baseUrl)
        .addHeader('Accept', 'application/json')
        .sendGetRequest('/items')
        .validateStatusCode(200);
    });

    await testStep('Validate response', async () => {
      const items = service.extractListFromResponse('data');
      softAssert.assertGreaterThan(items.length, 0, 'should return items');
      softAssert.assertAll();
    });
  });

  it('should validate schema', async () => {
    await testStep('GET and validate', async () => {
      await service
        .setBaseUri(baseUrl)
        .sendGetRequest('/items')
        .validateStatusCode(200)
        .validateJsonSchema('schemas/items.json');
    });
  });
});
```

### 3. Run

```bash
npm test
```

## Architecture

### `describe()`

The `describe()` function wraps Vitest's `describe` and auto-registers lifecycle hooks:

| Hook | What it does |
|------|-------------|
| `beforeAll` | Loads config, initializes file logging |
| `beforeEach` | Creates fresh `service`, `testBase`, `softAssert`, `loggerService` |
| `afterEach` | Clears service state, closes per-test loggers |
| `afterAll` | Closes all file loggers |

Pass additional lifecycle callbacks via options:

```typescript
describe('My Tests', {
  configDir: './config',
  beforeAll: () => { /* suite setup */ },
  beforeEach: () => { /* per-test setup */ },
  afterEach: () => { /* per-test teardown */ },
  afterAll: () => { /* suite teardown */ },
}, (ctx) => { /* tests */ });
```

Supported suite modifiers are also available on the custom wrapper:

```typescript
describe.skip('Skipped suite', ({ testStep }) => {
  // skipped
});

describe.only('Focused suite', ({ testStep }) => {
  // only this suite runs
});

describe.skipIf(process.env['SKIP_API_TESTS'] === 'true')(
  'Conditionally skipped suite',
  ({ testStep }) => {
    // runs only when condition is false
  },
);
```

### SuiteContext

The `describe()` callback receives a `SuiteContext` with live-proxied references — destructure for clean access:

| Property | Type | Description |
|----------|------|-------------|
| `service` | `ServiceBase` | Fluent HTTP client (fresh per test) |
| `testBase` | `TestBase` | Test step orchestration |
| `softAssert` | `SoftAssert` | Soft assertion collector |
| `loggerService` | `LoggerService` | Per-test logger |
| `testStep` | `function` | Shortcut for `testBase.testStep()` |

### Fluent HTTP Client

`ServiceBase` methods return `this` for sync chaining. Async send methods return a `FluentResponse` that supports chaining validations directly:

```typescript
// Sync chaining (request builder)
service
  .setBaseUri('https://api.example.com')
  .addHeader('Authorization', 'Bearer token')
  .setJsonContentType()
  .setBody({ name: 'test' });

// Fluent async chain (send + validate in one await)
await service
  .setBaseUri('https://api.example.com')
  .sendPostRequest('/items')
  .validateStatusCode(201)
  .validateResponseContains('created');

// Extract data after await
const id = service.extractIntegerFromResponse('id');
```

### Soft Assertions

Collect multiple assertion failures before failing the test:

```typescript
softAssert.assertFalse(body.error, 'error should be false');
softAssert.assertNotNull(body.id, 'id should exist');
softAssert.assertGreaterThan(body.items.length, 0, 'should have items');
softAssert.assertAll(); // throws if any failed
```

### Test Steps

`testStep` wraps a named action with timing and logging. Supports conditional skipping:

```typescript
// Standard step
await testStep('GET items', async () => { /* ... */ });

// Skip a step
await testStep('Flaky step', true, async () => { /* skipped */ });

// Skip with reason
await testStep('WIP step', true, 'Not implemented yet', async () => { /* skipped */ });
```

### Data-Driven Tests

Use Vitest's `it.each` for parameterized tests:

```typescript
it.each([
  { category: 'Programming', safe: true },
  { category: 'Misc', safe: false },
])('should fetch a $category joke (safe=$safe)', async ({ category, safe }) => {
  await testStep(`GET /joke/${category}`, async () => {
    await service.setBaseUri(baseUrl).sendGetRequest(`/joke/${category}`).validateStatusCode(200);
  });
});
```

## Configuration

Configuration is resolved in priority order (first match wins):

| Priority | Source | Example |
|----------|--------|---------|
| 1 | Environment variables | `API_BASEURL=https://... npm test` |
| 2 | `CONFIG_FILE` env var | Absolute path to a specific YAML file |
| 3 | `CONFIG_DIR` env var | Directory containing `{env}.config.yaml` |
| 4 | `configDir` option in `describe()` | `{ configDir: './config' }` |
| 5 | `{CWD}/config/{env}.config.yaml` | Consumer project config |
| 6 | Built-in defaults | Hard-coded fallback values |

Consumer project config is always discovered automatically — place YAML files in `config/` at your project root.

### Environment Variables

```bash
# Select environment
ENVIRONMENT=qa npm test

# Override specific values
API_BASEURL=https://staging.api.com npm test

# Point to custom config
CONFIG_DIR=./custom-config npm test
```

### YAML Config Example

```yaml
# config/qa.config.yaml
environment: qa

api:
  baseUrl: https://qa.api.example.com
  timeout: 30000

logging:
  enableFileLogging: true
  logDirectory: logs
  logLevel: debug

reporting:
  enableAllure: true
  enableJsonReport: true
  jsonReportPath: reports/execution-summary.json
```

## Project Structure

```
src/
  index.ts              # Barrel export
  base/
    ApiTestBase.ts       # describe()/it wrappers + ApiTestBase class
    ServiceBase.ts       # Fluent HTTP client with FluentResponse
    ServiceClient.ts     # Per-test service factory
    TestBase.ts          # Test step + timing utilities
    OAuth2Config.ts      # OAuth2 grant type builder
  asserts/
    SoftAssert.ts        # Soft assertion collector
  config/
    ConfigReader.ts      # YAML configuration loader
    ConfigResolver.ts    # Cascading config resolution
    Defaults.ts          # Built-in default values
  constants/
    Messages.ts          # String constants
    Timeouts.ts          # Timeout defaults
  exceptions/
    ConfigurationException.ts
    ValidationException.ts
    AuthenticationException.ts
  logger/
    LoggerService.ts     # Multi-transport Winston logger
  reporter/
    customize-allure.js  # Allure HTML customization script
    summary-reporter.ts  # Console summary reporter
  reports/
    JsonReporter.ts      # JSON execution report
    types.ts             # Report data types
  utils/
    Duration.ts          # Duration utilities
```

## License

MIT
