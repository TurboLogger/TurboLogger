import { EventEmitter } from 'events';

// Type definitions for log data
export interface LogData {
  level?: string;
  levelLabel?: string;
  msg?: string;
  message?: string;
  time?: number;
  correlationId?: string;
  requestId?: string;
  traceId?: string;
  sessionId?: string;
  operationId?: string;
  userId?: string;
  user?: { id?: string };
  correlationComplete?: boolean;
  requestComplete?: boolean;
  operationComplete?: boolean;
  statusCode?: number;
  status?: number;
  responseTime?: number;
  duration?: number;
  processingTime?: number;
  value?: number;
  _timestamp?: number;
  _processingTime?: number;
  [key: string]: unknown;
}

export interface AggregationOptions {
  enabled?: boolean;
  interval?: number; // Aggregation window in milliseconds
  metrics?: string[]; // Metrics to calculate: count, rate, p50, p95, p99, avg, min, max
  groupBy?: string[]; // Fields to group by
  retentionPeriod?: number; // How long to keep aggregated data (ms)
  maxGroups?: number; // Maximum number of groups to track
  flushInterval?: number; // How often to flush aggregated data
  persistenceEnabled?: boolean; // Whether to persist aggregations
}

export interface AggregatedMetric {
  group: Record<string, string | number | boolean>;
  metrics: {
    count: number;
    rate: number;
    avg?: number;
    min?: number;
    max?: number;
    p50?: number;
    p95?: number;
    p99?: number;
    sum?: number;
    stdDev?: number;
  };
  timestamp: number;
  window: {
    start: number;
    end: number;
  };
}

export interface LogCorrelation {
  correlationId: string;
  traceId?: string;
  sessionId?: string;
  userId?: string;
  requestId?: string;
  logs: LogData[];
  startTime: number;
  endTime: number;
  duration: number;
  status: 'ongoing' | 'completed' | 'error';
  summary: {
    totalLogs: number;
    errorCount: number;
    warnCount: number;
    levels: Record<string, number>;
  };
}

export class LogAggregator extends EventEmitter {
  private static readonly MAX_GROUPS = 1000;
  private static readonly MAX_LOGS_PER_GROUP = 1000;
  private static readonly MAX_CORRELATIONS = 500;
  private static readonly MAX_METRICS = 1000;
  
  private options: Required<AggregationOptions>;
  private aggregationData: Map<string, LogData[]> = new Map();
  private aggregatedMetrics: Map<string, AggregatedMetric> = new Map();
  private correlations: Map<string, LogCorrelation> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private flushTimer?: NodeJS.Timeout;

  constructor(options: AggregationOptions = {}) {
    super();
    
    this.options = {
      enabled: true,
      interval: 60000, // 1 minute
      metrics: ['count', 'rate', 'avg', 'p95'],
      groupBy: ['level', 'service'],
      retentionPeriod: 3600000, // 1 hour
      maxGroups: 1000,
      flushInterval: 30000, // 30 seconds
      persistenceEnabled: false,
      ...options
    };

    if (this.options.enabled) {
      this.startFlushTimer();
    }
  }

  addLog(log: LogData): void {
    if (!this.options.enabled) return;

    // Extract correlation identifiers
    this.handleCorrelation(log);

    // Create group key based on groupBy fields
    const groupKey = this.createGroupKey(log);
    
    // Add to aggregation data
    if (!this.aggregationData.has(groupKey)) {
      this.aggregationData.set(groupKey, []);
    }
    
    const logs = this.aggregationData.get(groupKey);
    if (!logs) return;
    logs.push({
      ...log,
      _timestamp: Date.now(),
      _processingTime: log.processingTime || 0
    });

    // Limit the number of logs per group to prevent memory issues
    if (logs.length > LogAggregator.MAX_LOGS_PER_GROUP) {
      logs.splice(0, logs.length - LogAggregator.MAX_LOGS_PER_GROUP);
    }

    // Check if we need to limit groups
    if (this.aggregationData.size > LogAggregator.MAX_GROUPS) {
      this.cleanupOldGroups();
    }
    
    // Enforce limits on other maps
    this.enforceMapLimit(this.aggregatedMetrics, LogAggregator.MAX_METRICS);
    this.enforceMapLimit(this.correlations, LogAggregator.MAX_CORRELATIONS);

    // Schedule aggregation for this group if not already scheduled
    if (!this.timers.has(groupKey)) {
      const timer = setTimeout(() => {
        this.aggregateGroup(groupKey);
        this.timers.delete(groupKey);
      }, this.options.interval);
      
      this.timers.set(groupKey, timer);
    }
  }

