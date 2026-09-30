# Using `@jsi/vitest-api-core` in a Consumer Test Project

## Table of Contents

- [Installation](#installation)
- [Project Setup](#project-setup)
- [Configuration](#configuration)
- [Writing Tests](#writing-tests)
  - [Non-Concurrent Suite (`describe`)](#non-concurrent-suite-describe)
  - [Concurrent Suite (`describe` with `it.concurrent`)](#concurrent-suite-describe-with-itconcurrent)
  - [Class-Based Suite (`ApiTestBase`)](#class-based-suite-apitestbase)
- [HTTP Requests (`ServiceBase`)](#http-requests-servicebase)
- [Authentication](#authentication)
- [Soft Assertions (`SoftAssert`)](#soft-assertions-softassert)
- [Test Steps (`testStep`)](#test-steps-teststep)
- [JSON Schema Validation](#json-schema-validation)
- [Logging (`LoggerService`)](#logging-loggerservice)
- [Reporting](#reporting)
- [Environment Variables Reference](#environment-variables-reference)

---

## Installation

### 1. Add `.npmrc` to your consumer project root

```
@jsi:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_NPM_TOKEN}
```

Set `GITHUB_NPM_TOKEN` to a GitHub PAT with `read:packages` scope.

### 2. Install the package

```bash
npm install @jsi/vitest-api-core
```

---

## Project Setup

### `package.json`

```json
{
  "name": "my-api-tests",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@jsi/vitest-api-core": "^1.0.0",
    "vitest": ">=2.0.0",
    "typescript": "^5.7.0"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["tests/**/*"]
}
```

### `vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 60000,
    hookTimeout: 30000,
    pool: 'threads',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['allure-vitest/setup'],       // required for Allure to capture test events
    reporters: [
      'default',
      ['allure-vitest/reporter', {
        resultsDir: 'reports/allure-results',  // raw result JSON files
      }],
    ],
    includeTaskLocation: true,                 // enables file + line links in the Allure report
  },
});
```

---

## Configuration

The framework auto-discovers config from `{projectRoot}/config/{env}.config.yaml`.

### Config files

Place config files in your project's `config/` directory:

```
config/
  default.config.yaml    # environment selector only
  dev.config.yaml        # full dev config
  qa.config.yaml         # full qa config
  uat.config.yaml        # full uat config
```

**`config/default.config.yaml`** — only sets the default environment name:

```yaml
environment: dev
```

> This file's sole purpose is to tell the framework which env config to load when no `--env` flag or `ENVIRONMENT` env var is provided. All other config details belong in the env-specific files.

**`config/dev.config.yaml`** — full configuration for the `dev` environment:

```yaml
api:
  baseUrl: https://dev-api.example.com
  timeout: 10000

logging:
  enableFileLogging: true
  logDirectory: logs
  logLevel: debug

reporting:
  enableJsonReport: false
  jsonReportPath: reports/execution-summary.json
```

**`config/qa.config.yaml`** — full configuration for the `qa` environment:

```yaml
api:
  baseUrl: https://qa-api.example.com
  timeout: 15000

logging:
  enableFileLogging: true
  logDirectory: logs
  logLevel: info

reporting:
  enableJsonReport: true
  jsonReportPath: reports/execution-summary.json
```

**`config/uat.config.yaml`** — full configuration for the `uat` environment:

```yaml
api:
  baseUrl: https://uat-api.example.com
  timeout: 20000

logging:
  enableFileLogging: true
  logDirectory: logs
  logLevel: warn

reporting:
  enableJsonReport: true
  jsonReportPath: reports/execution-summary.json
```

> Each env config file is **self-contained** — it defines all values needed for that environment. The framework loads only the file that matches the active environment. If a key is not present in the env file, the built-in framework defaults apply.

### Config resolution priority (first wins)

| Priority | Source |
|----------|--------|
| 1 | CLI arg `--env=<value>` — e.g. `vitest run -- --env=qa` |
| 2 | `ENVIRONMENT` / `TEST_ENVIRONMENT` env vars |
| 3 | `CONFIG_FILE` env var — absolute path to a YAML file |
| 4 | `CONFIG_DIR` env var — directory containing `{env}.config.yaml` |
| 5 | `ConfigReader.setConfigDir(dir)` — programmatic override |
| 6 | `{projectRoot}/config/{env}.config.yaml` — auto-discovered |
| 7 | Built-in framework defaults |

### Specifying the environment

**Option A — CLI argument (recommended)**

Pass `--env=<value>` after `--` so vitest forwards it to `process.argv`:

```bash
vitest run -- --env=qa
```

Add a script to `package.json`:

```json
"scripts": {
  "test": "vitest run",
  "test:qa":  "vitest run -- --env=qa",
  "test:uat": "vitest run -- --env=uat"
}
```

Then run:

```bash
npm run test:qa
```

**Option B — Environment variable**

```bash
# PowerShell
$env:ENVIRONMENT = 'qa'; npm test

# bash / macOS / Linux
ENVIRONMENT=qa npm test
```

**Option C — Programmatic (in a global setup file)**

```ts
import { ConfigResolver } from '@jsi/vitest-api-core';

ConfigResolver.configure({
  configDir: './config',
  environment: 'qa',
});
```

### Reading config values

```ts
import { ConfigResolver } from '@jsi/vitest-api-core';

const url     = ConfigResolver.resolve('api.baseUrl');
const url     = ConfigResolver.resolveOrDefault('api.baseUrl', 'https://fallback.example.com');
const url     = ConfigResolver.resolveOrThrow('api.baseUrl');            // throws if missing
const timeout = ConfigResolver.resolveInt('api.timeout');                // resolves as integer
const enabled = ConfigResolver.resolveBoolean('logging.enableFileLogging');
```

| Method | Return type | Behaviour when missing |
|--------|-------------|------------------------|
| `resolve(key)` | `string \| undefined` | Returns `undefined` |
| `resolveOrDefault(key, default)` | `string` | Returns the provided default |
| `resolveOrThrow(key, msg?)` | `string` | Throws `ConfigurationException` |
| `resolveInt(key)` | `number` | Returns `0` |
| `resolveBoolean(key)` | `boolean` | Returns `false` |

> Config keys use dot-notation (`api.baseUrl`). Any key can also be set as a `UPPER_SNAKE_CASE` env var — e.g. `API_BASEURL` overrides `api.baseUrl`.

---

## Writing Tests

The framework exposes two test styles:

| Style | When to use |
|-------|------------|
| `describe` + `it` (functional) | Most tests — no class boilerplate |
| `ApiTestBase` (class-based) | When you need shared lifecycle hooks via inheritance |

---

### Non-Concurrent Suite (`describe`)

Use the `describe` and `it` exported from `@jsi/vitest-api-core`. Each `it` callback receives a `SuiteContext` object with `service`, `testBase`, `softAssert`, `loggerService`, and `testStep` injected.

```ts
// tests/users-api.test.ts
import { describe, ConfigResolver } from '@jsi/vitest-api-core';
import { it } from 'vitest';
import type { SuiteContext } from '@jsi/vitest-api-core';

const baseUrl = ConfigResolver.resolveOrDefault('api.baseUrl', 'https://api.example.com');

describe('Users API', ({ service, testStep, softAssert }: SuiteContext) => {

  it('should get user by ID', async () => {
    await testStep('GET /users/1', async () => {
      await service
        .setBaseUri(baseUrl)
        .sendGetRequest('/users/1')
        .validateStatusCode(200);
    });

    await testStep('Validate response fields', async () => {
      const user = service.getResponseBody<{ id: number; name: string; email: string }>();

      softAssert.assertNotNull(user.id, 'id should exist');
      softAssert.assertNotNull(user.name, 'name should exist');
      softAssert.assertNotNull(user.email, 'email should exist');
      softAssert.assertAll();
    });
  });

  it('should create a new user', async () => {
    await testStep('POST /users', async () => {
      await service
        .setBaseUri(baseUrl)
        .setJsonContentType()
        .setBody({ name: 'John Doe', email: 'john@example.com' })
        .sendPostRequest('/users')
        .validateStatusCode(201);
    });
  });
});
```

#### `describe` with options

```ts
import { describe, ApiSuiteOptions } from '@jsi/vitest-api-core';

const options: ApiSuiteOptions = {
  environment: 'qa',
  configDir: './config',
  tags: ['smoke', 'orders'],  // Optional: tag this suite for filtering
};

describe('Orders API', options, ({ service, testStep }) => {
  it('should list orders', async () => { /* ... */ });
});
```

**Available options:**

| Option | Type | Description |
|--------|------|-------------|
| `environment` | `string` | Override the active environment for this suite |
| `configDir` | `string` | Path to custom config directory |
| `tags` | `string[]` | Tags to categorize this suite for test filtering |
| `beforeAll` | `() => void \| Promise<void>` | Hook running before all tests in the suite |
| `beforeEach` | `() => void \| Promise<void>` | Hook running before each test |
| `afterEach` | `() => void \| Promise<void>` | Hook running after each test |
| `afterAll` | `() => void \| Promise<void>` | Hook running after all tests complete |

**Filtering tests by tags:**

Run only tests tagged with `smoke`:

```bash
vitest run --tagsFilter=smoke
# or
vitest run --tags-filter=smoke
```

Run tests tagged with `api` or `smoke` using logical operators:

```bash
vitest run --tagsFilter='api || smoke'
```

Run tests NOT tagged with `integration`:

```bash
vitest run --tagsFilter='!integration'
```

List all available tags:

```bash
vitest run --listTags
```

For more advanced filtering options and syntax, check the [Vitest tagging documentation](https://vitest.dev/guide/test-tags).

**Common tag examples:**
- `smoke` - quick smoke tests for sanity checks
- `api` - API tests
- `integration` - integration tests
- `e2e` - end-to-end tests
- `critical` - critical path tests
- `regression` - regression tests

---

### Concurrent Suite (`describe` with `it.concurrent`)

For tests that can run in parallel, use vitest's `describe` with the framework's `it`.

```ts
// tests/products-api.concurrent.test.ts
import { describe } from 'vitest';
import { it, ConfigResolver } from '@jsi/vitest-api-core';

const baseUrl = ConfigResolver.resolveOrDefault('api.baseUrl', 'https://api.example.com');

describe('Products API (concurrent)', () => {

  it.concurrent('should get all products', async ({ service, testStep, softAssert }) => {
    await testStep('GET /products', async () => {
      await service
        .setBaseUri(baseUrl)
        .sendGetRequest('/products')
        .validateStatusCode(200);
    });

    await testStep('Validate list is not empty', async () => {
      const body = service.getResponseBody<{ products: unknown[] }>();
      softAssert.assertGreaterThan(body.products.length, 0, 'products list should not be empty');
      softAssert.assertAll();
    });
  });

  it.concurrent('should get product by ID', async ({ service }) => {
    await service
      .setBaseUri(baseUrl)
      .sendGetRequest('/products/1')
      .validateStatusCode(200);
  });
});
```

**Tag concurrent suites:**

You can add tags to concurrent suites using vitest's native `describe` options:

```ts
describe('Products API (concurrent)', { tags: ['products', 'smoke'] }, () => {
  it.concurrent('should get all products', async ({ service, testStep, softAssert }) => {
    // ... test
  });
});
```

> In concurrent mode, each `it.concurrent` callback receives its own isolated `service`, `softAssert`, etc. via the vitest context argument.

---

### Class-Based Suite (`ApiTestBase`)

Use when you need shared `onBeforeAll` / `onAfterAll` hooks or reusable setup logic across test files.

```ts
// tests/suites/OrdersSuite.ts
import { ApiTestBase, OAuth2Config, ConfigResolver } from '@jsi/vitest-api-core';
import type { SuiteContext } from '@jsi/vitest-api-core';

export class OrdersSuite extends ApiTestBase {

  protected async onBeforeAll(): Promise<void> {
    const tokenUrl = ConfigResolver.resolve('auth.tokenUrl')!;
    const clientId = ConfigResolver.resolve('auth.clientId')!;
    const clientSecret = ConfigResolver.resolve('auth.clientSecret')!;

    const oauth = OAuth2Config.clientCredentials(tokenUrl, clientId, clientSecret)
      .scope('orders:read orders:write');

    await this.service.authenticateOAuth2(oauth);
  }

  run(): void {
    this.describe('Orders API', ({ service, testStep, softAssert }: SuiteContext) => {

      it('should list all orders', async () => {
        await testStep('GET /orders', async () => {
          await service
            .setBaseUri(ConfigResolver.resolve('api.baseUrl')!)
            .sendGetRequest('/orders')
            .validateStatusCode(200);
        });
      });
    });
  }
}

// tests/orders.test.ts
import { OrdersSuite } from './suites/OrdersSuite';
new OrdersSuite().run();
```

---

## HTTP Requests (`ServiceBase`)

All request builder methods return `this` for chaining. HTTP methods return a `FluentResponse` — awaitable, with chainable validation.

### Request builder methods

```ts
service
  .setBaseUri('https://api.example.com')   // required
  .setBasePath('/v1')                       // optional base path prefix
  .addHeader('X-Trace-Id', 'abc123')        // single header
  .addHeaders({ 'Accept': 'application/json', 'X-Api-Key': 'key' })
  .setJsonContentType()                     // Content-Type: application/json
  .setXmlContentType()                      // Content-Type: application/xml
  .setFormUrlEncodedContentType()
  .setBody({ key: 'value' })               // request body
  .addQueryParam('page', '1')
  .addQueryParams({ page: '1', size: '10' })
  .addPathParam('id', '42')                // replaces :id in endpoint
  .setBasicAuth('user', 'pass')
  .setBearerToken('eyJ...')
```

### HTTP methods

```ts
await service.sendGetRequest('/endpoint');
await service.sendPostRequest('/endpoint');
await service.sendPutRequest('/endpoint');
await service.sendPatchRequest('/endpoint');
await service.sendDeleteRequest('/endpoint');
```

### Fluent validation chaining

```ts
await service
  .setBaseUri(baseUrl)
  .setJsonContentType()
  .setBody({ name: 'test' })
  .sendPostRequest('/items')
  .validateStatusCode(201)
  .validateResponseContains('test')
  .validateContentType('application/json')
  .validateJsonSchema('./tests/schemas/item.schema.json')
  .logBody();
```

### Accessing the response

```ts
const body = service.getResponseBody<MyType>();       // typed response body
const text = service.responseBodyText;                 // raw response string
const status = service.responseStatusCode;
const headers = service.responseHeaders;
const ms = service.responseTime;
```

### FluentResponse methods

| Method | Description |
|--------|-------------|
| `.validateStatusCode(200)` | Assert HTTP status code |
| `.validateResponseContains('text')` | Assert body contains string |
| `.validateResponseNotContains('text')` | Assert body does not contain string |
| `.validateContentType('application/json')` | Assert Content-Type header |
| `.validateResponseNotEmpty()` | Assert body is not empty |
| `.validateResponseEmpty()` | Assert body is empty |
| `.validateJsonSchema('./path/schema.json')` | Validate body against JSON schema |
| `.logAll()` | Log request + response |
| `.logBody()` | Log response body |
| `.logHeaders()` | Log response headers |
| `.logRequest()` | Log request details |
| `.logResponse()` | Log full response |
| `.printPrettyResponse()` | Pretty-print JSON response |

---

## Authentication

### Basic Auth

```ts
service.setBasicAuth('username', 'password');
```

### Bearer Token

```ts
service.setBearerToken('eyJhbGciOiJSUzI1NiJ9...');
```

### OAuth2 — Client Credentials

```ts
import { OAuth2Config } from '@jsi/vitest-api-core';

const oauth = OAuth2Config.clientCredentials(
  'https://auth.example.com/oauth/token',
  'my-client-id',
  'my-client-secret',
).scope('read write').audience('https://api.example.com');

await service.authenticateOAuth2(oauth);
// subsequent requests automatically include the Bearer token
```

### OAuth2 — Password Grant

```ts
const oauth = OAuth2Config.passwordGrant(
  'https://auth.example.com/token',
  'client-id',
  'client-secret',
  'username',
  'password',
);
await service.authenticateOAuth2(oauth);
```

### OAuth2 — Refresh Token

```ts
const oauth = OAuth2Config.refreshToken(
  'https://auth.example.com/token',
  'client-id',
  'client-secret',
  'refresh-token-value',
);
await service.authenticateOAuth2(oauth);
```

---

## Soft Assertions (`SoftAssert`)

Soft assertions collect all failures and report them together at the end of a step. Always call `assertAll()` at the end to throw if any assertion failed.

```ts
const body = service.getResponseBody<{ id: number; name: string; active: boolean }>();

softAssert.assertNotNull(body.id, 'id should not be null');
softAssert.assertEquals(body.name, 'John', 'name should match');
softAssert.assertTrue(body.active, 'user should be active');
softAssert.assertAll();  // throws if any assertion above failed
```

### Available assertion methods

| Method | Description |
|--------|-------------|
| `assertEquals(actual, expected, msg?)` | Deep equality check |
| `assertNotEquals(actual, expected, msg?)` | Assert values differ |
| `assertTrue(condition, msg?)` | Assert condition is true |
| `assertFalse(condition, msg?)` | Assert condition is false |
| `assertNotNull(value, msg?)` | Assert value is not null/undefined |
| `assertNull(value, msg?)` | Assert value is null/undefined |
| `assertGreaterThan(actual, expected, msg?)` | Assert actual > expected |
| `assertLessThan(actual, expected, msg?)` | Assert actual < expected |
| `assertContains(array, item, msg?)` | Assert array contains item |
| `assertAll()` | Throw collected failures |

---

## Test Steps (`testStep`)

`testStep` wraps a block of code with a named step, logs timing, and supports conditional skipping.

```ts
// Basic
await testStep('Verify user endpoint', async () => {
  await service.sendGetRequest('/users/1').validateStatusCode(200);
});

// Conditional skip
const skipStep = process.env['SKIP_AUTH'] === 'true';
await testStep('Authenticate', skipStep, async () => {
  await service.authenticateOAuth2(oauth);
});

// Skip with reason
await testStep('Optional step', true, 'Feature not deployed in dev', async () => {
  // skipped
});

// Retry: re-run the step up to N more times if it throws (works with every overload)
await testStep('Flaky endpoint', async () => { /* ... */ }, { retries: 2 });
await testStep('Flaky endpoint', skipStep, async () => { /* ... */ }, { retries: 2 });
await testStep('Flaky endpoint', skipStep, 'Not in dev', async () => { /* ... */ }, { retries: 2 });
```

With `retries: 2` the step runs at most 3 times. A retry happens when the step throws (hard assertion / error) **or** records a new soft-assertion failure. Soft assertions from a failed attempt are discarded before the next attempt; if the final attempt still has soft failures, they're kept and reported by `assertAll()`. If every attempt throws, the last error is thrown. Skipped steps never run, so they're never retried.

---

## JSON Schema Validation

Place JSON schema files in your test project and reference them by relative path.

```
tests/
  schemas/
    user.schema.json
    product.schema.json
```

```ts
await service
  .sendGetRequest('/users/1')
  .validateStatusCode(200)
  .validateJsonSchema('./tests/schemas/user.schema.json');
```

### Example schema (`tests/schemas/user.schema.json`)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["id", "name", "email"],
  "properties": {
    "id":    { "type": "integer" },
    "name":  { "type": "string" },
    "email": { "type": "string", "format": "email" }
  }
}
```

---

## Logging (`LoggerService`)

Logging is automatic inside `describe`/`it` blocks. You can also use it directly.

```ts
import { LoggerService } from '@jsi/vitest-api-core';

const logger = new LoggerService('MyTest');
logger.info('Starting test for user {}', userId);
logger.warn('Unexpected status: {}', status);
logger.error('Request failed: {}', errorMessage);
```

### Enable per-test log files

In your config YAML:

```yaml
logging:
  enableFileLogging: true
  logDirectory: logs
  logLevel: debug
```

Log files are written to `logs/{suiteName}/{testName}.log`.

---

## Reporting

### JSON Report

Enable in `config/dev.config.yaml`:

```yaml
reporting:
  enableJsonReport: true
  jsonReportPath: reports/execution-summary.json
```

The report is automatically written to the configured path at the end of each suite run.

---

### Allure Report

#### Step 1 — Install dependencies

`allure-vitest` and `allure-commandline` are bundled as dependencies of `@jsi/vitest-api-core`.
You do **not** need to install them separately. However, if you want to pin specific versions:

```bash
npm install -D allure-vitest allure-commandline
```

#### Step 2 — Configure `vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 60000,
    hookTimeout: 30000,
    pool: 'threads',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['allure-vitest/setup'],         // required — registers Allure hooks
    reporters: [
      'default',
      ['allure-vitest/reporter', {
        resultsDir: 'reports/allure-results',    // raw result files go here
      }],
    ],
    includeTaskLocation: true,                   // enables file+line links in the report
  },
});
```

> `setupFiles: ['allure-vitest/setup']` is **required**. Without it, Allure will not capture test lifecycle events.

#### Step 3 — Add report scripts to `package.json`

```json
{
  "scripts": {
    "test": "vitest run",
    "report:generate": "allure generate reports/allure-results -o reports/allure-report --clean && npx pactum-report",
    "report:open": "allure open reports/allure-report",
    "report": "npm run report:generate && npm run report:open"
  }
}
```

> `npx pactum-report` runs the `customize-allure` script bundled with `@jsi/vitest-api-core`.
> It injects a custom CSS theme, metrics bar (pass rate, totals, duration), and a theme switcher into the generated report.
> Skip it if you want the plain Allure report.

#### Generate from outside the project directory (PowerShell)

Do not copy `customize-allure.js` into `allure-results` — it needs the package's bundled CSS and is already exposed as the `pactum-report` CLI. Both `allure` and `pactum-report` are project-local npm executables (never global), and `allure` is only a *transitive* bin, so `npx --prefix ... allure` is unreliable. Use `npm`, which prepends the project's `node_modules\.bin` to `PATH`.

**Option A — run the project's npm scripts by path (simplest):**

```powershell
npm --prefix 'C:\work\my-api-tests' run report:generate
```

This uses the `report:generate` script defined in the consumer project's `package.json` (see Step 3). `npm run` sets the working directory to the project, so the script's relative `reports\...` paths resolve correctly no matter where you launch it.

**Option B — invoke the bins directly with `npm exec` and absolute paths:**

```powershell
$projectRoot = 'C:\work\my-api-tests'
$resultsDir = Join-Path $projectRoot 'reports\allure-results'
$reportDir = Join-Path $projectRoot 'reports\allure-report'

npm --prefix $projectRoot exec -- allure generate $resultsDir -o $reportDir --clean
npm --prefix $projectRoot exec -- pactum-report $reportDir
```

**Option C — change into the project first, then use the normal scripts:**

```powershell
Push-Location 'C:\work\my-api-tests'
npm run report:generate
Pop-Location
```

> If you see `'allure' is not recognized` or `'pactum-report' is not recognized`, you ran the bare command (or `npx --prefix`) instead of one of the options above — or `$projectRoot` was unset in a fresh terminal. `pactum-report` derives the raw results directory from the report directory's sibling `allure-results` folder.

#### Build a customized report from downloaded artifacts (`pactum-report-build`)

When you only have an `allure-results` folder — for example downloaded from a GitHub Actions artifact onto a machine without the project checked out or Allure installed — use the self-contained `pactum-report-build` command. It runs `allure generate` using the **bundled** `allure-commandline` (no system Allure needed) **and** applies the custom UI in one step:

```powershell
pactum-report-build <results-dir> [-o <report-dir>] [--no-clean]
```

The report directory defaults to a sibling `allure-report` next to the results folder. Run it via `npx` without checking out the project — you only need the package:

```powershell
# From anywhere; downloads the package on demand and builds the report
npx --package @jsi/vitest-api-core pactum-report-build .\allure-results -o .\allure-report
```

Or, in a CI job that already installed the package:

```powershell
npm exec -- pactum-report-build .\allure-results -o .\allure-report
```

Example GitHub Actions step (results downloaded via `actions/download-artifact`):

```yaml
- name: Build customized Allure report
  run: npx --package @jsi/vitest-api-core pactum-report-build ./allure-results -o ./allure-report

- name: Publish report
  uses: actions/upload-artifact@v4
  with:
    name: allure-report
    path: ./allure-report
```

> `pactum-report-build` bundles everything the report needs (Allure CLI + custom CSS/JS), so the published report keeps the metrics bar, suites table, and theme switcher without any extra setup. To open it locally afterwards: `npx allure open ./allure-report`.

#### Step 4 — Add `.gitignore` entries

```
reports/allure-results/
reports/allure-report/
```

#### Step 5 — Run tests and generate the report

```bash
# Run tests (produces raw result files in reports/allure-results/)
npm test

# Generate the HTML report and open it
npm run report
```

Or step by step:

```bash
npm test
npm run report:generate
npm run report:open
```

#### Folder structure after a run

```
reports/
  allure-results/          # raw JSON result files (generated by vitest)
    <uuid>-result.json
    <uuid>-container.json
    ...
  allure-report/           # final HTML report (generated by allure generate)
    index.html
    widgets/
    ...
```

#### Annotating tests with Allure metadata (optional)

Use `allure-js-commons` (bundled with the package) to add labels, links, and descriptions:

```ts
import { description, label, link, severity, step } from 'allure-js-commons';

it('should get user by ID', async () => {
  await description('Verifies that GET /users/:id returns the correct user');
  await severity('critical');
  await label('feature', 'User Management');
  await link('https://jira.example.com/PROJ-123', 'PROJ-123', 'issue');

  await testStep('GET /users/1', async () => {
    await service.sendGetRequest('/users/1').validateStatusCode(200);
  });
});
```

#### Allure annotations reference

| Function | Description |
|----------|-------------|
| `description('text')` | Test description shown in the report |
| `severity('critical' \| 'normal' \| 'minor' \| 'blocker' \| 'trivial')` | Test severity |
| `label('name', 'value')` | Custom label (e.g. feature, component) |
| `link(url, name?, type?)` | Attach a URL link (type: `issue`, `tms`, etc.) |
| `step('Step name', fn)` | Named inline step (appears in report body) |
| `attachment('name', content, type)` | Attach file or text to the test |
| `epic('name')` | Group by epic |
| `feature('name')` | Group by feature |
| `story('name')` | Group by story |

Import all from `allure-js-commons`:

```ts
import { description, severity, label, link, step, epic, feature, story } from 'allure-js-commons';
```

---

## Environment Variables Reference

| Variable | Description | Default |
|----------|-------------|---------|
| `ENVIRONMENT` | Target environment (`dev`, `qa`, `uat`, `prod`) | `dev` |
| `CONFIG_FILE` | Absolute path to a YAML config file | — |
| `CONFIG_DIR` | Directory containing `{env}.config.yaml` | — |
| `API_BASEURL` | Overrides `api.baseUrl` from config | — |
| `API_TIMEOUT` | Overrides `api.timeout` (ms) | `20000` |
| `LOGGING_ENABLEFILELOGGING` | Enables file logging (`true`/`false`) | `false` |
| `REPORTING_ENABLEJSONREPORT` | Enables JSON report (`true`/`false`) | `false` |

> Any dot-notation config key (e.g. `api.baseUrl`) can be overridden via the corresponding `UPPER_SNAKE_CASE` env var (`API_BASEURL`).

---

## CI Progress Reporter (non-TTY)

`NonTtyReporter` streams append-only, plain-text progress while tests run. It exists
because Vitest's `default` reporter relies on ANSI cursor redraw: when
`process.stdout.isTTY` is `false` (GitHub Actions, Linux CI log pipes, Docker,
redirected/captured stdout) that live file-progress display is not rendered, so a
long run can look hung until everything finishes. `verbose` streams individual tests
but gives no file-level progress, and `github-actions` only adds annotations.

This reporter emits one atomic `write` per block (parallel workers cannot interleave
partial lines), uses a monotonic clock (`performance.now()`), and never depends on
terminal width or escape sequences.

By default it honors `reporting.consolidateDataDriven` (default `true`), so repeated
data-set iterations that share a case ID are collapsed per file. This makes the live
`Total Tests:` / `Passed:` / `Failed:` / `Skipped:` counts match the `SummaryReporter`,
JUnit, Allure and TestRail totals. Set `consolidateDataDriven: false` (or
`reporting.consolidateDataDriven: false`) to report every raw Vitest instance instead.

### Configuration

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

const isNonTty =
  !process.stdout.isTTY ||
  process.env.CI === 'true' ||
  process.env.GITHUB_ACTIONS === 'true';

export default defineConfig({
  test: {
    reporters: isNonTty
      ? [
          ['@jsi-staging/vitest-api-core/non-tty-reporter', {
            interval: 5000,
            showFileStart: true,
            showFileDuration: true,
            showLiveCounts: true,
            githubActions: true,
          }],
          // existing custom reporters keep working unchanged
          new SummaryReporter(),
          ['allure-vitest/reporter', { resultsDir: 'reports/allure-results' }],
          new AllureConsolidationReporter({ resultsDir: 'reports/allure-results' }),
        ]
      : ['default', new SummaryReporter()],
  },
});
```

Or construct it directly:

```ts
import { NonTtyReporter } from '@jsi-staging/vitest-api-core';

reporters: [new NonTtyReporter({ interval: 5000, showSummary: false })]
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `interval` | `number` | `5000` | Live elapsed/progress update interval in ms. `0` disables the timer. |
| `showFileStart` | `boolean` | `true` | Print `[START] <file>` lines. |
| `startBatchWindow` | `number` | `50` | Window (ms) for grouping near-simultaneous worker starts into one block with a single trailing `Run elapsed`. `0` flushes each start immediately. |
| `showFileDuration` | `boolean` | `true` | Print `Duration: HH:MM:SS` per completed file. |
| `showLiveCounts` | `boolean` | `true` | Print aggregate `Progress:` / `Total Tests:` lines. |
| `showSummary` | `boolean` | `true` | Print the final test summary. Set `false` to avoid duplicating `SummaryReporter`. |
| `consolidateDataDriven` | `boolean` | resolved `reporting.consolidateDataDriven` (default `true`) | Collapse repeated data-set iterations that share a case ID (e.g. `C1234`) into a single result per file, so the live counts match the `SummaryReporter`, JUnit, Allure and TestRail totals. Set `false` (or `reporting.consolidateDataDriven: false`) to report every raw Vitest instance. |
| `githubActions` | `boolean` | `GITHUB_ACTIONS === 'true'` | Emit additive `::error` annotations for failures. |
| `groupFailures` | `boolean` | resolved `githubActions` | Wrap each failure in a collapsible `::group::...::endgroup::` block (collapsed by default in the Actions log UI) with the message and a trimmed stack, instead of leaving it inline. |
| `maxStackFrames` | `number` | `2` | Stack frames kept per failure inside a group before truncating with `... N more frame(s)`. |
| `showFailedTestsDigest` | `boolean` | resolved `githubActions` | Append a compact `Failed Tests (N):` list after the final summary. |
| `maxDigestEntries` | `number` | `25` | Entries listed in the digest before truncating with `... N more`. |
| `timestamps` | `boolean` | `false` | Prefix every line with an ISO timestamp. |
| `write` | `(chunk: string) => void` | `process.stdout.write` | Output sink (used by tests). |
| `now` | `() => number` | `performance.now` | Monotonic clock source. |

### Sample output

```text
Test run started

[START] tests/sessions/registration.api.spec.ts
[START] tests/sessions/interception.api.spec.ts
[START] tests/vq/vq-delivery.api.spec.ts
[START] tests/vq/vq-quality.api.spec.ts
[START] tests/sessions/teardown.api.spec.ts
Run elapsed: 00:00:05

Progress: 0/19 files completed
Total Tests: 18, Passed: 17, Failed: 1, Skipped: 0
Run elapsed: 00:00:10

[PASS] tests/vq/vq-delivery.api.spec.ts
  Duration: 00:00:11
  Total Tests: 7, Passed: 6, Failed: 0, Skipped: 1

Progress: 1/19 files completed
Total Tests: 19, Passed: 17, Failed: 1, Skipped: 1
Run elapsed: 00:00:12

[FAIL] tests/sessions/interception.api.spec.ts
  Duration: 00:00:17
  Total Tests: 7, Passed: 5, Failed: 1, Skipped: 1

Test run completed with failures
Test Files: 1 failed, 5 passed
Total Tests: 33, Passed: 22, Failed: 1, Skipped: 2
Duration: 00:00:22
```

`Total Tests` counts every Vitest `TestCase`, including data-driven instances that
share a TestRail case ID. `Passed`, `Failed`, and `Skipped` count only those exact
result states, so they can sum to less than `Total Tests`. For parallel runs, the
final aggregate is recalculated from Vitest's completed test modules and is not
affected by worker callback order.

Workers that pick up files at nearly the same moment share one `[START]` block and a
single `Run elapsed` line, so a run with many workers does not produce one elapsed
line per file. Pending starts are always flushed before any other output, keeping the
log strictly chronological.

Timers are cleared on run completion, failure, interruption, and on process `exit`.
The reporter only reads Vitest state and writes to its own sink, so TestRail upload
and Allure result generation/consolidation are unaffected.

### GitHub Actions failure grouping and end-of-run digest

When `githubActions` is `true` (the default detection via `GITHUB_ACTIONS === 'true'`),
each failure is additionally wrapped in a collapsible group and a `Failed Tests`
digest is appended after the summary, so a long CI log stays scannable instead of
burying case IDs in scattered stack traces:

```text
::group::❌ FAIL  C55325177 · tests/vq/t1678-vq.api.spec.ts:852
  Expected one of [15, 16] IP sessions but got 0
    at prepareSessionWav (vqHelpers.ts:795:23)
    at t1678-vq.api.spec.ts:852:49
    ... 2 more frame(s)
::endgroup::

Test run completed with failures
Test Files: 2 failed, 17 passed
Total Tests: 220, Passed: 195, Failed: 13, Skipped: 12
Duration: 00:41:07

Failed Tests (13):
  C55325177  Expected one of [15, 16] IP sessions but got 0  tests/vq/t1678-vq.api.spec.ts:852
  C58984041  WAV file did not appear within the polling timeout  tests/vq/t1678-vq.api.spec.ts:850
  ... 11 more (see junit-report.xml / allure-results for full detail)
```

Both features are additive to the existing `::error` annotations and are gated on
`githubActions` (or explicit `groupFailures`/`showFailedTestsDigest`), so local/non-CI
runs are unaffected by default. Set `groupFailures: false` or `showFailedTestsDigest: false`
to opt out individually.
