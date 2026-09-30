export class ConfigurationException extends Error {
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'ConfigurationException';
    if (cause) {
      this.cause = cause;
    }
  }
}
