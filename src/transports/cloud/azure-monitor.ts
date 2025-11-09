import { Transport, TransportOptions, LogData } from '../../core/transport';
import * as https from 'https';
// import * as crypto from 'crypto'; // Not used
import * as zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);

export interface AzureMonitorTransportOptions extends TransportOptions {
  connectionString?: string;
  instrumentationKey?: string;
  ingestionEndpoint?: string;
  liveEndpoint?: string;
  batchSize?: number;
  batchInterval?: number;
  maxRetries?: number;
  enableAutoCollectConsole?: boolean;
  enableAutoCollectExceptions?: boolean;
  enableAutoCollectPerformance?: boolean;
  samplingPercentage?: number;
  disableStatsbeat?: boolean;
  customProperties?: Record<string, string>;
  cloudRole?: string;
  cloudRoleInstance?: string;
}

// AzureTelemetryItem interface removed - using AzureEnvelope instead

interface AzureEnvelope {
  ver: number;
  name: string;
  time: string;
  sampleRate: number;
  iKey: string;
  tags: Record<string, string>;
  data: {
    baseType: string;
    baseData: any;
  };
}

export class AzureMonitorTransport extends Transport {
  protected options: AzureMonitorTransportOptions;
  private telemetryItems: AzureEnvelope[] = [];
  private batchTimer?: NodeJS.Timeout;
  private isProcessing: boolean = false;
  private instrumentationKey: string = '';
  private ingestionEndpoint: string = '';

  constructor(options: AzureMonitorTransportOptions) {
    super(options);
    this.options = {
      batchSize: 100,
      batchInterval: 5000,
      maxRetries: 3,
      enableAutoCollectConsole: false,
      enableAutoCollectExceptions: false,
      enableAutoCollectPerformance: false,
      samplingPercentage: 100,
      disableStatsbeat: true,
      ...options
    };

    this.initializeClient();
    this.startBatchTimer();
  }

  private async initializeClient(): Promise<void> {
    try {
      // Extract instrumentation key and endpoint from connection string if provided
      if (this.options.connectionString) {
        const parts = this.options.connectionString.split(';');
        for (const part of parts) {
          const [key, value] = part.split('=');
          if (key === 'InstrumentationKey') {
            this.instrumentationKey = value;
          } else if (key === 'IngestionEndpoint') {
            this.ingestionEndpoint = value.replace(/\/$/, '') + '/v2/track';
          }
        }
      } else if (this.options.instrumentationKey) {
        this.instrumentationKey = this.options.instrumentationKey;
      }

      if (!this.instrumentationKey) {
        throw new Error('Either connectionString or instrumentationKey must be provided');
      }

      // Use default ingestion endpoint if not specified
      if (!this.ingestionEndpoint) {
        this.ingestionEndpoint = this.options.ingestionEndpoint || 'https://dc.services.visualstudio.com/v2/track';
      }

      console.log('Azure Monitor transport initialized successfully');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Failed to initialize Azure Monitor client:', errorMessage);
      this.active = false;
    }
  }

