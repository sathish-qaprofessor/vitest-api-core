import pactum from 'pactum';
import Ajv from 'ajv';
import * as fs from 'node:fs';
import { LoggerService } from '../logger/LoggerService.js';
import { Messages } from '../constants/Messages.js';
import { ValidationException } from '../exceptions/ValidationException.js';
import { AuthenticationException } from '../exceptions/AuthenticationException.js';
import { OAuth2Config, ImplicitGrantOptions } from './OAuth2Config.js';
import { PathUtils } from '../utils/PathUtils.js';
import { ConfigResolver } from '../config/ConfigResolver.js';
import { JsonReporter } from '../reports/JsonReporter.js';
import { JunitReporter } from '../reports/JunitReporter.js';

const { spec } = pactum;

/**
 * Response data captured after each HTTP request.
 */
export interface CapturedResponse {
  statusCode: number;
  body: unknown;
  bodyText: string;
  headers: Record<string, string>;
  responseTime: number;
}

interface ImplicitTokenRequest {
  logger: LoggerService;
  tokenUrl: string;
  clientId: string;
  scope: string | undefined;
  callbackUrl: string;
  username: string;
  password: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start++;
  while (end > start && value[end - 1] === '/') end--;
  return value.slice(start, end);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/**
 * A PromiseLike returned by async HTTP methods that supports fluent chaining
 * of validation and logging methods directly after the request.
 *
 * ```ts
 * await service.setBaseUri(url).sendGetRequest('/info')
 *   .validateStatusCode(200)
 *   .validateJsonSchema(schemaPath);
 * ```
 */
export interface FluentResponse extends PromiseLike<ServiceBase> {
  // Validation methods
  validateStatusCode(expectedStatusCode: number): FluentResponse;
  validateResponseContains(expectedText: string): FluentResponse;
  validateResponseNotContains(unexpectedText: string): FluentResponse;
  validateContentType(expectedContentType: string): FluentResponse;
  validateResponseNotEmpty(): FluentResponse;
  validateResponseEmpty(): FluentResponse;
  validateJsonSchema(schemaPath: string): FluentResponse;
  // Logging methods
  logAll(): FluentResponse;
  logBody(): FluentResponse;
  logHeaders(): FluentResponse;
  logRequest(): FluentResponse;
  logResponse(): FluentResponse;
  printPrettyResponse(): FluentResponse;
  clearRequestSpec(): FluentResponse;
}

function createFluentResponse(promise: Promise<ServiceBase>): FluentResponse {
  return new Proxy(promise as object, {
    get(target, prop) {
      // Delegate Promise/thenable methods to the underlying promise
      if (prop === 'then' || prop === 'catch' || prop === 'finally') {
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as Function).bind(target) : value;
      }
      // Chain any other method call onto the resolved value
      return (...args: unknown[]) => {
        const chained = (target as Promise<ServiceBase>).then((resolved) => {
          const fn = (resolved as unknown as Record<string | symbol, unknown>)[prop];
          if (typeof fn === 'function') {
            const result = fn.apply(resolved, args);
            return result instanceof Promise ? result : resolved;
          }
          return resolved;
        });
        return createFluentResponse(chained);
      };
    },
  }) as unknown as FluentResponse;
}

/**
 * ServiceBase provides fluent HTTP client methods powered by Pactum.
 * All API operations are logged to console and per-test files via LoggerService.
 *
 * Every sync builder method returns `this` for chaining.
 * Every async HTTP method returns `FluentResponse<ServiceBase>` —
 * an awaitable object that also supports chaining sync methods directly.
 */
export class ServiceBase {
  private readonly loggerService: LoggerService;

  private _baseUri: string = '';
  private _basePath: string = '';
  private _headers: Record<string, string> = {};
  private _queryParams: Record<string, string> = {};
  private _pathParams: Record<string, string> = {};
  private _body: unknown = undefined;
  private _contentType: string | undefined;
  private _suppressResponseBodyLog: boolean = false;
  private _suppressRequestLog: boolean = false;

  private _responseStatusCode: number = 0;
  private _responseBody: unknown = undefined;
  private _responseBodyText: string = '';
  private _responseHeaders: Record<string, string> = {};
  private _responseTime: number = 0;

