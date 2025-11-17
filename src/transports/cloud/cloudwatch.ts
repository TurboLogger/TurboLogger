import { Transport, TransportOptions, LogData } from '../../core/transport';
import * as https from 'https';
import * as crypto from 'crypto';
import * as os from 'os';

export interface CloudWatchTransportOptions extends TransportOptions {
  logGroupName: string;
  logStreamName?: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  endpoint?: string;
  retentionInDays?: number;
  autoCreateLogGroup?: boolean;
  autoCreateLogStream?: boolean;
  batchSize?: number;
  batchInterval?: number;
  maxRetries?: number;
  sequenceToken?: string;
}

interface CloudWatchLogEvent {
  timestamp: number;
  message: string;
}

interface LogBatch {
  events: CloudWatchLogEvent[];
  logGroupName: string;
  logStreamName: string;
  sequenceToken?: string;
}

export class CloudWatchTransport extends Transport {
  protected options: CloudWatchTransportOptions;
  private eventQueue: CloudWatchLogEvent[] = [];
  private batchTimer?: NodeJS.Timeout;
  private sequenceToken?: string;
  private isProcessing: boolean = false;

  constructor(options: CloudWatchTransportOptions) {
    super(options);
    this.options = {
      batchSize: 10000, // CloudWatch limit
      batchInterval: 5000,
      maxRetries: 3,
      autoCreateLogGroup: true,
      autoCreateLogStream: true,
      retentionInDays: 7,
      ...options
    };

    this.initializeClient();
    this.startBatchTimer();
  }

  private async initializeClient(): Promise<void> {
    try {
      // Validate required options
      if (!this.options.region) {
        throw new Error('AWS region is required');
      }

      // Create log group and stream if they don't exist
      if (this.options.autoCreateLogGroup) {
        await this.ensureLogGroup();
      }

      if (this.options.autoCreateLogStream) {
        await this.ensureLogStream();
      }

      console.log('CloudWatch transport initialized successfully');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Failed to initialize CloudWatch client:', errorMessage);
      this.active = false;
    }
  }

