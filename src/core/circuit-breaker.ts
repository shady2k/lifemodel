import type { Logger } from '../types/index.js';

/**
 * Circuit breaker states.
 */
export enum CircuitState {
  /** Normal operation - requests go through */
  CLOSED = 'CLOSED',
  /** Failing - requests are rejected immediately */
  OPEN = 'OPEN',
  /** Testing - allowing one request through to test recovery */
  HALF_OPEN = 'HALF_OPEN',
}

/**
 * Circuit breaker configuration.
 */
export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit */
  maxFailures: number;
  /** Time in ms before attempting to close the circuit */
  resetTimeout: number;
  /** Timeout for individual operations in ms */
  timeout: number;
  /** Optional name for logging */
  name?: string;
  /** Optional logger */
  logger?: Logger;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  maxFailures: 3,
  resetTimeout: 30_000,
  timeout: 10_000,
};

/**
 * Circuit breaker error thrown when circuit is open.
 */
export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker "${name}" is open`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Timeout error thrown when operation exceeds timeout.
 */
export class TimeoutError extends Error {
  constructor(timeout: number) {
    super(`Operation timed out after ${String(timeout)}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Circuit breaker for protecting external calls.
 *
 * States:
 * - CLOSED: Normal operation, requests go through
 * - OPEN: Too many failures, requests rejected immediately
 * - HALF_OPEN: Testing if service recovered, one request allowed
 *
 * State transitions:
 * CLOSED -> OPEN: After maxFailures consecutive failures
 * OPEN -> HALF_OPEN: After resetTimeout
 * HALF_OPEN -> CLOSED: If test request succeeds
 * HALF_OPEN -> OPEN: If test request fails
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private lastFailureTime: number | null = null;
  private readonly config: CircuitBreakerConfig;
  private readonly name: string;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.name = this.config.name ?? 'unnamed';
  }

  /**
   * Get current circuit state.
   */
  getState(): CircuitState {
    // Check if we should transition from OPEN to HALF_OPEN
    if (this.state === CircuitState.OPEN && this.shouldAttemptReset()) {
      this.state = CircuitState.HALF_OPEN;
      this.log('info', 'Transitioning to HALF_OPEN');
    }
    return this.state;
  }

  /**
   * Execute an operation through the circuit breaker.
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    // Reject if circuit is open
    if (currentState === CircuitState.OPEN) {
      this.log('warn', 'Request rejected - circuit is open');
      throw new CircuitOpenError(this.name);
    }

    try {
      // Execute with timeout
      const result = await this.withTimeout(operation());
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Manually reset the circuit breaker.
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.lastFailureTime = null;
    this.log('info', 'Manually reset to CLOSED');
  }

  /**
   * Get circuit breaker stats.
   */
  getStats(): {
    state: CircuitState;
    failures: number;
    lastFailureTime: number | null;
  } {
    return {
      state: this.getState(),
      failures: this.failures,
      lastFailureTime: this.lastFailureTime,
    };
  }

  private shouldAttemptReset(): boolean {
    if (this.lastFailureTime === null) {
      return false;
    }
    return Date.now() - this.lastFailureTime >= this.config.resetTimeout;
  }

  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.log('info', 'Test request succeeded, closing circuit');
    }
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.lastFailureTime = null;
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      // Test request failed, open the circuit again
      this.state = CircuitState.OPEN;
      this.log('warn', 'Test request failed, reopening circuit');
    } else if (this.failures >= this.config.maxFailures) {
      // Too many failures, open the circuit
      this.state = CircuitState.OPEN;
      this.log('warn', `Opening circuit after ${String(this.failures)} failures`);
    }
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new TimeoutError(this.config.timeout));
      }, this.config.timeout);
    });

    return Promise.race([promise, timeoutPromise]);
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    if (this.config.logger) {
      this.config.logger[level]({ circuit: this.name, state: this.state }, message);
    }
  }
}

/**
 * Create a circuit breaker with the given configuration.
 */
export function createCircuitBreaker(config: Partial<CircuitBreakerConfig> = {}): CircuitBreaker {
  return new CircuitBreaker(config);
}