  private handleCorrelation(log: LogData): void {
    const correlationId = this.extractCorrelationId(log);
    if (!correlationId) return;

    const existing = this.correlations.get(correlationId);
    
    if (existing) {
      // Update existing correlation
      existing.logs.push(log);
      existing.endTime = Date.now();
      existing.duration = existing.endTime - existing.startTime;
      existing.summary.totalLogs++;
      
      // Update level counts
      const level = log.level || log.levelLabel || 'info';
      existing.summary.levels[level] = (existing.summary.levels[level] || 0) + 1;
      
      if (level === 'error') existing.summary.errorCount++;
      if (level === 'warn') existing.summary.warnCount++;
      
      // Check if correlation is complete
      if (this.isCorrelationComplete(log, existing)) {
        existing.status = log.level === 'error' ? 'error' : 'completed';
        this.emit('correlationComplete', existing);
        
        // Clean up after a delay
        setTimeout(() => {
          this.correlations.delete(correlationId);
        }, 60000); // Keep for 1 minute after completion
      }
    } else {
      // Create new correlation
      const correlation: LogCorrelation = {
        correlationId,
        traceId: log.traceId,
        sessionId: log.sessionId,
        userId: log.userId || log.user?.id,
        requestId: log.requestId,
        logs: [log],
        startTime: Date.now(),
        endTime: Date.now(),
        duration: 0,
        status: 'ongoing',
        summary: {
          totalLogs: 1,
          errorCount: log.level === 'error' ? 1 : 0,
          warnCount: log.level === 'warn' ? 1 : 0,
          levels: { [log.level || 'info']: 1 }
        }
      };
      
      this.correlations.set(correlationId, correlation);
      this.emit('correlationStarted', correlation);
    }
  }

  private extractCorrelationId(log: LogData): string | null {
    // Try multiple fields for correlation
    return log.correlationId || 
           log.requestId || 
           log.traceId || 
           log.sessionId ||
           log.operationId ||
           null;
  }

  private isCorrelationComplete(log: LogData, correlation: LogCorrelation): boolean {
    // Heuristics to determine if a correlation is complete
    
    // Check for explicit completion markers
    if (log.correlationComplete || log.requestComplete || log.operationComplete) {
      return true;
    }
    
    // Check for response patterns
    if (log.msg && typeof log.msg === 'string') {
      const completionPatterns = [
        /request completed/i,
        /operation finished/i,
        /response sent/i,
        /transaction committed/i
      ];
      
      if (completionPatterns.some(pattern => pattern.test(log.msg || ''))) {
        return true;
      }
    }
    
    // Check for HTTP response codes
    if (log.statusCode || log.status) {
      return true;
    }
    
    // Check for error conditions
    if (log.level === 'error' && correlation.summary.totalLogs > 1) {
      return true;
    }
    
    // Auto-complete after timeout
    if (correlation.duration > 300000) { // 5 minutes
      return true;
    }
    
    return false;
  }

  private createGroupKey(log: LogData): string {
    const keyParts: string[] = [];
    
    for (const field of this.options.groupBy) {
      const value = this.getNestedValue(log, field);
      keyParts.push(`${field}:${value}`);
    }
    
    return keyParts.join('|');
  }

  private getNestedValue(obj: unknown, path: string): string | number | boolean | undefined {
    const result = path.split('.').reduce((current: unknown, key: string) => {
      return current && typeof current === 'object' && current !== null && key in current 
        ? (current as Record<string, unknown>)[key] 
        : undefined;
    }, obj);
    
    if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
      return result;
    }
    
