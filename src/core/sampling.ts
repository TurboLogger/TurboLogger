import { EventEmitter } from 'events';

export interface SamplingRule {
  name: string;
  condition: SamplingCondition;
  rate: number;
  priority: number;
  tags?: Record<string, string>;
}

export interface SamplingCondition {
  level?: string | string[];
  service?: string | string[];
  field?: string;
  pattern?: RegExp;
  custom?: (log: Record<string, unknown>) => boolean;
  timeWindow?: {
    start: string;
    end: string;
  };
  rateLimit?: {
    maxPerSecond: number;
    maxPerMinute: number;
  };
}

export interface SamplingStats {
  totalLogs: number;
  sampledLogs: number;
  droppedLogs: number;
  samplingRate: number;
  ruleStats: Record<string, {
    matched: number;
    sampled: number;
    dropped: number;
  }>;
}

export interface AdaptiveSamplingOptions {
  enabled: boolean;
  targetRate: number;
  adjustmentInterval: number;
  minRate: number;
  maxRate: number;
  memoryThreshold: number;
  cpuThreshold: number;
}

export class LogSampler extends EventEmitter {
  private rules: SamplingRule[] = [];
  private stats: SamplingStats;
  private rateLimiters: Map<string, number[]> = new Map();
  private adaptiveOptions?: AdaptiveSamplingOptions;
  private currentAdaptiveRate: number = 1.0;
  private lastAdjustment: number = Date.now();

  constructor(adaptiveOptions?: AdaptiveSamplingOptions) {
    super();
    this.adaptiveOptions = adaptiveOptions;
    this.currentAdaptiveRate = adaptiveOptions?.targetRate || 1.0;
    
    this.stats = {
      totalLogs: 0,
      sampledLogs: 0,
      droppedLogs: 0,
      samplingRate: 1.0,
      ruleStats: {}
    };

    if (adaptiveOptions?.enabled) {
      this.startAdaptiveAdjustment();
    }
  }

  addRule(rule: SamplingRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
    this.stats.ruleStats[rule.name] = {
      matched: 0,
      sampled: 0,
      dropped: 0
    };
  }

  removeRule(name: string): void {
    this.rules = this.rules.filter(rule => rule.name !== name);
    delete this.stats.ruleStats[name];
  }

  shouldSample(log: Record<string, unknown>): { sample: boolean; rule?: string; reason?: string } {
    this.stats.totalLogs++;

    // Apply adaptive sampling first
    if (this.adaptiveOptions?.enabled) {
      if (Math.random() > this.currentAdaptiveRate) {
        this.stats.droppedLogs++;
        return { 
          sample: false, 
          rule: 'adaptive', 
          reason: `Adaptive rate: ${this.currentAdaptiveRate.toFixed(3)}` 
        };
      }
    }

    // Check rules in priority order
    for (const rule of this.rules) {
      if (this.matchesCondition(log, rule.condition)) {
        this.stats.ruleStats[rule.name].matched++;

        // Check rate limiting
        if (rule.condition.rateLimit) {
          if (!this.checkRateLimit(rule.name, rule.condition.rateLimit)) {
            this.stats.ruleStats[rule.name].dropped++;
            this.stats.droppedLogs++;
            return { 
              sample: false, 
              rule: rule.name, 
              reason: 'Rate limit exceeded' 
            };
          }
        }

        // Apply sampling rate
        if (Math.random() <= rule.rate) {
          this.stats.ruleStats[rule.name].sampled++;
          this.stats.sampledLogs++;
          return { sample: true, rule: rule.name };
        } else {
          this.stats.ruleStats[rule.name].dropped++;
          this.stats.droppedLogs++;
          return { 
            sample: false, 
            rule: rule.name, 
            reason: `Sampling rate: ${rule.rate}` 
          };
        }
      }
    }

    // Default: sample everything that doesn't match any rule
    this.stats.sampledLogs++;
    return { sample: true };
  }

