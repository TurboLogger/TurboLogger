import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  baggage?: Record<string, string>;
  sampled: boolean;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  tags: Record<string, string | number | boolean>;
  logs: Array<{
    timestamp: number;
    fields: Record<string, unknown>;
  }>;
  status: 'ok' | 'error' | 'timeout';
}

export interface JaegerSpan {
  traceID: string;
  spanID: string;
  parentSpanID?: string;
  operationName: string;
  startTime: number;
  duration: number;
  tags: Array<{ key: string; value: string | number | boolean }>;
  logs: Array<{
    timestamp: number;
    fields: Array<{ key: string; value: unknown }>;
  }>;
  process: {
    serviceName: string;
    tags: Array<{ key: string; value: string | number | boolean }>;
  };
}

export interface TracingOptions {
  serviceName: string;
  sampler: 'always' | 'never' | 'probabilistic' | 'adaptive';
  probability?: number;
  jaegerEndpoint?: string;
  maxSpans?: number;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

export class TurboTracer {
  private options: TracingOptions;
  private spans: Map<string, Span> = new Map();
  private completedSpans: Span[] = [];
  private maxCompletedSpans: number;

  constructor(options: TracingOptions) {
    this.options = {
      probability: 0.1,
      maxSpans: 10000,
      ...options
    };
    this.maxCompletedSpans = this.options.maxSpans!;
  }

  generateTraceId(): string {
    return randomBytes(16).toString('hex');
  }

  generateSpanId(): string {
    return randomBytes(8).toString('hex');
  }

  shouldSample(): boolean {
    switch (this.options.sampler) {
      case 'always':
        return true;
      case 'never':
        return false;
      case 'probabilistic':
        return Math.random() < (this.options.probability || 0.1);
      case 'adaptive':
        // Simple adaptive sampling based on current load
        const spanCount = this.spans.size;
        const threshold = this.maxCompletedSpans * 0.8;
        return spanCount < threshold || Math.random() < 0.01;
      default:
        return false;
    }
  }

  startSpan(operationName: string, parentContext?: TraceContext): Span {
    const shouldSample = this.shouldSample();
    const traceId = parentContext?.traceId || this.generateTraceId();
    const spanId = this.generateSpanId();
    const parentSpanId = parentContext?.spanId;

    const span: Span = {
      traceId,
      spanId,
      parentSpanId,
      operationName,
      startTime: Date.now(),
      tags: {
        'service.name': this.options.serviceName,
        'span.kind': 'internal',
        sampled: shouldSample
      },
      logs: [],
      status: 'ok'
    };

    if (shouldSample) {
      this.spans.set(spanId, span);
    }

    return span;
  }

  finishSpan(span: Span): void {
    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;

    this.spans.delete(span.spanId);
    
    if (span.tags.sampled) {
      this.completedSpans.push(span);
      
      // Keep only the most recent spans
      if (this.completedSpans.length > this.maxCompletedSpans) {
        this.completedSpans.shift();
      }
    }

    this.exportSpan(span);
  }

  setTag(span: Span, key: string, value: string | number | boolean): void {
    span.tags[key] = value;
  }

  log(span: Span, fields: Record<string, unknown>): void {
    span.logs.push({
      timestamp: Date.now(),
      fields
    });
  }

  setError(span: Span, error: Error): void {
    span.status = 'error';
    span.tags['error'] = true;
    span.tags['error.object'] = error.constructor.name;
    span.tags['error.message'] = error.message;
    
    this.log(span, {
      level: 'error',
      message: error.message,
      stack: error.stack
    });
  }

  withSpan<T>(operationName: string, fn: (span: Span) => T): T {
    const currentContext = this.getCurrentContext();
    const span = this.startSpan(operationName, currentContext);
    
    const traceContext: TraceContext = {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      sampled: typeof span.tags.sampled === 'boolean' ? span.tags.sampled : true
    };

    try {
      return traceStorage.run(traceContext, () => {
        try {
          const result = fn(span);
          if (result instanceof Promise) {
            return result.finally(() => this.finishSpan(span)) as T;
          }
          this.finishSpan(span);
          return result;
        } catch (error) {
          this.setError(span, error as Error);
          this.finishSpan(span);
          throw error;
        }
      });
    } catch (error) {
      this.setError(span, error as Error);
      this.finishSpan(span);
      throw error;
    }
  }

  async withSpanAsync<T>(operationName: string, fn: (span: Span) => Promise<T>): Promise<T> {
    const currentContext = this.getCurrentContext();
    const span = this.startSpan(operationName, currentContext);
    
    const traceContext: TraceContext = {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      sampled: typeof span.tags.sampled === 'boolean' ? span.tags.sampled : true
    };

    try {
      return await traceStorage.run(traceContext, async () => {
        try {
          const result = await fn(span);
          this.finishSpan(span);
          return result;
        } catch (error) {
          this.setError(span, error as Error);
          this.finishSpan(span);
          throw error;
        }
      });
    } catch (error) {
      this.setError(span, error as Error);
      this.finishSpan(span);
      throw error;
    }
  }

