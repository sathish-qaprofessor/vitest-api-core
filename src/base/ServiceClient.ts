import { ServiceBase } from './ServiceBase.js';
import { LoggerService } from '../logger/LoggerService.js';

/**
 * Factory for creating ServiceBase instances per test.
 * 
 * In Vitest/Node, each worker is isolated. For thread-local
 * simulation we keep a single ServiceBase per ServiceClient instance.
 *
 * Ported from Java ServiceClient.java.
 */
export class ServiceClient {
  private service: ServiceBase | null = null;

  /**
   * Initialize a fresh ServiceBase instance.
   */
  initService(loggerService?: LoggerService): ServiceBase {
    this.service = new ServiceBase(loggerService);
    return this.service;
  }

  /**
   * Get the current ServiceBase instance.
   * Initializes one if not yet created.
   */
  getService(loggerService?: LoggerService): ServiceBase {
    if (!this.service) {
      return this.initService(loggerService);
    }
    return this.service;
  }

  /**
   * Clear the ServiceBase instance.
   */
  clearService(): void {
    this.service = null;
  }

  /**
   * Create a new ServiceBase, replacing any existing one.
   */
  createNewService(loggerService?: LoggerService): ServiceBase {
    this.clearService();
    return this.initService(loggerService);
  }
}
