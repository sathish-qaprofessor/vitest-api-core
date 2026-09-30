/**
 * Simple Duration utility (replaces java.time.Duration).
 */
export class Duration {
  private constructor(private readonly ms: number) {}

  static ofMillis(ms: number): Duration {
    return new Duration(ms);
  }

  static ofSeconds(seconds: number): Duration {
    return new Duration(seconds * 1000);
  }

  static ofMinutes(minutes: number): Duration {
    return new Duration(minutes * 60 * 1000);
  }

  toMillis(): number {
    return this.ms;
  }

  toSeconds(): number {
    return this.ms / 1000;
  }

  static between(start: number, end: number): Duration {
    return new Duration(end - start);
  }
}