    return String(result || 'unknown');
  }

  private aggregateGroup(groupKey: string): void {
    const logs = this.aggregationData.get(groupKey);
    if (!logs || logs.length === 0) return;

    const now = Date.now();
    const windowStart = now - this.options.interval;
    
    // Filter logs within the window
    const windowLogs = logs.filter(log => (log._timestamp ?? 0) >= windowStart);
    
    if (windowLogs.length === 0) return;

    // Extract group information
    const firstLog = windowLogs[0];
    const group: Record<string, string | number | boolean> = {};
    for (const field of this.options.groupBy) {
      const value = this.getNestedValue(firstLog, field);
      group[field] = value || 'unknown';
    }

    // Calculate metrics
    const metrics = this.calculateMetrics(windowLogs);
    
    const aggregatedMetric: AggregatedMetric = {
      group,
      metrics,
      timestamp: now,
      window: {
        start: windowStart,
        end: now
      }
    };

    // Store aggregated metric
    const metricKey = `${groupKey}:${now}`;
    this.aggregatedMetrics.set(metricKey, aggregatedMetric);

    // Emit aggregation event
    this.emit('aggregated', aggregatedMetric);

    // Clean up old logs from this group
    this.aggregationData.set(groupKey, logs.filter(log => (log._timestamp ?? 0) >= windowStart));
  }

  private calculateMetrics(logs: LogData[]): AggregatedMetric['metrics'] {
    const metrics: AggregatedMetric['metrics'] = {
      count: logs.length,
      rate: logs.length / (this.options.interval / 1000)
    };

    // Extract numeric values for statistical calculations
    const numericValues = logs
      .map(log => {
        // Try to extract numeric values from common fields
        return log.responseTime || 
               log.duration || 
               log.processingTime || 
               log._processingTime ||
               (typeof log.value === 'number' ? log.value : null);
      })
      .filter(val => val !== null && !isNaN(val)) as number[];

    if (numericValues.length > 0 && this.options.metrics.some(m => ['avg', 'min', 'max', 'p50', 'p95', 'p99', 'sum', 'stdDev'].includes(m))) {
      const sorted = numericValues.sort((a, b) => a - b);
      
      if (this.options.metrics.includes('avg')) {
        metrics.avg = numericValues.reduce((sum, val) => sum + val, 0) / numericValues.length;
      }
      
      if (this.options.metrics.includes('min')) {
        metrics.min = sorted[0];
      }
      
      if (this.options.metrics.includes('max')) {
        metrics.max = sorted[sorted.length - 1];
      }
      
      if (this.options.metrics.includes('sum')) {
        metrics.sum = numericValues.reduce((sum, val) => sum + val, 0);
      }
      
      if (this.options.metrics.includes('p50')) {
        metrics.p50 = this.percentile(sorted, 50);
      }
      
      if (this.options.metrics.includes('p95')) {
        metrics.p95 = this.percentile(sorted, 95);
      }
      
      if (this.options.metrics.includes('p99')) {
        metrics.p99 = this.percentile(sorted, 99);
      }
      
      if (this.options.metrics.includes('stdDev') && metrics.avg !== undefined) {
        const avgValue = metrics.avg;
        const variance = numericValues.reduce((sum, val) => sum + Math.pow(val - avgValue, 2), 0) / numericValues.length;
        metrics.stdDev = Math.sqrt(variance);
      }
    }

    return metrics;
  }

  private percentile(sortedValues: number[], percentile: number): number {
    const index = (percentile / 100) * (sortedValues.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index % 1;

    if (upper >= sortedValues.length) return sortedValues[sortedValues.length - 1];
    return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flushAggregations();
    }, this.options.flushInterval);
  }

  private flushAggregations(): void {
    const now = Date.now();
    const cutoff = now - this.options.retentionPeriod;

    // Remove old aggregated metrics
    for (const [key, metric] of this.aggregatedMetrics) {
      if (metric.timestamp < cutoff) {
        this.aggregatedMetrics.delete(key);
      }
    }

    // Clean up old raw aggregation data
    for (const [groupKey, logs] of this.aggregationData) {
      const filteredLogs = logs.filter(log => (log._timestamp ?? 0) >= cutoff);
      if (filteredLogs.length === 0) {
        this.aggregationData.delete(groupKey);
      } else {
        this.aggregationData.set(groupKey, filteredLogs);
      }
    }

    // Clean up old correlations
    for (const [correlationId, correlation] of this.correlations) {
      if (correlation.endTime < cutoff || (correlation.status !== 'ongoing' && correlation.endTime < now - 300000)) {
        this.correlations.delete(correlationId);
      }
    }

    this.emit('flushed', {
      activeGroups: this.aggregationData.size,
      storedMetrics: this.aggregatedMetrics.size,
      activeCorrelations: this.correlations.size
    });
  }

  private cleanupOldGroups(): void {
    // Remove the oldest groups to stay under the limit
    const groupEntries = Array.from(this.aggregationData.entries());
    const sortedGroups = groupEntries.sort((a, b) => {
      const aLatest = Math.max(...a[1].map(log => log._timestamp ?? 0));
      const bLatest = Math.max(...b[1].map(log => log._timestamp ?? 0));
      return aLatest - bLatest;
    });

    const toRemove = sortedGroups.slice(0, sortedGroups.length - this.options.maxGroups + 100);
    for (const [groupKey] of toRemove) {
      this.aggregationData.delete(groupKey);
      
      // Cancel any pending timers
      const timer = this.timers.get(groupKey);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(groupKey);
      }
    }
  }

  private enforceMapLimit<K, V>(map: Map<K, V>, maxSize: number): void {
    if (map.size > maxSize) {
      const entriesToDelete = map.size - maxSize;
      const iterator = map.keys();
      for (let i = 0; i < entriesToDelete; i++) {
        const nextItem = iterator.next();
        if (!nextItem.done) {
          map.delete(nextItem.value);
        }
      }
    }
  }

  getAggregatedMetrics(filter?: {
    groupBy?: Record<string, string | number | boolean>;
    timeRange?: { start: number; end: number };
    limit?: number;
  }): AggregatedMetric[] {
    let metrics = Array.from(this.aggregatedMetrics.values());

    if (filter) {
      if (filter.timeRange) {
        const timeRange = filter.timeRange;
        if (timeRange) {
          metrics = metrics.filter(metric => 
            metric.timestamp >= timeRange.start && 
            metric.timestamp <= timeRange.end
          );
        }
      }

      if (filter.groupBy) {
        metrics = metrics.filter(metric => {
          const groupBy = filter.groupBy;
          if (!groupBy) return true;
          return Object.entries(groupBy).every(([key, value]) => 
            metric.group[key] === value
          );
        });
      }

      if (filter.limit) {
        metrics = metrics.slice(-filter.limit);
      }
    }

    return metrics.sort((a, b) => a.timestamp - b.timestamp);
  }

  getCorrelations(filter?: {
    status?: LogCorrelation['status'];
    userId?: string;
    traceId?: string;
    limit?: number;
  }): LogCorrelation[] {
    let correlations = Array.from(this.correlations.values());

    if (filter) {
      if (filter.status) {
        correlations = correlations.filter(c => c.status === filter.status);
      }

      if (filter.userId) {
        correlations = correlations.filter(c => c.userId === filter.userId);
      }

      if (filter.traceId) {
        correlations = correlations.filter(c => c.traceId === filter.traceId);
      }

      if (filter.limit) {
        correlations = correlations.slice(-filter.limit);
      }
    }

    return correlations.sort((a, b) => b.startTime - a.startTime);
  }

  getStats(): {
    aggregation: {
      activeGroups: number;
      totalLogs: number;
      storedMetrics: number;
      oldestMetric: number | null;
    };
    correlation: {
      total: number;
      active: number;
      completed: number;
      errors: number;
      averageDuration: number;
    };
    memory: {
      aggregationDataSize: number;
      metricsSize: number;
      correlationsSize: number;
    };
  } {
    const now = Date.now();
    const activeCorrelations = Array.from(this.correlations.values())
      .filter(c => c.status === 'ongoing');

    return {
      aggregation: {
        activeGroups: this.aggregationData.size,
        totalLogs: Array.from(this.aggregationData.values())
          .reduce((sum, logs) => sum + logs.length, 0),
        storedMetrics: this.aggregatedMetrics.size,
        oldestMetric: this.aggregatedMetrics.size > 0 ? 
          Math.min(...Array.from(this.aggregatedMetrics.values()).map(m => m.timestamp)) : null
      },
      correlation: {
        total: this.correlations.size,
        active: activeCorrelations.length,
        completed: Array.from(this.correlations.values())
          .filter(c => c.status === 'completed').length,
        errors: Array.from(this.correlations.values())
          .filter(c => c.status === 'error').length,
        averageDuration: activeCorrelations.length > 0 ?
          activeCorrelations.reduce((sum, c) => sum + (now - c.startTime), 0) / activeCorrelations.length : 0
      },
      memory: {
        aggregationDataSize: this.estimateSize(this.aggregationData),
        metricsSize: this.estimateSize(this.aggregatedMetrics),
        correlationsSize: this.estimateSize(this.correlations)
      }
    };
  }

  private estimateSize(map: Map<unknown, unknown>): number {
    // Rough estimation of memory usage
    return map.size * 1000; // Assume 1KB per entry on average
  }

  destroy(): void {
    // Clear all timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Clear all data
    this.aggregationData.clear();
    this.aggregatedMetrics.clear();
    this.correlations.clear();

    this.removeAllListeners();
  }
}