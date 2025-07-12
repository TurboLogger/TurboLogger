/**
 * Simple working logger for immediate testing
 */
import { hostname } from 'os';

export interface SimpleLogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface SimpleTransport {
  name: string;
  write(entry: SimpleLogEntry): void | Promise<void>;
}

export interface SimpleLoggerConfig {
  name?: string;
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  transports?: SimpleTransport[];
  enableTimestamp?: boolean;
  enableMetadata?: boolean;
}

export class ConsoleTransport implements SimpleTransport {
  name = 'console';
  
  write(entry: SimpleLogEntry): void {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(entry, null, 2));
  }
}

export class BufferedTransport implements SimpleTransport {
  name = 'buffered';
  private buffer: SimpleLogEntry[] = [];
  
  write(entry: SimpleLogEntry): void {
    this.buffer.push(entry);
  }
  
  getEntries(): SimpleLogEntry[] {
    return [...this.buffer];
  }
  
  clear(): void {
    this.buffer = [];
  }
  
  flush(): void {
    // eslint-disable-next-line no-console
    this.buffer.forEach(entry => console.log(JSON.stringify(entry)));
    this.clear();
  }
}

export class SimpleLogger {
  private config: SimpleLoggerConfig;
  private transports: SimpleTransport[] = [];
  
  constructor(config: SimpleLoggerConfig = {}) {
    this.config = {
      name: 'simple-logger',
      level: 'info',
      enableTimestamp: true,
      enableMetadata: true,
      ...config
    };
    
    this.transports = config.transports || [new ConsoleTransport()];
  }
  
  private shouldLog(level: string): boolean {
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    const currentLevel = levels.indexOf(this.config.level || 'info');
    const logLevel = levels.indexOf(level);
    return logLevel >= currentLevel;
  }
  
  private createEntry(level: string, message: string, context?: Record<string, unknown>): SimpleLogEntry {
    const entry: SimpleLogEntry = {
      timestamp: this.config.enableTimestamp ? new Date().toISOString() : '',
      level,
      message,
    };
    
    if (context) {
      entry.context = context;
    }
    
    if (this.config.enableMetadata) {
      entry.metadata = {
        logger: this.config.name,
        pid: process.pid,
        hostname: hostname(),
      };
    }
    
    return entry;
  }
  
  private log(level: string, message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) {
      return;
    }
    
    const entry = this.createEntry(level, message, context);
    
    // Write to all transports
    this.transports.forEach(transport => {
      try {
        const result = transport.write(entry);
        if (result instanceof Promise) {
          result.catch(error => {
            console.error(`Transport ${transport.name} error:`, error);
          });
        }
      } catch (error) {
        console.error(`Transport ${transport.name} error:`, error);
      }
    });
  }
  
  trace(message: string, context?: Record<string, unknown>): void {
    this.log('trace', message, context);
  }
  
  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }
  
  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }
  
  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }
  
  error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context);
  }
  
  fatal(message: string, context?: Record<string, unknown>): void {
    this.log('fatal', message, context);
  }
  
  addTransport(transport: SimpleTransport): void {
    this.transports.push(transport);
  }
  
  removeTransport(name: string): void {
    this.transports = this.transports.filter(t => t.name !== name);
  }
  
  getTransports(): SimpleTransport[] {
    return [...this.transports];
  }
  
  getConfig(): SimpleLoggerConfig {
    return { ...this.config };
  }
}

// Factory function for easy creation
export function createSimpleLogger(config?: SimpleLoggerConfig): SimpleLogger {
  return new SimpleLogger(config);
}

// Export default logger instance
export const logger = createSimpleLogger();

// Export for compatibility
export default SimpleLogger;
