/**
 * Refactored TurboLogger Core
 * Improved architecture with better separation of concerns
 */

import { AsyncLocalStorage } from 'async_hooks';
import { hostname } from 'os';
import { EventEmitter } from 'events';

import { TurboLoggerConfig, validateConfig, createDefaultConfig } from '../config/schema';
import { DIContainer } from '../di/container';
import { TurboLoggerError, ErrorHandler, errorHandler } from '../errors';
import { OptimizedCircularBuffer } from '../buffers/pool';

export enum LogLevel {
  TRACE = 10,
  DEBUG = 20,
  INFO = 30,
  WARN = 40,
  ERROR = 50,
  FATAL = 60,
}

export const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.TRACE]: 'trace',
  [LogLevel.DEBUG]: 'debug',
  [LogLevel.INFO]: 'info',
  [LogLevel.WARN]: 'warn',
  [LogLevel.ERROR]: 'error',
  [LogLevel.FATAL]: 'fatal',
};

export type LogLevelName = keyof typeof LOG_LEVEL_NAMES;

export interface LogEntry {
  level: LogLevel;
  levelName: string;
  message?: string;
  timestamp: number;
  context?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
    cause?: unknown;
  };
  metadata: {
    hostname?: string;
    pid?: number;
    name?: string;
    requestId?: string;
    traceId?: string;
    spanId?: string;
  };
}

export interface Transport {
  name: string;
  write(entry: LogEntry): Promise<void>;
  writeBatch(entries: LogEntry[]): Promise<void>;
  isHealthy(): boolean;
  getStats(): Record<string, unknown>;
  destroy(): Promise<void>;
}

export interface LoggerPlugin {
  name: string;
  init(logger: TurboLoggerCore): void | Promise<void>;
  beforeLog?(entry: LogEntry): LogEntry | Promise<LogEntry>;
  afterLog?(entry: LogEntry): void | Promise<void>;
  destroy?(): void | Promise<void>;
}

/**
 * Core Logger Implementation
 */
export class TurboLoggerCore extends EventEmitter {
  private config: TurboLoggerConfig;
  private context: Record<string, unknown> = {};
  private transports = new Map<string, Transport>();
  private plugins = new Map<string, LoggerPlugin>();
  private buffer: OptimizedCircularBuffer<LogEntry>;
  private asyncStorage = new AsyncLocalStorage<Record<string, unknown>>();
  private container: DIContainer;
  private errorHandler: ErrorHandler;
  private disposed = false;

  // Static metadata
  private static readonly defaultHostname = hostname();
  private static readonly defaultPid = process.pid;

  constructor(config: unknown = {}, container?: DIContainer) {
    super();
    
    this.config = validateConfig(config);
    this.container = container || new DIContainer();
    this.errorHandler = errorHandler;

    this.initializeBuffer();
    this.setupTransports();
    this.loadPlugins();

    // Register for cleanup
    process.once('beforeExit', () => this.dispose());
    process.once('SIGINT', () => this.dispose());
    process.once('SIGTERM', () => this.dispose());
  }

  /**
   * Initialize the buffer system
   */
  private initializeBuffer(): void {
    this.buffer = new OptimizedCircularBuffer<LogEntry>({
      size: this.config.performance.bufferSize,
      flushInterval: this.config.performance.flushInterval,
      useMemoryPool: this.config.performance.zeroAllocation,
      onFlush: async (entries) => this.flushEntries(entries),
      itemFactory: () => ({
        level: LogLevel.INFO,
        levelName: 'info',
        timestamp: 0,
        metadata: {},
      } as LogEntry),
      itemReset: (entry) => {
        // Reset entry for reuse
        (entry as LogEntry).level = LogLevel.INFO;
        (entry as LogEntry).levelName = 'info';
        (entry as LogEntry).message = undefined;
        (entry as LogEntry).timestamp = 0;
        (entry as LogEntry).context = undefined;
        (entry as LogEntry).error = undefined;
        Object.keys((entry as LogEntry).metadata).forEach(key => {
          delete (entry as LogEntry).metadata[key];
        });
      },
    });
  }

