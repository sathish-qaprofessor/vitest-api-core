/**
 * Configuration model for all OAuth2 authentication grant types.
 * Builder pattern with static factory methods per grant type.
 * Ported from Java OAuth2Config.java.
 *
 * Supported grant types:
 * - client_credentials — Machine-to-machine
 * - password — Resource Owner Password Credentials
 * - authorization_code — Auth code exchange
 * - refresh_token — Token refresh
 * - custom — Any custom grant type
 *
 * Usage:
 * ```ts
 * const config = OAuth2Config.clientCredentials(
 *   'https://auth.example.com/token', 'myClientId', 'mySecret'
 * ).scope('read write').audience('https://api.example.com');
 *
 * await service().authenticateOAuth2(config).sendGetRequest('/resource');
 * ```
 */
export interface OAuth2ConfigOptions {
  tokenUrl: string;
  grantType: string;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  scope?: string;
  audience?: string;
  redirectUri?: string;
  authorizationCode?: string;
  refreshToken?: string;
  resource?: string;
  additionalParams?: Record<string, string>;
}

/**
 * Options for the OAuth2 Implicit Grant flow.
 * All fields are optional — missing values are resolved from config (auth.*).
 */
export interface ImplicitGrantOptions {
  /** Base URL of the /authorize endpoint (e.g. https://auth.example.com/connect/authorize) */
  tokenUrl?: string;
  clientId?: string;
  scope?: string;
  /** Redirect/callback URI registered with the authorization server */
  callbackUrl?: string;
  username?: string;
  password?: string;
  /**
   * CSS selector for the username input.
   * Defaults to IdentityServer 4/Duende pattern: 'input[name="Input.Username"]'
   * Override when your login page uses different field names.
   */
  /** Token lifetime in minutes. Cached token is refreshed after this duration. Defaults to auth.tokenTtlMinutes config or 60. */
  tokenTtlMinutes?: number;
  usernameSelector?: string;
  /**
   * CSS selector for the password input.
   * Defaults to IdentityServer 4/Duende pattern: 'input[name="Input.Password"]'
   */
  passwordSelector?: string;
  /**
   * CSS selector for the submit button.
   * Defaults to 'button[value="login"], button[type="submit"], input[type="submit"]'
   */
  submitSelector?: string;
}

export class OAuth2Config {
  private _tokenUrl: string = '';
  private _grantType: string = '';
  private _clientId?: string;
  private _clientSecret?: string;
  private _username?: string;
  private _password?: string;
  private _scope?: string;
  private _audience?: string;
  private _redirectUri?: string;
  private _authorizationCode?: string;
  private _refreshToken?: string;
  private _resource?: string;
  private _additionalParams: Record<string, string> = {};

  private constructor() {}

  // ====================== FACTORY METHODS ======================

  static clientCredentials(tokenUrl: string, clientId: string, clientSecret: string): OAuth2Config {
    const config = new OAuth2Config();
    config._tokenUrl = tokenUrl;
    config._grantType = 'client_credentials';
    config._clientId = clientId;
    config._clientSecret = clientSecret;
    return config;
  }

  static passwordGrant(
    tokenUrl: string,
    clientId: string,
    clientSecret: string,
    username: string,
    password: string,
  ): OAuth2Config {
    const config = new OAuth2Config();
    config._tokenUrl = tokenUrl;
    config._grantType = 'password';
    config._clientId = clientId;
    config._clientSecret = clientSecret;
    config._username = username;
    config._password = password;
    return config;
  }

  static authorizationCode(
    tokenUrl: string,
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): OAuth2Config {
    const config = new OAuth2Config();
    config._tokenUrl = tokenUrl;
    config._grantType = 'authorization_code';
    config._clientId = clientId;
    config._clientSecret = clientSecret;
    config._authorizationCode = code;
    config._redirectUri = redirectUri;
    return config;
  }

  static refreshToken(
    tokenUrl: string,
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): OAuth2Config {
    const config = new OAuth2Config();
    config._tokenUrl = tokenUrl;
    config._grantType = 'refresh_token';
    config._clientId = clientId;
    config._clientSecret = clientSecret;
    config._refreshToken = refreshToken;
    return config;
  }

  static from(options: OAuth2ConfigOptions): OAuth2Config {
    const config = new OAuth2Config();
    config._tokenUrl = options.tokenUrl;
    config._grantType = options.grantType;
    config._clientId = options.clientId;
    config._clientSecret = options.clientSecret;
    config._username = options.username;
    config._password = options.password;
    config._scope = options.scope;
    config._audience = options.audience;
    config._redirectUri = options.redirectUri;
    config._authorizationCode = options.authorizationCode;
    config._refreshToken = options.refreshToken;
    config._resource = options.resource;
    if (options.additionalParams) {
      config._additionalParams = { ...options.additionalParams };
    }
    return config;
  }

  static custom(tokenUrl: string, grantType: string): OAuth2Config {
    const config = new OAuth2Config();
    config._tokenUrl = tokenUrl;
    config._grantType = grantType;
    return config;
  }

  // ====================== BUILDER METHODS ======================

  scope(scope: string): this {
    this._scope = scope;
    return this;
  }

  audience(audience: string): this {
    this._audience = audience;
    return this;
  }

  resource(resource: string): this {
    this._resource = resource;
    return this;
  }

  clientId(clientId: string): this {
    this._clientId = clientId;
    return this;
  }

  clientSecret(clientSecret: string): this {
    this._clientSecret = clientSecret;
    return this;
  }

  username(username: string): this {
    this._username = username;
    return this;
  }

  password(password: string): this {
    this._password = password;
    return this;
  }

  redirectUri(redirectUri: string): this {
    this._redirectUri = redirectUri;
    return this;
  }

  authorizationCode(code: string): this {
    this._authorizationCode = code;
    return this;
  }

  refreshTokenValue(refreshToken: string): this {
    this._refreshToken = refreshToken;
    return this;
  }

  additionalParam(key: string, value: string): this {
    this._additionalParams[key] = value;
    return this;
  }

  private addGrantParams(params: Record<string, string>): void {
    if (this._grantType === 'password') {
      if (this._username) params['username'] = this._username;
      if (this._password) params['password'] = this._password;
    } else if (this._grantType === 'authorization_code') {
      if (this._authorizationCode) params['code'] = this._authorizationCode;
      if (this._redirectUri) params['redirect_uri'] = this._redirectUri;
    } else if (this._grantType === 'refresh_token' && this._refreshToken) {
      params['refresh_token'] = this._refreshToken;
    }
  }

  // ====================== BUILD TOKEN REQUEST FORM PARAMS ======================

  buildFormParams(): Record<string, string> {
    const params: Record<string, string> = {};

    params['grant_type'] = this._grantType;

    if (this._clientId) params['client_id'] = this._clientId;
    if (this._clientSecret) params['client_secret'] = this._clientSecret;
    if (this._scope) params['scope'] = this._scope;
    if (this._audience) params['audience'] = this._audience;
    if (this._resource) params['resource'] = this._resource;

    this.addGrantParams(params);

    Object.assign(params, this._additionalParams);
    return params;
  }

  // ====================== GETTERS ======================

  get tokenUrl(): string {
    return this._tokenUrl;
  }

  get grantType(): string {
    return this._grantType;
  }

  getClientId(): string | undefined {
    return this._clientId;
  }

  getScope(): string | undefined {
    return this._scope;
  }

  getAudience(): string | undefined {
    return this._audience;
  }
}
