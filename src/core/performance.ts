import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import * as v8 from 'v8';

// Interface for GC performance entries
interface GCPerformanceEntry {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
  detail?: {
    kind?: number | string;
  };
}

export interface PerformanceMetrics {
  timestamp: number;
  cpu: {
    user: number;
    system: number;
    percent: number;
  };
  memory: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
    arrayBuffers: number;
  };
  eventLoop: {
    delay: number;
    utilization: number;
  };
  gc?: {
    collections: number;
    pauseMs: number;
    type: string;
  };
}

export interface ProfileOptions {
  name: string;
  metadata?: Record<string, unknown>;
}

export class PerformanceMonitor extends EventEmitter {
  private metricsInterval?: NodeJS.Timeout;
  private lastCpuUsage?: NodeJS.CpuUsage;
  private lastTimestamp: number = 0;
  private gcStats: Map<string, number | string> = new Map();
  private profiles: Map<string, number> = new Map();
  // private eventLoopMonitor?: unknown;

  constructor() {
    super();
    this.setupGCTracking();
  }

  startMonitoring(interval: number = 5000): void {
    if (this.metricsInterval) {
      return;
    }

    this.lastCpuUsage = process.cpuUsage();
    this.lastTimestamp = Date.now();

    this.metricsInterval = setInterval(() => {
      const metrics = this.collectMetrics();
      this.emit('metrics', metrics);
    }, interval);

    this.metricsInterval.unref();
  }

  stopMonitoring(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = undefined;
    }
  }

  private collectMetrics(): PerformanceMetrics {
    const now = Date.now();
    const cpuUsage = process.cpuUsage(this.lastCpuUsage);
    const memoryUsage = process.memoryUsage();
    // BUG-045 FIX: Removed commented-out dead code

    const elapsedMs = now - this.lastTimestamp;
    // BUG-042 FIX: Prevent division by zero - if elapsedMs is 0, set cpuPercent to 0
    const cpuPercent = elapsedMs > 0
      ? ((cpuUsage.user + cpuUsage.system) / 1000 / elapsedMs) * 100
      : 0;

    this.lastCpuUsage = process.cpuUsage();
    this.lastTimestamp = now;

    return {
      timestamp: now,
      cpu: {
        user: cpuUsage.user,
        system: cpuUsage.system,
        percent: Math.min(cpuPercent, 100)
      },
      memory: {
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
        external: memoryUsage.external,
        rss: memoryUsage.rss,
        arrayBuffers: memoryUsage.arrayBuffers || 0
      },
      eventLoop: this.getEventLoopMetrics(),
      gc: this.getGCMetrics()
    };
  }

  private setupGCTracking(): void {
    try {
      const obs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        for (const entry of entries) {
          if (entry.entryType === 'gc') {
            // Safe type assertion for GC entry
            const gcEntry = entry as GCPerformanceEntry;
            const gcType = gcEntry.detail?.kind?.toString() || 'unknown';
            const collections = this.gcStats.get('collections') || 0;
            const pauseMs = this.gcStats.get('pauseMs') || 0;
            this.gcStats.set('collections', (typeof collections === 'number' ? collections : 0) + 1);
            this.gcStats.set('pauseMs', (typeof pauseMs === 'number' ? pauseMs : 0) + entry.duration);
            this.gcStats.set('lastType', gcType.toString());
          }
        }
      });
      obs.observe({ entryTypes: ['gc'] });
    } catch (err) {
      // GC tracking not available
    }
  }

  private getEventLoopMetrics(): { delay: number; utilization: number } {
    // Simplified event loop metrics
    const start = performance.now();
    setImmediate(() => {
      const delay = performance.now() - start;
      this.emit('eventLoopDelay', delay);
    });

    return {
      delay: 0, // Will be updated asynchronously
      utilization: 0 // Requires more complex calculation
    };
  }

  private getGCMetrics(): PerformanceMetrics['gc'] | undefined {
    if (this.gcStats.size === 0) {
      return undefined;
    }

    return {
      collections: typeof (this.gcStats.get('collections') || 0) === 'number' ? this.gcStats.get('collections') as number || 0 : 0,
      pauseMs: typeof (this.gcStats.get('pauseMs') || 0) === 'number' ? this.gcStats.get('pauseMs') as number || 0 : 0,
      type: String(this.gcStats.get('lastType')) || 'unknown'
    };
  }

  profile(name: string): () => void {
    const start = performance.now();
    this.profiles.set(name, start);

    return () => {
      const end = performance.now();
      const duration = end - start;
      this.profiles.delete(name);
      
      this.emit('profile', {
        name,
        duration,
        timestamp: Date.now()
      });

      return duration;
    };
  }

  async profileAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const endProfile = this.profile(name);
    try {
      const result = await fn();
      return result;
    } finally {
      endProfile();
    }
  }

  getSnapshot(): {
    heap: v8.HeapInfo;
    profiles: { name: string; startTime: number }[];
  } {
    return {
      heap: v8.getHeapSnapshot() as unknown as v8.HeapInfo,
      profiles: Array.from(this.profiles.entries()).map(([name, startTime]) => ({
        name,
        startTime
      }))
    };
  }

  destroy(): void {
    this.stopMonitoring();
    this.removeAllListeners();
    this.gcStats.clear();
    this.profiles.clear();
  }
}

export class LoggerProfiler {
  private monitor: PerformanceMonitor;
  private logCounts: Map<string, number> = new Map();
  private logSizes: Map<string, number> = new Map();
  private transportLatencies: Map<string, number[]> = new Map();

  constructor() {
    this.monitor = new PerformanceMonitor();
  }

  recordLog(level: string, size: number): void {
    this.logCounts.set(level, (this.logCounts.get(level) || 0) + 1);
    this.logSizes.set(level, (this.logSizes.get(level) || 0) + size);
  }

  recordTransportLatency(transport: string, latency: number): void {
    if (!this.transportLatencies.has(transport)) {
      this.transportLatencies.set(transport, []);
    }
    const transportLatencies = this.transportLatencies.get(transport);
    if (transportLatencies) {
      transportLatencies.push(latency);
      
      // Keep only last 1000 measurements
      if (transportLatencies.length > 1000) {
        transportLatencies.shift();
      }
    }
  }

  getStats(): {
    logCounts: Record<string, number>;
    logSizes: Record<string, number>;
    transportLatencies: Record<string, { avg: number; p95: number; p99: number }>;
    performance: PerformanceMetrics;
  } {
    const transportStats: Record<string, { avg: number; p95: number; p99: number }> = {};
    
    for (const [transport, latencies] of this.transportLatencies) {
      if (latencies.length > 0) {
        const sorted = [...latencies].sort((a, b) => a - b);
        transportStats[transport] = {
          avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
          p95: sorted[Math.floor(sorted.length * 0.95)],
          p99: sorted[Math.floor(sorted.length * 0.99)]
        };
      }
    }

    return {
      logCounts: Object.fromEntries(this.logCounts),
      logSizes: Object.fromEntries(this.logSizes),
      transportLatencies: transportStats,
      performance: {} as PerformanceMetrics // this.monitor.collectMetrics()
    };
  }

  reset(): void {
    this.logCounts.clear();
    this.logSizes.clear();
    this.transportLatencies.clear();
  }

  destroy(): void {
    this.monitor.destroy();
    this.reset();
  }
}