  private matchesCondition(log: Record<string, unknown>, condition: SamplingCondition): boolean {
    // Level matching
    if (condition.level) {
      const levels = Array.isArray(condition.level) ? condition.level : [condition.level];
      if (!levels.includes(log.level as string) && !levels.includes(log.levelLabel as string)) {
        return false;
      }
    }

    // Service matching
    if (condition.service) {
      const services = Array.isArray(condition.service) ? condition.service : [condition.service];
      if (!services.includes(log.service as string) && !services.includes(log.name as string)) {
        return false;
      }
    }

    // Field existence
    if (condition.field && !Object.prototype.hasOwnProperty.call(log, condition.field)) {
      return false;
    }

    // Pattern matching
    if (condition.pattern) {
      const searchText = (log.msg as string) || (log.message as string) || JSON.stringify(log);
      if (!condition.pattern.test(searchText)) {
        return false;
      }
    }

    // Custom condition
    if (condition.custom && !condition.custom(log)) {
      return false;
    }

    // Time window
    if (condition.timeWindow) {
      const now = new Date();
      const currentTime = now.getHours() * 100 + now.getMinutes();
      const start = this.parseTime(condition.timeWindow.start);
      const end = this.parseTime(condition.timeWindow.end);
      
      if (start <= end) {
        if (currentTime < start || currentTime > end) {
          return false;
        }
      } else {
        // Overnight window (e.g., 22:00 to 06:00)
        if (currentTime < start && currentTime > end) {
          return false;
        }
      }
    }

    return true;
  }

  private parseTime(timeStr: string): number {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 100 + minutes;
  }

  private checkRateLimit(ruleName: string, rateLimit: NonNullable<SamplingCondition['rateLimit']>): boolean {
    const now = Date.now();
    const key = `${ruleName}:${Math.floor(now / 1000)}`; // Per-second key
    const minuteKey = `${ruleName}:${Math.floor(now / 60000)}`; // Per-minute key

    // Clean old entries
    this.cleanRateLimiters(now);

    // Check per-second limit
    if (rateLimit.maxPerSecond) {
      const secondCount = this.rateLimiters.get(key) || [];
      if (secondCount.length >= rateLimit.maxPerSecond) {
        return false;
      }
      secondCount.push(now);
      this.rateLimiters.set(key, secondCount);
    }

    // Check per-minute limit
    if (rateLimit.maxPerMinute) {
      const minuteCount = this.rateLimiters.get(minuteKey) || [];
      if (minuteCount.length >= rateLimit.maxPerMinute) {
        return false;
      }
      minuteCount.push(now);
      this.rateLimiters.set(minuteKey, minuteCount);
    }

    return true;
  }

  private cleanRateLimiters(now: number): void {
    const cutoffSecond = now - 2000; // Keep 2 seconds of data
    const cutoffMinute = now - 120000; // Keep 2 minutes of data

    for (const [key, timestamps] of this.rateLimiters.entries()) {
      const cutoff = key.includes(':') && key.split(':')[1].length > 10 ? cutoffMinute : cutoffSecond;
      const filtered = timestamps.filter(ts => ts > cutoff);
      
      if (filtered.length === 0) {
        this.rateLimiters.delete(key);
      } else {
        this.rateLimiters.set(key, filtered);
      }
    }
  }

  private startAdaptiveAdjustment(): void {
    if (!this.adaptiveOptions) return;

    const interval = this.adaptiveOptions.adjustmentInterval;
    
    setInterval(() => {
      this.adjustAdaptiveRate();
    }, interval);
  }

