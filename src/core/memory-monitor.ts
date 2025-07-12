/**
 * Memory monitoring and leak detection for TurboLogger
 */

// Type definitions for modern JavaScript features
interface WeakRefLike<T extends object> {
  deref(): T | undefined;
}

interface FinalizationRegistryLike<T, U> {
  register(target: T, heldValue: U, unregisterToken?: object): void;
  unregister(unregisterToken: object): boolean;
}

// Extend globalThis to include modern JavaScript features
declare global {
  const WeakRef: {
    new <T extends object>(target: T): WeakRefLike<T>;
  } | undefined;
  const FinalizationRegistry: {
    new <T, U>(callback: (heldValue: U) => void): FinalizationRegistryLike<T, U>;
  } | undefined;
}

// Type guard functions
function isWeakRefAvailable(): boolean {
  return typeof globalThis !== 'undefined' && 
    'WeakRef' in globalThis && 
    typeof (globalThis as unknown as { WeakRef: unknown }).WeakRef === 'function';
}

function isFinalizationRegistryAvailable(): boolean {
  return typeof globalThis !== 'undefined' && 
    'FinalizationRegistry' in globalThis && 
    typeof (globalThis as unknown as { FinalizationRegistry: unknown }).FinalizationRegistry === 'function';
}

export interface MemoryMetrics {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  arrayBuffers: number;
  timestamp: number;
}

export interface MemoryLeak {
  type: 'heap' | 'external' | 'rss';
  growth: number;
  threshold: number;
  duration: number;
}

export class MemoryMonitor {
  private metrics: MemoryMetrics[] = [];
  private readonly maxMetrics: number;
  private readonly checkInterval: number;
  private timer?: NodeJS.Timeout;
  private listeners: ((leak: MemoryLeak) => void)[] = [];

  constructor(options: {
    maxMetrics?: number;
    checkInterval?: number;
  } = {}) {
    this.maxMetrics = options.maxMetrics ?? 100;
    this.checkInterval = options.checkInterval ?? 30000; // 30 seconds
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.collectMetrics();
      this.checkForLeaks();
    }, this.checkInterval);

    // Initial collection
    this.collectMetrics();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  onMemoryLeak(callback: (leak: MemoryLeak) => void): void {
    this.listeners.push(callback);
  }

  getCurrentMetrics(): MemoryMetrics {
    const usage = process.memoryUsage();
    return {
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      rss: usage.rss,
      arrayBuffers: usage.arrayBuffers ?? 0,
      timestamp: Date.now()
    };
  }

  getMemoryHistory(): MemoryMetrics[] {
    return [...this.metrics];
  }

  forceGC(): boolean {
    if (global.gc) {
      global.gc();
      return true;
    }
    return false;
  }

  analyzeMemoryTrend(duration: number = 300000): {
    heapGrowthRate: number;
    rssGrowthRate: number;
    isLeaking: boolean;
  } {
    const now = Date.now();
    const cutoff = now - duration;
    const recentMetrics = this.metrics.filter(m => m.timestamp > cutoff);

    if (recentMetrics.length < 2) {
      return { heapGrowthRate: 0, rssGrowthRate: 0, isLeaking: false };
    }

    const first = recentMetrics[0];
    const last = recentMetrics[recentMetrics.length - 1];
    const timeDiff = last.timestamp - first.timestamp;

    if (timeDiff === 0) {
      return { heapGrowthRate: 0, rssGrowthRate: 0, isLeaking: false };
    }

    const heapGrowthRate = (last.heapUsed - first.heapUsed) / timeDiff * 1000; // bytes/second
    const rssGrowthRate = (last.rss - first.rss) / timeDiff * 1000; // bytes/second

    // Consider it a leak if growth rate is > 1MB/minute consistently
    const leakThreshold = 1024 * 1024 / 60; // 1MB per minute in bytes per second
    const isLeaking = heapGrowthRate > leakThreshold || rssGrowthRate > leakThreshold;

    return { heapGrowthRate, rssGrowthRate, isLeaking };
  }

  private collectMetrics(): void {
    const metrics = this.getCurrentMetrics();
    this.metrics.push(metrics);

    // Keep only recent metrics
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics);
    }
  }

  private checkForLeaks(): void {
    if (this.metrics.length < 5) {
      return;
    }

    const analysis = this.analyzeMemoryTrend();
    
    if (analysis.isLeaking) {
      const leak: MemoryLeak = {
        type: analysis.heapGrowthRate > analysis.rssGrowthRate ? 'heap' : 'rss',
        growth: Math.max(analysis.heapGrowthRate, analysis.rssGrowthRate),
        threshold: 1024 * 1024 / 60, // 1MB/minute
        duration: this.checkInterval * this.metrics.length
      };

      this.listeners.forEach(listener => {
        try {
          listener(leak);
        } catch (err) {
          console.error('Error in memory leak listener:', err);
        }
      });
    }
  }

  cleanup(): void {
    this.stop();
    this.metrics.length = 0;
    this.listeners.length = 0;
  }
}

