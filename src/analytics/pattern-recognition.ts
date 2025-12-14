import { EventEmitter } from 'events';

// Type definitions for log data
export interface LogData {
  level?: string;
  msg?: string;
  message?: string;
  time?: number;
  service?: string;
  error?: unknown;
  stack?: string;
  responseTime?: number;
  duration?: number;
  memory?: { rss?: number; heapUsed?: number };
  memoryUsage?: { rss?: number; heapUsed?: number };
  correlationId?: string;
  requestId?: string;
  userId?: string;
  _sanitized?: boolean;
  [key: string]: unknown;
}

export interface BaselineData {
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  count: number;
}

export interface SanitizedLog {
  level?: string;
  msg?: string;
  message?: string;
  service?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface LogPattern {
  id: string;
  name: string;
  description: string;
  pattern: RegExp | string;
  category: 'error' | 'warning' | 'info' | 'security' | 'performance' | 'business';
  severity: 'low' | 'medium' | 'high' | 'critical';
  frequency: number;
  firstSeen: number;
  lastSeen: number;
  occurrences: number;
  samples: SanitizedLog[];
  threshold?: {
    count: number;
    timeWindow: number;
  };
}

export interface AnomalyDetection {
  id: string;
  type: 'frequency' | 'pattern' | 'value' | 'sequence' | 'correlation';
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  detectedAt: number;
  affectedLogs: LogData[];
  baseline: BaselineData | Record<string, unknown>;
  currentValue: number | string | Record<string, unknown>;
  suggestions?: string[];
}

export interface PatternAnalysisOptions {
  windowSize: number;
  minOccurrences: number;
  confidenceThreshold: number;
  maxPatterns: number;
  enableAnomalyDetection: boolean;
  alertThresholds: {
    errorSpike: number;
    newPattern: number;
    anomalyConfidence: number;
  };
}

export class PatternRecognitionEngine extends EventEmitter {
  private patterns: Map<string, LogPattern> = new Map();
  private logHistory: LogData[] = [];
  private options: PatternAnalysisOptions;
  private frequencyBaselines: Map<string, number[]> = new Map();
  private sequencePatterns: Map<string, number> = new Map();
  private correlationMatrix: Map<string, Map<string, number>> = new Map();
  // BUG-NEW-001 FIX: Store interval IDs to allow proper cleanup
  private periodicAnalysisIntervalId?: NodeJS.Timeout;
  private patternDiscoveryIntervalId?: NodeJS.Timeout;

  constructor(options: Partial<PatternAnalysisOptions> = {}) {
    super();
    this.options = {
      windowSize: 1000,
      minOccurrences: 5,
      confidenceThreshold: 0.7,
      maxPatterns: 100,
      enableAnomalyDetection: true,
      alertThresholds: {
        errorSpike: 5.0,
        newPattern: 10,
        anomalyConfidence: 0.8
      },
      ...options
    };

    this.initializeKnownPatterns();
    this.startPeriodicAnalysis();
  }

  analyzeLog(log: LogData): void {
    this.logHistory.push({
      ...log,
      _timestamp: Date.now(),
      _analyzed: false
    });

    // Maintain sliding window
    if (this.logHistory.length > this.options.windowSize) {
      this.logHistory.shift();
    }

    // Real-time pattern matching
    this.matchKnownPatterns(log);

    // Update frequency baselines
    this.updateFrequencyBaselines(log);

    // Check for immediate anomalies
    if (this.options.enableAnomalyDetection) {
      this.detectImmediateAnomalies(log);
    }
  }