  /**
   * Per-worker token cache. Key = resolved tokenUrl+clientId+username combo.
   * Stores the in-flight Promise and its expiry timestamp so tokens are refreshed
   * automatically when they expire. Concurrent callers share the same browser launch.
   * Call `ServiceBase.clearImplicitGrantTokenCache()` to force a fresh login.
   */
  private static readonly _implicitGrantCache = new Map<string, { promise: Promise<string>; expiresAt: number }>();

  constructor(loggerService?: LoggerService) {
    this.loggerService = loggerService ?? new LoggerService('ServiceBase');
  }

  // ====================== GETTERS ======================

  get baseUri(): string {
    return this._baseUri;
  }

  get responseStatusCode(): number {
    return this._responseStatusCode;
  }

  get responseBody(): unknown {
    return this._responseBody;
  }

  get responseBodyText(): string {
    return this._responseBodyText;
  }

  get responseHeaders(): Record<string, string> {
    return this._responseHeaders;
  }

  get responseTime(): number {
    return this._responseTime;
  }

  // ====================== REQUEST BUILDER METHODS (sync — return this) ======================

  setBaseUri(baseUri: string): this {
    this._baseUri = baseUri;
    return this;
  }

  setBasePath(basePath: string): this {
    this._basePath = basePath;
    return this;
  }

  addHeader(headerName: string, headerValue: string): this {
    this._headers[headerName] = headerValue;
    return this;
  }

  addHeaders(headers: Record<string, string>): this {
    if (headers && Object.keys(headers).length > 0) {
      for (const [key, value] of Object.entries(headers)) {
        this._headers[key] = value;
      }
    }
    return this;
  }

  setContentType(contentType: string): this {
    this._contentType = contentType;
    this._headers['Content-Type'] = contentType;
    return this;
  }

  setJsonContentType(): this {
    return this.setContentType('application/json');
  }

  setXmlContentType(): this {
    return this.setContentType('application/xml');
  }

  setFormUrlEncodedContentType(): this {
    return this.setContentType('application/x-www-form-urlencoded');
  }

  setBasicAuth(username: string, password: string): this {
    const encoded = Buffer.from(`${username}:${password}`).toString('base64');
    this._headers['Authorization'] = `Basic ${encoded}`;
    return this;
  }

  setBearerToken(token: string): this {
    this._headers['Authorization'] = `Bearer ${token}`;
    return this;
  }

  setOAuth2Token(token: string): this {
    return this.setBearerToken(token);
  }

  /**
   * Suppress response body logging for the next request only.
   * Useful when the response is very large (e.g. paginated list endpoints).
   * The status code is still logged. Resets automatically after each request.
   */
  suppressResponseBodyLog(): this {
    this._suppressResponseBodyLog = true;
    return this;
  }

  /**
   * Suppress request URL, params, and body logging for the next request only.
   * Useful during polling loops to reduce verbose output.
   * Resets automatically after each request.
   */
  suppressRequestLog(): this {
    this._suppressRequestLog = true;
    return this;
  }

  setBody(body: unknown): this {
    if (body != null) {
      this._body = body;
    }
    return this;
  }

  addQueryParam(paramName: string, paramValue: string | number): this {
    this._queryParams[paramName] = String(paramValue);
    return this;
  }

  addQueryParams(queryParams: Record<string, string>): this {
    if (queryParams && Object.keys(queryParams).length > 0) {
      for (const [key, value] of Object.entries(queryParams)) {
        this._queryParams[key] = value;
      }
    }
    return this;
  }

  addPathParam(paramName: string, paramValue: string | number): this {
    this._pathParams[paramName] = String(paramValue);
    return this;
  }

  addPathParams(pathParams: Record<string, string>): this {
    if (pathParams && Object.keys(pathParams).length > 0) {
      for (const [key, value] of Object.entries(pathParams)) {
        this._pathParams[key] = value;
      }
    }
    return this;
  }

  // ====================== OAUTH2 AUTHENTICATION ======================

  async authenticateOAuth2(config: OAuth2Config): Promise<this> {
    this.loggerService.info(Messages.OAUTH2_AUTHENTICATING, config.grantType, config.tokenUrl);
    const token = await this.requestOAuth2Token(config);
    this.loggerService.info(Messages.OAUTH2_TOKEN_OBTAINED);
    return this.setBearerToken(token);
  }