  private adjustAdaptiveRate(): void {
    if (!this.adaptiveOptions) return;

    const now = Date.now();
    const timeSinceLastAdjustment = now - this.lastAdjustment;
    
    // Get system metrics
    const memoryUsage = process.memoryUsage();
    const memoryPercent = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;
    
    // Simple CPU estimation based on event loop delay
    const startTime = process.hrtime.bigint();
    setImmediate(() => {
      const endTime = process.hrtime.bigint();
      const delay = Number(endTime - startTime) / 1000000; // Convert to ms
      const cpuLoad = Math.min(delay / 10, 100); // Rough approximation

      // Adjust sampling rate based on system load
      let adjustment = 0;
      
      const adaptiveOpts = this.adaptiveOptions;
      if (!adaptiveOpts) return;

      if (memoryPercent > adaptiveOpts.memoryThreshold) {
        adjustment -= 0.1; // Reduce sampling if memory is high
      }
      
      if (cpuLoad > adaptiveOpts.cpuThreshold) {
        adjustment -= 0.1; // Reduce sampling if CPU is high
      }
      
      // Current sampling efficiency
      const currentEfficiency = this.stats.totalLogs > 0 
        ? this.stats.sampledLogs / this.stats.totalLogs 
        : 1;
      
      if (currentEfficiency < adaptiveOpts.targetRate) {
        adjustment += 0.05; // Increase sampling if below target
      } else if (currentEfficiency > adaptiveOpts.targetRate + 0.1) {
        adjustment -= 0.05; // Decrease sampling if well above target
      }

      // Apply adjustment with bounds
      this.currentAdaptiveRate = Math.max(
        adaptiveOpts.minRate,
        Math.min(
          adaptiveOpts.maxRate,
          this.currentAdaptiveRate + adjustment
        )
      );

      this.emit('adaptiveAdjustment', {
        previousRate: this.currentAdaptiveRate - adjustment,
        newRate: this.currentAdaptiveRate,
        memoryPercent,
        cpuLoad,
        adjustment,
        timeSinceLastAdjustment
      });
    });

    this.lastAdjustment = now;
  }

  getStats(): SamplingStats {
    const totalLogs = this.stats.totalLogs;
    return {
      ...this.stats,
      samplingRate: totalLogs > 0 ? this.stats.sampledLogs / totalLogs : 1.0
    };
  }

  resetStats(): void {
    this.stats = {
      totalLogs: 0,
      sampledLogs: 0,
      droppedLogs: 0,
      samplingRate: 1.0,
      ruleStats: {}
    };

    // Reinitialize rule stats
    for (const rule of this.rules) {
      this.stats.ruleStats[rule.name] = {
        matched: 0,
        sampled: 0,
        dropped: 0
      };
    }
  }

  // Predefined sampling strategies
  static createHighVolumeStrategy(): SamplingRule[] {
    return [
      {
        name: 'always-sample-errors',
        condition: { level: ['error', 'fatal'] },
        rate: 1.0,
        priority: 100
      },
      {
        name: 'sample-warnings',
        condition: { level: 'warn' },
        rate: 0.5,
        priority: 80
      },
      {
        name: 'rate-limit-debug',
        condition: { 
          level: 'debug',
          rateLimit: { maxPerSecond: 10, maxPerMinute: 100 }
        },
        rate: 0.1,
        priority: 20
      },
      {
        name: 'business-hours-info',
        condition: {
          level: 'info',
          timeWindow: { start: '09:00', end: '17:00' }
        },
        rate: 0.3,
        priority: 40
      },
      {
        name: 'off-hours-info',
        condition: {
          level: 'info',
          timeWindow: { start: '17:01', end: '08:59' }
        },
        rate: 0.1,
        priority: 30
      }
    ];
  }

  static createDevelopmentStrategy(): SamplingRule[] {
    return [
      {
        name: 'sample-all-errors',
        condition: { level: ['error', 'fatal'] },
        rate: 1.0,
        priority: 100
      },
      {
        name: 'sample-most-warnings',
        condition: { level: 'warn' },
        rate: 0.8,
        priority: 80
      },
      {
        name: 'sample-some-info',
        condition: { level: 'info' },
        rate: 0.5,
        priority: 60
      },
      {
        name: 'limit-debug-spam',
        condition: { 
          level: 'debug',
          rateLimit: { maxPerSecond: 50, maxPerMinute: 3000 }
        },
        rate: 0.3,
        priority: 40
      }
    ];
  }

  static createProductionStrategy(): SamplingRule[] {
    return [
      {
        name: 'always-errors',
        condition: { level: ['error', 'fatal'] },
        rate: 1.0,
        priority: 100
      },
      {
        name: 'critical-patterns',
        condition: { pattern: /payment|security|auth|critical/i },
        rate: 1.0,
        priority: 90
      },
      {
        name: 'warnings',
        condition: { level: 'warn' },
        rate: 0.7,
        priority: 70
      },
      {
        name: 'info-throttled',
        condition: { 
          level: 'info',
          rateLimit: { maxPerSecond: 100, maxPerMinute: 1000 }
        },
        rate: 0.2,
        priority: 50
      },
      {
        name: 'debug-minimal',
        condition: { level: 'debug' },
        rate: 0.05,
        priority: 10
      }
    ];
  }
}