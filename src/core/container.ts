/**
 * Dependency Injection Container for TurboLogger
 * Implements a lightweight IoC container for loose coupling
 */

export type Factory<T> = () => T | Promise<T>;
export type Token<T> = symbol & { readonly __type: T };

export interface IContainer {
  register<T>(token: Token<T>, factory: Factory<T>): void;
  registerSingleton<T>(token: Token<T>, factory: Factory<T>): void;
  resolve<T>(token: Token<T>): T;
  resolveAsync<T>(token: Token<T>): Promise<T>;
  has<T>(token: Token<T>): boolean;
  clear(): void;
}

export class TurboLoggerContainer implements IContainer {
  private readonly factories = new Map<symbol, Factory<unknown>>();
  private readonly singletons = new Map<symbol, unknown>();
  private readonly singletonsFactories = new Set<symbol>();

  register<T>(token: Token<T>, factory: Factory<T>): void {
    this.factories.set(token, factory);
  }

  registerSingleton<T>(token: Token<T>, factory: Factory<T>): void {
    this.factories.set(token, factory);
    this.singletonsFactories.add(token);
  }

  resolve<T>(token: Token<T>): T {
    // Check if singleton already exists
    if (this.singletonsFactories.has(token) && this.singletons.has(token)) {
      return this.singletons.get(token) as T;
    }

    const factory = this.factories.get(token) as Factory<T> | undefined;
    if (!factory) {
      throw new Error(`No factory registered for token: ${token.toString()}`);
    }

    const instance = factory();
    
    // Handle promises synchronously (not recommended but for compatibility)
    if (instance instanceof Promise) {
      throw new Error(`Use resolveAsync for asynchronous factories. Token: ${token.toString()}`);
    }

    // Store singleton if needed
    if (this.singletonsFactories.has(token)) {
      this.singletons.set(token, instance);
    }

    return instance;
  }

  async resolveAsync<T>(token: Token<T>): Promise<T> {
    // Check if singleton already exists
    if (this.singletonsFactories.has(token) && this.singletons.has(token)) {
      return this.singletons.get(token) as T;
    }

    const factory = this.factories.get(token) as Factory<T> | undefined;
    if (!factory) {
      throw new Error(`No factory registered for token: ${token.toString()}`);
    }

    const instance = await factory();

    // Store singleton if needed
    if (this.singletonsFactories.has(token)) {
      this.singletons.set(token, instance);
    }

    return instance as T;
  }

  has<T>(token: Token<T>): boolean {
    return this.factories.has(token);
  }

  clear(): void {
    this.factories.clear();
    this.singletons.clear();
    this.singletonsFactories.clear();
  }

  // Advanced features for debugging and introspection
  getRegisteredTokens(): symbol[] {
    return Array.from(this.factories.keys());
  }

  getSingletonTokens(): symbol[] {
    return Array.from(this.singletonsFactories);
  }

  getInstanceCount(): number {
    return this.singletons.size;
  }
}

// Token creation utility
export function createToken<T>(description: string): Token<T> {
  return Symbol(description) as Token<T>;
}

// Default container instance
export const container = new TurboLoggerContainer();

// Pre-defined tokens for core services
export const TOKENS = {
  AGGREGATOR: createToken<ILogAggregator>('aggregator'),
  NATIVE_OPTIMIZER: createToken<INativeOptimizer>('nativeOptimizer'),
  LOG_CLASSIFIER: createToken<ILogClassifier>('logClassifier'),
  METRICS_COLLECTOR: createToken<IMetricsCollector>('metricsCollector'),
  EVENT_MANAGER: createToken<IEventManager>('eventManager'),
  PLUGIN_MANAGER: createToken<IPluginManager>('pluginManager'),
  PERFORMANCE_MONITOR: createToken<IPerformanceMonitor>('performanceMonitor'),
  SECURITY_MANAGER: createToken<ISecurityManager>('securityManager')
} as const;

// Type definitions
export interface LogObject {
  level?: number;
  levelLabel?: string;
  msg?: string;
  time?: number;
  [key: string]: unknown;
}

export interface Metric {
  name: string;
  value: number;
  timestamp: number;
  labels?: Record<string, string | number>;
}

export interface EventData {
  [key: string]: unknown;
}

export type EventListener = (data: EventData) => void;

// Interfaces for type safety
export interface ILogAggregator {
  addLog(log: LogObject): void;
  getMetrics(): Metric[];
  destroy(): void;
}

export interface INativeOptimizer {
  optimizeObject<T extends object>(obj: T): T;
  isEnabled(): boolean;
  destroy(): void;
}

export interface ILogClassifier {
  classify(log: LogObject): string;
  train(logs: LogObject[]): void;
  destroy(): void;
}

export interface IMetricsCollector {
  counter(name: string, labels?: Record<string, string | number>): void;
  histogram(name: string, value: number, labels?: Record<string, string | number>): void;
  gauge(name: string, value: number, labels?: Record<string, string | number>): void;
  exportPrometheus(): string;
}

export interface IEventManager {
  emit(event: string, data: EventData): boolean;
  on(event: string, listener: EventListener): this;
  off(event: string, listener: EventListener): this;
  removeAllListeners(event?: string): this;
}

export interface IPluginManager {
  register(plugin: ILoggerPlugin): void;
  unregister(name: string): void;
  processLog(log: LogObject): Promise<LogObject>;
  getPlugin(name: string): ILoggerPlugin | undefined;
  getAllPlugins(): ILoggerPlugin[];
  destroy(): Promise<void>;
}

export interface ILoggerPlugin {
  name: string;
  version: string;
  initialize(logger: unknown): Promise<void>;
  process(log: LogObject): Promise<LogObject>;
  destroy(): Promise<void>;
}

export interface IPerformanceMonitor {
  startTimer(name: string): () => number;
  recordMetric(name: string, value: number): void;
  getMetrics(): Record<string, Metric | Metric[]>;
  reset(): void;
}

export interface ISecurityManager {
  sanitizeInput(input: string): string;
  validatePath(path: string): string;
  detectPII(content: string): boolean;
  maskPII(content: string): string;
}