  async requestOAuth2Token(config: OAuth2Config, tokenField: string = 'access_token'): Promise<string> {
    this.loggerService.info(Messages.OAUTH2_TOKEN_REQUEST, config.tokenUrl, config.grantType);

    const formParams = config.buildFormParams();
    this.loggerService.info(Messages.OAUTH2_GRANT_TYPE, config.grantType);

    if (config.getScope()) {
      this.loggerService.info(Messages.OAUTH2_SCOPE, config.getScope());
    }
    if (config.getAudience()) {
      this.loggerService.info(Messages.OAUTH2_AUDIENCE, config.getAudience());
    }

    try {
      const oauthTimeoutMs = Number.parseInt(ConfigResolver.resolveOrDefault('api.timeout', '20000'), 10);
      const response = await spec()
        .post(config.tokenUrl)
        .withHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' })
        .withForm(formParams)
        .withRequestTimeout(oauthTimeoutMs)
        .toss();

      const statusCode = response.statusCode;
      this.loggerService.info(Messages.OAUTH2_TOKEN_RESPONSE_STATUS, statusCode);

      if (statusCode < 200 || statusCode >= 300) {
        const body = JSON.stringify(response.body);
        this.loggerService.error(Messages.OAUTH2_TOKEN_REQUEST_FAILED, statusCode, body);
        throw new AuthenticationException(`OAuth2 token request failed with status ${statusCode}: ${body}`);
      }

      const token = response.body?.[tokenField];
      if (!token) {
        const body = JSON.stringify(response.body);
        this.loggerService.error(Messages.OAUTH2_TOKEN_FIELD_MISSING, tokenField, body);
        throw new AuthenticationException(
          `OAuth2 token response does not contain '${tokenField}': ${body}`,
        );
      }

      this.loggerService.info(Messages.OAUTH2_TOKEN_EXTRACTED, tokenField);
      return token as string;
    } catch (err) {
      if (err instanceof AuthenticationException) throw err;
      this.loggerService.error(Messages.OAUTH2_TOKEN_ERROR, (err as Error).message);
      throw new AuthenticationException(
        `Failed to obtain OAuth2 token: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  // ====================== OAUTH2 IMPLICIT GRANT (BROWSER) ======================

  /**
   * Launch a headless Chromium browser, navigate to the authorization server,
   * submit the login form, and capture the access_token from the URL fragment
   * of the redirect response (Implicit Grant / response_type=token).
   *
   * Available as both a **static** method (no instance needed — use in beforeAll)
   * and an **instance** method (applies the token as Bearer for subsequent requests).
   *
   * All options fall back to config keys under `auth.*` in your YAML config:
   *   auth.tokenUrl, auth.clientId, auth.scope, auth.callbackUrl,
   *   auth.username, auth.password
   *
   * @example Static — use in beforeAll without a service instance:
   * ```ts
   * const token = await ServiceBase.requestImplicitGrantToken();
   * AuthContext.setCredentials({ type: 'bearer', token });
   * ```
   *
   * @example Instance — use inside a test to authenticate and chain requests:
   * ```ts
   * await service.requestImplicitGrantToken(); // returns raw token
   * await service.authenticateImplicitGrant(); // sets Bearer header
   * ```
   */
  static async requestImplicitGrantToken(options: ImplicitGrantOptions = {}): Promise<string> {
    const logger = new LoggerService('ImplicitGrant');

    const tokenUrl    = options.tokenUrl    ?? ConfigResolver.resolveOrDefault('auth.tokenUrl');
    const clientId    = options.clientId    ?? ConfigResolver.resolveOrDefault('auth.clientId');
    const scope       = options.scope       ?? ConfigResolver.resolveOrDefault('auth.scope');
    const callbackUrl = options.callbackUrl ?? ConfigResolver.resolveOrDefault('auth.callbackUrl');
    const username    = options.username    ?? ConfigResolver.resolveOrDefault('auth.username');
    const password    = options.password    ?? ConfigResolver.resolveOrDefault('auth.password');

    if (!tokenUrl)    throw new AuthenticationException('Implicit grant: auth.tokenUrl is required');
    if (!clientId)    throw new AuthenticationException('Implicit grant: auth.clientId is required');
    if (!callbackUrl) throw new AuthenticationException('Implicit grant: auth.callbackUrl is required');
    if (!username)    throw new AuthenticationException('Implicit grant: auth.username is required');
    if (!password)    throw new AuthenticationException('Implicit grant: auth.password is required');

    // Deduplication key — unique per auth server + client + user combination
    const cacheKey = `${tokenUrl}::${clientId}::${username}`;

    // Token TTL: prefer explicit option, then config, then default 55 min.
    // The || 55 guard handles a NaN result if the config value is missing or non-numeric.
    const ttlMinutes =
      options.tokenTtlMinutes ??
      (Number.parseInt(ConfigResolver.resolveOrDefault('auth.tokenTtlMinutes', '55'), 10) || 55);
    const ttlMs = ttlMinutes * 60 * 1000;

    // Return existing in-flight or already-resolved promise if not yet expired
    const cached = ServiceBase._implicitGrantCache.get(cacheKey);
    if (cached) {
      if (Date.now() < cached.expiresAt) {
        logger.info('[OAuth2 Implicit] Reusing cached token promise for key: {} (expires in {} min)', cacheKey, Math.ceil((cached.expiresAt - Date.now()) / 60_000));
        return cached.promise;
      }
      // Token has expired — remove and fall through to fetch a fresh one
      logger.info('[OAuth2 Implicit] Cached token expired for key: {} — refreshing', cacheKey);
      ServiceBase._implicitGrantCache.delete(cacheKey);
    }

    const tokenPromise = ServiceBase._fetchImplicitToken({
      logger,
      tokenUrl,
      clientId,
      scope,
      callbackUrl,
      username,
      password,
      usernameSelector: options.usernameSelector,
      passwordSelector: options.passwordSelector,
      submitSelector: options.submitSelector,
    });

    // Store the promise immediately (expiresAt = Infinity) so concurrent callers share
    // the same in-flight browser launch without launching a second one.
    // expiresAt is updated to the real wall-clock expiry once the token is actually obtained,
    // ensuring the full TTL is counted from when the token was issued, not when the request started.
    const entry: { promise: Promise<string>; expiresAt: number } = { promise: tokenPromise, expiresAt: Infinity };
    ServiceBase._implicitGrantCache.set(cacheKey, entry);

    tokenPromise.then(() => {
      entry.expiresAt = Date.now() + ttlMs;
    });

    // On failure remove from cache so the next call retries cleanly
    tokenPromise.catch(() => ServiceBase._implicitGrantCache.delete(cacheKey));

    return tokenPromise;
  }

  /** Clear the token cache — forces a fresh browser login on the next call. */
  static clearImplicitGrantTokenCache(): void {
    ServiceBase._implicitGrantCache.clear();
  }

  /**
   * Evict any cache entries whose token has already expired.
   * Call this manually to free memory in long-running processes.
   */
  static evictExpiredImplicitGrantTokens(): void {
    const now = Date.now();
    for (const [key, entry] of ServiceBase._implicitGrantCache) {
      if (now >= entry.expiresAt) {
        ServiceBase._implicitGrantCache.delete(key);
      }
    }
  }

  private static async _fetchImplicitToken({
    logger,
    tokenUrl,
    clientId,
    scope,
    callbackUrl,
    username,
    password,
    usernameSelector = 'input[name="Input.Username"], input[name="Username"], input[name="UserName"], input[name="username"], input#userNameInput',
    passwordSelector = 'input[name="Input.Password"], input[name="Password"], input[name="password"], input[type="password"], input#passwordInput',
    submitSelector = 'button[value="login"], button[type="submit"], input[type="submit"], span.submit, span#submitButton',
  }: ImplicitTokenRequest): Promise<string> {
    const authorizeUrl =
      `${tokenUrl}?response_type=token` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(callbackUrl)}` +
      (scope ? `&scope=${encodeURIComponent(scope)}` : '');

    //logger.info('[OAuth2 Implicit] Authorize URL: {}', authorizeUrl);

    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page    = await context.newPage();

      let accessToken: string | undefined;

      page.on('request', req => {
        const url = req.url();
        if (url.startsWith(callbackUrl)) {
          const fragment = url.split('#')[1] ?? '';
          const params   = new URLSearchParams(fragment);
          accessToken    = params.get('access_token') ?? undefined;
        }
      });

      await page.goto(authorizeUrl, { waitUntil: 'domcontentloaded' });

      await page.fill(usernameSelector, username);
      await page.fill(passwordSelector, password);
      await page.click(submitSelector);

      await page.waitForURL(url => url.toString().startsWith(callbackUrl), { timeout: 12_000 }).catch(() => {});

      if (!accessToken) {
        const currentUrl = page.url();
        const fragment   = currentUrl.split('#')[1] ?? '';
        const params     = new URLSearchParams(fragment);
        accessToken      = params.get('access_token') ?? undefined;
      }

      if (!accessToken) {
        const finalUrl   = page.url();
        const pageTitle  = await page.title();
        throw new AuthenticationException(
          `Implicit grant: no access_token found in redirect.\n  Final URL: ${finalUrl}\n  Page title: ${pageTitle}\n  Hint: If still on the login page, check usernameSelector/passwordSelector options match your login form.`,
        );
      }

      logger.info('[OAuth2 Implicit] access_token obtained successfully');
      return accessToken;
    } finally {
      await browser.close();
    }
  }

  /**
   * Obtain an access_token via the OAuth2 Implicit Grant (browser-based flow)
   * and apply it as a Bearer token for all subsequent requests on this instance.
   *
   * Delegates to the static `ServiceBase.requestImplicitGrantToken()`.
   */
  async authenticateImplicitGrant(options: ImplicitGrantOptions = {}): Promise<this> {
    const token = await ServiceBase.requestImplicitGrantToken(options);
    return this.setBearerToken(token);
  }

  // ====================== REQUEST EXECUTION METHODS ======================

  sendGetRequest(endpoint: string): FluentResponse {
    return createFluentResponse(this.executeRequest('GET', endpoint));
  }

  sendPostRequest(endpoint: string): FluentResponse {
    return createFluentResponse(this.executeRequest('POST', endpoint));
  }

  sendPutRequest(endpoint: string): FluentResponse {
    return createFluentResponse(this.executeRequest('PUT', endpoint));
  }

  sendPatchRequest(endpoint: string): FluentResponse {
    return createFluentResponse(this.executeRequest('PATCH', endpoint));
  }

  sendDeleteRequest(endpoint: string): FluentResponse {
    return createFluentResponse(this.executeRequest('DELETE', endpoint));
  }

  private buildResolvedUrl(endpoint: string): string {
    const [rawEndpointPath, rawEndpointQuery = ''] = endpoint.split('?', 2);
    const consumedPathParamKeys = new Set<string>();
    let endpointPath = rawEndpointPath;
    for (const [key, value] of Object.entries(this._pathParams)) {
      const placeholder = `{${key}}`;
      if (!endpointPath.includes(placeholder)) continue;
      consumedPathParamKeys.add(key);
      endpointPath = endpointPath.replaceAll(placeholder, encodeURIComponent(value));
    }

    const appendedPathSegments = Object.entries(this._pathParams)
      .filter(([key]) => !consumedPathParamKeys.has(key))
      .map(([, value]) => encodeURIComponent(value));

    const normalizedBaseUri = trimTrailingSlashes(this._baseUri);
    const normalizedBasePath = trimSlashes(this._basePath);
    const normalizedEndpointPath = trimSlashes(endpointPath);

    const pathParts = [normalizedBaseUri, normalizedBasePath, normalizedEndpointPath, ...appendedPathSegments]
      .filter((part) => part.length > 0);

    let url = pathParts.join('/');
    if (!url && endpointPath.startsWith('/')) {
      url = '/';
    }

    const queryParams = new URLSearchParams(rawEndpointQuery);
    for (const [key, value] of Object.entries(this._queryParams)) {
      queryParams.append(key, value);
    }

    const queryString = queryParams.toString();
    return queryString ? `${url}?${queryString}` : url;
  }

  private async executeRequest(method: string, endpoint: string): Promise<this> {
    const url = this.buildResolvedUrl(endpoint);

    // Consolidated request log
    const logLines: string[] = [`Sending ${method} Request using Url: ${url}`];

    if (Object.keys(this._queryParams).length > 0) {
      const qpStr = Object.entries(this._queryParams).map(([k, v]) => `${k}=${v}`).join(', ');
      logLines.push(`      Query Params: ${qpStr}`);
    }
    if (Object.keys(this._pathParams).length > 0) {
      const ppStr = Object.entries(this._pathParams).map(([k, v]) => `${k}=${v}`).join(', ');
      logLines.push(`      Path Params: ${ppStr}`);
    }
    if (this._body !== undefined) {
      const payload = typeof this._body === 'string' ? this._body : JSON.stringify(this._body);
      logLines.push(`      Request Body: ${payload}`);
    }
    if (!this._suppressRequestLog) {
      this.loggerService.info(logLines.join('\n'));
    }

    const suppressLog = this._suppressRequestLog;

    try {
      // Create Pactum spec
      let pactumSpec = this.createRequestSpec(method, url);

      // Apply headers
      if (Object.keys(this._headers).length > 0) {
        pactumSpec = pactumSpec.withHeaders(this._headers);
      }

      // Apply body
      if (this._body !== undefined) {
        if (this._contentType === 'application/x-www-form-urlencoded') {
          pactumSpec = pactumSpec.withForm(this._body as Record<string, string>);
        } else {
          pactumSpec = pactumSpec.withBody(this._body);
        }
      }

      // Apply configured request timeout
      const timeoutMs = Number.parseInt(ConfigResolver.resolveOrDefault('api.timeout', '20000'), 10);
      pactumSpec = pactumSpec.withRequestTimeout(timeoutMs);

      // Execute
      const response = await pactumSpec.toss();

      // Capture response
      this._responseStatusCode = response.statusCode;
      this._responseBody = response.body;
      this._responseBodyText =
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
      this._responseHeaders = (response.headers ?? {}) as Record<string, string>;
      this._responseTime = response.responseTime ?? 0;

      // Auto-log status code and response body to console, log files, and report
      const singleLineBody = this.toSingleLineBody(this._responseBodyText) || 'No Response available';
      if (!this._suppressResponseBodyLog) {
        this.loggerService.info(Messages.STATUS_CODE_AND_RESPONSE_BODY, this._responseStatusCode, singleLineBody);
      }
      const testId = this.loggerService.getTestId();
      if (testId) {
        const requestLog = {
          method,
          url,
          statusCode: this._responseStatusCode,
          responseBody: singleLineBody,
          timestamp: new Date().toISOString(),
        };
        JsonReporter.recordRequest(testId, requestLog);
        JunitReporter.recordRequest(testId, requestLog);
      }
    } catch (err) {
      throw new Error(`${method} request to ${url} failed: ${(err as Error).message}`);
    } finally {
      this.resetRequestSpec();
      this._suppressRequestLog = suppressLog; // preserve for validateStatusCode()
    }

    return this;
  }

  private createRequestSpec(method: string, url: string): ReturnType<typeof spec> {
    const requestSpec = spec();
    switch (method) {
      case 'POST': return requestSpec.post(url);
      case 'PUT': return requestSpec.put(url);
      case 'PATCH': return requestSpec.patch(url);
      case 'DELETE': return requestSpec.delete(url);
      default: return requestSpec.get(url);
    }
  }

  // ====================== RESPONSE VALIDATION METHODS ======================

  validateStatusCode(expectedStatusCode: number): this {
    if (this._responseStatusCode !== expectedStatusCode) {
      this.loggerService.info(Messages.RESPONSE_STATUS_CODE, expectedStatusCode, this._responseStatusCode);
      throw new Error(
        Messages.EXPECTED_STATUS_CODE + expectedStatusCode + Messages.BUT_GOT + this._responseStatusCode,
      );
    }
    if (!this._suppressRequestLog) {
      this.loggerService.info(Messages.STATUS_CODE_VALIDATION_PASSED, expectedStatusCode, this._responseStatusCode);
    }
    return this;
  }

  validateResponseContains(expectedText: string): this {
    if (this._responseBodyText?.includes(expectedText)) {
      this.loggerService.info(Messages.VALIDATING_RESPONSE_CONTAINS, expectedText);
      return this;
    }
    throw new Error(Messages.RESPONSE_DOES_NOT_CONTAIN + expectedText);
  }

  validateResponseNotContains(unexpectedText: string): this {
    if (this._responseBodyText && !this._responseBodyText.includes(unexpectedText)) {
      this.loggerService.info(Messages.VALIDATING_RESPONSE_NOT_CONTAINS, unexpectedText);
      return this;
    }
    throw new Error(Messages.RESPONSE_CONTAINS_UNEXPECTED + unexpectedText);
  }

  validateContentType(expectedContentType: string): this {
    const actualContentType = this._responseHeaders['content-type'] || '';
    this.loggerService.info(Messages.VALIDATING_CONTENT_TYPE, expectedContentType, actualContentType);
    if (actualContentType.includes(expectedContentType)) {
      return this;
    }
    throw new Error(Messages.EXPECTED_CONTENT_TYPE + expectedContentType + Messages.BUT_GOT + actualContentType);
  }

  validateResponseNotEmpty(): this {
    if (!this._responseBodyText) {
      throw new Error(Messages.RESPONSE_BODY_EMPTY);
    }
    this.loggerService.info(Messages.RESPONSE_BODY_NOT_EMPTY);
    return this;
  }

  validateResponseEmpty(): this {
    if (this._responseBodyText) {
      throw new Error(Messages.RESPONSE_BODY_NOT_EMPTY_ASSERT);
    }
    this.loggerService.info(Messages.RESPONSE_BODY_IS_EMPTY);
    return this;
  }

  /**
   * Validate response body against a JSON Schema file.
   * Uses Ajv for validation.
   */
  validateJsonSchema(schemaPath: string): this {
    const resolvedPath = PathUtils.resolveSchemaPath(schemaPath);

    if (!resolvedPath || !PathUtils.exists(resolvedPath)) {
      throw new ValidationException(`JSON Schema file not found: ${schemaPath}`);
    }

    const schemaContent = fs.readFileSync(resolvedPath, 'utf-8');
    const schema = JSON.parse(schemaContent);

    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const valid = validate(this._responseBody);

    if (!valid) {
      const errors = ajv.errorsText(validate.errors);
      throw new ValidationException(`JSON Schema validation failed: ${errors}`);
    }

    this.loggerService.info('✓ JSON Schema validation passed');
    return this;
  }

  // ====================== RESPONSE EXTRACTION METHODS ======================

  /**
   * Extract a value from the response body using a dot-notation path.
   */
  extractFromResponse<T = unknown>(jsonPath: string): T {
    this.loggerService.info(Messages.EXTRACTING_VALUE_FROM_RESPONSE, jsonPath);
    return this.getNestedValue(this._responseBody, jsonPath) as T;
  }

  extractStringFromResponse(jsonPath: string): string {
    const value = this.extractFromResponse<string>(jsonPath);
    this.loggerService.info(Messages.EXTRACTED_STRING_VALUE, value);
    return value;
  }

  extractIntegerFromResponse(jsonPath: string): number {
    const value = this.extractFromResponse<number>(jsonPath);
    this.loggerService.info(Messages.EXTRACTED_INTEGER_VALUE, value);
    return value;
  }

  extractListFromResponse<T = unknown>(jsonPath: string): T[] {
    const value = this.extractFromResponse<T[]>(jsonPath);
    this.loggerService.info(Messages.EXTRACTED_LIST_WITH_ELEMENTS, value?.length ?? 0);
    return value;
  }

  /**
   * Extract the full response body as a JSON object.
   * Replaces REST Assured's extractJsonPath().
   */
  extractJsonPath(): Record<string, unknown> {
    this.loggerService.info(Messages.EXTRACTING_JSON_PATH);
    return this._responseBody as Record<string, unknown>;
  }

  /**
   * Get the response body typed to a specific interface.
   */
  getResponseBody<T = unknown>(): T {
    return this._responseBody as T;
  }

  /**
   * Get a response header value.
   */
  getResponseHeader(headerName: string): string | undefined {
    const value = this._responseHeaders[headerName.toLowerCase()];
    this.loggerService.info(Messages.RESPONSE_HEADER, headerName, value);
    return value;
  }

  /**
   * Get the full captured response.
   */
  getResponse(): CapturedResponse {
    return {
      statusCode: this._responseStatusCode,
      body: this._responseBody,
      bodyText: this._responseBodyText,
      headers: this._responseHeaders,
      responseTime: this._responseTime,
    };
  }

  // ====================== LOGGING HELPER METHODS ======================

  clearRequestSpec(): this {
   // this.loggerService.info(Messages.CLEARING_REQUEST_SPEC);
    this.resetRequestSpec();
    return this;
  }

  logAll(): this {
    if (!this._responseBody) {
      this.loggerService.info(Messages.NO_RESPONSE_TO_LOG);
      return this;
    }
    this.loggerService.info(Messages.LOGGING_ALL_REQUEST_AND_RESPONSE);
    this.loggerService.info(Messages.BASE_URI, this._baseUri);
    this.loggerService.info(Messages.STATUS_CODE_AND_RESPONSE_BODY, this._responseStatusCode, this._responseBodyText);
    return this;
  }

  logBody(): this {
    if (!this._responseBody) {
      this.loggerService.info(Messages.NO_RESPONSE_TO_LOG_BODY);
      return this;
    }
    this.loggerService.info(Messages.RESPONSE_BODY, this._responseBodyText);
    return this;
  }

  logHeaders(): this {
    if (!this._responseHeaders) {
      this.loggerService.info(Messages.NO_RESPONSE_TO_LOG_HEADERS);
      return this;
    }
    this.loggerService.info(Messages.RESPONSE_HEADERS, JSON.stringify(this._responseHeaders));
    return this;
  }

  logRequest(): this {
    this.loggerService.info(Messages.LOGGING_REQUEST_DETAILS);
    this.loggerService.info(Messages.BASE_URI, this._baseUri);
    this.loggerService.info(Messages.BASE_PATH, this._basePath);
    return this;
  }

  logResponse(): this {
    this.loggerService.info(Messages.LOGGING_RESPONSE_DETAILS);
    this.loggerService.info(Messages.STATUS_CODE_AND_RESPONSE_BODY, this._responseStatusCode, this._responseBodyText);
    return this;
  }

  printPrettyResponse(): this {
    if (!this._responseBodyText) {
      this.loggerService.info(Messages.NO_RESPONSE_BODY_TO_PRETTY_PRINT);
      return this;
    }

    if (!this.isJsonResponse()) {
      this.loggerService.info(Messages.RESPONSE_IS_NOT_JSON_FORMAT);
      let body = this._responseBodyText.replace(/\s+/g, ' ').trim();
      if (body.length > 2000) {
        body = body.substring(0, 2000) + '... [truncated]';
      }
      this.loggerService.info(body);
      return this;
    }

    try {
      const pretty = JSON.stringify(this._responseBody, null, 2);
      this.loggerService.info(Messages.STATUS_CODE_AND_RESPONSE_BODY, this._responseStatusCode, pretty);
    } catch {
      this.loggerService.info(Messages.COULD_NOT_PRETTY_PRINT);
      this.loggerService.info(
        Messages.STATUS_CODE_AND_RESPONSE_BODY_NON_JSON,
        this._responseStatusCode,
        this._responseBodyText,
      );
    }

    return this;
  }

  // ====================== PRIVATE HELPERS ======================

  /**
   * Resolve the path to a Chrome/Chromium executable already installed on the machine.
   * Checks common locations on Windows, macOS, and Linux in order.
   * Returns undefined when none is found — playwright will use its own bundled Chromium.
   */
  private static resolveChromePath(): string | undefined {
    const candidates: string[] = [];

    if (process.platform === 'win32') {
      const localAppData  = process.env['LOCALAPPDATA']  ?? '';
      const programFiles  = process.env['PROGRAMFILES']  ?? String.raw`C:\Program Files`;
      const programFiles86 = process.env['PROGRAMFILES(X86)'] ?? String.raw`C:\Program Files (x86)`;
      candidates.push(
        String.raw`${localAppData}\Google\Chrome\Application\chrome.exe`,
        String.raw`${programFiles}\Google\Chrome\Application\chrome.exe`,
        String.raw`${programFiles86}\Google\Chrome\Application\chrome.exe`,
        String.raw`${localAppData}\Chromium\Application\chrome.exe`,
        String.raw`${programFiles}\Chromium\Application\chrome.exe`,
      );
    } else if (process.platform === 'darwin') {
      candidates.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      );
    } else {
      // Linux
      candidates.push(
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
      );
    }

    return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  }

  private resetRequestSpec(): void {
    this._headers = {};
    this._queryParams = {};
    this._pathParams = {};
    this._body = undefined;
    this._contentType = undefined;
    this._suppressResponseBodyLog = false;
    this._suppressRequestLog = false;
    // NOTE: baseUri and basePath are preserved (same as Java version)
  }

  private isJsonResponse(): boolean {
    if (!this._responseBodyText) return false;
    const trimmed = this._responseBodyText.trim();
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'));
  }

  private toSingleLineBody(bodyText: string): string {
    if (!bodyText) return bodyText;

    const trimmed = bodyText.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        // Compact JSON into one line for consistent request/response logging.
        return JSON.stringify(JSON.parse(trimmed));
      } catch {
        // Fall through to whitespace compaction when body is not valid JSON.
      }
    }

    return bodyText.replace(/\r?\n|\r/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  /**
   * Access nested value from object using dot-notation path.
   * Example: getNestedValue(obj, 'jokes.categories') => obj.jokes.categories
   */
  private getNestedValue(obj: unknown, path: string): unknown {
    if (obj == null) return undefined;
    return path.split('.').reduce((current: unknown, key: string) => {
      if (current == null) return undefined;
      if (typeof current === 'object') {
        return (current as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
  }
}