  private initializeKnownPatterns(): void {
    const knownPatterns: Omit<LogPattern, 'id' | 'frequency' | 'firstSeen' | 'lastSeen' | 'occurrences' | 'samples'>[] = [
      {
        name: 'Database Connection Error',
        description: 'Database connectivity issues',
        pattern: /database.*connection.*failed|connection.*timeout|ECONNREFUSED.*database/i,
        category: 'error',
        severity: 'high',
        threshold: { count: 5, timeWindow: 60000 }
      },
      {
        name: 'Authentication Failure',
        description: 'Failed authentication attempts',
        pattern: /auth.*failed|invalid.*credentials|unauthorized|403.*forbidden/i,
        category: 'security',
        severity: 'medium',
        threshold: { count: 10, timeWindow: 300000 }
      },
      {
        name: 'Memory Leak Indicator',
        description: 'Potential memory leak pattern',
        pattern: /out.*of.*memory|heap.*exceeded|memory.*allocation.*failed/i,
        category: 'performance',
        severity: 'critical',
        threshold: { count: 3, timeWindow: 60000 }
      },
      {
        name: 'Payment Processing Error',
        description: 'Payment system failures',
        pattern: /payment.*failed|transaction.*error|credit.*card.*declined/i,
        category: 'business',
        severity: 'high',
        threshold: { count: 5, timeWindow: 120000 }
      },
      {
        name: 'API Rate Limit',
        description: 'API rate limiting triggered',
        pattern: /rate.*limit.*exceeded|too.*many.*requests|429/i,
        category: 'warning',
        severity: 'medium',
        threshold: { count: 20, timeWindow: 60000 }
      },
      {
        name: 'SQL Injection Attempt',
        description: 'Potential SQL injection attack',
        pattern: /union.*select|drop.*table|insert.*into.*values|script.*alert/i,
        category: 'security',
        severity: 'critical',
        threshold: { count: 1, timeWindow: 60000 }
      },
      {
        name: 'File System Error',
        description: 'File system access issues',
        pattern: /ENOENT|EACCES|EMFILE|disk.*full|no.*space.*left/i,
        category: 'error',
        severity: 'medium',
        threshold: { count: 10, timeWindow: 300000 }
      },
      {
        name: 'Network Timeout',
        description: 'Network connectivity timeouts',
        pattern: /timeout|ETIMEDOUT|connection.*reset|socket.*hang.*up/i,
        category: 'error',
        severity: 'medium',
        threshold: { count: 15, timeWindow: 180000 }
      }
    ];

    knownPatterns.forEach((pattern, index) => {
      const id = `known_${index}`;
      this.patterns.set(id, {
        ...pattern,
        id,
        frequency: 0,
        firstSeen: 0,
        lastSeen: 0,
        occurrences: 0,
        samples: []
      });
    });
  }

  private matchKnownPatterns(log: LogData): void {
    const searchText = this.extractSearchableText(log);
    const now = Date.now();

    for (const [id, pattern] of this.patterns) {
      let matches = false;

      if (pattern.pattern instanceof RegExp) {
        matches = pattern.pattern.test(searchText);
      } else {
        matches = searchText.toLowerCase().includes(pattern.pattern.toLowerCase());
      }

      if (matches) {
        this.updatePattern(id, log, now);
        this.checkThresholds(pattern);
      }
    }
  }

  private extractSearchableText(log: LogData): string {
    interface ErrorWithMessage {
      message: unknown;
    }
    
    const isErrorWithMessage = (obj: unknown): obj is ErrorWithMessage =>
      typeof obj === 'object' && obj !== null && 'message' in obj;
    
    const errorMessage = isErrorWithMessage(log.error) 
      ? String(log.error.message)
      : '';
    
    const errField = (log as Record<string, unknown>).err;
    const errMessage = isErrorWithMessage(errField)
      ? String(errField.message)
      : '';
    
    const parts = [
      log.msg || log.message || '',
      errorMessage,
      errMessage,
      JSON.stringify(log.error || errField || {})
    ];
    return parts.join(' ');
  }

  private updatePattern(id: string, log: LogData, timestamp: number): void {
    const pattern = this.patterns.get(id);
    if (!pattern) return;
    
    pattern.occurrences++;
    pattern.lastSeen = timestamp;
    pattern.frequency = this.calculateFrequency(pattern, timestamp);
    
    if (pattern.firstSeen === 0) {
      pattern.firstSeen = timestamp;
    }

    // Store sample logs (keep only recent ones)
    pattern.samples.push(this.sanitizeLogForSample(log));
    
    if (pattern.samples.length > 10) {
      pattern.samples.shift();
    }

    this.patterns.set(id, pattern);
  }

  private calculateFrequency(pattern: LogPattern, currentTime: number): number {
    const recentSamples = pattern.samples.filter(
      sample => currentTime - (sample.timestamp || 0) < 3600000 // Last hour
    );
    return recentSamples.length;
  }

