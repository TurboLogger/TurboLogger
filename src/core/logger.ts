// import { TurboSerializer } from './serializer'; // Not used in zero-dependency mode
import { MultiLevelBuffer, CircularBufferOptions } from './buffer';
import { Transport, TransportOptions, ConsoleTransport } from './transport';
import { LogAggregator, LogData as AggregatorLogData } from '../analytics/aggregation';
import { NativeOptimizer, SerializableObject } from '../performance/native-optimizer';
import { LogClassifier } from '../ml/log-classifier';
import { hostname } from 'os';
import { AsyncLocalStorage } from 'async_hooks';

export interface LogLevel {
  value: number;
  label: string;
}

export const LOG_LEVELS = {
  trace: { value: 10, label: 'trace' },
  debug: { value: 20, label: 'debug' },
  info: { value: 30, label: 'info' },
  warn: { value: 40, label: 'warn' },
  error: { value: 50, label: 'error' },
  fatal: { value: 60, label: 'fatal' }
} as const;

export type LogLevelName = keyof typeof LOG_LEVELS;

export interface TurboLoggerOptions {
  performance?: {
    mode?: 'standard' | 'fast' | 'ultra';
    bufferSize?: number;
    flushInterval?: number;
    zeroAllocation?: boolean;
  };
  output?: {
    format?: 'json' | 'structured' | 'compact';
    destination?: NodeJS.WritableStream;
    level?: LogLevelName;
    timestamp?: boolean;
    hostname?: boolean;
    pid?: boolean;
  };
  observability?: {
    metrics?: boolean;
    traces?: boolean;
    opentelemetry?: boolean;
    prometheus?: {
      enabled: boolean;
      port?: number;
      endpoint?: string;
    };
  };
  cloud?: {
    kubernetes?: boolean;
    prometheus?: boolean;
    jaeger?: boolean;
    costTracking?: boolean;
    serviceDiscovery?: boolean;
  };
  security?: {
    encryption?: string;
    signing?: boolean;
    piiMasking?: {
      enabled: boolean;
      autoDetect?: boolean;
      rules?: Array<{ field?: string; pattern?: RegExp; mask: string }>;
    };
    compliance?: string[];
  };
  dev?: {
    realtime?: boolean;
    sourceMap?: boolean;
    stackTrace?: boolean;
    ide?: string;
    hotReload?: boolean;
    debugger?: boolean;
  };
  name?: string;
  context?: Record<string, unknown>;
  transports?: Transport[];
  errorHandler?: (error: Error, context: string) => void;
}

interface LogObject {
  level: number;
  levelLabel: string;
  msg?: string;
  time: number;
  hostname?: string;
  pid?: number;
  name?: string;
  [key: string]: unknown;
}

const asyncLocalStorage = new AsyncLocalStorage<Record<string, unknown>>();

export class TurboLogger {
  private options: Required<TurboLoggerOptions>;
  private buffer: MultiLevelBuffer<LogObject>;
  private transports: Transport[] = [];
  private context: Record<string, unknown> = {};
  private name?: string;
  private aggregator?: LogAggregator;
  private nativeOptimizer?: NativeOptimizer;
  private classifier?: LogClassifier;
  private pendingFlushes?: Array<Promise<void>>; // FIX BUG-034: Track pending fatal log flushes
  private static defaultHostname = hostname();
  private static defaultPid = process.pid;

  constructor(options: TurboLoggerOptions = {}) {
    this.options = this.mergeOptions(options);
    this.name = options.name;
    this.context = options.context || {};
    
    this.buffer = this.createBuffer();
    this.setupTransports(options.transports);
    this.initializeAdvancedFeatures();
  }