  /**
   * Setup transports based on configuration
   */
  private async setupTransports(): Promise<void> {
    try {
      for (const transportConfig of this.config.transports) {
        if (!transportConfig.enabled) continue;

        const transport = await this.createTransport(transportConfig);
        this.transports.set(transport.name, transport);
      }

      // Add default console transport if none configured
      if (this.transports.size === 0) {
        const consoleTransport = await this.createConsoleTransport();
        this.transports.set('console', consoleTransport);
      }
    } catch (error) {
      await this.errorHandler.handle(new TurboLoggerError(
        'Failed to setup transports',
        'TRANSPORT_SETUP_FAILED',
        'TRANSPORT',
        'HIGH',
        { cause: error as Error }
      ));
    }
  }

  /**
   * Create a transport instance
   */
  private async createTransport(config: any): Promise<Transport> {
    // This would be implemented based on transport type
    // For now, return a mock transport
    return {
      name: config.type,
      write: async () => {},
      writeBatch: async () => {},
      isHealthy: () => true,
      getStats: () => ({}),
      destroy: async () => {},
    };
  }

  /**
   * Create default console transport
   */
  private async createConsoleTransport(): Promise<Transport> {
    return {
      name: 'console',
      write: async (entry) => {
        const formatted = this.formatEntry(entry);
        process.stdout.write(formatted + '\n');
      },
      writeBatch: async (entries) => {
        const formatted = entries.map(entry => this.formatEntry(entry)).join('\n');
        process.stdout.write(formatted + '\n');
      },
      isHealthy: () => true,
      getStats: () => ({ name: 'console', healthy: true }),
      destroy: async () => {},
    };
  }

  /**
   * Format log entry for output
   */
  private formatEntry(entry: LogEntry): string {
    const timestamp = new Date(entry.timestamp).toISOString();
    const level = entry.levelName.toUpperCase().padEnd(5);
    const message = entry.message || '';
    
    let formatted = `[${timestamp}] ${level}: ${message}`;
    
    if (entry.context && Object.keys(entry.context).length > 0) {
      formatted += ` ${JSON.stringify(entry.context)}`;
    }
    
    if (entry.error) {
      formatted += `\n  Error: ${entry.error.message}`;
      if (entry.error.stack) {
        formatted += `\n  Stack: ${entry.error.stack}`;
      }
    }
    
    return formatted;
  }

  /**
   * Load and initialize plugins
   */
  private async loadPlugins(): Promise<void> {
    try {
      for (const pluginName of this.config.plugins) {
        if (this.container.has(pluginName)) {
          const plugin = await this.container.resolve<LoggerPlugin>(pluginName);
          await plugin.init?.(this);
          this.plugins.set(plugin.name, plugin);
        }
      }
    } catch (error) {
      await this.errorHandler.handle(new TurboLoggerError(
        'Failed to load plugins',
        'PLUGIN_LOAD_FAILED',
        'INTERNAL',
        'MEDIUM',
        { cause: error as Error }
      ));
    }
  }

  /**
   * Check if a log level should be processed
   */
  private shouldLog(level: LogLevel): boolean {
    const configuredLevel = this.getLevelValue(this.config.output.level);
    return level >= configuredLevel;
  }

  /**
   * Get numeric value for log level
   */
  private getLevelValue(levelName: string): LogLevel {
    switch (levelName) {
      case 'trace': return LogLevel.TRACE;
      case 'debug': return LogLevel.DEBUG;
      case 'info': return LogLevel.INFO;
      case 'warn': return LogLevel.WARN;
      case 'error': return LogLevel.ERROR;
      case 'fatal': return LogLevel.FATAL;
      default: return LogLevel.INFO;
    }
  }