  private sanitizeLogForSample(log: LogData): SanitizedLog {
    const sanitized = { ...log };
    const sensitiveFields = ['password', 'token', 'key', 'secret', 'authorization'];
    
    sensitiveFields.forEach(field => {
      if (field in sanitized) {
        delete sanitized[field];
      }
    });
    
    return sanitized;
  }

  private checkThresholds(pattern: LogPattern): void {
    if (!pattern.threshold) return;

    const now = Date.now();
    const timeWindow = pattern.threshold?.timeWindow;
    if (!timeWindow) return;
    
    const recentOccurrences = pattern.samples.filter(
      sample => now - (sample.timestamp || 0) < timeWindow
    ).length;

    if (recentOccurrences >= pattern.threshold.count) {
      this.emit('patternThresholdExceeded', {
        pattern,
        recentOccurrences,
        threshold: pattern.threshold,
        timestamp: now
      });
    }
  }

  private updateFrequencyBaselines(log: LogData): void {
    const level = log.level || (log as Record<string, unknown>).levelLabel || 'unknown';
    const service = log.service || log.name || 'unknown';
    const key = `${String(level)}:${String(service)}`;

    if (!this.frequencyBaselines.has(key)) {
      this.frequencyBaselines.set(key, []);
    }

    const baseline = this.frequencyBaselines.get(key);
    if (baseline) {
      baseline.push(Date.now());

      // Keep only last hour of data
      const cutoff = Date.now() - 3600000;
      const filtered = baseline.filter(timestamp => timestamp > cutoff);
      this.frequencyBaselines.set(key, filtered);
    }
  }

  private detectImmediateAnomalies(log: LogData): void {
    // Error spike detection
    this.detectErrorSpike(log);
    
    // Unusual field values
    this.detectUnusualValues(log);
    
    // Sequence anomalies
    this.detectSequenceAnomalies(log);
  }

  private detectErrorSpike(log: LogData): void {
    if (log.level !== 'error' && log.levelLabel !== 'error') return;

    const now = Date.now();
    const errorKey = 'error:global';
    const baseline = this.frequencyBaselines.get(errorKey) || [];
    
    // Count errors in last 5 minutes
    const recentErrors = baseline.filter(timestamp => now - timestamp < 300000).length;
    
    // Calculate historical average
    const historicalAverage = baseline.length > 0 ? baseline.length / ((now - baseline[0]) / 300000) : 0;
    
    if (recentErrors > historicalAverage * this.options.alertThresholds.errorSpike) {
      const anomaly: AnomalyDetection = {
        id: `error_spike_${now}`,
        type: 'frequency',
        description: `Error spike detected: ${recentErrors} errors in 5 minutes (${historicalAverage.toFixed(1)} average)`,
        severity: 'high',
        confidence: 0.9,
        detectedAt: now,
        affectedLogs: [log],
        baseline: { 
          mean: historicalAverage,
          count: baseline.length,
          stdDev: 0,
          min: historicalAverage,
          max: historicalAverage
        },
        currentValue: recentErrors,
        suggestions: [
          'Check recent deployments',
          'Review system resources',
          'Examine error patterns'
        ]
      };

      this.emit('anomalyDetected', anomaly);
    }
  }

  private detectUnusualValues(log: LogData): void {
    // Response time anomalies
    if (log.responseTime && typeof log.responseTime === 'number') {
      this.detectResponseTimeAnomaly(log);
    }

    // Memory usage anomalies
    if (log.memory && typeof log.memory === 'object') {
      this.detectMemoryAnomaly(log);
    }
  }

  private detectResponseTimeAnomaly(log: LogData): void {
    const responseTime = log.responseTime;
    if (responseTime === undefined || typeof responseTime !== 'number') return;
    
    const service = log.service || log.name || 'unknown';
    const key = `response_time:${String(service)}`;

    if (!this.frequencyBaselines.has(key)) {
      this.frequencyBaselines.set(key, []);
    }

    const baseline = this.frequencyBaselines.get(key);
    if (!baseline) return;
    baseline.push(responseTime);

    if (baseline.length < 10) return; // Need baseline data

    // Calculate statistics
    const sorted = [...baseline].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const median = sorted[Math.floor(sorted.length * 0.5)];

    if (responseTime > p95 * 2) {
      const anomaly: AnomalyDetection = {
        id: `response_time_${Date.now()}`,
        type: 'value',
        description: `Unusual response time: ${responseTime}ms (P95: ${p95}ms)`,
        severity: responseTime > p95 * 5 ? 'critical' : 'medium',
        confidence: 0.8,
        detectedAt: Date.now(),
        affectedLogs: [log],
        baseline: { 
          mean: median,
          count: baseline.length,
          stdDev: 0,
          min: sorted[0],
          max: sorted[sorted.length - 1]
        },
        currentValue: responseTime,
        suggestions: [
          'Check database performance',
          'Review external API calls',
          'Monitor system resources'
        ]
      };

      this.emit('anomalyDetected', anomaly);
    }

    // Keep baseline size manageable
    if (baseline.length > 100) {
      baseline.splice(0, 50);
    }
  }

