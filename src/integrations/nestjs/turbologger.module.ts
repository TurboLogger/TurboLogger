// NestJS TurboLogger Module
import { TurboLogger } from '../../core/logger';

// Mock NestJS types to avoid dependency
type DynamicModule = {
  module: unknown;
  providers?: Provider[];
  exports?: unknown[];
  imports?: unknown[];
  global?: boolean;
};

type Provider = {
  provide: string | symbol | Function;
  useValue?: unknown;
  useFactory?: (...args: unknown[]) => unknown;
  inject?: unknown[];
};

type Type<T = {}> = new (...args: unknown[]) => T;
type Abstract<T = {}> = Function & { prototype: T };
type ForwardReference = { forwardRef: () => unknown };

interface ExecutionContext {
  switchToHttp(): {
    getRequest(): Request;
    getResponse(): Response;
  };
}

interface CallHandler {
  handle(): Observable<unknown>;
}

interface Observable<T> {
  pipe(...operators: unknown[]): Observable<T>;
}

interface NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown>;
}

interface ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): unknown;
}

interface ArgumentsHost {
  switchToHttp(): {
    getRequest(): Request;
    getResponse(): Response;
  };
}

interface CanActivate {
  canActivate(context: ExecutionContext): boolean | Promise<boolean>;
}

// Mock Express types
interface Request {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  user?: { id?: string };
  requestId?: string;
  ip?: string;
  connection?: { remoteAddress?: string };
}

interface Response {
  status(code: number): Response;
  json(obj: unknown): Response;
}
export interface TurboLoggerModuleOptions {
  performance?: {
    mode?: 'standard' | 'fast' | 'ultra';
    bufferSize?: number;
    flushInterval?: number;
    zeroAllocation?: boolean;
  };
  output?: {
    format?: 'json' | 'structured' | 'compact';
    level?: string;
    timestamp?: boolean;
    hostname?: boolean;
    pid?: boolean;
  };
  observability?: {
    metrics?: boolean;
    traces?: boolean;
    opentelemetry?: boolean;
    prometheus?: {
      enabled: boolean;
      port?: number;
      endpoint?: string;
    };
  };
  security?: {
    piiMasking?: {
      enabled: boolean;
      autoDetect?: boolean;
      rules?: Array<{ field?: string; pattern?: RegExp; mask: string }>;
    };
  };
  global?: boolean;
  interceptors?: boolean;
  guards?: boolean;
  filters?: boolean;
}

export interface TurboLoggerModuleAsyncOptions {
  imports?: Array<Type<unknown> | DynamicModule | Promise<DynamicModule> | ForwardReference>;
  useFactory?: (...args: unknown[]) => Promise<TurboLoggerModuleOptions> | TurboLoggerModuleOptions;
  inject?: Array<Type<unknown> | string | symbol | Abstract<unknown> | Function>;
  global?: boolean;
}

// Module implementation
export class TurboLoggerModule {
  static forRoot(options: TurboLoggerModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      {
        provide: 'TURBOLOGGER_OPTIONS',
        useValue: options
      },
      {
        provide: 'TURBOLOGGER_INSTANCE',
        useFactory: (...args: unknown[]) => {
          const opts = args[0] as TurboLoggerModuleOptions;
          const createTurboLogger = require('../../index').default;
          return createTurboLogger(opts);
        },
        inject: ['TURBOLOGGER_OPTIONS']
      },
      {
        provide: TurboLoggerService,
        useFactory: (...args: unknown[]) => new TurboLoggerService(args[0] as TurboLogger),
        inject: ['TURBOLOGGER_INSTANCE']
      }
    ];

    // Add interceptors, guards, and filters if enabled
    if (options.interceptors) {
      providers.push({
        provide: 'APP_INTERCEPTOR',
        useFactory: (...args: unknown[]) => new TurboLoggerInterceptor(args[0] as TurboLoggerService),
        inject: [TurboLoggerService]
      });
    }

    if (options.guards) {
      providers.push({
        provide: 'APP_GUARD',
        useFactory: (...args: unknown[]) => new TurboLoggerGuard(args[0] as TurboLoggerService),
        inject: [TurboLoggerService]
      });
    }

    if (options.filters) {
      providers.push({
        provide: 'APP_FILTER',
        useFactory: (...args: unknown[]) => new TurboLoggerExceptionFilter(args[0] as TurboLoggerService),
        inject: [TurboLoggerService]
      });
    }

    return {
      module: TurboLoggerModule,
      providers,
      exports: ['TURBOLOGGER_INSTANCE', TurboLoggerService],
      global: options.global || false
    };
  }

  static forRootAsync(options: TurboLoggerModuleAsyncOptions): DynamicModule {
    const providers = [
      {
        provide: 'TURBOLOGGER_OPTIONS',
        useFactory: options.useFactory,
        inject: options.inject || []
      },
      {
        provide: 'TURBOLOGGER_INSTANCE',
        useFactory: (...args: unknown[]) => {
          const opts = args[0] as TurboLoggerModuleOptions;
          const createTurboLogger = require('../../index').default;
          return createTurboLogger(opts);
        },
        inject: ['TURBOLOGGER_OPTIONS']
      }
    ];

    return {
      module: TurboLoggerModule,
      imports: options.imports || [],
      providers,
      exports: ['TURBOLOGGER_INSTANCE', TurboLoggerService],
      global: options.global || false
    };
  }
}