  private mergeOptions(options: TurboLoggerOptions): Required<TurboLoggerOptions> {
    return {
      performance: {
        mode: options.performance?.mode || 'fast',
        bufferSize: options.performance?.bufferSize || 4096,
        flushInterval: options.performance?.flushInterval || 100,
        zeroAllocation: options.performance?.zeroAllocation || false
      },
      output: {
        format: options.output?.format || 'json',
        destination: options.output?.destination || process.stdout,
        level: options.output?.level || 'info',
        timestamp: options.output?.timestamp !== false,
        hostname: options.output?.hostname !== false,
        pid: options.output?.pid !== false
      },
      observability: {
        metrics: options.observability?.metrics || false,
        traces: options.observability?.traces || false,
        opentelemetry: options.observability?.opentelemetry || false,
        prometheus: options.observability?.prometheus || { enabled: false }
      },
      cloud: {
        kubernetes: options.cloud?.kubernetes || false,
        prometheus: options.cloud?.prometheus || false,
        jaeger: options.cloud?.jaeger || false,
        costTracking: options.cloud?.costTracking || false,
        serviceDiscovery: options.cloud?.serviceDiscovery || false
      },
      security: {
        encryption: options.security?.encryption || '',
        signing: options.security?.signing || false,
        piiMasking: options.security?.piiMasking || { enabled: false },
        compliance: options.security?.compliance || []
      },
      dev: {
        realtime: options.dev?.realtime || false,
        sourceMap: options.dev?.sourceMap || false,
        stackTrace: options.dev?.stackTrace || false,
        ide: options.dev?.ide || '',
        hotReload: options.dev?.hotReload || false,
        debugger: options.dev?.debugger || false
      },
      name: options.name,
      context: options.context || {},
      transports: options.transports || []
    } as Required<TurboLoggerOptions>;
  }

  private createBuffer(): MultiLevelBuffer<LogObject> {
    const bufferConfig: CircularBufferOptions = {
      size: this.options.performance.bufferSize || 4096,
      flushInterval: this.options.performance.flushInterval || 100,
      onFlush: async (items: unknown[]) => {
        await this.flushToTransports(items as LogObject[]);
      }
    };

    return new MultiLevelBuffer<LogObject>(
      {
        trace: bufferConfig,
        debug: bufferConfig,
        info: bufferConfig,
        warn: bufferConfig,
        error: bufferConfig,
        fatal: bufferConfig
      },
      'info'
    );
  }

  private setupTransports(transports?: Transport[]): void {
    if (transports && transports.length > 0) {
      this.transports = transports;
    } else {
      this.transports = [new ConsoleTransport({
        destination: this.options.output.destination,
        format: this.options.output.format
      } as TransportOptions)];
    }
  }

  private initializeAdvancedFeatures(): void {
    // Initialize log aggregation
    if (this.options.observability?.metrics) {
      this.aggregator = new LogAggregator({
        enabled: true,
        interval: 60000, // 1 minute
        groupBy: ['level', 'service', 'endpoint'],
        metrics: ['count', 'rate', 'p95'],
        retentionPeriod: 3600000 // 1 hour
      });
    }

    // Initialize native performance optimizations
    if (this.options.performance?.mode === 'ultra') {
      this.nativeOptimizer = new NativeOptimizer({
        enabled: true,
        serialization: { enabled: true },
        compression: { enabled: true, algorithm: 'lz4' },
        jsonParsing: { enabled: true }
      });
    }

    // Initialize ML-based log classification
    if (this.options.observability?.metrics) {
      this.classifier = new LogClassifier({
        enabled: true,
        modelType: 'naive-bayes',
        categories: ['error', 'performance', 'security', 'business', 'system'],
        onlineTraining: true,
        confidenceThreshold: 0.7
      });
    }
  }

