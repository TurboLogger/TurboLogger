import { EventEmitter } from 'events';
import * as http from 'http';
// import { createHash } from 'crypto';

export interface MetricDefinition {
  name: string;
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
  help: string;
  labels?: string[];
  buckets?: number[]; // For histograms
}

export interface MetricValue {
  name: string;
  value: number;
  labels?: Record<string, string>;
  timestamp: number;
}

export interface CounterMetric extends MetricDefinition {
  type: 'counter';
}

export interface GaugeMetric extends MetricDefinition {
  type: 'gauge';
}

export interface HistogramMetric extends MetricDefinition {
  type: 'histogram';
  buckets: number[];
}

class MetricRegistry {
  private metrics: Map<string, MetricDefinition> = new Map();
  private values: Map<string, MetricValue[]> = new Map();
  private emitter = new EventEmitter();

  register(metric: MetricDefinition): void {
    const key = this.getMetricKey(metric.name, metric.labels);
    this.metrics.set(key, metric);
    
    if (!this.values.has(key)) {
      this.values.set(key, []);
    }
  }

  increment(name: string, value: number = 1, labels?: Record<string, string>): void {
    const key = this.getMetricKey(name, Object.keys(labels || {}));
    const metric = this.metrics.get(key);
    
    if (!metric || metric.type !== 'counter') {
      throw new Error(`Counter metric '${name}' not found or wrong type`);
    }

    this.recordValue(name, value, labels);
    this.emitter.emit('metric', { name, value, labels, type: 'counter' });
  }

  gauge(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.getMetricKey(name, Object.keys(labels || {}));
    const metric = this.metrics.get(key);
    
    if (!metric || metric.type !== 'gauge') {
      throw new Error(`Gauge metric '${name}' not found or wrong type`);
    }

    this.recordValue(name, value, labels, true); // Replace for gauges
    this.emitter.emit('metric', { name, value, labels, type: 'gauge' });
  }

  observe(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.getMetricKey(name, Object.keys(labels || {}));
    const metric = this.metrics.get(key);
    
    if (!metric || (metric.type !== 'histogram' && metric.type !== 'summary')) {
      throw new Error(`Observation metric '${name}' not found or wrong type`);
    }

    this.recordValue(name, value, labels);
    this.emitter.emit('metric', { name, value, labels, type: metric.type });
  }

  private recordValue(name: string, value: number, labels?: Record<string, string>, replace: boolean = false): void {
    const valueKey = this.getValueKey(name, labels);
    
    if (!this.values.has(valueKey)) {
      this.values.set(valueKey, []);
    }

    const values = this.values.get(valueKey)!;
    const metricValue: MetricValue = {
      name,
      value,
      labels,
      timestamp: Date.now()
    };

    if (replace) {
      // For gauges, replace the last value
      if (values.length > 0) {
        values[values.length - 1] = metricValue;
      } else {
        values.push(metricValue);
      }
    } else {
      values.push(metricValue);
      
      // Keep only last 10000 values per metric
      if (values.length > 10000) {
        values.shift();
      }
    }
  }

  private getMetricKey(name: string, labels?: string[]): string {
    return labels ? `${name}:${labels.sort().join(',')}` : name;
  }

  private getValueKey(name: string, labels?: Record<string, string>): string {
    if (!labels) return name;
    
    const labelString = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    
    return `${name}{${labelString}}`;
  }

  getMetrics(): MetricDefinition[] {
    return Array.from(this.metrics.values());
  }

  getValues(name?: string): MetricValue[] {
    if (name) {
      const results: MetricValue[] = [];
      for (const [key, values] of this.values) {
        if (key.startsWith(name)) {
          results.push(...values);
        }
      }
      return results;
    }
    
    const allValues: MetricValue[] = [];
    for (const values of this.values.values()) {
      allValues.push(...values);
    }
    return allValues;
  }

