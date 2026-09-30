import { Duration } from '../utils/Duration.js';

/**
 * Framework-wide timeout constants.
 * Ported from Java Timeouts.java.
 */
export const Timeouts = {
  /** Default script/request timeout */
  SCRIPT_TIMEOUT: Duration.ofSeconds(20),

  /** Default polling interval */
  POLLING_INTERVAL: Duration.ofMillis(500),

  /** Default retry count */
  RETRY_COUNT: 2,
} as const;