  private async flushToTransports(items: LogObject[]): Promise<void> {
    const promises: Promise<void>[] = [];
    
    for (const transport of this.transports) {
      if (transport.isActive()) {
        promises.push(transport.writeBatch(items));
      }
    }
    
    const results = await Promise.allSettled(promises);
    
    // Log any transport failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`Transport ${index} flush failed:`, result.reason);
      }
    });
  }

  private handleError(error: Error, context: string): void {
    if (this.options.errorHandler) {
      try {
        this.options.errorHandler(error, context);
      } catch (handlerError) {
        console.error(`Error handler failed in ${context}:`, handlerError);
        console.error('Original error:', error);
      }
    } else {
      console.error(`[TurboLogger] Error in ${context}:`, error);
    }
  }

  private shouldLog(level: LogLevelName): boolean {
    const configuredLevel = this.options.output.level as LogLevelName;

    // FIX BUG-023: Validate both levels exist in LOG_LEVELS before accessing
    // This prevents type confusion if level formats change or invalid levels are passed
    if (!LOG_LEVELS[level] || !LOG_LEVELS[configuredLevel]) {
      console.error(
        `[TurboLogger] Invalid log level comparison: level="${level}", configuredLevel="${configuredLevel}"`
      );
      return false; // Reject invalid log levels
    }

    return LOG_LEVELS[level].value >= LOG_LEVELS[configuredLevel].value;
  }

  private createLogObject(
    level: LogLevelName,
    msgOrObj?: string | Record<string, unknown>,
    msgOrData?: string | Record<string, unknown>
  ): LogObject {
    const logLevel = LOG_LEVELS[level];
    const asyncContext = asyncLocalStorage.getStore() || {};
    
    const logObj: LogObject = {
      level: logLevel.value,
      levelLabel: logLevel.label,
      time: Date.now(),
      ...this.context,
      ...asyncContext
    };

    if (this.options.output.hostname) {
      logObj.hostname = TurboLogger.defaultHostname;
    }

    if (this.options.output.pid) {
      logObj.pid = TurboLogger.defaultPid;
    }

    if (this.name) {
      logObj.name = this.name;
    }

    // Handle different calling patterns:
    // 1. logger.info('message') 
    // 2. logger.info({data})
    // 3. logger.info('message', {data})
    // 4. logger.info({data}, 'message')
    
    if (typeof msgOrObj === 'string') {
      logObj.msg = msgOrObj;
      // If second parameter is an object, merge it
      if (typeof msgOrData === 'object' && msgOrData !== null) {
        Object.assign(logObj, msgOrData);
      }
    } else if (typeof msgOrObj === 'object' && msgOrObj !== null) {
      Object.assign(logObj, msgOrObj);
      // If second parameter is a string, use it as message
      if (typeof msgOrData === 'string') {
        logObj.msg = msgOrData;
      }
    }

    return logObj;
  }

  private log(
    level: LogLevelName,
    msgOrObj?: string | Record<string, unknown>,
    msgOrData?: string | Record<string, unknown>
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const logObj = this.createLogObject(level, msgOrObj, msgOrData);
    
    if (this.options.security.piiMasking?.enabled) {
      this.maskPII(logObj);
    }

    // Add to aggregation
    if (this.aggregator) {
      // Convert LogObject to AggregatorLogData format
      const aggregatorLog: AggregatorLogData = {
        ...logObj,
        level: logObj.levelLabel, // Override with string value
        msg: logObj.msg,
        time: logObj.time
      };
      this.aggregator.addLog(aggregatorLog);
    }

    // ML classification
    if (this.classifier) {
      const classification = this.classifier.classify({
        ...logObj,
        level: logObj.levelLabel // Ensure string type for classifier
      });
      if (classification) {
        logObj.category = classification.category;
        logObj.confidence = classification.confidence;
      }
    }

    // Use native optimization for serialization if available
    if (this.nativeOptimizer && this.options.performance.mode === 'ultra') {
      try {
        // Convert LogObject to SerializableObject
        const serializableObj: SerializableObject = {
          level: logObj.level,
          levelLabel: logObj.levelLabel,
          msg: logObj.msg,
          time: logObj.time,
          hostname: logObj.hostname,
          pid: logObj.pid,
          name: logObj.name
        };
        logObj._serialized = this.nativeOptimizer.serialize(serializableObj);
      } catch (error) {
        // Fallback to regular serialization
        this.handleError(error instanceof Error ? error : new Error(String(error)), 'native serialization');
      }
    }

    this.buffer.write(logObj, level);

    if (level === 'fatal') {
      // FIX BUG-034: Ensure fatal logs are flushed before potential process exit
      // Note: For guaranteed fatal log delivery, use the async flush() method
      // and await process exit: await logger.flush(); process.exit(1);
      // This synchronous approach attempts immediate flush but may not complete
      // if process.exit() is called immediately after logging
      const flushPromise = this.buffer.flush(level);

      // Store the promise so it can be awaited by external shutdown handlers
      if (!this.pendingFlushes) {
        this.pendingFlushes = [];
      }
      this.pendingFlushes.push(flushPromise);

      // Clean up completed promises
      flushPromise.finally(() => {
        const index = this.pendingFlushes?.indexOf(flushPromise);
        if (index !== undefined && index > -1) {
          this.pendingFlushes?.splice(index, 1);
        }
      }).catch(console.error);
    }
  }

  private maskPII(obj: Record<string, unknown>): void {
    if (!this.options.security.piiMasking?.rules) return;

    for (const rule of this.options.security.piiMasking.rules) {
      if (rule.field && obj[rule.field]) {
        obj[rule.field] = rule.mask;
      } else if (rule.pattern) {
        for (const key in obj) {
          if (typeof obj[key] === 'string' && rule.pattern.test(obj[key])) {
            obj[key] = rule.mask;
          }
        }
      }
    }
  }

  trace(msgOrObj?: string | Record<string, unknown>, msgOrData?: string | Record<string, unknown>): void {
    this.log('trace', msgOrObj, msgOrData);
  }

  debug(msgOrObj?: string | Record<string, unknown>, msgOrData?: string | Record<string, unknown>): void {
    this.log('debug', msgOrObj, msgOrData);
  }

  info(msgOrObj?: string | Record<string, unknown>, msgOrData?: string | Record<string, unknown>): void {
    this.log('info', msgOrObj, msgOrData);
  }

  warn(msgOrObj?: string | Record<string, unknown>, msgOrData?: string | Record<string, unknown>): void {
    this.log('warn', msgOrObj, msgOrData);
  }

  error(msgOrObj?: string | Record<string, unknown> | Error, msgOrData?: string | Record<string, unknown>): void {
    if (msgOrObj instanceof Error) {
      const errorObj = {
        msg: msgOrObj.message,
        err: {
          type: msgOrObj.name,
          message: msgOrObj.message,
          stack: this.options.dev.stackTrace ? msgOrObj.stack : undefined
        }
      };
      this.log('error', errorObj, msgOrData as string);
    } else {
      this.log('error', msgOrObj, msgOrData);
    }
  }

  fatal(msgOrObj?: string | Record<string, unknown> | Error, msgOrData?: string | Record<string, unknown>): void {
    if (msgOrObj instanceof Error) {
      const errorObj = {
        msg: msgOrObj.message,
        err: {
          type: msgOrObj.name,
          message: msgOrObj.message,
          stack: msgOrObj.stack
        }
      };
      this.log('fatal', errorObj, msgOrData as string);
    } else {
      this.log('fatal', msgOrObj, msgOrData);
    }
  }

  child(context: Record<string, unknown>): TurboLogger {
    // BUG-007 FIX: Deep clone options and transports to prevent shared state mutation
    // Previous shallow copy caused child logger modifications to affect parent
    const childOptions = JSON.parse(JSON.stringify(this.options));

    // For transports, we need a proper deep clone that preserves class instances
    const childTransports = this.transports.map(transport => {
      const proto = Object.getPrototypeOf(transport) as object;
      const cloned = Object.create(proto) as Transport;

      // Deep copy all own properties
      for (const key of Object.keys(transport)) {
        const value = (transport as any)[key];

        // Handle different types appropriately
        if (value === null || value === undefined) {
          (cloned as any)[key] = value;
        } else if (typeof value === 'function') {
          // Don't clone functions, use reference
          (cloned as any)[key] = value;
        } else if (value instanceof Date) {
          (cloned as any)[key] = new Date(value);
        } else if (Array.isArray(value)) {
          (cloned as any)[key] = [...value];
        } else if (typeof value === 'object') {
          // For complex objects, create a new copy (not deep clone to avoid circular refs)
          (cloned as any)[key] = { ...value };
        } else {
          // Primitive values (string, number, boolean)
          (cloned as any)[key] = value;
        }
      }

      return cloned;
    });

    return new TurboLogger({
      ...childOptions,
      name: this.name,
      context: { ...this.context, ...context },
      transports: childTransports
    });
  }

  // BUG-026 FIX: Use function overloads for type-safe API
  // Overload 1: When fn is provided, run it with context and return its result
  withContext<T>(context: Record<string, unknown>, fn: () => T | Promise<T>): T | Promise<T>;
  // Overload 2: When fn is omitted, return a new logger with context
  withContext(context: Record<string, unknown>): TurboLogger;
  // Implementation
  withContext<T>(context: Record<string, unknown>, fn?: () => T | Promise<T>): T | Promise<T> | TurboLogger {
    if (fn) {
      // Async context with callback
      const currentContext = asyncLocalStorage.getStore() || {};
      const mergedContext = { ...currentContext, ...context };
      return asyncLocalStorage.run(mergedContext, fn);
    } else {
      // NEW-BUG-001 FIX: Clone transports to prevent shared state (same issue as BUG-007)
      // Return new logger instance with context
      const currentContext = asyncLocalStorage.getStore() || {};
      const mergedContext = { ...currentContext, ...context };

      // Use the same transport cloning logic as child() method
      const clonedTransports = this.transports.map(transport => {
        const proto = Object.getPrototypeOf(transport) as object;
        const cloned = Object.create(proto) as Transport;

        for (const key of Object.keys(transport)) {
          const value = (transport as any)[key];
          if (value === null || value === undefined) {
            (cloned as any)[key] = value;
          } else if (typeof value === 'function') {
            (cloned as any)[key] = value;
          } else if (value instanceof Date) {
            (cloned as any)[key] = new Date(value);
          } else if (Array.isArray(value)) {
            (cloned as any)[key] = [...value];
          } else if (typeof value === 'object') {
            (cloned as any)[key] = { ...value };
          } else {
            (cloned as any)[key] = value;
          }
        }

        return cloned;
      });

      return new TurboLogger({
        ...this.options,
        name: this.name,
        context: { ...this.context, ...mergedContext },
        transports: clonedTransports
      });
    }
  }

  runWithContext<T>(context: Record<string, unknown>, fn: () => T): T {
    const currentContext = asyncLocalStorage.getStore() || {};
    const mergedContext = { ...currentContext, ...context };
    return asyncLocalStorage.run(mergedContext, fn);
  }

  addTransport(transport: Transport): void {
    this.transports.push(transport);
  }

  removeTransport(transport: Transport): void {
    const index = this.transports.indexOf(transport);
    if (index !== -1) {
      this.transports.splice(index, 1);
    }
  }

  async flush(): Promise<void> {
    await this.buffer.flush();
  }

  // Advanced analytics methods
  getAggregatedMetrics(filter?: Record<string, unknown>): unknown[] {
    return this.aggregator ? this.aggregator.getAggregatedMetrics(filter) : [];
  }

  getCorrelations(filter?: Record<string, unknown>): unknown[] {
    return this.aggregator ? this.aggregator.getCorrelations(filter) : [];
  }

  getClassificationStats(): unknown {
    return this.classifier ? this.classifier.getStats() : null;
  }

  getPerformanceStats(): Record<string, unknown> {
    return this.nativeOptimizer ? this.nativeOptimizer.getPerformanceStats() : {};
  }

  trainClassifier(log: LogObject, category: string): void {
    if (this.classifier) {
      this.classifier.train({
        ...log,
        level: log.levelLabel // Ensure string type
      }, category);
    }
  }

  destroy(): void {
    this.buffer.destroy();
    for (const transport of this.transports) {
      transport.destroy();
    }
    
    if (this.aggregator) {
      this.aggregator.destroy();
    }
    
    if (this.nativeOptimizer) {
      this.nativeOptimizer.destroy();
    }
    
    if (this.classifier) {
      this.classifier.destroy();
    }
  }
}

export function createLogger(options?: TurboLoggerOptions): TurboLogger {
  return new TurboLogger(options);
}