  exportPrometheus(): string {
    const lines: string[] = [];
    
    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      
      const values = this.getValues(metric.name);
      for (const value of values) {
        const labelsStr = value.labels 
          ? Object.entries(value.labels)
              .map(([k, v]) => `${k}="${v}"`)
              .join(',')
          : '';
        
        const metricLine = labelsStr 
          ? `${metric.name}{${labelsStr}} ${value.value}`
          : `${metric.name} ${value.value}`;
        
        lines.push(metricLine);
      }
      lines.push('');
    }
    
    return lines.join('\n');
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.emitter.on(event, listener);
  }

  clear(): void {
    this.values.clear();
  }

  destroy(): void {
    this.emitter.removeAllListeners();
    this.metrics.clear();
    this.values.clear();
  }
}

export class TurboMetrics {
  private registry = new MetricRegistry();
  private httpServer?: ReturnType<typeof http.createServer>;

  constructor() {
    this.setupDefaultMetrics();
  }

  private setupDefaultMetrics(): void {
    // Default logging metrics
    this.registry.register({
      name: 'oxog_turbologger_logs_total',
      type: 'counter',
      help: 'Total number of log messages',
      labels: ['level', 'service']
    });

    this.registry.register({
      name: 'oxog_turbologger_log_size_bytes',
      type: 'histogram',
      help: 'Size of log messages in bytes',
      buckets: [10, 50, 100, 500, 1000, 5000, 10000]
    });

    this.registry.register({
      name: 'oxog_turbologger_transport_latency_ms',
      type: 'histogram',
      help: 'Transport write latency in milliseconds',
      labels: ['transport'],
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000]
    });

    this.registry.register({
      name: 'oxog_turbologger_errors_total',
      type: 'counter',
      help: 'Total number of logging errors',
      labels: ['type', 'transport']
    });

    this.registry.register({
      name: 'oxog_turbologger_buffer_size',
      type: 'gauge',
      help: 'Current buffer size',
      labels: ['level']
    });
  }

  counter(definition: CounterMetric): {
    inc: (value?: number, labels?: Record<string, string>) => void;
  } {
    this.registry.register(definition);
    
    return {
      inc: (value = 1, labels) => this.registry.increment(definition.name, value, labels)
    };
  }

  gauge(definition: GaugeMetric): {
    set: (value: number, labels?: Record<string, string>) => void;
  } {
    this.registry.register(definition);
    
    return {
      set: (value, labels) => this.registry.gauge(definition.name, value, labels)
    };
  }

  histogram(definition: HistogramMetric): {
    observe: (value: number, labels?: Record<string, string>) => void;
  } {
    this.registry.register(definition);
    
    return {
      observe: (value, labels) => this.registry.observe(definition.name, value, labels)
    };
  }

  // Built-in metrics for TurboLogger
  recordLog(level: string, size: number, service?: string): void {
    this.registry.increment('oxog_turbologger_logs_total', 1, { level, service: service || 'unknown' });
    this.registry.observe('oxog_turbologger_log_size_bytes', size);
  }

  recordTransportLatency(transport: string, latency: number): void {
    this.registry.observe('oxog_turbologger_transport_latency_ms', latency, { transport });
  }

  recordError(type: string, transport?: string): void {
    this.registry.increment('oxog_turbologger_errors_total', 1, { 
      type, 
      transport: transport || 'unknown' 
    });
  }

  setBufferSize(level: string, size: number): void {
    this.registry.gauge('oxog_turbologger_buffer_size', size, { level });
  }

  startPrometheusServer(port: number = 9090, endpoint: string = '/metrics'): void {
    try {
      this.httpServer = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
        if (req.url === endpoint) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(this.registry.exportPrometheus());
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });
      
      this.httpServer.listen(port, () => {
        console.log(`Prometheus metrics server listening on port ${port}`);
      });
    } catch (error) {
      console.error('Failed to start Prometheus server:', error);
    }
  }

  stopPrometheusServer(): void {
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = undefined;
    }
  }

  getMetrics(): string {
    return this.registry.exportPrometheus();
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.registry.on(event, listener);
  }

  destroy(): void {
    this.stopPrometheusServer();
    this.registry.destroy();
  }
}