/**
 * Object pool for reducing garbage collection pressure
 */
export class ObjectPool<T> {
  private objects: T[] = [];
  private readonly maxSize: number;
  private readonly factory: () => T;
  private readonly reset?: (obj: T) => void;

  constructor(
    factory: () => T,
    maxSize = 100,
    reset?: (obj: T) => void
  ) {
    this.factory = factory;
    this.maxSize = maxSize;
    this.reset = reset;
  }

  acquire(): T {
    const obj = this.objects.pop();
    if (obj) {
      return obj;
    }
    return this.factory();
  }

  release(obj: T): void {
    if (this.objects.length < this.maxSize) {
      if (this.reset) {
        this.reset(obj);
      }
      this.objects.push(obj);
    }
  }

  clear(): void {
    this.objects.length = 0;
  }

  get size(): number {
    return this.objects.length;
  }
}

/**
 * Weak reference cache that doesn't prevent garbage collection
 */
export class WeakCache<K extends object, V> {
  private cache = new WeakMap<K, V>();
  private keyRegistry = new Set<WeakRefLike<K>>();
  private cleanupRegistry?: FinalizationRegistryLike<K, K>;

  set(key: K, value: V): void {
    this.cache.set(key, value);
    try {
      // Use WeakRef if available
      if (isWeakRefAvailable()) {
        const WeakRefConstructor = (globalThis as unknown as { WeakRef: new <T extends object>(target: T) => WeakRefLike<T> }).WeakRef;
        const weakRef = new WeakRefConstructor(key);
        this.keyRegistry.add(weakRef);
      }
      if (isFinalizationRegistryAvailable() && !this.cleanupRegistry) {
        const FinalizationRegistryConstructor = (globalThis as unknown as { FinalizationRegistry: new <T, U>(callback: (heldValue: U) => void) => FinalizationRegistryLike<T, U> }).FinalizationRegistry;
        this.cleanupRegistry = new FinalizationRegistryConstructor((_key: K) => {
          // Remove weak references when objects are collected
          for (const ref of this.keyRegistry) {
            if (ref.deref() === undefined) {
              this.keyRegistry.delete(ref);
            }
          }
        });
      }
      if (this.cleanupRegistry) {
        this.cleanupRegistry.register(key, key);
      }
    } catch (e) {
      // WeakRef/FinalizationRegistry not available
    }
  }

  get(key: K): V | undefined {
    return this.cache.get(key);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    try {
      if (this.cleanupRegistry) {
        this.cleanupRegistry.unregister(key);
      }
      for (const ref of this.keyRegistry) {
        if (ref.deref() === key) {
          this.keyRegistry.delete(ref);
          break;
        }
      }
    } catch (e) {
      // Ignore cleanup errors
    }
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache = new WeakMap();
    this.keyRegistry.clear();
  }

  get approximateSize(): number {
    // Clean up dead references
    try {
      for (const ref of this.keyRegistry) {
        if (ref.deref() === undefined) {
          this.keyRegistry.delete(ref);
        }
      }
    } catch (e) {
      // Ignore cleanup errors
    }
    return this.keyRegistry.size;
  }
}