  private detectMemoryAnomaly(log: LogData): void {
    const heapUsed = log.memory?.heapUsed;
    if (!heapUsed || typeof heapUsed !== 'number') return;

    const key = 'memory:heap_used';
    if (!this.frequencyBaselines.has(key)) {
      this.frequencyBaselines.set(key, []);
    }

    const baseline = this.frequencyBaselines.get(key);
    if (!baseline) return;
    baseline.push(heapUsed);

    if (baseline.length < 20) return;

    const average = baseline.reduce((a, b) => a + b, 0) / baseline.length;
    const stdDev = Math.sqrt(
      baseline.reduce((sq, n) => sq + Math.pow(n - average, 2), 0) / baseline.length
    );

    if (heapUsed > average + (3 * stdDev)) {
      const anomaly: AnomalyDetection = {
        id: `memory_spike_${Date.now()}`,
        type: 'value',
        description: `Memory usage spike: ${Math.round(heapUsed / 1024 / 1024)}MB (avg: ${Math.round(average / 1024 / 1024)}MB)`,
        severity: 'high',
        confidence: 0.85,
        detectedAt: Date.now(),
        affectedLogs: [log],
        baseline: { 
          mean: average,
          count: baseline.length,
          stdDev: stdDev,
          min: Math.min(...baseline),
          max: Math.max(...baseline)
        },
        currentValue: Math.round(heapUsed / 1024 / 1024),
        suggestions: [
          'Check for memory leaks',
          'Review large object allocations',
          'Monitor garbage collection'
        ]
      };

      this.emit('anomalyDetected', anomaly);
    }

    if (baseline.length > 50) {
      baseline.splice(0, 25);
    }
  }

  private detectSequenceAnomalies(log: LogData): void {
    const logRecord = log as Record<string, unknown>;
    const eventType = String(logRecord.event || logRecord.action || logRecord.type || '');
    if (!eventType) return;

    const key = `sequence:${eventType}`;
    const now = Date.now();
    const lastSeen = this.sequencePatterns.get(key) || 0;
    const timeDiff = now - lastSeen;

    this.sequencePatterns.set(key, now);

    // Detect unexpected event timing
    if (lastSeen > 0) {
      // If this event typically happens every X minutes but now it's been much longer
      const expectedInterval = this.getExpectedInterval(eventType);
      if (expectedInterval > 0 && timeDiff > expectedInterval * 3) {
        const anomaly: AnomalyDetection = {
          id: `sequence_gap_${now}`,
          type: 'sequence',
          description: `Unexpected gap in ${eventType} events: ${Math.round(timeDiff / 60000)} minutes (expected: ${Math.round(expectedInterval / 60000)} minutes)`,
          severity: 'medium',
          confidence: 0.7,
          detectedAt: now,
          affectedLogs: [log],
          baseline: { mean: expectedInterval, count: 1, stdDev: 0, min: expectedInterval, max: expectedInterval },
          currentValue: timeDiff
        };

        this.emit('anomalyDetected', anomaly);
      }
    }
  }

  private getExpectedInterval(eventType: string): number {
    // This would typically be learned from historical data
    // For now, using heuristics
    const intervals: Record<string, number> = {
      'heartbeat': 30000,
      'health_check': 60000,
      'backup': 3600000,
      'cleanup': 7200000
    };

    return intervals[eventType] || 0;
  }

  private startPeriodicAnalysis(): void {
    // BUG-NEW-001 FIX: Store interval IDs to allow cleanup in destroy()
    this.periodicAnalysisIntervalId = setInterval(() => {
      this.runPeriodicAnalysis();
    }, 60000); // Every minute

    this.patternDiscoveryIntervalId = setInterval(() => {
      this.discoverNewPatterns();
    }, 300000); // Every 5 minutes
  }

