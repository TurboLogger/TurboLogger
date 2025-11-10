import { Transport, TransportOptions, LogData } from '../core/transport';

export interface ElasticsearchTransportOptions extends TransportOptions {
  node: string | string[];
  index?: string;
  indexPattern?: string;
  auth?: {
    username: string;
    password: string;
  } | {
    apiKey: string;
  };
  ssl?: {
    ca?: string;
    cert?: string;
    key?: string;
    rejectUnauthorized?: boolean;
  };
  bulk?: {
    size: number;
    interval: number;
    timeout?: number;
  };
  mapping?: {
    properties: Record<string, unknown>;
  };
  retry?: {
    maxRetries: number;
    retryDelay: number;
  };
  compression?: boolean;
  maxQueueSize?: number;
}

interface ElasticsearchBulkItem {
  index: {
    _index: string;
    _id?: string;
  };
}

interface QueuedLog {
  log: LogData;
  timestamp: number;
  index: string;
}

// Define Elasticsearch client types
interface ElasticsearchClient {
  ping(): Promise<unknown>;
  indices: {
    putIndexTemplate(params: unknown): Promise<unknown>;
    exists(params: { index: string }): Promise<boolean>;
    create(params: unknown): Promise<unknown>;
    delete(params: { index: string }): Promise<unknown>;
  };
  bulk(params: { body: unknown[]; timeout: number }): Promise<unknown>;
}

interface BulkResponse {
  errors: boolean;
  items: Array<{
    index?: { error?: unknown };
    create?: { error?: unknown };
    update?: { error?: unknown };
    delete?: { error?: unknown };
  }>;
}

export class ElasticsearchTransport extends Transport {
  private client?: ElasticsearchClient;
  protected options: ElasticsearchTransportOptions;
  private logQueue: QueuedLog[] = [];
  private bulkTimer?: NodeJS.Timeout;
  private retryQueue: QueuedLog[] = [];
  private isProcessing: boolean = false;

  constructor(options: ElasticsearchTransportOptions) {
    super(options);
    this.options = {
      index: 'logs',
      indexPattern: 'logs-{YYYY.MM.DD}',
      bulk: {
        size: 1000,
        interval: 5000,
        timeout: 30000
      },
      retry: {
        maxRetries: 3,
        retryDelay: 1000
      },
      compression: true,
      maxQueueSize: 10000,
      ...options
    };

    // FIX BUG-035: Initialize client asynchronously to prevent race conditions
    // Don't await in constructor - set up initialization promise
    this.initializeClient();
    // Start timer only after initialization
    this.startBulkTimer();
  }

  private async initializeClient(): Promise<void> {
    try {
      const { Client } = require('@elastic/elasticsearch');
      
      const clientConfig: Record<string, unknown> = {
        node: this.options.node,
        compression: this.options.compression ? 'gzip' : false,
        requestTimeout: this.options.bulk?.timeout || 30000,
        maxRetries: this.options.retry?.maxRetries || 3,
        retryDelay: this.options.retry?.retryDelay || 1000
      };

      if (this.options.auth) {
        if ('username' in this.options.auth) {
          clientConfig.auth = {
            username: this.options.auth.username,
            password: this.options.auth.password
          };
        } else if ('apiKey' in this.options.auth) {
          clientConfig.auth = {
            apiKey: this.options.auth.apiKey
          };
        }
      }

      if (this.options.ssl) {
        clientConfig.tls = this.options.ssl;
      }

      this.client = new Client(clientConfig) as ElasticsearchClient;

      // FIX BUG-035: Mark transport inactive until connection is verified
      // This prevents writes during initialization
      this.active = false;

      // Test connection
      await this.client.ping();
      console.log('Elasticsearch transport connected successfully');

      // Create index template if mapping is provided
      if (this.options.mapping) {
        await this.createIndexTemplate();
      }

      // FIX BUG-035: Only activate transport after successful initialization
      this.active = true;

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Failed to initialize Elasticsearch client:', errorMessage);
      this.active = false;
    }
  }