  private async makeAWSRequest(
    action: string,
    params: Record<string, any>,
    retryCount: number = 0
  ): Promise<any> {
    const host = this.options.endpoint || `logs.${this.options.region}.amazonaws.com`;
    const method = 'POST';
    const service = 'logs';
    const target = `Logs_20140328.${action}`;
    
    const body = JSON.stringify(params);
    const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = timestamp.substring(0, 8);
    
    // Create canonical headers
    const headers: Record<string, string> = {
      'content-type': 'application/x-amz-json-1.1',
      'host': host,
      'x-amz-date': timestamp,
      'x-amz-target': target
    };
    
    if (this.options.sessionToken) {
      headers['x-amz-security-token'] = this.options.sessionToken;
    }
    
    // Sign request with AWS Signature V4
    const signedHeaders = await this.signRequest({
      method,
      host,
      path: '/',
      headers,
      body,
      service,
      region: this.options.region,
      timestamp,
      dateStamp
    });
    
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: host,
        port: 443,
        path: '/',
        method,
        headers: signedHeaders
      }, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(response);
            } else {
              // Handle retryable errors
              if (retryCount < (this.options.maxRetries || 3) && this.isRetryableError(response)) {
                setTimeout(() => {
                  this.makeAWSRequest(action, params, retryCount + 1)
                    .then(resolve)
                    .catch(reject);
                }, Math.pow(2, retryCount) * 1000);
              } else {
                reject(new Error(`AWS API error: ${JSON.stringify(response)}`));
              }
            }
          } catch (e) {
            reject(new Error(`Failed to parse AWS response: ${data}`));
          }
        });
      });
      
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
  
  private async signRequest(request: {
    method: string;
    host: string;
    path: string;
    headers: Record<string, string>;
    body: string;
    service: string;
    region: string;
    timestamp: string;
    dateStamp: string;
  }): Promise<Record<string, string>> {
    if (!this.options.accessKeyId || !this.options.secretAccessKey) {
      throw new Error('AWS credentials are required');
    }
    
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${request.dateStamp}/${request.region}/${request.service}/aws4_request`;
    
    // Create canonical request
    const canonicalHeaders = Object.keys(request.headers)
      .sort()
      .map(key => `${key}:${request.headers[key]}`)
      .join('\n');
    
    const signedHeaders = Object.keys(request.headers).sort().join(';');
    const payloadHash = crypto.createHash('sha256').update(request.body).digest('hex');
    
    const canonicalRequest = [
      request.method,
      request.path,
      '', // query string
      canonicalHeaders,
      '',
      signedHeaders,
      payloadHash
    ].join('\n');
    
    // Create string to sign
    const canonicalRequestHash = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
    const stringToSign = [
      algorithm,
      request.timestamp,
      credentialScope,
      canonicalRequestHash
    ].join('\n');
    
    // Calculate signature
    const signingKey = this.getSignatureKey(
      this.options.secretAccessKey,
      request.dateStamp,
      request.region,
      request.service
    );
    
    const signature = crypto.createHmac('sha256', signingKey)
      .update(stringToSign)
      .digest('hex');
    
    // Add authorization header
    const authorizationHeader = [
      `${algorithm} Credential=${this.options.accessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`
    ].join(', ');
    
    return {
      ...request.headers,
      'Authorization': authorizationHeader
    };
  }
  
  private getSignatureKey(key: string, dateStamp: string, regionName: string, serviceName: string): Buffer {
    const kDate = crypto.createHmac('sha256', `AWS4${key}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(regionName).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(serviceName).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    return kSigning;
  }
  
  private isRetryableError(error: any): boolean {
    const retryableCodes = ['ThrottlingException', 'ServiceUnavailable', 'RequestTimeout'];
    return error && retryableCodes.includes(error.__type || error.code);
  }

  private async ensureLogGroup(): Promise<void> {
    try {
      await this.makeAWSRequest('CreateLogGroup', {
        logGroupName: this.options.logGroupName,
        retentionInDays: this.options.retentionInDays
      });
    } catch (error: unknown) {
      const errorStr = error instanceof Error ? error.message : String(error);
      if (!errorStr.includes('ResourceAlreadyExistsException')) {
        console.warn(`Failed to create log group: ${errorStr}`);
      }
    }
  }

  private async ensureLogStream(): Promise<void> {
    try {
      const logStreamName = this.getLogStreamName();
      await this.makeAWSRequest('CreateLogStream', {
        logGroupName: this.options.logGroupName,
        logStreamName
      });
    } catch (error: unknown) {
      const errorStr = error instanceof Error ? error.message : String(error);
      if (!errorStr.includes('ResourceAlreadyExistsException')) {
        console.warn(`Failed to create log stream: ${errorStr}`);
      }
    }
  }

  private getLogStreamName(): string {
    if (this.options.logStreamName) {
      return this.options.logStreamName;
    }

    // Generate stream name with timestamp and hostname
    const timestamp = new Date().toISOString().slice(0, 10);
    const hostname = os.hostname();
    // NEW-BUG-010 FIX: Use 16 bytes (128 bits) for strong uniqueness in high-throughput scenarios
    // 4 bytes was insufficient and could cause ID collisions. 16 bytes provides 2^128 possibilities.
    const randomId = crypto.randomBytes(16).toString('hex'); // Secure random ID

    return `${hostname}-${timestamp}-${randomId}`;
  }

  // FIX NEW-006: Helper method to determine if CloudWatch error is retriable
  private isRetriableCloudWatchError(error: unknown): boolean {
    if (!error) return false;

    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = (error as any)?.code || (error as any)?.name || '';

    // Retriable errors (transient failures)
    const retriableErrors = [
      'ThrottlingException',
      'ServiceUnavailableException',
      'RequestLimitExceeded',
      'ProvisionedThroughputExceededException',
      'NetworkingError',
      'TimeoutError',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND'
    ];

    // Non-retriable errors (permanent failures)
    const nonRetriableErrors = [
      'InvalidParameterException',
      'InvalidSequenceTokenException',
      'DataAlreadyAcceptedException',
      'ResourceNotFoundException',
      'AccessDeniedException',
      'UnrecognizedClientException',
      'InvalidSignatureException',
      'ExpiredTokenException',
      'MalformedQueryStringException'
    ];

    // Check if error is explicitly non-retriable
    if (nonRetriableErrors.some(code => errorCode.includes(code) || errorMessage.includes(code))) {
      return false;
    }

    // Check if error is explicitly retriable
    if (retriableErrors.some(code => errorCode.includes(code) || errorMessage.includes(code))) {
      return true;
    }

    // Default: don't retry unknown errors to prevent infinite loops
    return false;
  }

  async write(log: LogData): Promise<void> {
    if (!this.active || !this.shouldWrite(log)) {
      return;
    }

    const event: CloudWatchLogEvent = {
      timestamp: log.time || Date.now(),
      message: this.formatMessage(log)
    };

    this.eventQueue.push(event);

    // Trigger immediate flush if queue is full
    if (this.eventQueue.length >= (this.options.batchSize || 10000)) {
      await this.flushBatch();
    }
  }

  async writeBatch(logs: LogData[]): Promise<void> {
    const events = logs
      .filter(log => this.shouldWrite(log))
      .map(log => ({
        timestamp: log.time || Date.now(),
        message: this.formatMessage(log)
      }));

    this.eventQueue.push(...events);

    if (this.eventQueue.length >= (this.options.batchSize || 10000)) {
      await this.flushBatch();
    }
  }

  private formatMessage(log: LogData): string {
    // CloudWatch expects a string message
    if (typeof log === 'string') {
      return log;
    }

    return this.serializer.serialize(log).toString();
  }

  private startBatchTimer(): void {
    this.batchTimer = setInterval(async () => {
      if (this.eventQueue.length > 0) {
        await this.flushBatch();
      }
    }, this.options.batchInterval);
  }

  private async flushBatch(): Promise<void> {
    if (this.isProcessing || this.eventQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    const eventsToSend = this.eventQueue.splice(0, this.options.batchSize || 10000);

    try {
      // Sort events by timestamp (CloudWatch requirement)
      eventsToSend.sort((a, b) => a.timestamp - b.timestamp);

      const batch: LogBatch = {
        events: eventsToSend,
        logGroupName: this.options.logGroupName,
        logStreamName: this.getLogStreamName(),
        sequenceToken: this.sequenceToken
      };

      await this.sendBatchToCloudWatch(batch);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Failed to flush batch to CloudWatch:', errorMessage);

      // FIX NEW-006: Only retry on transient errors, not permanent failures
      // Check if error is retriable before re-queueing
      const isRetriable = this.isRetriableCloudWatchError(error);

      if (!isRetriable) {
        console.error('Non-retriable error detected, dropping events:', errorMessage);
        // FIX BUG-027: Rethrow error even for non-retriable errors to propagate failure
        throw error;
      }

      // Prevent unbounded growth by implementing proper limits
      const maxQueueSize = (this.options.batchSize || 10000) * 3;
      const currentQueueSize = this.eventQueue.length;

      // Only re-queue if we have room and haven't exceeded retry attempts
      if (currentQueueSize < maxQueueSize && eventsToSend.length <= 1000) {
        // Re-add failed events with exponential backoff
        setTimeout(() => {
          if (this.eventQueue.length < maxQueueSize) {
            this.eventQueue.unshift(...eventsToSend.slice(0, 500)); // Limit re-queued items
          }
        }, Math.min(1000 * Math.pow(2, Math.floor(currentQueueSize / 1000)), 30000));
      } else {
        // Drop events to prevent memory exhaustion
        console.warn(`Dropping ${eventsToSend.length} events due to queue overflow or size limits`);
      }

      // FIX BUG-027: Rethrow error to propagate to caller for proper error handling
      // This ensures write() method properly indicates failure instead of silently succeeding
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  private async sendBatchToCloudWatch(batch: LogBatch, retryCount: number = 0): Promise<void> {
    try {
      const params: any = {
        logGroupName: batch.logGroupName,
        logStreamName: batch.logStreamName,
        logEvents: batch.events
      };
      
      if (batch.sequenceToken) {
        params.sequenceToken = batch.sequenceToken;
      }
      
      const response = await this.makeAWSRequest('PutLogEvents', params);

      // BUG-040 FIX: Validate AWS API response structure before accessing properties
      // AWS SDK responses can vary and missing validation causes runtime errors
      if (!response || typeof response !== 'object') {
        console.warn('[CloudWatch] Invalid response from PutLogEvents:', response);
        return;
      }

      // Update sequence token for next batch
      if (response.nextSequenceToken && typeof response.nextSequenceToken === 'string') {
        this.sequenceToken = response.nextSequenceToken;
      }
      
    } catch (error: unknown) {
      const errorStr = error instanceof Error ? error.message : String(error);
      const maxRetries = this.options.maxRetries || 3;
      
      if (retryCount < maxRetries) {
        // Handle specific CloudWatch errors
        if (errorStr.includes('InvalidSequenceTokenException')) {
          // Extract expected token from error message
          const tokenMatch = errorStr.match(/expectedSequenceToken: (\S+)/);
          if (tokenMatch) {
            batch.sequenceToken = tokenMatch[1];
            this.sequenceToken = tokenMatch[1];
            
            // Retry with correct token
            await this.sendBatchToCloudWatch(batch, retryCount + 1);
            return;
          }
        }

        if (errorStr.includes('ThrottlingException') || errorStr.includes('ServiceUnavailable')) {
          // Exponential backoff for throttling
          const delay = Math.pow(2, retryCount) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
          await this.sendBatchToCloudWatch(batch, retryCount + 1);
          return;
        }
      }

      throw error;
    }
  }

  async queryLogs(options: {
    startTime?: number;
    endTime?: number;
    filterPattern?: string;
    limit?: number;
  }): Promise<any[]> {
    try {
      const response = await this.makeAWSRequest('FilterLogEvents', {
        logGroupName: this.options.logGroupName,
        startTime: options.startTime,
        endTime: options.endTime,
        filterPattern: options.filterPattern,
        limit: options.limit || 100
      });
      
      return response.events || [];
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Failed to query CloudWatch logs:', errorMessage);
      return [];
    }
  }

  async getLogStreams(): Promise<string[]> {
    try {
      const response = await this.makeAWSRequest('DescribeLogStreams', {
        logGroupName: this.options.logGroupName
      });
      
      if (response && response.logStreams && Array.isArray(response.logStreams)) {
        return response.logStreams.map((stream: any) => stream.logStreamName).filter(Boolean);
      }
      return [];
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Failed to get log streams:', errorMessage);
      return [];
    }
  }

  getStats(): any {
    return {
      queueSize: this.eventQueue.length,
      isProcessing: this.isProcessing,
      active: this.active,
      logGroupName: this.options.logGroupName,
      logStreamName: this.getLogStreamName(),
      sequenceToken: this.sequenceToken ? 'set' : 'unset'
    };
  }

  destroy(): void {
    super.destroy();
    
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = undefined;
    }

    // Flush remaining events
    this.flushBatch().catch(console.error);
  }
}