  private async sendToAzureMonitor(envelopes: AzureEnvelope[]): Promise<void> {
    const data = envelopes.map(e => JSON.stringify(e)).join('\n');
    const compressed = await gzip(data);
    
    const url = new URL(this.ingestionEndpoint);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-json-stream',
        'Content-Encoding': 'gzip',
        'Content-Length': compressed.length,
        'Accept': 'application/json',
        'User-Agent': 'TurboLogger/1.0'
      }
    };
    
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Azure Monitor API error: ${res.statusCode} - ${data}`));
          }
        });
      });

      // FIX BUG-039: Add timeout to prevent indefinite hangs on network issues
      // Azure Monitor requests should timeout to prevent resource exhaustion
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Request timeout: Azure Monitor request exceeded 30s'));
      });

      req.on('error', reject);
      req.write(compressed);
      req.end();
    });
  }

  async write(log: LogData): Promise<void> {
    if (!this.active || !this.shouldWrite(log)) {
      return;
    }

    const telemetryItem = this.formatTelemetryItem(log);
    this.telemetryItems.push(telemetryItem);

    // Trigger immediate flush if queue is full
    if (this.telemetryItems.length >= (this.options.batchSize || 100)) {
      await this.flushBatch();
    }
  }

  async writeBatch(logs: LogData[]): Promise<void> {
    const items = logs
      .filter(log => this.shouldWrite(log))
      .map(log => this.formatTelemetryItem(log));

    this.telemetryItems.push(...items);

    if (this.telemetryItems.length >= (this.options.batchSize || 100)) {
      await this.flushBatch();
    }
  }

  private formatTelemetryItem(log: LogData): AzureEnvelope {
    const timestamp = new Date(log.time || Date.now()).toISOString();
    const severity = this.mapLogLevel(log.level || log.levelLabel);

    // Determine telemetry type based on log content
    const telemetryType = this.determineTelemetryType(log);

    const item: AzureEnvelope = {
      ver: 1,
      name: `Microsoft.ApplicationInsights.${this.instrumentationKey}.${telemetryType}`,
      time: timestamp,
      sampleRate: this.options.samplingPercentage || 100,
      iKey: this.instrumentationKey,
      tags: this.buildTags(log),
      data: {
        baseType: this.getBaseType(telemetryType),
        baseData: this.buildBaseData(log, telemetryType, severity)
      }
    };

    return item;
  }

  private determineTelemetryType(log: any): string {
    // Check for HTTP request data
    if (log.req || log.request || log.httpRequest || log.method) {
      return 'Request';
    }

    // Check for dependency data (external calls)
    if (log.dependency || log.target || log.command) {
      return 'RemoteDependency';
    }

    // Check for custom events
    if (log.event || log.eventName) {
      return 'Event';
    }

    // Check for metrics
    if (log.metric || log.metrics || typeof log.value === 'number') {
      return 'Metric';
    }

    // Check for exceptions
    if (log.error || log.err || log.exception) {
      return 'Exception';
    }

    // Default to trace/log
    return 'Message';
  }

  private getBaseType(telemetryType: string): string {
    const typeMap: Record<string, string> = {
      'Request': 'RequestData',
      'RemoteDependency': 'RemoteDependencyData',
      'Event': 'EventData',
      'Metric': 'MetricData',
      'Exception': 'ExceptionData',
      'Message': 'MessageData'
    };

    return typeMap[telemetryType] || 'MessageData';
  }

  private buildTags(log: any): Record<string, string> {
    const tags: Record<string, string> = {};

    // Add custom properties
    if (this.options.customProperties) {
      Object.assign(tags, this.options.customProperties);
    }

    // Add log-specific tags
    if (log.service || log.name) {
      tags['ai.cloud.role'] = log.service || log.name;
    }

    if (log.version) {
      tags['ai.application.ver'] = log.version;
    }

    if (log.userId || log.user?.id) {
      tags['ai.user.id'] = log.userId || log.user.id;
    }

    if (log.sessionId || log.session?.id) {
      tags['ai.session.id'] = log.sessionId || log.session.id;
    }

    if (log.operationId || log.traceId) {
      tags['ai.operation.id'] = log.operationId || log.traceId;
    }

    if (log.operationParentId || log.spanId) {
      tags['ai.operation.parentId'] = log.operationParentId || log.spanId;
    }

    if (log.operationName) {
      tags['ai.operation.name'] = log.operationName;
    }

    return tags;
  }

  private buildBaseData(log: any, telemetryType: string, severity: number): any {
    switch (telemetryType) {
      case 'Request':
        return this.buildRequestData(log);
      case 'RemoteDependency':
        return this.buildDependencyData(log);
      case 'Event':
        return this.buildEventData(log);
      case 'Metric':
        return this.buildMetricData(log);
      case 'Exception':
        return this.buildExceptionData(log);
      default:
        return this.buildMessageData(log, severity);
    }
  }

  private buildRequestData(log: any): any {
    const req = log.req || log.request || log.httpRequest || log;
    
    return {
      id: log.requestId || log.id || this.generateId(),
      name: `${req.method || 'GET'} ${req.url || req.path || '/'}`,
      url: req.url || req.originalUrl || req.path,
      duration: this.formatDuration(log.responseTime || log.duration),
      responseCode: String(log.statusCode || req.statusCode || 200),
      success: (log.statusCode || req.statusCode || 200) < 400,
      source: req.ip || req.remoteAddress,
      properties: this.extractProperties(log),
      measurements: this.extractMeasurements(log)
    };
  }

  private buildDependencyData(log: any): any {
    const dep = log.dependency || log;
    
    return {
      id: log.dependencyId || log.id || this.generateId(),
      name: dep.name || dep.command || dep.operation,
      data: dep.command || dep.query || dep.data,
      type: dep.type || 'HTTP',
      target: dep.target || dep.host,
      duration: this.formatDuration(log.duration || log.responseTime),
      resultCode: String(log.statusCode || dep.statusCode || 200),
      success: (log.statusCode || dep.statusCode || 200) < 400,
      properties: this.extractProperties(log),
      measurements: this.extractMeasurements(log)
    };
  }

  private buildEventData(log: any): any {
    return {
      name: log.event || log.eventName || log.name || 'CustomEvent',
      properties: this.extractProperties(log),
      measurements: this.extractMeasurements(log)
    };
  }

  private buildMetricData(log: any): any {
    const metric = log.metric || log.metrics || log;
    
    return {
      metrics: [{
        name: metric.name || log.name || 'CustomMetric',
        value: metric.value || log.value || 1,
        count: metric.count || 1,
        min: metric.min,
        max: metric.max,
        stdDev: metric.stdDev
      }],
      properties: this.extractProperties(log)
    };
  }

  private buildExceptionData(log: any): any {
    const error = log.error || log.err || log.exception || new Error(log.msg || log.message || 'Unknown error');
    
    return {
      exceptions: [{
        typeName: error.name || 'Error',
        message: error.message || String(error),
        hasFullStack: !!error.stack,
        stack: error.stack,
        parsedStack: error.stack ? this.parseStack(error.stack) : []
      }],
      severityLevel: this.mapLogLevel(log.level || log.levelLabel),
      properties: this.extractProperties(log),
      measurements: this.extractMeasurements(log)
    };
  }

  private buildMessageData(log: any, severity: number): any {
    return {
      message: log.msg || log.message || this.serializer.serialize(log).toString(),
      severityLevel: severity,
      properties: this.extractProperties(log)
    };
  }

  private mapLogLevel(level: string | number): number {
    // Map to Application Insights severity levels
    if (typeof level === 'number') {
      if (level >= 60) return 4; // Critical
      if (level >= 50) return 3; // Error
      if (level >= 40) return 2; // Warning
      if (level >= 30) return 1; // Information
      return 0; // Verbose
    }

    const levelMap: Record<string, number> = {
      'fatal': 4,
      'error': 3,
      'warn': 2,
      'warning': 2,
      'info': 1,
      'debug': 0,
      'trace': 0
    };

    return levelMap[level?.toLowerCase()] || 1;
  }

  private extractProperties(log: any): Record<string, string> {
    const excluded = ['time', 'timestamp', 'level', 'levelLabel', 'msg', 'message', 'error', 'err', 'exception'];
    const properties: Record<string, string> = {};

    for (const [key, value] of Object.entries(log)) {
      if (!excluded.includes(key) && typeof value !== 'object') {
        properties[key] = String(value);
      }
    }

    return properties;
  }

  private extractMeasurements(log: any): Record<string, number> {
    const measurements: Record<string, number> = {};

    for (const [key, value] of Object.entries(log)) {
      if (typeof value === 'number' && !['time', 'timestamp', 'level'].includes(key)) {
        measurements[key] = value;
      }
    }

    return measurements;
  }

  private formatDuration(ms: number | undefined): string {
    if (!ms) return '00:00:00.000';
    
    const totalMs = Math.floor(ms);
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const milliseconds = totalMs % 1000;

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
  }

  private parseStack(stack: string): any[] {
    return stack.split('\n').slice(1).map((line, index) => {
      const match = line.match(/^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/) ||
                   line.match(/^\s*at\s+(.+?):(\d+):(\d+)/) ||
                   line.match(/^\s*(.+?)@(.+?):(\d+):(\d+)/);

      if (match) {
        return {
          level: index,
          method: match[1] || 'unknown',
          fileName: match[2] || 'unknown',
          line: parseInt(match[3] || '0'),
          column: parseInt(match[4] || '0')
        };
      }

      return {
        level: index,
        method: line.trim(),
        fileName: 'unknown',
        line: 0,
        column: 0
      };
    });
  }

  private generateId(): string {
    // BUG #48 FIX: Use .slice() instead of deprecated .substr()
    return Math.random().toString(36).slice(2, 11);
  }

  private startBatchTimer(): void {
    this.batchTimer = setInterval(async () => {
      if (this.telemetryItems.length > 0) {
        await this.flushBatch();
      }
    }, this.options.batchInterval);
  }

  private async flushBatch(): Promise<void> {
    if (this.isProcessing || this.telemetryItems.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      const itemsToSend = this.telemetryItems.splice(0, this.options.batchSize || 100);
      await this.sendBatchToAzure(itemsToSend);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Failed to flush batch to Azure Monitor:', errorMessage);

      // FIX BUG-027: Rethrow error to propagate to caller for proper error handling
      // This ensures write() method properly indicates failure instead of silently succeeding
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  private async sendBatchToAzure(items: AzureEnvelope[], retryCount: number = 0): Promise<void> {
    try {
      await this.sendToAzureMonitor(items);
    } catch (error: unknown) {
      const maxRetries = this.options.maxRetries || 3;
      
      if (retryCount < maxRetries) {
        const delay = Math.pow(2, retryCount) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        await this.sendBatchToAzure(items, retryCount + 1);
        return;
      }

      throw error;
    }
  }

  getStats(): any {
    return {
      queueSize: this.telemetryItems.length,
      isProcessing: this.isProcessing,
      active: this.active,
      instrumentationKey: this.instrumentationKey ? 'set' : 'unset',
      connectionString: this.options.connectionString ? 'set' : 'unset'
    };
  }

  destroy(): void {
    super.destroy();
    
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = undefined;
    }

    // Flush remaining items
    this.flushBatch().catch(console.error);
  }
}