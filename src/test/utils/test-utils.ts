/**
 * Test utilities for TurboLogger testing
 */

import { Transport, LogEntry } from '../../core/logger/logger-core';
import { TurboLoggerConfig } from '../../core/config/schema';

/**
 * Mock Transport for testing
 */
export class MockTransport implements Transport {
  public name: string;
  public entries: LogEntry[] = [];
  public batchEntries: LogEntry[][] = [];
  public writeCallCount = 0;
  public batchWriteCallCount = 0;
  public healthy = true;
  public writeDelay = 0;
  public shouldFail = false;

  constructor(name = 'mock-transport') {
    this.name = name;
  }

  async write(entry: LogEntry): Promise<void> {
    this.writeCallCount++;
    
    if (this.writeDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.writeDelay));
    }
    
    if (this.shouldFail) {
      throw new Error(`Mock transport ${this.name} write failure`);
    }
    
    this.entries.push(entry);
  }

  async writeBatch(entries: LogEntry[]): Promise<void> {
    this.batchWriteCallCount++;
    
    if (this.writeDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.writeDelay));
    }
    
    if (this.shouldFail) {
      throw new Error(`Mock transport ${this.name} batch write failure`);
    }
    
    this.batchEntries.push([...entries]);
    this.entries.push(...entries);
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  getStats(): Record<string, unknown> {
    return {
      name: this.name,
      writeCallCount: this.writeCallCount,
      batchWriteCallCount: this.batchWriteCallCount,
      totalEntries: this.entries.length,
      healthy: this.healthy,
    };
  }

  async destroy(): Promise<void> {
    this.clear();
  }

  // Test utilities
  clear(): void {
    this.entries = [];
    this.batchEntries = [];
    this.writeCallCount = 0;
    this.batchWriteCallCount = 0;
  }

  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  setWriteDelay(delay: number): void {
    this.writeDelay = delay;
  }

  setShouldFail(shouldFail: boolean): void {
    this.shouldFail = shouldFail;
  }

  getLastEntry(): LogEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  getEntriesByLevel(level: string): LogEntry[] {
    return this.entries.filter(entry => entry.levelName === level);
  }

  hasEntryWithMessage(message: string): boolean {
    return this.entries.some(entry => entry.message === message);
  }

  hasEntryWithContext(key: string, value: unknown): boolean {
    return this.entries.some(entry => 
      entry.context && entry.context[key] === value
    );
  }
}

/**
 * Memory stream for capturing console output
 */
export class MemoryStream {
  private chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  getOutput(): string {
    return this.chunks.join('');
  }

  getLines(): string[] {
    return this.getOutput().split('\n').filter(line => line.length > 0);
  }

  clear(): void {
    this.chunks = [];
  }

  get isTTY(): boolean {
    return false;
  }
}

/**
 * Test configuration factory
 */
export function createTestConfig(overrides: Partial<TurboLoggerConfig> = {}): TurboLoggerConfig {
  return {
    name: 'test-logger',
    context: {},
    performance: {
      mode: 'fast',
      bufferSize: 256,
      flushInterval: 10,
      zeroAllocation: false,
      enableOptimizations: true,
    },
    output: {
      format: 'json',
      level: 'debug',
      timestamp: true,
      hostname: false,
      pid: false,
      stackTrace: false,
    },
    security: {
      encryption: {
        enabled: false,
        algorithm: 'aes-256-gcm',
      },
      piiMasking: {
        enabled: false,
        autoDetect: false,
        compliance: [],
        customRules: [],
      },
      signing: {
        enabled: false,
        algorithm: 'hmac-sha256',
      },
    },
    observability: {
      metrics: {
        enabled: false,
        provider: 'prometheus',
        interval: 60000,
      },
      tracing: {
        enabled: false,
        provider: 'otel',
        sampleRate: 1,
      },
    },
    transports: [],
    plugins: [],
    ...overrides,
  };
}

/**
 * Wait for a condition to be true with timeout
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 1000,
  interval = 10
): Promise<boolean> {
  const start = Date.now();
  
  while (Date.now() - start < timeout) {
    if (await condition()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  
  return false;
}

/**
 * Wait for async operations to complete
 */
