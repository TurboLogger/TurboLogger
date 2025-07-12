/**
 * Comprehensive Error Handling System
 * Provides structured error handling with error codes, categories, and recovery strategies
 */

export enum ErrorCategory {
  CONFIGURATION = 'CONFIGURATION',
  TRANSPORT = 'TRANSPORT', 
  SERIALIZATION = 'SERIALIZATION',
  SECURITY = 'SECURITY',
  PERFORMANCE = 'PERFORMANCE',
  NETWORK = 'NETWORK',
  VALIDATION = 'VALIDATION',
  INTERNAL = 'INTERNAL',
}

export enum ErrorSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM', 
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export interface ErrorContext {
  timestamp: number;
  operation?: string;
  component?: string;
  metadata?: Record<string, unknown>;
  stackTrace?: string;
}

export interface RecoveryStrategy {
  name: string;
  description: string;
  execute: (error: TurboLoggerError) => Promise<void> | void;
}

export class TurboLoggerError extends Error {
  public readonly code: string;
  public readonly category: ErrorCategory;
  public readonly severity: ErrorSeverity;
  public readonly context: ErrorContext;
  public readonly recoverable: boolean;
  public readonly retryable: boolean;
  public readonly recoveryStrategies: RecoveryStrategy[];

  constructor(
    message: string,
    code: string,
    category: ErrorCategory,
    severity: ErrorSeverity = ErrorSeverity.MEDIUM,
    options: {
      cause?: Error;
      context?: Partial<ErrorContext>;
      recoverable?: boolean;
      retryable?: boolean;
      recoveryStrategies?: RecoveryStrategy[];
    } = {}
  ) {
    super(message, { cause: options.cause });
    
    this.name = 'TurboLoggerError';
    this.code = code;
    this.category = category;
    this.severity = severity;
    this.recoverable = options.recoverable ?? false;
    this.retryable = options.retryable ?? false;
    this.recoveryStrategies = options.recoveryStrategies || [];
    
    this.context = {
      timestamp: Date.now(),
      operation: options.context?.operation,
      component: options.context?.component,
      metadata: options.context?.metadata || {},
      stackTrace: this.stack,
    };

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TurboLoggerError);
    }
  }

  /**
   * Create a serializable representation of the error
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      severity: this.severity,
      recoverable: this.recoverable,
      retryable: this.retryable,
      context: this.context,
      stack: this.stack,
    };
  }

  /**
   * Check if error matches specific criteria
   */
  matches(criteria: {
    code?: string | RegExp;
    category?: ErrorCategory;
    severity?: ErrorSeverity;
  }): boolean {
    if (criteria.code) {
      if (typeof criteria.code === 'string' && this.code !== criteria.code) {
        return false;
      }
      if (criteria.code instanceof RegExp && !criteria.code.test(this.code)) {
        return false;
      }
    }

    if (criteria.category && this.category !== criteria.category) {
      return false;
    }

    if (criteria.severity && this.severity !== criteria.severity) {
      return false;
    }

    return true;
  }
}

// Specific error types
export class ConfigurationError extends TurboLoggerError {
  constructor(message: string, code: string, options?: Partial<ConstructorParameters<typeof TurboLoggerError>[4]>) {
    super(message, code, ErrorCategory.CONFIGURATION, ErrorSeverity.HIGH, options);
    this.name = 'ConfigurationError';
  }
}

export class TransportError extends TurboLoggerError {
  constructor(message: string, code: string, options?: Partial<ConstructorParameters<typeof TurboLoggerError>[4]>) {
    super(message, code, ErrorCategory.TRANSPORT, ErrorSeverity.MEDIUM, {
      ...options,
      retryable: true,
    });
    this.name = 'TransportError';
  }
}

export class SerializationError extends TurboLoggerError {
  constructor(message: string, code: string, options?: Partial<ConstructorParameters<typeof TurboLoggerError>[4]>) {
    super(message, code, ErrorCategory.SERIALIZATION, ErrorSeverity.MEDIUM, options);
    this.name = 'SerializationError';
  }
}

export class SecurityError extends TurboLoggerError {
  constructor(message: string, code: string, options?: Partial<ConstructorParameters<typeof TurboLoggerError>[4]>) {
    super(message, code, ErrorCategory.SECURITY, ErrorSeverity.CRITICAL, options);
    this.name = 'SecurityError';
  }
}

export class ValidationError extends TurboLoggerError {
  constructor(message: string, code: string, options?: Partial<ConstructorParameters<typeof TurboLoggerError>[4]>) {
    super(message, code, ErrorCategory.VALIDATION, ErrorSeverity.HIGH, options);
    this.name = 'ValidationError';
  }
}

