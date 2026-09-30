export class ValidationException extends Error {
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'ValidationException';
    if (cause) {
      this.cause = cause;
    }
  }
}