export async function flushPromises(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

/**
 * Create a promise that can be resolved externally
 */
export function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void;
  let reject: (reason?: any) => void;
  
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  
  return { promise, resolve: resolve!, reject: reject! };
}

/**
 * Performance measurement utilities
 */
export class PerformanceMeasurement {
  private measurements: { name: string; duration: number }[] = [];
  
  async measure<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    const start = performance.now();
    const result = await fn();
    const end = performance.now();
    
    this.measurements.push({
      name,
      duration: end - start,
    });
    
    return result;
  }
  
  getMeasurements(): { name: string; duration: number }[] {
    return [...this.measurements];
  }
  
  getAverageDuration(name: string): number {
    const measurements = this.measurements.filter(m => m.name === name);
    if (measurements.length === 0) return 0;
    
    const total = measurements.reduce((sum, m) => sum + m.duration, 0);
    return total / measurements.length;
  }
  
  clear(): void {
    this.measurements = [];
  }
}

/**
 * Memory usage monitoring
 */
export class MemoryMonitor {
  private snapshots: { name: string; usage: NodeJS.MemoryUsage }[] = [];
  
  snapshot(name: string): void {
    this.snapshots.push({
      name,
      usage: process.memoryUsage(),
    });
  }
  
  getMemoryDiff(fromSnapshot: string, toSnapshot: string): NodeJS.MemoryUsage | null {
    const from = this.snapshots.find(s => s.name === fromSnapshot);
    const to = this.snapshots.find(s => s.name === toSnapshot);
    
    if (!from || !to) return null;
    
    return {
      rss: to.usage.rss - from.usage.rss,
      heapTotal: to.usage.heapTotal - from.usage.heapTotal,
      heapUsed: to.usage.heapUsed - from.usage.heapUsed,
      external: to.usage.external - from.usage.external,
      arrayBuffers: to.usage.arrayBuffers - from.usage.arrayBuffers,
    };
  }
  
  clear(): void {
    this.snapshots = [];
  }
}

/**
 * Test event emitter for logger events
 */
export class TestEventCollector {
  private events: { name: string; data: any; timestamp: number }[] = [];
  
  record(name: string, data: any): void {
    this.events.push({
      name,
      data,
      timestamp: Date.now(),
    });
  }
  
  getEvents(name?: string): Array<{ name: string; data: any; timestamp: number }> {
    if (name) {
      return this.events.filter(e => e.name === name);
    }
    return [...this.events];
  }
  
  getEventCount(name?: string): number {
    return this.getEvents(name).length;
  }
  
  hasEvent(name: string): boolean {
    return this.events.some(e => e.name === name);
  }
  
  clear(): void {
    this.events = [];
  }
}

/**
 * Retry utility for flaky tests
 */
export async function retry<T>(
  fn: () => T | Promise<T>,
  maxAttempts = 3,
  delayMs = 100
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  
  throw lastError!;
}

/**
 * Test assertion helpers
 */
export const assertions = {
  /**
   * Assert that a value is defined
   */
  isDefined<T>(value: T | undefined | null): asserts value is T {
    if (value === undefined || value === null) {
      throw new Error('Expected value to be defined');
    }
  },
  
  /**
   * Assert that arrays have the same length
   */
  hasSameLength<T, U>(a: T[], b: U[]): void {
    if (a.length !== b.length) {
      throw new Error(`Expected arrays to have same length, got ${a.length} and ${b.length}`);
    }
  },
  
  /**
   * Assert that a promise rejects
   */
  async rejects(fn: () => Promise<any>): Promise<Error> {
    try {
      await fn();
      throw new Error('Expected promise to reject');
    } catch (error) {
      return error as Error;
    }
  },
  
  /**
   * Assert that a value is within a range
   */
  inRange(value: number, min: number, max: number): void {
    if (value < min || value > max) {
      throw new Error(`Expected ${value} to be between ${min} and ${max}`);
    }
  },
  
  /**
   * Assert that execution time is within bounds
   */
  async executionTime<T>(
    fn: () => T | Promise<T>,
    maxMs: number
  ): Promise<T> {
    const start = performance.now();
    const result = await fn();
    const duration = performance.now() - start;
    
    if (duration > maxMs) {
      throw new Error(`Expected execution to take less than ${maxMs}ms, took ${duration}ms`);
    }
    
    return result;
  },
};