  private runPeriodicAnalysis(): void {
    this.analyzeCorrelations();
    this.detectTrendAnomalies();
    this.cleanupOldData();
  }

  private analyzeCorrelations(): void {
    // Find correlations between different log types/services
    const recentLogs = this.logHistory.filter(
      log => Date.now() - (log._timestamp as number) < 3600000 // Last hour
    );

    for (let i = 0; i < recentLogs.length - 1; i++) {
      for (let j = i + 1; j < recentLogs.length; j++) {
        const log1 = recentLogs[i];
        const log2 = recentLogs[j];
        
        const timestamp1 = (log1 as Record<string, unknown>)._timestamp as number;
        const timestamp2 = (log2 as Record<string, unknown>)._timestamp as number;
        
        if (Math.abs(timestamp1 - timestamp2) < 60000) {
          this.updateCorrelation(log1, log2);
        }
      }
    }
  }

  private updateCorrelation(log1: LogData, log2: LogData): void {
    const log1Record = log1 as Record<string, unknown>;
    const log2Record = log2 as Record<string, unknown>;
    
    const key1 = `${String(log1.level || log1Record.levelLabel)}:${String(log1.service || log1.name || 'unknown')}`;
    const key2 = `${String(log2.level || log2Record.levelLabel)}:${String(log2.service || log2.name || 'unknown')}`;

    if (!this.correlationMatrix.has(key1)) {
      this.correlationMatrix.set(key1, new Map());
    }

    const correlations = this.correlationMatrix.get(key1);
    if (!correlations) return;
    correlations.set(key2, (correlations.get(key2) || 0) + 1);
  }

  private detectTrendAnomalies(): void {
    // Analyze trends in log frequencies
    for (const [key, timestamps] of this.frequencyBaselines) {
      if (timestamps.length < 10) continue;

      const now = Date.now();
      const hour1 = timestamps.filter(t => now - t < 3600000).length;
      const hour2 = timestamps.filter(t => now - t < 7200000 && now - t >= 3600000).length;
      const hour3 = timestamps.filter(t => now - t < 10800000 && now - t >= 7200000).length;

      if (hour2 > 0 && hour3 > 0) {
        const trend1 = hour1 / hour2;
        const trend2 = hour2 / hour3;

        if (trend1 > 3 && trend2 > 1.5) {
          const anomaly: AnomalyDetection = {
            id: `trend_spike_${now}`,
            type: 'frequency',
            description: `Increasing trend detected for ${key}: ${hour3} → ${hour2} → ${hour1}`,
            severity: 'medium',
            confidence: 0.75,
            detectedAt: now,
            affectedLogs: [],
            baseline: { 
              mean: (hour1 + hour2 + hour3) / 3,
              count: timestamps.length,
              stdDev: 0,
              min: Math.min(hour1, hour2, hour3),
              max: Math.max(hour1, hour2, hour3)
            },
            currentValue: hour1
          };

          this.emit('anomalyDetected', anomaly);
        }
      }
    }
  }

  private discoverNewPatterns(): void {
    // Simple pattern discovery from recent logs
    const recentLogs = this.logHistory.filter(
      log => {
        const logRecord = log as Record<string, unknown>;
        return Date.now() - (logRecord._timestamp as number) < 3600000 && !(logRecord._analyzed as boolean);
      }
    );

    const errorLogs = recentLogs.filter(
      log => {
        const logRecord = log as Record<string, unknown>;
        return log.level === 'error' || logRecord.levelLabel === 'error';
      }
    );

    if (errorLogs.length >= this.options.minOccurrences) {
      this.findCommonErrorPatterns(errorLogs);
    }

    // Mark logs as analyzed
    recentLogs.forEach(log => {
      (log as Record<string, unknown>)._analyzed = true;
    });
  }