// Service for dependency injection
export class TurboLoggerService {
  constructor(private readonly logger: TurboLogger) {}

  trace(message: string, context?: string | Record<string, unknown>): void {
    this.logger.trace(context, message);
  }

  debug(message: string, context?: string | Record<string, unknown>): void {
    this.logger.debug(context, message);
  }

  info(message: string | Record<string, unknown>, context?: string | Record<string, unknown>): void {
    if (typeof message === 'object') {
      this.logger.info(message);
    } else {
      this.logger.info(context, message);
    }
  }

  warn(message: string, context?: string | Record<string, unknown>): void {
    this.logger.warn(context, message);
  }

  error(message: string | Error | Record<string, unknown>, context?: string | Record<string, unknown>): void {
    if (message instanceof Error) {
      this.logger.error(message);
    } else if (typeof message === 'object') {
      this.logger.error(message);
    } else {
      this.logger.error(context, message);
    }
  }

  fatal(message: string | Error, context?: string | Record<string, unknown>): void {
    if (message instanceof Error) {
      this.logger.fatal(message);
    } else {
      this.logger.fatal(context, message);
    }
  }

  child(context: Record<string, unknown>): TurboLogger {
    return this.logger.child(context);
  }

  withContext(context: Record<string, unknown>): TurboLogger {
    const result = this.logger.withContext(context);
    // withContext without a callback always returns TurboLogger
    return result as TurboLogger;
  }
  
  runWithContext<T>(context: Record<string, unknown>, fn: () => T): T {
    return this.logger.runWithContext(context, fn);
  }
}

// Interceptor for automatic request/response logging
export class TurboLoggerInterceptor implements NestInterceptor {
  constructor(private readonly logger: TurboLoggerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();

    // Generate request ID
    const requestId = this.generateRequestId();
    request.requestId = requestId;

    // Create request-scoped logger
    const requestLogger = this.logger.child({
      requestId,
      method: request.method,
      url: request.url,
      userAgent: request.headers['user-agent'],
      ip: this.getClientIP(request)
    });

    // Log request
    requestLogger.info({
      type: 'request',
      method: request.method,
      url: request.url,
      headers: this.sanitizeHeaders(request.headers),
      query: request.query,
      params: request.params
    }, 'Request started');

    return next.handle().pipe(
      // Use rxjs operators here in real implementation
      // tap(() => {
      //   const responseTime = Date.now() - startTime;
      //   requestLogger.info({
      //     type: 'response',
      //     statusCode: response.statusCode,
      //     responseTime
      //   }, 'Request completed');
      // }),
      // catchError((error) => {
      //   const responseTime = Date.now() - startTime;
      //   requestLogger.error({
      //     type: 'error',
      //     error: {
      //       name: error.name,
      //       message: error.message,
      //       stack: error.stack
      //     },
      //     responseTime
      //   }, 'Request failed');
      //   throw error;
      // })
    );
  }

  private generateRequestId(): string {
    // BUG #48 FIX: Use .slice() instead of deprecated .substr()
    return Math.random().toString(36).slice(2, 11);
  }

  private getClientIP(request: Request & { ip?: string; connection?: { remoteAddress?: string } }): string {
    return request.ip || 
           request.connection?.remoteAddress || 
           (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
           'unknown';
  }

  private sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
    const sanitized = { ...headers };
    delete sanitized.authorization;
    delete sanitized.cookie;
    delete sanitized['x-api-key'];
    return sanitized;
  }
}

// Exception filter for error logging
export class TurboLoggerExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: TurboLoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest();
    const response = ctx.getResponse();

    const status = (exception as { getStatus?: () => number }).getStatus?.() || 500;
    
    const errorLog = {
      type: 'exception',
      requestId: request.requestId,
      method: request.method,
      url: request.url,
      statusCode: status,
      error: {
        name: (exception as Error).name || 'Unknown',
        message: (exception as Error).message || 'Unknown error',
        stack: (exception as Error).stack
      },
      timestamp: new Date().toISOString()
    };

    this.logger.error(errorLog);

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message: (exception as Error).message || 'Unknown error'
    });
  }
}

// Guard for request authorization logging
export class TurboLoggerGuard implements CanActivate {
  constructor(private readonly logger: TurboLoggerService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    
    this.logger.info({
      type: 'authorization',
      requestId: request.requestId,
      method: request.method,
      url: request.url,
      user: request.user?.id || 'anonymous'
    });

    return true; // Always allow, just log
  }
}