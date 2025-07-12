// Type definitions for cloud SDK modules
// These are no longer used in zero-dependency mode

// Keeping these type definitions for reference only
// The actual implementations now use HTTP/HTTPS requests directly

/*
declare module 'applicationinsights' {
  export interface TelemetryClient {
    trackTrace(trace: { message: string; severity?: number; properties?: Record<string, string> }): void;
    trackException(exception: { exception: Error; properties?: Record<string, string> }): void;
    trackEvent(event: { name: string; properties?: Record<string, string>; measurements?: Record<string, number> }): void;
    flush(): void;
  }
  
  export interface Configuration {
    start(): Configuration;
  }
  
  export function setup(connectionString?: string): Configuration;
  export function start(): Configuration;
  export const defaultClient: TelemetryClient;
}

declare module '@aws-sdk/client-cloudwatch-logs' {
  export interface CloudWatchLogsClientConfig {
    region?: string;
    credentials?: {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };
  }
  
  export class CloudWatchLogsClient {
    constructor(config: CloudWatchLogsClientConfig);
    send<T>(command: T): Promise<unknown>;
  }
  
  export interface CreateLogGroupCommandInput {
    logGroupName: string;
  }
  
  export class CreateLogGroupCommand {
    constructor(params: CreateLogGroupCommandInput);
  }
  
  export interface CreateLogStreamCommandInput {
    logGroupName: string;
    logStreamName: string;
  }
  
  export class CreateLogStreamCommand {
    constructor(params: CreateLogStreamCommandInput);
  }
  
  export interface PutLogEventsCommandInput {
    logGroupName: string;
    logStreamName: string;
    logEvents: Array<{
      timestamp: number;
      message: string;
    }>;
    sequenceToken?: string;
  }
  
  export class PutLogEventsCommand {
    constructor(params: PutLogEventsCommandInput);
  }
  
  export class DataAlreadyAcceptedException extends Error {}
  export class InvalidSequenceTokenException extends Error {}
}

declare module '@google-cloud/logging' {
  export interface LoggingOptions {
    projectId?: string;
    keyFilename?: string;
    credentials?: object;
  }
  
  export interface Log {
    write(entry: LogEntry | LogEntry[]): Promise<void>;
  }
  
  export interface LogEntry {
    data: unknown;
    metadata?: {
      severity?: string;
      resource?: {
        type: string;
        labels?: Record<string, string>;
      };
    };
  }
  
  export class Logging {
    constructor(options?: LoggingOptions);
    log(name: string): Log;
  }
}
*/