  getCurrentContext(): TraceContext | undefined {
    return traceStorage.getStore();
  }

  injectContext(span: Span): Record<string, string> {
    return {
      'x-trace-id': span.traceId,
      'x-span-id': span.spanId,
      'x-parent-span-id': span.parentSpanId || '',
      'x-sampled': span.tags.sampled ? '1' : '0'
    };
  }

  extractContext(headers: Record<string, string>): TraceContext | undefined {
    const traceId = headers['x-trace-id'];
    const spanId = headers['x-span-id'];
    const parentSpanId = headers['x-parent-span-id'];
    const sampled = headers['x-sampled'] === '1';

    if (!traceId || !spanId) {
      return undefined;
    }

    return {
      traceId,
      spanId,
      parentSpanId: parentSpanId || undefined,
      sampled
    };
  }

  private exportSpan(span: Span): void {
    if (this.options.jaegerEndpoint && span.tags.sampled) {
      this.sendToJaeger(span).catch(error => {
        console.error('Failed to export span to Jaeger:', error);
      });
    }
  }

  private async sendToJaeger(span: Span): Promise<void> {
    try {
      const jaegerSpan = this.convertToJaegerFormat(span);

      // FIX NEW-008: Check if fetch is available (Node.js 18+)
      // Use https module as fallback for older Node versions
      if (typeof fetch === 'undefined') {
        await this.sendToJaegerWithHttps(span, jaegerSpan);
        return;
      }

      // Simplified Jaeger HTTP API call
      const response = await fetch(`${this.options.jaegerEndpoint}/api/traces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          data: [{
            traceID: span.traceId,
            spans: [jaegerSpan],
            processes: {
              p1: {
                serviceName: this.options.serviceName,
                tags: []
              }
            }
          }]
        })
      });

      if (!response.ok) {
        throw new Error(`Jaeger export failed: ${response.statusText}`);
      }
    } catch (error) {
      // Silently fail for now, could add retry logic
    }
  }

  // FIX NEW-008: Fallback method using https module for Node.js < 18
  private async sendToJaegerWithHttps(span: Span, jaegerSpan: JaegerSpan): Promise<void> {
    const https = require('https');
    const { URL } = require('url');

    return new Promise((resolve, reject) => {
      const url = new URL(`${this.options.jaegerEndpoint}/api/traces`);
      const body = JSON.stringify({
        data: [{
          traceID: span.traceId,
          spans: [jaegerSpan],
          processes: {
            p1: {
              serviceName: this.options.serviceName,
              tags: []
            }
          }
        }]
      });

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = https.request(options, (res: any) => {
        let data = '';
        res.on('data', (chunk: any) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Jaeger export failed: ${res.statusCode}`));
          }
        });
      });

      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Jaeger request timeout'));
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private convertToJaegerFormat(span: Span): JaegerSpan {
    return {
      traceID: span.traceId,
      spanID: span.spanId,
      parentSpanID: span.parentSpanId || '0',
      operationName: span.operationName,
      startTime: span.startTime * 1000, // Jaeger expects microseconds
      duration: (span.duration || 0) * 1000,
      tags: Object.entries(span.tags).map(([key, value]) => ({
        key,
        type: typeof value === 'string' ? 'string' : 'number',
        value: String(value)
      })),
      logs: span.logs.map(log => ({
        timestamp: log.timestamp * 1000,
        fields: Object.entries(log.fields).map(([key, value]) => ({
          key,
          value: String(value)
        }))
      })),
      process: {
        serviceName: this.options.serviceName,
        tags: []
      }
    };
  }

  getCompletedSpans(): Span[] {
    return [...this.completedSpans];
  }

  getActiveSpans(): Span[] {
    return Array.from(this.spans.values());
  }

  clear(): void {
    this.spans.clear();
    this.completedSpans.length = 0;
  }

  destroy(): void {
    this.clear();
  }
}

// Global tracer instance
let globalTracer: TurboTracer | undefined;

export function initializeTracing(options: TracingOptions): TurboTracer {
  globalTracer = new TurboTracer(options);
  return globalTracer;
}

export function getTracer(): TurboTracer | undefined {
  return globalTracer;
}

export function trace<T>(operationName: string, fn: (span: Span) => T): T {
  if (!globalTracer) {
    return fn({} as Span);
  }
  return globalTracer.withSpan(operationName, fn);
}

export async function traceAsync<T>(operationName: string, fn: (span: Span) => Promise<T>): Promise<T> {
  if (!globalTracer) {
    return fn({} as Span);
  }
  return globalTracer.withSpanAsync(operationName, fn);
}