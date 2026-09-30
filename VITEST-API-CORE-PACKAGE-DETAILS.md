# Package File Structure — `vitest-api-core`

> **Purpose:** Complete reference of every class, interface, and configuration file in the `vitest-api-core` framework package.
> **Last Updated:** May 19, 2026 | **Framework Version:** 1.0.5 | **Package:** `@jsi-staging/vitest-api-core`

> **⚠️ CRITICAL — DO NOT CREATE THESE FILES**
> All classes in this document are **pre-installed** in the consumer project via the `@jsi-staging/vitest-api-core` dependency.
> **Never generate:** `ApiTestBase.ts`, `ServiceBase.ts`, `ServiceClient.ts`, `OAuth2Config.ts`, `TestBase.ts`, or any framework-internal class.
> **Only generate:** test files (that use `describe()`/`it()`), model/interface files, JSON schema files, and YAML config files.

---

## Table of Contents

- [1. Source Package Structure](#1-source-package-structure)
- [2. Technology Stack](#2-technology-stack)
- [3. Detailed Class Reference](#3-detailed-class-reference)
  - [3.1 `base/` — Core Framework](#31-base--core-framework)
  - [3.2 `asserts/` — Assertions](#32-asserts--assertions)
  - [3.3 `config/` — Configuration](#33-config--configuration)
  - [3.4 `constants/` — Constants](#34-constants--constants)
  - [3.5 `exceptions/` — Exceptions](#35-exceptions--exceptions)
  - [3.6 `logger/` — Logging](#36-logger--logging)
  - [3.7 `reports/` — Reporting](#37-reports--reporting)
  - [3.8 `utils/` — Utilities](#38-utils--utilities)
- [4. Configuration Reference](#4-configuration-reference)
- [5. Reporting](#5-reporting)
- [6. Class Dependency Diagram](#6-class-dependency-diagram)

---

## 1. Source Package Structure

```
src/
├── index.ts                          ← Barrel export (public API surface)
├── base/
│   ├── ApiTestBase.ts                ← ★ describe()/it wrappers + class-based test base
│   ├── ServiceBase.ts                ← ★ Fluent HTTP client (request/response/validate)
│   ├── ServiceClient.ts              ← Per-test ServiceBase factory
│   ├── TestBase.ts                   ← testStep() lifecycle + soft assertion wiring
│   └── OAuth2Config.ts               ← OAuth2 grant type builder (all grant types)
├── asserts/
│   └── SoftAssert.ts                 ← Soft assertion collector with diff reporting
├── config/
│   ├── ConfigReader.ts               ← Loads environment-specific YAML config files
│   ├── ConfigResolver.ts             ← Cascading config resolution (env → yaml → defaults)
│   └── Defaults.ts                   ← Built-in default configuration values
├── constants/
│   ├── Messages.ts                   ← All log/error/assertion message string constants
│   └── Timeouts.ts                   ← Timeout and retry constant values
├── exceptions/
│   ├── ConfigurationException.ts     ← Thrown for missing/invalid config keys
│   ├── ValidationException.ts        ← Thrown for failed response/schema validations
│   └── AuthenticationException.ts   ← Thrown for OAuth2 / auth failures
├── logger/
│   └── LoggerService.ts              ← Multi-transport Winston logger (console + file + Allure)
├── reporter/
│   ├── customize-allure.js           ← Post-process script: injects custom CSS/JS into Allure HTML
│   └── summary-reporter.ts           ← Console test summary reporter
├── reports/
│   ├── allure-custom.css             ← Custom Allure report stylesheet
│   ├── JsonReporter.ts               ← JSON execution summary writer
│   └── types.ts                      ← TestResult / SuiteResult / RequestLog interfaces
└── utils/
    ├── Duration.ts                   ← Duration formatting helpers
    └── PathUtils.ts                  ← Cross-platform path resolution helpers
```

---

## 2. Technology Stack

| Concern | Library | Version |
|---------|---------|---------|
| Test Runner | Vitest | ≥ 2.0.0 |
| HTTP Client | Pactum | ^3.7.0 |
| Schema Validation | Ajv | ^8.17.0 |
| Logging | Winston | ^3.17.0 |
| Allure Reporting | allure-vitest + allure-commandline | ^3.6.0 / ^2.38.1 |
| Config Format | js-yaml | ^4.1.0 |
| Browser Automation | Playwright | 1.59.1 |
| Language | TypeScript | ^5.7.0 |
| Runtime | Node.js | ≥ 18.0.0 |

---

## 3. Detailed Class Reference

### 3.1 `base/` — Core Framework

---

#### `ApiTestBase.ts` ★ (Entry point for all test suites)

| Aspect | Details |
|--------|---------|
| **Type** | Class + exported `describe()` and `it` wrappers |
| **Purpose** | Wires Vitest lifecycle hooks, exposes `SuiteContext`, supports suite modifiers (`skip/only/skipIf`), and provides fixture-aware `it` |
| **Consumer usage** | Import `describe` and `it` from package — **do not extend or instantiate directly** |

**`describe()` function signature:**

```typescript
import { describe, it } from '@jsi-staging/vitest-api-core';

describe('Suite Name', (ctx: SuiteContext) => {
  it('test name', async ({ service, testStep, softAssert }) => { ... });
});

describe.skip('Skipped suite', (ctx: SuiteContext) => { /* ... */ });
describe.only('Focused suite', (ctx: SuiteContext) => { /* ... */ });
describe.skipIf(process.env['SKIP_SUITE'] === 'true')('Conditional suite', (ctx: SuiteContext) => { /* ... */ });
```

**`describe()` overloads and options:**

```typescript
describe(name, (ctx) => { /* ... */ });
describe(name, {
  configDir: './config',
  environment: 'qa',
  tags: ['api', 'smoke'],
  beforeAll: async () => {},
  beforeEach: async () => {},
  afterEach: async () => {},
  afterAll: async () => {},
}, (ctx) => { /* ... */ });
```

**Custom `it` wrapper:**
- Exported `it` is a lazy `vitestTest.extend(...)` proxy.
- Fixtures are auto-injected: `service`, `testStep`, `softAssert`.
- Works with Vitest variants like `it.concurrent(...)`.
- Per-test setup/teardown and JSON reporter write happen automatically.

**`SuiteContext` properties (destructure freely):**

| Property | Type | Description |
|----------|------|-------------|
| `service` | `ServiceBase` | Fluent HTTP client — fresh instance per test |
| `testBase` | `TestBase` | Test step runner and soft assert wiring |
| `softAssert` | `SoftAssert` | Soft assertion collector |
| `loggerService` | `LoggerService` | Per-test named logger |
| `testStep` | `function` | Shortcut for `testBase.testStep(...)` |

**Automatic lifecycle (no setup code required):**

| Hook | What happens |
|------|-------------|
| `beforeAll` | Loads environment config, initialises file logging, initialises JSON reporter |
| `beforeEach` | Creates fresh `ServiceClient`, `ServiceBase`, `TestBase`, `LoggerService` instances |
| `afterEach` | Attaches console logs to Allure, writes test result to JSON reporter, resets state |
| `afterAll` | Flushes JSON report, closes file loggers |

---

#### `ServiceBase.ts` ★ (Fluent HTTP client)

| Aspect | Details |
|--------|---------|
| **Type** | Class |
| **Returned by** | `SuiteContext.service` (auto-created per test) |
| **Pattern** | Builder (sync) + `FluentResponse` (async chainable) |

**Request Builder Methods** *(sync — all return `this`)*

| Method | Description |
|--------|-------------|
| `setBaseUri(url)` | Set the base URL |
| `setBasePath(path)` | Set a path prefix applied to all endpoints |
| `addHeader(name, value)` | Add a single request header |
| `addHeaders(map)` | Add multiple headers at once |
| `setContentType(type)` | Set `Content-Type` header |
| `setJsonContentType()` | Sets `Content-Type: application/json` |
| `setXmlContentType()` | Sets `Content-Type: application/xml` |
| `setFormUrlEncodedContentType()` | Sets form-encoded content type |
| `setBasicAuth(user, pass)` | Sets `Authorization: Basic …` header |
| `setBearerToken(token)` | Sets `Authorization: Bearer …` header |
| `setOAuth2Token(token)` | Alias for `setBearerToken()` |
| `setBody(body)` | Set request body (object or string) |
| `addQueryParam(name, value)` | Add a single query parameter |
| `addQueryParams(map)` | Add multiple query parameters |
| `addPathParam(name, value)` | Add a path parameter (replaces `{name}` in URL) |
| `addPathParams(map)` | Add multiple path parameters |
| `suppressResponseBodyLog()` | Suppress response body log for next request only |
| `suppressRequestLog()` | Suppress request URL/params/body log for next request only |
| `clearRequestSpec()` | Reset all request state except `baseUri` |

**HTTP Send Methods** *(async — return `FluentResponse`)*

| Method | Description |
|--------|-------------|
| `sendGetRequest(endpoint)` | Executes HTTP GET |
| `sendPostRequest(endpoint)` | Executes HTTP POST |
| `sendPutRequest(endpoint)` | Executes HTTP PUT |
| `sendPatchRequest(endpoint)` | Executes HTTP PATCH |
| `sendDeleteRequest(endpoint)` | Executes HTTP DELETE |

**`FluentResponse` Validation Methods** *(chainable after send)*

| Method | Description |
|--------|-------------|
| `validateStatusCode(code)` | Assert HTTP status code |
| `validateResponseContains(text)` | Assert response body contains text |
| `validateResponseNotContains(text)` | Assert response body does not contain text |
| `validateContentType(type)` | Assert `Content-Type` response header |
| `validateResponseNotEmpty()` | Assert body is not empty |
| `validateResponseEmpty()` | Assert body is empty |
| `validateJsonSchema(schemaPath)` | Validate body against a JSON Schema file |

**`FluentResponse` Logging Methods** *(chainable after send)*

| Method | Description |
|--------|-------------|
| `logAll()` | Log full request + response |
| `logBody()` | Log response body |
| `logHeaders()` | Log response headers |
| `logRequest()` | Log raw request details |
| `logResponse()` | Log raw response details |
| `printPrettyResponse()` | Pretty-print response JSON to console |

**Response Extraction Methods** *(call after `await`)*

| Method | Description |
|--------|-------------|
| `responseStatusCode` | HTTP status code (number) |
| `responseBody` | Parsed body (unknown) |
| `responseBodyText` | Raw body as string |
| `responseHeaders` | Headers as `Record<string, string>` |
| `responseTime` | Response time in milliseconds |
| `extractFromResponse(path)` | Extract value at dot-notation path |
| `extractStringFromResponse(path)` | Extract value as string |
| `extractIntegerFromResponse(path)` | Extract value as integer |
| `extractListFromResponse(path)` | Extract array at path |

**OAuth2 Methods** *(async)*

| Method | Description |
|--------|-------------|
| `authenticateOAuth2(config)` | Fetches token and sets bearer auth |
| `requestOAuth2Token(config, field?)` | Returns raw token string |
| `authenticateImplicitGrant(options?)` | Uses browser implicit flow and sets bearer auth |

**OAuth2 Implicit Grant (static methods):**

| Method | Description |
|--------|-------------|
| `requestImplicitGrantToken(options?)` | Launches Playwright browser and returns `access_token` |
| `clearImplicitGrantTokenCache()` | Clears in-memory implicit token cache |

**Chaining Example:**

```typescript
// Full chain: build → send → validate → extract
await service
  .setBaseUri('https://api.example.com')
  .addHeader('Accept', 'application/json')
  .addQueryParam('page', '1')
  .sendGetRequest('/items')
  .validateStatusCode(200)
  .validateJsonSchema('schemas/items.json');

const items = service.extractListFromResponse('data');
```

---

#### `TestBase.ts`

| Aspect | Details |
|--------|---------|
| **Type** | Class |
| **Accessed via** | `SuiteContext.testBase` or shortcut `testStep()` |

**`testStep()` Overloads:**

```typescript
// Always runs
await testStep('Step name', async () => { ... });

// Conditionally skipped
await testStep('Step name', shouldSkip, async () => { ... });

// Conditionally skipped with reason
await testStep('Step name', shouldSkip, 'Reason text', async () => { ... });
```

| Behaviour | Details |
|-----------|---------|
| Timing | Start/end time logged automatically |
| Allure | Each step appears as a named step in the Allure report |
| Skip | Skipped steps are logged but not executed |
| Errors | Step failures propagate and fail the test |

**Exposed state:**

| Property/Method | Description |
|-----------------|-------------|
| `assertions` | Returns the `SoftAssert` instance used by the current test |
| `softAssertionFailed` | Indicates whether any step failed in the current test lifecycle |
| `reset()` | Clears soft assertion state and internal step counters between tests |

---

#### `OAuth2Config.ts`

| Aspect | Details |
|--------|---------|
| **Type** | Class (builder pattern) |
| **Factory methods** | `clientCredentials()`, `passwordGrant()`, `authorizationCode()`, `refreshToken()`, `custom()` |

**Exported Interfaces:**

| Interface | Description |
|-----------|-------------|
| `OAuth2ConfigOptions` | All OAuth2 fields as a plain object (alternative construction via `custom()`) |
| `ImplicitGrantOptions` | Options for browser-based implicit grant flow (Playwright-driven login) |

**Grant Type Builders:**

```typescript
// Client credentials (machine-to-machine)
const config = OAuth2Config.clientCredentials(tokenUrl, clientId, clientSecret)
  .scope('read write')
  .audience('https://api.example.com');

// Resource owner password
const config = OAuth2Config.passwordGrant(tokenUrl, clientId, secret, username, password);

// Authorization code exchange
const config = OAuth2Config.authorizationCode(tokenUrl, clientId, secret, code, redirectUri);

// Refresh token
const config = OAuth2Config.refreshToken(tokenUrl, clientId, secret, refreshToken);

// Custom grant type
const config = OAuth2Config.custom(tokenUrl, 'urn:custom:grant');
```

**Builder Fluent Methods:**

| Method | Description |
|--------|-------------|
| `.scope(value)` | OAuth2 scope string |
| `.audience(value)` | Token audience |
| `.resource(value)` | Token resource (e.g. Azure AD resource URI) |
| `.redirectUri(value)` | Redirect URI for auth code flow |
| `.clientId(value)` | Override client ID after construction |
| `.clientSecret(value)` | Override client secret after construction |
| `.username(value)` | Override username after construction |
| `.password(value)` | Override password after construction |
| `.authorizationCode(code)` | Set authorization code after construction |
| `.refreshTokenValue(token)` | Set refresh token value after construction |
| `.additionalParam(key, value)` | Add custom form parameter |

**Other Methods:**

| Method | Description |
|--------|-------------|
| `buildFormParams()` | Returns the assembled token request form params as `Record<string, string>` |

---

### 3.2 `asserts/` — Assertions

#### `SoftAssert.ts`

| Aspect | Details |
|--------|---------|
| **Type** | Class |
| **Accessed via** | `SuiteContext.softAssert` |
| **Behaviour** | Collects all failures; only throws when `assertAll()` is called |

**Assertion Methods:**

| Method | Description |
|--------|-------------|
| `assertEquals(actual, expected, msg?)` | Deep equality check |
| `assertNotEquals(actual, expected, msg?)` | Deep inequality check |
| `assertTrue(condition, msg?)` | Asserts `condition === true` |
| `assertFalse(condition, msg?)` | Asserts `condition === false` |
| `assertNull(value, msg?)` | Asserts `value == null` |
| `assertNotNull(value, msg?)` | Asserts `value != null` |
| `assertContains(actual, expected, msg?)` | String/array contains check |
| `assertNotContains(actual, expected, msg?)` | String/array does not contain |
| `assertGreaterThan(actual, expected, msg?)` | Numeric greater-than |
| `assertLessThan(actual, expected, msg?)` | Numeric less-than |
| `assertObjectEquals(actual, expected, msg?)` | Field-by-field object diff with per-field pass/fail reporting |
| `assertAll()` | Throws `ValidationException` if any assertion failed |
| `reset()` | Clears all collected results |

**Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `passedCount` | `number` | Number of passed assertions |
| `failedCount` | `number` | Number of failed assertions |
| `totalAssertions` | `number` | Total assertion count |
| `hasFailures` | `boolean` | True if any assertion failed |

---

### 3.3 `config/` — Configuration

#### `ConfigResolver.ts` ★ (Primary config API)

Resolution order (first match wins):

| Priority | Source |
|----------|--------|
| 1 | Environment variable (`KEY_NAME` or `KEY.NAME`) |
| 2 | `--env=<value>` CLI argument (for `environment` key) |
| 3 | `CONFIG_FILE` env var (absolute path override) |
| 4 | `CONFIG_DIR` env var + `{env}.config.yaml` |
| 5 | `{CWD}/config/{env}.config.yaml` |
| 6 | `{INIT_CWD}/config/{env}.config.yaml` |
| 7 | `Defaults` built-in values |

**Static Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `resolve` | `(key) → string \| undefined` | Returns value or `undefined` if not found |
| `resolveOrDefault` | `(key, default?) → string` | Returns value; if missing and default provided → returns default; if missing and no default → **throws `ConfigurationException`** |
| `resolveOrThrow` | `(key, msg?) → string` | Always throws if key is missing |
| `resolveBoolean` | `(key) → boolean` | Returns `true` only if value is the string `"true"` |
| `resolveInt` | `(key) → number` | Parses value as integer; returns `0` on failure |
| `configure` | `({ configDir?, environment? }) → void` | Programmatic setup — call before any `resolve()` |

**Usage:**

```typescript
import { ConfigResolver } from '@jsi-staging/vitest-api-core';

// Required key — throws if missing
const baseUrl = ConfigResolver.resolveOrDefault('api.baseUrl');

// Required key with fallback default
const timeout = ConfigResolver.resolveOrDefault('api.timeout', '30000');

// Optional key
const logLevel = ConfigResolver.resolve('logging.logLevel') ?? 'info';

// Boolean flag
const fileLogging = ConfigResolver.resolveBoolean('logging.enableFileLogging');

// Integer
const timeoutMs = ConfigResolver.resolveInt('api.timeout');
```

---

#### `ConfigReader.ts`

| Aspect | Details |
|--------|---------|
| **Type** | Static class |
| **Purpose** | Loads and caches YAML config file for the active environment |
| **Consumer usage** | Not used directly — accessed via `ConfigResolver` |

**Static Methods:**

| Method | Description |
|--------|-------------|
| `load(environment)` | Load `{env}.config.yaml` (auto-discovers file path) |
| `get(key)` | Get a config value by dot-notation key |
| `isLoaded()` | Returns `true` if config has been loaded |
| `reset()` | Clears loaded config (used in testing) |
| `setConfigDir(dir)` | Programmatically set config directory |

---

#### `Defaults.ts`

| Aspect | Details |
|--------|---------|
| **Type** | Static class |
| **Purpose** | Loads `config/default.config.yaml` from consumer project; hard-coded fallbacks if file missing |

**Built-in Defaults:**

| Key | Default Value |
|-----|---------------|
| `environment` | *(from `default.config.yaml`)* |
| `api.timeout` | `20000` |
| `logging.enableFileLogging` | `false` |
| `logging.logDirectory` | `logs` |
| `logging.logLevel` | `info` |
| `reporting.enableJsonReport` | `false` |
| `reporting.jsonReportPath` | `reports/execution-summary.json` |

---

### 3.4 `constants/` — Constants

#### `Messages.ts`

String constants used in logging throughout the framework. All log messages reference these constants — never hard-coded strings. Categories include: request building, request execution, response, OAuth2, assertions, test steps, config, and errors.

#### `Timeouts.ts`

Numeric timeout constants for request defaults and retry logic.

---

### 3.5 `exceptions/` — Exceptions

| Class | Thrown When |
|-------|-------------|
| `ConfigurationException` | A required config key is missing or config file cannot be loaded |
| `ValidationException` | Response validation fails (status code, schema, body content) |
| `AuthenticationException` | OAuth2 token request fails or token is missing from response |

All three extend `Error` and include an optional `cause` property.

---

### 3.6 `logger/` — Logging

#### `LoggerService.ts`

| Aspect | Details |
|--------|---------|
| **Type** | Class |
| **Transport** | Console (always) + file (if `logging.enableFileLogging=true`) + Allure inline steps |
| **Accessed via** | `SuiteContext.loggerService` |

**Methods:**

| Method | Description |
|--------|-------------|
| `info(msg, ...args)` | Log at INFO level; `{}` placeholders replaced by args |
| `warn(msg, ...args)` | Log at WARN level |
| `error(msg, ...args)` | Log at ERROR level |
| `debug(msg, ...args)` | Log at DEBUG level |

**Static Methods:**

| Method | Description |
|--------|-------------|
| `setCurrentTestId(id)` | Sets the active test context for log routing |
| `getCurrentTestId()` | Returns the currently active test ID |
| `setFileLoggingEnabled(flag)` | Enables/disables file logging at runtime |
| `initTestFileLogging(suite, test, testId?)` | Opens per-test log file |
| `initTestLogsFor(testId)` | Initialises log storage for a specific test ID (concurrent-safe, does not change shared state) |
| `closeTestFileLogging()` | Closes and flushes per-test log file for the current test |
| `closeTestFileLoggingFor(testId)` | Closes and flushes per-test log file for a specific test ID (concurrent-safe) |
| `closeAllTestFileLogging()` | Closes all open test file loggers |
| `getTestLogs(testId?)` | Returns captured log lines for a test (defaults to current test ID) |
| `getTestLogsFor(testId)` | Returns captured log lines for a specific test ID |

> **Note:** `debug()` messages are written to the console only — they are intentionally excluded from the per-test log file and Allure attachment.

---

### 3.7 `reports/` — Reporting

#### `summary-reporter.ts`

Console reporter used in Vitest config to print suite/test summary totals at the end of execution.

| Aspect | Details |
|--------|---------|
| **Type** | Custom Vitest reporter class (`SummaryReporter`) |
| **Exported from** | `src/index.ts` |
| **Purpose** | Human-readable pass/fail/skipped summary per file/suite |

#### `JsonReporter.ts`

Writes an execution summary JSON file after each suite run.

| Method | Description |
|--------|-------------|
| `initSuite(name)` | Start tracking a new suite |
| `addTestResult(result)` | Record a test outcome |
| `recordRequest(testId, log)` | Attach an HTTP request log to the active test |
| `flush()` | Write JSON file to `reporting.jsonReportPath` (merges with existing file if present) |
| `reset()` | Clear state (called in `beforeAll`) |

**Report Types** (from `reports/types.ts`):

```typescript
interface RequestLog {
  method: string;
  url: string;
  statusCode: number;
  responseBody: string;
  timestamp: string;
}

interface StepResult {
  name: string;
  status: 'passed' | 'failed';
  duration: number;
  error?: string;
}

interface TestResult {
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

interface SuiteResult {
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
```

#### `customize-allure.js` (CLI script — `pactum-report`)

Post-processing binary run automatically by `npm run report:generate`. It:

1. Reclassifies `broken` test results as `failed` in all allure-results JSON files
2. Patches all generated report data files (`data/`, `widgets/`) to merge broken → failed
3. Injects custom CSS and JS into `index.html` to produce the branded report

**Injected customisations:**
- Custom metrics bar (Suites / Total Tests / Passed / Failed / Skipped / Duration / Pass Rate)
- Custom Suites table (Suite, Total, Passed, Failed, Pass%) replacing the default widget
- Pre-calculated pass rate using merged failed counts
- Theme switcher (solarized [default] / dark-teal / light / dark)

---

### 3.8 `utils/` — Utilities

#### `PathUtils.ts`

| Method | Description |
|--------|-------------|
| `exists(path)` | Check if path exists |
| `ensureDirectory(path)` | Create directory recursively if missing |
| `resolve(...segments)` | Join and resolve path segments |
| `resolveFromCwd(...segments)` | Resolve relative to `process.cwd()` |
| `resolveFromConsumerRoot(...segments)` | Resolve relative to `INIT_CWD` (consumer project root) |
| `getPackageConfigDirs(baseDir)` | Returns potential config directory paths for package resolution |
| `resolveSchemaFile(schemaPath)` | Resolves a schema file path across multiple lookup locations (up to depth 8) |
| `findPackageRoot(startDir)` | Walks up from `startDir` to find the nearest `package.json` directory |

---

#### `Duration.ts`

A lightweight `Duration` wrapper replacing `java.time.Duration`.

| Method | Description |
|--------|-------------|
| `Duration.ofMillis(ms)` | Creates a `Duration` from milliseconds |
| `Duration.ofSeconds(seconds)` | Creates a `Duration` from seconds |
| `Duration.ofMinutes(minutes)` | Creates a `Duration` from minutes |
| `Duration.between(start, end)` | Creates a `Duration` from two epoch-millisecond timestamps |
| `.toMillis()` | Returns duration in milliseconds |
| `.toSeconds()` | Returns duration in seconds |

---

## 4. Configuration Reference

### YAML Config File Structure

Place config files in `{project-root}/config/` using the naming convention `{environment}.config.yaml`.

```yaml
# config/dev.config.yaml
environment: dev

api:
  baseUrl: https://api.example.com
  timeout: 30000            # milliseconds

logging:
  enableFileLogging: true
  logDirectory: logs
  logLevel: debug           # debug | info | warn | error

reporting:
  enableJsonReport: true
  jsonReportPath: reports/execution-summary.json
```

### `default.config.yaml`

Sets the default environment when no CLI arg or environment variable is provided:

```yaml
# config/default.config.yaml
environment: qa
```

### Environment Variables (override any config key)

| Variable | Maps to config key |
|----------|--------------------|
| `ENVIRONMENT` | `environment` |
| `API_BASEURL` | `api.baseUrl` |
| `API_TIMEOUT` | `api.timeout` |
| `LOGGING_ENABLEFILELOGGING` | `logging.enableFileLogging` |
| `REPORTING_ENABLEJSONREPORT` | `reporting.enableJsonReport` |

Any config key can be overridden by converting dot-notation to `UPPER_SNAKE_CASE`:
`api.baseUrl` → `API_BASEURL`

### Selecting Environment at Runtime

```bash
# Via CLI argument (highest priority after env vars)
npx vitest run -- --env=qa

# Via environment variable
ENVIRONMENT=staging npx vitest run

# Via custom config directory
CONFIG_DIR=/path/to/config npx vitest run
```

---

## 5. Reporting

### Allure Report

```bash
# Generate + open (recommended)
npm run report

# Generate only
npm run report:generate

# Open existing report
npm run report:open
```

The `report:generate` script runs `allure generate` then `node src/reporter/customize-allure.js` to apply the custom theme.

### JSON Execution Summary

Enabled via `reporting.enableJsonReport: true` in config. Output path configurable via `reporting.jsonReportPath`.

---

## 6. Class Dependency Diagram

```
Consumer Test File
    │
    └── describe(suiteName, fn)                  ← ApiTestBase.ts
            │
            ├── ConfigResolver.resolve()          ← ConfigResolver.ts
            │       ├── ConfigReader.load()       ← ConfigReader.ts
            │       └── Defaults.get()            ← Defaults.ts
            │
            ├── ServiceClient.initService()       ← ServiceClient.ts
            │       └── new ServiceBase()         ← ServiceBase.ts
            │               ├── Pactum spec()
            │               ├── LoggerService     ← LoggerService.ts
            │               └── OAuth2Config      ← OAuth2Config.ts (optional)
            │
            ├── new TestBase()                    ← TestBase.ts
            │       └── new SoftAssert()          ← SoftAssert.ts
            │
            ├── new LoggerService()               ← LoggerService.ts
            │       └── Winston transports
            │
            └── JsonReporter                      ← JsonReporter.ts
                    └── reports/execution-summary.json
```
