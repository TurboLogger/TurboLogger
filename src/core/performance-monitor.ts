/**
 * Performance Monitor for TurboLogger
 * Implements comprehensive performance tracking and optimization
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { IPerformanceMonitor, Metric } from './container';

export interface PerformanceMetric {
  name: string;
  type: 'timer' | 'counter' | 'gauge' | 'histogram';
  value: number;
  timestamp: number;
  labels?: Record<string, string | number>;
}

export interface TimerResult {
  name: string;
  duration: number;
  startTime: number;
  endTime: number;
}

export interface PerformanceStats {
  totalMetrics: number;
  activeTimers: number;
  memoryUsage: NodeJS.MemoryUsage;
  eventLoopLag: number;
  cpuUsage: NodeJS.CpuUsage;
  uptime: number;
  metrics: Record<string, PerformanceMetric[]>;
  aggregations: {
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, HistogramStats>;
    timers: Record<string, TimerStats>;
  };
}

export interface HistogramStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface TimerStats {
  count: number;
  totalDuration: number;
  minDuration: number;
  maxDuration: number;
  avgDuration: number;
}

export interface PerformanceConfig {
  enableEventLoopMonitoring?: boolean;
  enableMemoryMonitoring?: boolean;
  enableCpuMonitoring?: boolean;
  metricsRetentionMs?: number;
  aggregationInterval?: number;
  eventLoopLagThreshold?: number;
  memoryUsageThreshold?: number;
  maxMetricsPerType?: number;
}

export class PerformanceMonitor extends EventEmitter implements IPerformanceMonitor {
  private readonly config: Required<PerformanceConfig>;
  private readonly metrics = new Map<string, PerformanceMetric[]>();
  private readonly activeTimers = new Map<string, { name: string; startTime: number }>();
  private readonly aggregations = {
    counters: new Map<string, number>(),
    gauges: new Map<string, number>(),
    histograms: new Map<string, number[]>(),
    timers: new Map<string, number[]>()
  };
  
  private eventLoopTimer?: NodeJS.Timeout;
  private aggregationTimer?: NodeJS.Timeout;
  private lastCpuUsage?: NodeJS.CpuUsage;
  private startTime = Date.now();
  private isDestroyed = false;

  constructor(config: PerformanceConfig = {}) {
    super();
    
    this.config = {
      enableEventLoopMonitoring: config.enableEventLoopMonitoring ?? true,
      enableMemoryMonitoring: config.enableMemoryMonitoring ?? true,
      enableCpuMonitoring: config.enableCpuMonitoring ?? true,
      metricsRetentionMs: config.metricsRetentionMs ?? 300000, // 5 minutes
      aggregationInterval: config.aggregationInterval ?? 10000, // 10 seconds
      eventLoopLagThreshold: config.eventLoopLagThreshold ?? 10, // 10ms
      memoryUsageThreshold: config.memoryUsageThreshold ?? 0.8, // 80%
      maxMetricsPerType: config.maxMetricsPerType ?? 1000
    };

    this.initialize();
  }

  private initialize(): void {
    if (this.config.enableEventLoopMonitoring) {
      this.startEventLoopMonitoring();
    }

    if (this.config.enableCpuMonitoring) {
      this.lastCpuUsage = process.cpuUsage();
    }

    // Start aggregation timer
    this.aggregationTimer = setInterval(() => {
      this.performAggregation();
      this.cleanupOldMetrics();
    }, this.config.aggregationInterval);
  }

  startTimer(name: string): () => number {
    if (this.isDestroyed) {
      return () => 0;
    }

    const timerKey = `${name}_${Date.now()}_${Math.random()}`;
    const startTime = performance.now();
    
    this.activeTimers.set(timerKey, { name, startTime });

    return (): number => {
      const timer = this.activeTimers.get(timerKey);
      if (!timer) {
        return 0;
      }

      const endTime = performance.now();
      const duration = endTime - timer.startTime;
      
      this.activeTimers.delete(timerKey);
      this.recordTimer(name, duration);
      
      return duration;
    };
  }

  recordMetric(name: string, value: number, labels?: Record<string, string | number>): void {
    if (this.isDestroyed) return;

    const metric: PerformanceMetric = {
      name,
      type: 'gauge',
      value,
      timestamp: Date.now(),
      labels
    };

    this.addMetric(metric);
    this.aggregations.gauges.set(name, value);
  }

  recordCounter(name: string, increment: number = 1, labels?: Record<string, string | number>): void {
    if (this.isDestroyed) return;

    const metric: PerformanceMetric = {
      name,
      type: 'counter',
      value: increment,
      timestamp: Date.now(),
      labels
    };

    this.addMetric(metric);
    
    const currentValue = this.aggregations.counters.get(name) || 0;
    this.aggregations.counters.set(name, currentValue + increment);
  }

  recordHistogram(name: string, value: number, labels?: Record<string, string | number>): void {
    if (this.isDestroyed) return;

    const metric: PerformanceMetric = {
      name,
      type: 'histogram',
      value,
      timestamp: Date.now(),
      labels
    };

    this.addMetric(metric);
    
    const values = this.aggregations.histograms.get(name) || [];
    values.push(value);
    
    // Keep only recent values to prevent memory growth
    if (values.length > this.config.maxMetricsPerType) {
      values.splice(0, values.length - this.config.maxMetricsPerType);
    }
    
    this.aggregations.histograms.set(name, values);
  }

  private recordTimer(name: string, duration: number): void {
    const metric: PerformanceMetric = {
      name,
      type: 'timer',
      value: duration,
      timestamp: Date.now()
    };

    this.addMetric(metric);
    
    const durations = this.aggregations.timers.get(name) || [];
    durations.push(duration);
    
    // Keep only recent durations
    if (durations.length > this.config.maxMetricsPerType) {
      durations.splice(0, durations.length - this.config.maxMetricsPerType);
    }
    
    this.aggregations.timers.set(name, durations);
  }

  private addMetric(metric: PerformanceMetric): void {
    const metricsList = this.metrics.get(metric.name) || [];
    metricsList.push(metric);
    
    // Limit metrics per type
    if (metricsList.length > this.config.maxMetricsPerType) {
      metricsList.splice(0, metricsList.length - this.config.maxMetricsPerType);
    }
    
    this.metrics.set(metric.name, metricsList);
  }

  getMetrics(): Record<string, Metric | Metric[]> {
    if (this.isDestroyed) return {};

    const result: Record<string, Metric | Metric[]> = {};
    
    // Convert internal metrics to Metric interface format
    for (const [name, metricsList] of this.metrics) {
      const metrics: Metric[] = metricsList.map(m => ({
        name: m.name,
        value: m.value,
        timestamp: m.timestamp,
        labels: m.labels
      }));
      result[name] = metrics.length === 1 ? metrics[0] : metrics;
    }

    return result;
  }

  getDetailedMetrics(): Record<string, unknown> {
    if (this.isDestroyed) return {};

    return {
      raw: Object.fromEntries(this.metrics),
      aggregated: this.getAggregatedMetrics(),
      system: this.getSystemMetrics()
    };
  }

  private getAggregatedMetrics(): Record<string, unknown> {
    return {
      counters: Object.fromEntries(this.aggregations.counters),
      gauges: Object.fromEntries(this.aggregations.gauges),
      histograms: this.computeHistogramStats(),
      timers: this.computeTimerStats()
    };
  }

  private computeHistogramStats(): Record<string, HistogramStats> {
    const stats: Record<string, HistogramStats> = {};
    
    for (const [name, values] of this.aggregations.histograms) {
      if (values.length === 0) continue;
      
      const sorted = [...values].sort((a, b) => a - b);
      const sum = values.reduce((acc, val) => acc + val, 0);
      
      stats[name] = {
        count: values.length,
        sum,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: sum / values.length,
        p50: this.percentile(sorted, 0.5),
        p95: this.percentile(sorted, 0.95),
        p99: this.percentile(sorted, 0.99)
      };
    }
    
    return stats;
  }

  private computeTimerStats(): Record<string, TimerStats> {
    const stats: Record<string, TimerStats> = {};
    
    for (const [name, durations] of this.aggregations.timers) {
      if (durations.length === 0) continue;
      
      const totalDuration = durations.reduce((acc, val) => acc + val, 0);
      
      stats[name] = {
        count: durations.length,
        totalDuration,
        minDuration: Math.min(...durations),
        maxDuration: Math.max(...durations),
        avgDuration: totalDuration / durations.length
      };
    }
    
    return stats;
  }

  private percentile(sorted: number[], p: number): number {
    const index = (sorted.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    
    if (lower === upper) {
      return sorted[lower];
    }
    
    const weight = index - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  private getSystemMetrics() {
    const metrics: Record<string, unknown> = {
      uptime: Date.now() - this.startTime,
      activeTimers: this.activeTimers.size
    };

    if (this.config.enableMemoryMonitoring) {
      metrics.memory = process.memoryUsage();
    }

    if (this.config.enableCpuMonitoring && this.lastCpuUsage) {
      const currentUsage = process.cpuUsage(this.lastCpuUsage);
      metrics.cpu = currentUsage;
      this.lastCpuUsage = process.cpuUsage();
    }

    return metrics;
  }

  private startEventLoopMonitoring(): void {
    let lastTime = performance.now();
    
    const measureLag = () => {
      const currentTime = performance.now();
      const lag = currentTime - lastTime - 10; // Expected 10ms interval
      lastTime = currentTime;
      
      this.recordMetric('event_loop_lag', lag);
      
      if (lag > this.config.eventLoopLagThreshold) {
        this.emit('performance.alert', {
          metric: 'event_loop_lag',
          value: lag,
          threshold: this.config.eventLoopLagThreshold,
          timestamp: Date.now()
        });
      }
      
      if (!this.isDestroyed) {
        this.eventLoopTimer = setTimeout(measureLag, 10);
      }
    };
    
    this.eventLoopTimer = setTimeout(measureLag, 10);
  }

  private performAggregation(): void {
    if (this.isDestroyed) return;

    // Check memory usage
    if (this.config.enableMemoryMonitoring) {
      const memUsage = process.memoryUsage();
      const heapUsedRatio = memUsage.heapUsed / memUsage.heapTotal;
      
      if (heapUsedRatio > this.config.memoryUsageThreshold) {
        this.emit('memory.warning', {
          usage: heapUsedRatio,
          threshold: this.config.memoryUsageThreshold,
          timestamp: Date.now()
        });
      }
    }

    // Emit aggregated metrics
    this.emit('performance.metric', {
      name: 'aggregation_summary',
      value: this.metrics.size,
      labels: {
        activeTimers: this.activeTimers.size,
        totalMetrics: Array.from(this.metrics.values()).reduce((sum, list) => sum + list.length, 0)
      },
      timestamp: Date.now()
    });
  }

  private cleanupOldMetrics(): void {
    const cutoffTime = Date.now() - this.config.metricsRetentionMs;
    
    for (const [name, metricsList] of this.metrics) {
      const filtered = metricsList.filter(metric => metric.timestamp > cutoffTime);
      
      if (filtered.length === 0) {
        this.metrics.delete(name);
      } else {
        this.metrics.set(name, filtered);
      }
    }
  }

  reset(): void {
    if (this.isDestroyed) return;

    this.metrics.clear();
    this.activeTimers.clear();
    this.aggregations.counters.clear();
    this.aggregations.gauges.clear();
    this.aggregations.histograms.clear();
    this.aggregations.timers.clear();
  }

  destroy(): void {
    if (this.isDestroyed) return;

    this.isDestroyed = true;

    // BUG #10 FIX: Clear timer references and set to undefined to prevent leaks
    if (this.eventLoopTimer) {
      clearTimeout(this.eventLoopTimer);
      this.eventLoopTimer = undefined;
    }

    if (this.aggregationTimer) {
      clearInterval(this.aggregationTimer);
      this.aggregationTimer = undefined;
    }

    this.reset();
    this.removeAllListeners();

    // Force garbage collection of large objects
    setImmediate(() => {
      if (global.gc) {
        global.gc();
      }
    });
  }

  // Utility methods for external integration
  isHealthy(): boolean {
    if (this.isDestroyed) return false;
    
    const systemMetrics = this.getSystemMetrics();
    const memUsage = systemMetrics.memory;
    
    if (memUsage && typeof memUsage === 'object' && 'heapUsed' in memUsage && 'heapTotal' in memUsage) {
      const heapUsedRatio = (memUsage as NodeJS.MemoryUsage).heapUsed / (memUsage as NodeJS.MemoryUsage).heapTotal;
      if (heapUsedRatio > this.config.memoryUsageThreshold) {
        return false;
      }
    }
    
    // Check for excessive event loop lag
    const lagMetrics = this.metrics.get('event_loop_lag');
    if (lagMetrics && lagMetrics.length > 0) {
      const recentLag = lagMetrics[lagMetrics.length - 1];
      if (recentLag.value > this.config.eventLoopLagThreshold * 5) {
        return false;
      }
    }
    
    return true;
  }

  getHealthReport(): {
    healthy: boolean;
    issues: string[];
    metrics: Record<string, unknown>;
  } {
    const issues: string[] = [];
    const metrics = this.getSystemMetrics();
    
    // Check memory
    if (metrics.memory && typeof metrics.memory === 'object') {
      const memUsage = metrics.memory as NodeJS.MemoryUsage;
      const heapUsedRatio = memUsage.heapUsed / memUsage.heapTotal;
      if (heapUsedRatio > this.config.memoryUsageThreshold) {
        issues.push(`High memory usage: ${(heapUsedRatio * 100).toFixed(1)}%`);
      }
    }
    
    // Check event loop lag
    const lagMetrics = this.metrics.get('event_loop_lag');
    if (lagMetrics && lagMetrics.length > 0) {
      const recentLag = lagMetrics[lagMetrics.length - 1];
      if (recentLag.value > this.config.eventLoopLagThreshold) {
        issues.push(`High event loop lag: ${recentLag.value.toFixed(2)}ms`);
      }
    }
    
    return {
      healthy: issues.length === 0,
      issues,
      metrics
    };
  }
}

// Export singleton instance
export const performanceMonitor = new PerformanceMonitor();