  private findCommonErrorPatterns(errorLogs: LogData[]): void {
    const patterns: Map<string, LogData[]> = new Map();

    for (const log of errorLogs) {
      const text = this.extractSearchableText(log);
      const words = text.toLowerCase().match(/\w+/g) || [];

      // Look for recurring word combinations
      for (let i = 0; i < words.length - 1; i++) {
        const pattern = `${words[i]} ${words[i + 1]}`;
        if (!patterns.has(pattern)) {
          patterns.set(pattern, []);
        }
        const patternLogs = patterns.get(pattern);
        if (patternLogs) {
          patternLogs.push(log);
        }
      }
    }

    // Find patterns that occur frequently enough
    for (const [pattern, logs] of patterns) {
      if (logs.length >= this.options.minOccurrences) {
        const id = `discovered_${Date.now()}_${pattern.replace(/\s+/g, '_')}`;
        
        if (!this.patterns.has(id)) {
          const newPattern: LogPattern = {
            id,
            name: `Discovered Pattern: ${pattern}`,
            description: `Auto-discovered error pattern`,
            pattern: new RegExp(pattern.replace(/\s+/g, '\\s+'), 'i'),
            category: 'error',
            severity: 'medium',
            frequency: logs.length,
            firstSeen: Math.min(...logs.map(log => (log as Record<string, unknown>)._timestamp as number || 0)),
            lastSeen: Math.max(...logs.map(log => (log as Record<string, unknown>)._timestamp as number || 0)),
            occurrences: logs.length,
            samples: logs.slice(0, 5).map(log => this.sanitizeLogForSample(log))
          };

          this.patterns.set(id, newPattern);
          
          this.emit('newPatternDiscovered', newPattern);

          // Limit number of patterns
          if (this.patterns.size > this.options.maxPatterns) {
            this.pruneOldPatterns();
          }
        }
      }
    }
  }

  private pruneOldPatterns(): void {
    const sortedPatterns = Array.from(this.patterns.values())
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, this.options.maxPatterns);

    this.patterns.clear();
    sortedPatterns.forEach(pattern => {
      this.patterns.set(pattern.id, pattern);
    });
  }

  private cleanupOldData(): void {
    const cutoff = Date.now() - 86400000; // 24 hours

    // Clean frequency baselines
    for (const [key, timestamps] of this.frequencyBaselines) {
      const filtered = timestamps.filter(timestamp => timestamp > cutoff);
      if (filtered.length === 0) {
        this.frequencyBaselines.delete(key);
      } else {
        this.frequencyBaselines.set(key, filtered);
      }
    }

    // Clean sequence patterns
    for (const [key, timestamp] of this.sequencePatterns) {
      if (timestamp < cutoff) {
        this.sequencePatterns.delete(key);
      }
    }
  }

  getPatterns(): LogPattern[] {
    return Array.from(this.patterns.values());
  }

  getPatternById(id: string): LogPattern | undefined {
    return this.patterns.get(id);
  }

  getAnalyticsReport(): {
    totalPatterns: number;
    activePatterns: number;
    topPatterns: LogPattern[];
    recentAnomalies: number;
    systemHealth: 'good' | 'warning' | 'critical';
  } {
    const now = Date.now();
    const activePatterns = Array.from(this.patterns.values())
      .filter(pattern => now - pattern.lastSeen < 3600000);

    const topPatterns = activePatterns
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 10);

    const errorPatterns = activePatterns.filter(
      pattern => pattern.category === 'error' && pattern.severity === 'critical'
    );

    let systemHealth: 'good' | 'warning' | 'critical' = 'good';
    if (errorPatterns.length > 5) {
      systemHealth = 'critical';
    } else if (errorPatterns.length > 2) {
      systemHealth = 'warning';
    }

    return {
      totalPatterns: this.patterns.size,
      activePatterns: activePatterns.length,
      topPatterns,
      recentAnomalies: 0, // Would track recent anomaly count
      systemHealth
    };
  }

  // BUG-NEW-001 FIX: Add destroy() method to properly clean up resources
  destroy(): void {
    // Clear periodic analysis interval
    if (this.periodicAnalysisIntervalId) {
      clearInterval(this.periodicAnalysisIntervalId);
      this.periodicAnalysisIntervalId = undefined;
    }

    // Clear pattern discovery interval
    if (this.patternDiscoveryIntervalId) {
      clearInterval(this.patternDiscoveryIntervalId);
      this.patternDiscoveryIntervalId = undefined;
    }

    // Clear all data structures
    this.patterns.clear();
    this.logHistory = [];
    this.frequencyBaselines.clear();
    this.sequencePatterns.clear();
    this.correlationMatrix.clear();

    // Remove all event listeners
    this.removeAllListeners();
  }
}