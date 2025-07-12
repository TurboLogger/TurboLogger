import { Transport, TransportOptions, LogData } from '../../core/transport';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { promisify } from 'util';

const readFile = promisify(fs.readFile);

export interface StackdriverTransportOptions extends TransportOptions {
  projectId: string;
  logName: string;
  resource?: {
    type: string;
    labels: Record<string, string>;
  };
  credentials?: {
    client_email: string;
    private_key: string;
    project_id: string;
  } | string; // Path to service account JSON
  maxRetries?: number;
  batchSize?: number;
  batchInterval?: number;
  labels?: Record<string, string>;
  partialSuccess?: boolean;
}

interface StackdriverLogEntry {
  severity: string;
  timestamp: string;
  jsonPayload?: any;
  textPayload?: string;
  labels?: Record<string, string>;
  httpRequest?: any;
  operation?: any;
  trace?: string;
  spanId?: string;
}

interface GoogleCredentials {
  client_email: string;
  private_key: string;
  project_id: string;
}

interface GoogleAccessToken {
  access_token: string;
  expires_at: number;
}

export class StackdriverTransport extends Transport {
  protected options: StackdriverTransportOptions;
  private logQueue: StackdriverLogEntry[] = [];
  private batchTimer?: NodeJS.Timeout;
  private isProcessing: boolean = false;
  private accessToken?: GoogleAccessToken;
  private credentials?: GoogleCredentials;

  constructor(options: StackdriverTransportOptions) {
    super(options);
    this.options = {
      batchSize: 1000,
      batchInterval: 5000,
      maxRetries: 3,
      partialSuccess: true,
      resource: {
        type: 'global',
        labels: {}
      },
      ...options
    };

    this.initializeClient();
    this.startBatchTimer();
  }

  private async initializeClient(): Promise<void> {
    try {
      // Load credentials
      if (this.options.credentials) {
        if (typeof this.options.credentials === 'string') {
          // Load from file
          const credentialData = await readFile(this.options.credentials, 'utf8');
          this.credentials = JSON.parse(credentialData);
        } else {
          this.credentials = this.options.credentials;
        }
      } else {
        throw new Error('Credentials are required for Stackdriver transport');
      }
      
      // Get access token
      await this.refreshAccessToken();
      
      console.log('Stackdriver transport initialized successfully');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Failed to initialize Stackdriver client:', errorMessage);
      this.active = false;
    }
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.credentials) {
      throw new Error('No credentials available');
    }
    
    // Check if current token is still valid
    if (this.accessToken && this.accessToken.expires_at > Date.now() + 60000) {
      return;
    }
    
