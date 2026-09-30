export class AuthenticationException extends Error {
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'AuthenticationException';
    if (cause) {
      this.cause = cause;
    }
  }
}