  /**
   * Create a log entry
   */
  private createLogEntry(
    level: LogLevel,
    message?: string,
    context?: Record<string, unknown>,
    error?: Error
  ): LogEntry {
    const asyncContext = this.asyncStorage.getStore() || {};
    
    const entry: LogEntry = {
      level,
      levelName: LOG_LEVEL_NAMES[level],
      message,
      timestamp: Date.now(),
      context: { ...this.context, ...asyncContext, ...context },
      metadata: {
        ...(this.config.output.hostname && { hostname: TurboLoggerCore.defaultHostname }),
        ...(this.config.output.pid && { pid: TurboLoggerCore.defaultPid }),
        ...(this.config.name && { name: this.config.name }),
      },
    };

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        ...(this.config.output.stackTrace && { stack: error.stack }),
        ...(error.cause && { cause: error.cause }),
      };
    }

    return entry;
  }

  /**
   * Process log entry through plugins and write to buffer
   * FIX BUG-031: Proper error propagation and failure tracking
   */
  private async processLogEntry(entry: LogEntry): Promise<void> {
    try {
      // Run through beforeLog plugins
      let processedEntry = entry;
      for (const plugin of this.plugins.values()) {
        if (plugin.beforeLog) {
          try {
            processedEntry = await plugin.beforeLog(processedEntry);
          } catch (pluginError) {
            // Plugin errors should not prevent logging
            console.error(`beforeLog plugin failed:`, pluginError);
            // Emit error event for monitoring
            this.emit('plugin-error', {
              plugin: plugin.name || 'unknown',
              phase: 'beforeLog',
              error: pluginError
            });
          }
        }
      }

      // Write to buffer
      this.buffer.write(processedEntry);

      // Run through afterLog plugins
      for (const plugin of this.plugins.values()) {
        if (plugin.afterLog) {
          try {
            await plugin.afterLog(processedEntry);
          } catch (pluginError) {
            // afterLog errors should not prevent logging completion
            console.error(`afterLog plugin failed:`, pluginError);
            this.emit('plugin-error', {
              plugin: plugin.name || 'unknown',
              phase: 'afterLog',
              error: pluginError
            });
          }
        }
      }

      // Emit log event
      this.emit('log', processedEntry);

      // Force flush for fatal logs
      if (entry.level === LogLevel.FATAL) {
        await this.buffer.flush();
      }
    } catch (error) {
      // FIX BUG-031: Better error propagation
      const logError = new TurboLoggerError(
        'Failed to process log entry',
        'LOG_PROCESSING_FAILED',
        'INTERNAL',
        'MEDIUM',
        { cause: error as Error, entry }
      );

      // Emit error event for monitoring systems
      this.emit('error', logError);

      // Handle through error handler
      await this.errorHandler.handle(logError);

      // For fatal logs, rethrow to ensure caller knows about failure
      if (entry.level === LogLevel.FATAL) {
        console.error('[TurboLogger] FATAL log processing failed:', error);
        throw logError;
      }

      // Log to console as last resort (prevents silent failures)
      console.error('[TurboLogger] Log processing failed:', error);
    }
  }

  /**
   * Flush entries to transports
   */
  private async flushEntries(entries: LogEntry[]): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const transport of this.transports.values()) {
      if (transport.isHealthy()) {
        promises.push(
          transport.writeBatch(entries).catch(error => {
            this.errorHandler.handle(new TurboLoggerError(
              `Transport ${transport.name} write failed`,
              'TRANSPORT_WRITE_FAILED',
              'TRANSPORT',
              'MEDIUM',
              { 
                cause: error as Error,
                context: { transportName: transport.name }
              }
            ));
          })
        );
      }
    }

    await Promise.allSettled(promises);
  }

  // Public logging methods
  public trace(message?: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(LogLevel.TRACE)) return;
    const entry = this.createLogEntry(LogLevel.TRACE, message, context);
    this.processLogEntry(entry);
  }

  public debug(message?: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(LogLevel.DEBUG)) return;
    const entry = this.createLogEntry(LogLevel.DEBUG, message, context);
    this.processLogEntry(entry);
  }

  public info(message?: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(LogLevel.INFO)) return;
    const entry = this.createLogEntry(LogLevel.INFO, message, context);
    this.processLogEntry(entry);
  }

  public warn(message?: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(LogLevel.WARN)) return;
    const entry = this.createLogEntry(LogLevel.WARN, message, context);
    this.processLogEntry(entry);
  }

  public error(messageOrError?: string | Error, context?: Record<string, unknown>): void {
    if (!this.shouldLog(LogLevel.ERROR)) return;
    
    let message: string | undefined;
    let error: Error | undefined;
    
    if (messageOrError instanceof Error) {
      error = messageOrError;
      message = messageOrError.message;
    } else {
      message = messageOrError;
    }
    
    const entry = this.createLogEntry(LogLevel.ERROR, message, context, error);
    this.processLogEntry(entry);
  }

  public fatal(messageOrError?: string | Error, context?: Record<string, unknown>): void {
    if (!this.shouldLog(LogLevel.FATAL)) return;
    
    let message: string | undefined;
    let error: Error | undefined;
    
    if (messageOrError instanceof Error) {
      error = messageOrError;
      message = messageOrError.message;
    } else {
      message = messageOrError;
    }
    
    const entry = this.createLogEntry(LogLevel.FATAL, message, context, error);
    this.processLogEntry(entry);
  }

  /**
   * Create a child logger with additional context
   */
  public child(context: Record<string, unknown>): TurboLoggerCore {
    const childLogger = new TurboLoggerCore(this.config, this.container);
    childLogger.context = { ...this.context, ...context };
    return childLogger;
  }

  /**
   * Run a function with additional context
   */
  public withContext<T>(context: Record<string, unknown>, fn: () => T): T {
    const mergedContext = { ...this.asyncStorage.getStore(), ...context };
    return this.asyncStorage.run(mergedContext, fn);
  }

  /**
   * Add a transport
   */
  public addTransport(transport: Transport): void {
    this.transports.set(transport.name, transport);
  }

  /**
   * Remove a transport
   */
  public removeTransport(name: string): boolean {
    return this.transports.delete(name);
  }

  /**
   * Add a plugin
   */
  public async addPlugin(plugin: LoggerPlugin): Promise<void> {
    await plugin.init?.(this);
    this.plugins.set(plugin.name, plugin);
  }

  /**
   * Remove a plugin
   */
  public async removePlugin(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (plugin) {
      await plugin.destroy?.(this);
      return this.plugins.delete(name);
    }
    return false;
  }

  /**
   * Force flush all buffers
   */
  public async flush(): Promise<void> {
    await this.buffer.flush();
  }

  /**
   * Get logger statistics
   */
  public getStats(): Record<string, unknown> {
    return {
      buffer: this.buffer.getStats(),
      transports: Array.from(this.transports.values()).map(t => t.getStats()),
      plugins: Array.from(this.plugins.keys()),
      errorHandler: this.errorHandler.getMetrics(),
      config: {
        level: this.config.output.level,
        transportsCount: this.transports.size,
        pluginsCount: this.plugins.size,
      },
    };
  }

  /**
   * Dispose of the logger and cleanup resources
   */
  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    try {
      // Flush remaining entries
      await this.buffer.flush();

      // Destroy plugins
      for (const plugin of this.plugins.values()) {
        await plugin.destroy?.();
      }

      // Destroy transports
      for (const transport of this.transports.values()) {
        await transport.destroy();
      }

      // Cleanup buffer
      this.buffer.dispose();

      // Clear collections
      this.plugins.clear();
      this.transports.clear();

      this.emit('disposed');
    } catch (error) {
      console.error('Error during logger disposal:', error);
    }
  }
}

/**
 * Factory function to create logger instances
 */
export function createLogger(config?: unknown, container?: DIContainer): TurboLoggerCore {
  return new TurboLoggerCore(config, container);
}