    // Create JWT for authentication
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: this.credentials.client_email,
      scope: 'https://www.googleapis.com/auth/logging.write',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    };
    
    const header = {
      alg: 'RS256',
      typ: 'JWT'
    };
    
    const headerBase64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signatureInput = `${headerBase64}.${payloadBase64}`;
    
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signatureInput);
    const signature = sign.sign(this.credentials.private_key, 'base64url');
    
    const jwt = `${signatureInput}.${signature}`;
    
    // Exchange JWT for access token
    const tokenData = await this.exchangeJWTForToken(jwt);
    this.accessToken = {
      access_token: tokenData.access_token,
      expires_at: Date.now() + (tokenData.expires_in * 1000)
    };
  }
  
  private async exchangeJWTForToken(jwt: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const postData = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      }).toString();
      
      const options = {
        hostname: 'oauth2.googleapis.com',
        port: 443,
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (res.statusCode === 200) {
              resolve(response);
            } else {
              reject(new Error(`Failed to get access token: ${JSON.stringify(response)}`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse token response: ${data}`));
          }
        });
      });
      
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
  
  private async makeStackdriverRequest(
    method: string,
    path: string,
    body?: any,
    retryCount: number = 0
  ): Promise<any> {
    await this.refreshAccessToken();
    
    if (!this.accessToken) {
      throw new Error('No access token available');
    }
    
    return new Promise((resolve, reject) => {
      const bodyData = body ? JSON.stringify(body) : '';
      
      const options = {
        hostname: 'logging.googleapis.com',
        port: 443,
        path,
        method,
        headers: {
          'Authorization': `Bearer ${this.accessToken?.access_token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyData)
        }
      };
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data ? JSON.parse(data) : {});
            } else {
              // const error = JSON.parse(data); // Not used
              
              // Handle retryable errors
              if (retryCount < (this.options.maxRetries || 3) && 
                  res.statusCode && (res.statusCode === 429 || res.statusCode >= 500)) {
                setTimeout(() => {
                  this.makeStackdriverRequest(method, path, body, retryCount + 1)
                    .then(resolve)
                    .catch(reject);
                }, Math.pow(2, retryCount) * 1000);
              } else {
                reject(new Error(`Stackdriver API error: ${res.statusCode} - ${data}`));
              }
            }
          } catch (e) {
            reject(new Error(`Failed to parse Stackdriver response: ${data}`));
          }
        });
      });
      
      req.on('error', reject);
      if (bodyData) {
        req.write(bodyData);
      }
      req.end();
    });
  }

  async write(log: LogData): Promise<void> {
    if (!this.active || !this.shouldWrite(log)) {
      return;
    }

    const entry = this.formatLogEntry(log);
    this.logQueue.push(entry);

    // Trigger immediate flush if queue is full
    if (this.logQueue.length >= (this.options.batchSize || 1000)) {
      await this.flushBatch();
    }
  }

  async writeBatch(logs: LogData[]): Promise<void> {
    const entries = logs
      .filter(log => this.shouldWrite(log))
      .map(log => this.formatLogEntry(log));

    this.logQueue.push(...entries);

    if (this.logQueue.length >= (this.options.batchSize || 1000)) {
      await this.flushBatch();
    }
  }

  private formatLogEntry(log: LogData): StackdriverLogEntry {
    const entry: StackdriverLogEntry = {
      severity: this.mapLogLevel(log.level || log.levelLabel),
      timestamp: new Date(log.time || Date.now()).toISOString()
    };

    // Add labels
    if (this.options.labels || log.labels) {
      entry.labels = {
        ...this.options.labels,
        ...(log.labels || {})
      };
    }

    // Handle different payload types
    if (typeof log === 'string') {
      entry.textPayload = log;
    } else {
      // Create structured payload
      const logObj = log as Record<string, any>;
      const { level, levelLabel, time, timestamp, labels, httpRequest, operation, trace, spanId, ...payload } = logObj;
      
      if (Object.keys(payload).length === 1 && payload.msg) {
        entry.textPayload = payload.msg;
      } else {
        entry.jsonPayload = payload;
      }

      // Add HTTP request info if available
      if (httpRequest || log.req || log.request) {
        entry.httpRequest = this.formatHttpRequest(httpRequest || log.req || log.request);
      }

      // Add operation info
      if (operation || log.operation) {
        entry.operation = operation || log.operation;
      }

      // Add tracing info
      if (trace || log.trace || log.traceId) {
        entry.trace = `projects/${this.options.projectId}/traces/${trace || log.trace || log.traceId}`;
      }

      if (spanId || log.spanId) {
        entry.spanId = spanId || log.spanId;
      }
    }

    return entry;
  }

  private mapLogLevel(level: string | number | undefined): string {
    // Map TurboLogger levels to Stackdriver severity
    if (typeof level === 'number') {
      if (level >= 60) return 'CRITICAL';
      if (level >= 50) return 'ERROR';
      if (level >= 40) return 'WARNING';
      if (level >= 30) return 'INFO';
      if (level >= 20) return 'DEBUG';
      return 'DEFAULT';
    }

    const levelMap: Record<string, string> = {
      'fatal': 'CRITICAL',
      'error': 'ERROR',
      'warn': 'WARNING',
      'warning': 'WARNING',
      'info': 'INFO',
      'debug': 'DEBUG',
      'trace': 'DEBUG'
    };

    return levelMap[level?.toLowerCase() || ''] || 'DEFAULT';
  }

  private formatHttpRequest(req: any): any {
    if (!req) return undefined;

    return {
      requestMethod: req.method,
      requestUrl: req.url || req.originalUrl,
      requestSize: req.headers?.['content-length'] ? parseInt(req.headers['content-length']) : undefined,
      status: req.statusCode || req.status,
      responseSize: req.responseSize,
      userAgent: req.headers?.['user-agent'],
      remoteIp: req.ip || req.connection?.remoteAddress,
      referer: req.headers?.referer,
      latency: req.responseTime ? `${req.responseTime / 1000}s` : undefined,
      protocol: req.protocol
    };
  }

  private startBatchTimer(): void {
    this.batchTimer = setInterval(async () => {
      if (this.logQueue.length > 0) {
        await this.flushBatch();
      }
    }, this.options.batchInterval);
  }

  private async flushBatch(): Promise<void> {
    if (this.isProcessing || this.logQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    
    const entriesToSend = this.logQueue.splice(0, this.options.batchSize || 1000);

    try {
      await this.sendBatchToStackdriver(entriesToSend);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Failed to flush batch to Stackdriver:', errorMessage);
      
      // Re-queue entries on failure (up to a limit)
      if (this.logQueue.length < (this.options.batchSize || 1000) * 2) {
        this.logQueue.unshift(...entriesToSend);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async sendBatchToStackdriver(entries: StackdriverLogEntry[], retryCount: number = 0): Promise<void> {
    try {
      // Convert entries to Google Cloud Logging API format
      const logEntries = entries.map(entry => {
        const logEntry: any = {
          logName: `projects/${this.options.projectId}/logs/${encodeURIComponent(this.options.logName)}`,
          resource: this.options.resource,
          severity: entry.severity,
          timestamp: entry.timestamp,
          labels: entry.labels
        };

        if (entry.jsonPayload) {
          logEntry.jsonPayload = entry.jsonPayload;
        } else if (entry.textPayload) {
          logEntry.textPayload = entry.textPayload;
        }

        if (entry.httpRequest) {
          logEntry.httpRequest = entry.httpRequest;
        }

        if (entry.operation) {
          logEntry.operation = entry.operation;
        }

        if (entry.trace) {
          logEntry.trace = entry.trace;
        }

        if (entry.spanId) {
          logEntry.spanId = entry.spanId;
        }

        return logEntry;
      });

      // Write entries using REST API
      const path = `/v2/entries:write`;
      const body = {
        entries: logEntries,
        partialSuccess: this.options.partialSuccess
      };
      
      await this.makeStackdriverRequest('POST', path, body);

    } catch (error: unknown) {
      const maxRetries = this.options.maxRetries || 3;
      
      if (retryCount < maxRetries) {
        // Exponential backoff for retries
        const delay = Math.pow(2, retryCount) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        await this.sendBatchToStackdriver(entries, retryCount + 1);
        return;
      }

      throw error;
    }
  }

  async queryLogs(options: {
    filter?: string;
    orderBy?: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<any> {
    try {
      const path = `/v2/entries:list`;
      const body: any = {
        resourceNames: [`projects/${this.options.projectId}`]
      };
      
      if (options.filter) {
        body.filter = options.filter;
      }
      if (options.orderBy) {
        body.orderBy = options.orderBy;
      }
      if (options.pageSize) {
        body.pageSize = options.pageSize;
      }
      if (options.pageToken) {
        body.pageToken = options.pageToken;
      }
      
      const response = await this.makeStackdriverRequest('POST', path, body);
      
      return {
        entries: (response.entries || []).map((entry: any) => ({
          severity: entry.severity,
          timestamp: entry.timestamp,
          data: entry.jsonPayload || entry.textPayload || entry.protoPayload,
          labels: entry.labels,
          httpRequest: entry.httpRequest,
          operation: entry.operation,
          trace: entry.trace,
          spanId: entry.spanId
        })),
        nextPageToken: response.nextPageToken
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Failed to query Stackdriver logs:', errorMessage);
      return { entries: [], nextPageToken: null };
    }
  }

  async deleteLog(): Promise<void> {
    try {
      const path = `/v2/projects/${this.options.projectId}/logs/${encodeURIComponent(this.options.logName)}`;
      await this.makeStackdriverRequest('DELETE', path);
      console.log(`Deleted log: ${this.options.logName}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Failed to delete log:', errorMessage);
    }
  }

  async createSink(sinkName: string, destination: string, filter?: string): Promise<void> {
    try {
      const path = `/v2/projects/${this.options.projectId}/sinks`;
      const body: any = {
        name: sinkName,
        destination,
        uniqueWriterIdentity: true
      };
      
      if (filter) {
        body.filter = filter;
      }
      
      await this.makeStackdriverRequest('POST', path, body);
      console.log(`Created sink: ${sinkName}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Failed to create sink:', errorMessage);
    }
  }

  getStats(): any {
    return {
      queueSize: this.logQueue.length,
      isProcessing: this.isProcessing,
      active: this.active,
      projectId: this.options.projectId,
      logName: this.options.logName,
      resource: this.options.resource
    };
  }

  destroy(): void {
    super.destroy();
    
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = undefined;
    }

    // Flush remaining entries
    this.flushBatch().catch(console.error);
  }
}