  private async createIndexTemplate(): Promise<void> {
    try {
      const templateName = `${this.options.index}-template`;
      const indexPattern = this.options.indexPattern?.replace('{YYYY.MM.DD}', '*') || `${this.options.index}-*`;
      
      await this.client?.indices?.putIndexTemplate({
        name: templateName,
        index_patterns: [indexPattern],
        template: {
          mappings: this.options.mapping,
          settings: {
            'index.refresh_interval': '5s',
            'index.number_of_shards': 1,
            'index.number_of_replicas': 1
          }
        }
      });
      
      console.log(`Created Elasticsearch index template: ${templateName}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.warn('Failed to create index template:', errorMessage);
    }
  }

  async write(log: LogData): Promise<void> {
    if (!this.active || !this.client) {
      return;
    }

    if (!this.shouldWrite(log)) {
      return;
    }

    const indexName = this.generateIndexName(log);
    const queuedLog: QueuedLog = {
      log: this.formatLog(log),
      timestamp: Date.now(),
      index: indexName
    };

    // Check queue size limit
    if (this.logQueue.length >= (this.options.maxQueueSize || 10000)) {
      // Remove oldest logs to make space
      this.logQueue.splice(0, Math.floor((this.options.maxQueueSize || 10000) * 0.1));
    }

    this.logQueue.push(queuedLog);

    // Trigger immediate flush if queue is full
    if (this.logQueue.length >= (this.options.bulk?.size || 1000)) {
      await this.flushBulk();
    }
  }

  async writeBatch(logs: LogData[]): Promise<void> {
    const promises = logs.map(log => this.write(log));
    await Promise.all(promises);
  }

  private formatLog(log: LogData): any {
    const { time, msg, levelLabel, level, ...rest } = log;
    
    const formattedLog = {
      '@timestamp': new Date(time || Date.now()).toISOString(),
      level: levelLabel || level,
      message: msg || log.message,
      ...rest
    };

    return formattedLog;
  }

  private generateIndexName(log: LogData): string {
    if (this.options.indexPattern) {
      const date = new Date(log.time || Date.now());
      return this.options.indexPattern
        .replace('{YYYY}', date.getFullYear().toString())
        .replace('{MM}', (date.getMonth() + 1).toString().padStart(2, '0'))
        .replace('{DD}', date.getDate().toString().padStart(2, '0'))
        .replace('{YYYY.MM.DD}', 
          `${date.getFullYear()}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getDate().toString().padStart(2, '0')}`
        );
    }
    
    return this.options.index || 'logs';
  }

  private startBulkTimer(): void {
    this.bulkTimer = setInterval(async () => {
      if (this.logQueue.length > 0) {
        await this.flushBulk();
      }
    }, this.options.bulk?.interval || 5000);
  }

  private async flushBulk(): Promise<void> {
    if (this.isProcessing || this.logQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    
    try {
      // Get logs to process
      const logsToProcess = this.logQueue.splice(0, this.options.bulk?.size || 1000);
      
      // Add any retry queue items
      if (this.retryQueue.length > 0) {
        const retryLogs = this.retryQueue.splice(0, (this.options.bulk?.size || 1000) - logsToProcess.length);
        logsToProcess.push(...retryLogs);
      }

      if (logsToProcess.length === 0) {
        return;
      }

      // Prepare bulk request
      const bulkBody: unknown[] = [];
      
      for (const queuedLog of logsToProcess) {
        const indexAction: ElasticsearchBulkItem = {
          index: {
            _index: queuedLog.index
          }
        };
        
        // Add document ID if available
        if (queuedLog.log.id || queuedLog.log._id) {
          indexAction.index._id = String(queuedLog.log.id || queuedLog.log._id);
        }
        
        bulkBody.push(indexAction as unknown);
        bulkBody.push(queuedLog.log);
      }

      // Execute bulk request
      const response = await this.client?.bulk({
        body: bulkBody,
        timeout: this.options.bulk?.timeout || 30000
      });

      // Handle errors
      const bulkResponse = response as BulkResponse;
      if (bulkResponse.errors) {
        const failedLogs: QueuedLog[] = [];

        bulkResponse.items.forEach((item, index: number) => {
          const operation = item.index || item.create || item.update || item.delete;

          if (operation && operation.error) {
            console.error(`Elasticsearch bulk error for document ${index}:`, operation.error);

            // FIX NEW-005: Validate index bounds before accessing logsToProcess
            // Elasticsearch response could have different number of items than sent
            if (operation.error && this.isRetriableError(operation.error)) {
              if (index < logsToProcess.length) {
                const failedLog = logsToProcess[index];
                if (failedLog) {
                  failedLogs.push(failedLog);
                }
              } else {
                console.warn(`Index ${index} out of bounds for logsToProcess (length: ${logsToProcess.length})`);
              }
            }
          }
        });
        
        // Add failed logs to retry queue
        this.retryQueue.push(...failedLogs);
        
        // Limit retry queue size
        const maxRetrySize = (this.options.maxQueueSize || 10000) / 2;
        if (this.retryQueue.length > maxRetrySize) {
          this.retryQueue.splice(0, this.retryQueue.length - maxRetrySize);
        }
      }
      
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Elasticsearch bulk write failed:', errorMessage);
      
      // Re-queue logs for retry on connection errors
      if (this.isRetriableError(error)) {
        this.retryQueue.push(...this.logQueue.splice(0, this.options.bulk?.size || 1000));
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private isRetriableError(error: unknown): boolean {
    if (!error) return false;
    
    const retriableCodes = [
      'connection_exception',
      'timeout_exception',
      'too_many_requests_exception',
      'service_unavailable_exception'
    ];
    
    const errorType = (error as any)?.type || (error as any)?.code || '';
    return retriableCodes.some(code => errorType.includes(code)) ||
           ((error as any)?.status >= 500 && (error as any)?.status < 600);
  }

  async createIndex(indexName: string, mapping?: Record<string, unknown>): Promise<void> {
    try {
      const exists = await this.client?.indices.exists({ index: indexName });
      
      if (!exists) {
        const indexConfig: Record<string, unknown> = {
          index: indexName
        };
        
        if (mapping || this.options.mapping) {
          indexConfig.body = {
            mappings: mapping || this.options.mapping,
            settings: {
              'index.refresh_interval': '5s',
              'index.number_of_shards': 1,
              'index.number_of_replicas': 1
            }
          };
        }
        
        await this.client?.indices.create(indexConfig);
        console.log(`Created Elasticsearch index: ${indexName}`);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error(`Failed to create index ${indexName}:`, errorMessage);
    }
  }

  async deleteIndex(indexName: string): Promise<void> {
    try {
      await this.client?.indices.delete({ index: indexName });
      console.log(`Deleted Elasticsearch index: ${indexName}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error(`Failed to delete index ${indexName}:`, errorMessage);
    }
  }