/**
 * Error Handler with recovery strategies and metrics
 */
export interface ErrorHandlerOptions {
  enableRecovery?: boolean;
  enableMetrics?: boolean;
  maxRecoveryAttempts?: number;
  recoveryTimeout?: number;
  onError?: (error: TurboLoggerError, recovered: boolean) => void;
}

export class ErrorHandler {
  private options: Required<ErrorHandlerOptions>;
  private errorMetrics = new Map<string, {
    count: number;
    lastOccurrence: number;
    recoveryAttempts: number;
    recoverySuccesses: number;
  }>();

  constructor(options: ErrorHandlerOptions = {}) {
    this.options = {
      enableRecovery: options.enableRecovery ?? true,
      enableMetrics: options.enableMetrics ?? true,
      maxRecoveryAttempts: options.maxRecoveryAttempts ?? 3,
      recoveryTimeout: options.recoveryTimeout ?? 5000,
      onError: options.onError || (() => {}),
    };
  }

  /**
   * Handle an error with recovery strategies
   */
  async handle(error: TurboLoggerError): Promise<boolean> {
    // Update metrics
    if (this.options.enableMetrics) {
      this.updateMetrics(error);
    }

    // Attempt recovery if enabled and error is recoverable
    let recovered = false;
    if (this.options.enableRecovery && error.recoverable && error.recoveryStrategies.length > 0) {
      recovered = await this.attemptRecovery(error);
    }

    // Notify error handler
    this.options.onError(error, recovered);

    return recovered;
  }

  /**
   * Attempt recovery using available strategies
   */
  private async attemptRecovery(error: TurboLoggerError): Promise<boolean> {
    const metrics = this.errorMetrics.get(error.code);
    if (metrics && metrics.recoveryAttempts >= this.options.maxRecoveryAttempts) {
      return false; // Max attempts reached
    }

    for (const strategy of error.recoveryStrategies) {
      try {
        await Promise.race([
          strategy.execute(error),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Recovery timeout')), this.options.recoveryTimeout)
          ),
        ]);

        // Recovery successful
        if (metrics) {
          metrics.recoverySuccesses++;
        }
        return true;
      } catch (recoveryError) {
        // Recovery failed, try next strategy
        if (metrics) {
          metrics.recoveryAttempts++;
        }
        continue;
      }
    }

    return false; // All recovery strategies failed
  }

  /**
   * Update error metrics
   */
  private updateMetrics(error: TurboLoggerError): void {
    const existing = this.errorMetrics.get(error.code);
    if (existing) {
      existing.count++;
      existing.lastOccurrence = Date.now();
    } else {
      this.errorMetrics.set(error.code, {
        count: 1,
        lastOccurrence: Date.now(),
        recoveryAttempts: 0,
        recoverySuccesses: 0,
      });
    }
  }

  /**
   * Get error metrics
   */
  getMetrics(): Record<string, unknown> {
    const metrics: Record<string, unknown> = {};
    for (const [code, data] of this.errorMetrics) {
      metrics[code] = { ...data };
    }
    return metrics;
  }

  /**
   * Clear metrics
   */
  clearMetrics(): void {
    this.errorMetrics.clear();
  }
}

// Recovery strategies
export const RecoveryStrategies = {
  retryAfterDelay: (delay: number): RecoveryStrategy => ({
    name: 'retryAfterDelay',
    description: `Retry after ${delay}ms delay`,
    execute: () => new Promise(resolve => setTimeout(resolve, delay)),
  }),

  fallbackTransport: (fallbackTransport: unknown): RecoveryStrategy => ({
    name: 'fallbackTransport',
    description: 'Switch to fallback transport',
    execute: (error) => {
      // Implementation would switch to fallback transport
      console.log(`Switching to fallback transport for error: ${error.code}`);
    },
  }),

  clearBuffer: (): RecoveryStrategy => ({
    name: 'clearBuffer',
    description: 'Clear buffer to prevent memory issues',
    execute: (error) => {
      // Implementation would clear relevant buffers
      console.log(`Clearing buffer for error: ${error.code}`);
    },
  }),

  gracefulDegradation: (): RecoveryStrategy => ({
    name: 'gracefulDegradation',
    description: 'Reduce logging level or disable features',
    execute: (error) => {
      // Implementation would reduce functionality
      console.log(`Graceful degradation for error: ${error.code}`);
    },
  }),
};

// Global error handler instance
export const errorHandler = new ErrorHandler();