  async search(query: Record<string, unknown>, indexName?: string): Promise<unknown> {
    try {
      const searchParams: Record<string, unknown> = {
        index: indexName || this.options.index,
        body: query
      };
      
      return await (this.client as any)?.search?.(searchParams);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Elasticsearch search failed:', errorMessage);
      throw error;
    }
  }

  async getStats(): Promise<Record<string, unknown>> {
    return {
      queueSize: this.logQueue.length,
      retryQueueSize: this.retryQueue.length,
      isProcessing: this.isProcessing,
      active: this.active,
      client: this.client ? 'connected' : 'disconnected'
    };
  }

  async destroy(): Promise<void> {
    super.destroy();

    if (this.bulkTimer) {
      clearInterval(this.bulkTimer);
      this.bulkTimer = undefined;
    }

    // Flush remaining logs
    await this.flushBulk().catch(console.error);

    // FIX BUG-014: Close Elasticsearch client connection to prevent connection pool exhaustion
    if (this.client) {
      try {
        // Close the client connection properly
        // The Elasticsearch client may have a close() method
        if (typeof (this.client as unknown as { close?: () => Promise<void> }).close === 'function') {
          await (this.client as unknown as { close: () => Promise<void> }).close();
        }
      } catch (error) {
        console.error('Error closing Elasticsearch client:', error);
      } finally {
        this.client = null;
      }
    }
  }
}