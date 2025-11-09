// Express types with proper typing to avoid direct dependency
interface Request {
  method?: string;
  url?: string;
  path?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  ip?: string;
  ips?: string[];
  hostname?: string;
  protocol?: string;
  secure?: boolean;
  xhr?: boolean;
  user?: unknown;
  log?: TurboLogger;
  requestId?: string;
  startTime?: number;
  get?(name: string): string | undefined;
  connection?: { remoteAddress?: string };
  socket?: { remoteAddress?: string };
  [key: string]: unknown;
}

interface Response {
  statusCode?: number;
  statusMessage?: string;
  locals?: Record<string, unknown>;
  setHeader?(name: string, value: string | number | readonly string[]): void;
  get?(name: string): string | undefined;
  getHeaders?(): Record<string, unknown>;
  end?: (...args: unknown[]) => unknown;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  [key: string]: unknown;
}

type NextFunction = (err?: unknown) => void;
import { TurboLogger } from '../core/logger';
import { getTracer } from '../observability/tracing';
import { randomBytes } from 'crypto';

export interface ExpressLoggerOptions {
  autoLogging?: boolean;
  includeBody?: boolean;
  includeHeaders?: boolean | string[];
  excludeHeaders?: string[];
  sanitize?: string[];
  customFields?: (req: Request, res: Response) => Record<string, unknown>;
  skipPaths?: (string | RegExp)[];
  skipSuccessfulRequests?: boolean;
  logLevel?: string;
  requestIdHeader?: string;
  generateRequestId?: () => string;
  ignoredUserAgents?: (string | RegExp)[];
  bodyMaxLength?: number;
  redactKeys?: string[];
}

export interface RequestLog {
  requestId: string;
  method: string;
  url: string;
  path: string;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: unknown;
  userAgent?: string;
  ip: string;
  timestamp: number;
}

export interface ResponseLog {
  requestId: string;
  statusCode: number;
  statusMessage: string;
  headers?: Record<string, unknown>;
  responseTime: number;
  contentLength?: number;
  timestamp: number;
}

declare global {
  namespace Express {
    interface Request {
      log: TurboLogger;
      requestId: string;
      startTime: number;
    }
  }
}

export function createExpressLogger(
  logger: TurboLogger,
  options: ExpressLoggerOptions = {}
): (req: Request, res: Response, next: NextFunction) => void {
  const {
    autoLogging = true,
    includeBody = false,
    includeHeaders = true,
    excludeHeaders = ['authorization', 'cookie', 'x-api-key'],
    sanitize = ['password', 'token', 'secret', 'key'],
    skipPaths = [],
    skipSuccessfulRequests = false,
    logLevel = 'info',
    requestIdHeader = 'x-request-id',
    generateRequestId = () => randomBytes(16).toString('hex'),
    ignoredUserAgents = [],
    bodyMaxLength = 10000,
    redactKeys = ['password', 'token', 'secret', 'authorization']
  } = options;

  return function turboLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
    const startTime = Date.now();
    req.startTime = startTime;

    // Generate or extract request ID
    req.requestId = (req.headers?.[requestIdHeader] as string) || generateRequestId();
    if (res.setHeader) {
      res.setHeader(requestIdHeader, req.requestId);
    }

    // Skip logging for certain paths
    const requestPath = req.path || req.url?.split('?')[0] || '/';
    if (shouldSkipPath(requestPath, skipPaths)) {
      return next();
    }

    // Skip logging for ignored user agents
    const userAgent = req.get ? req.get('user-agent') : req.headers?.['user-agent'] as string | undefined;
    if (shouldSkipUserAgent(userAgent, ignoredUserAgents)) {
      return next();
    }

    // Create request-scoped logger
    const requestUserAgent = req.get ? req.get('user-agent') : req.headers?.['user-agent'] as string | undefined;
    req.log = logger.child({
      requestId: req.requestId,
      method: req.method,
      url: req.url,
      userAgent: requestUserAgent,
      ip: getClientIP(req)
    });

    // Start tracing span if available
    const tracer = getTracer();
    let span: any;
    if (tracer) {
      span = tracer.startSpan(`${req.method} ${req.path}`);
      tracer.setTag(span, 'http.method', req.method || 'UNKNOWN');
      tracer.setTag(span, 'http.url', req.url || 'UNKNOWN');
      const traceUserAgent = (req.get ? req.get('user-agent') : req.headers?.['user-agent'] as string | undefined) || '';
      tracer.setTag(span, 'http.user_agent', traceUserAgent);
    }

    if (autoLogging) {
      const requestLog = createRequestLog(req, {
        includeHeaders,
        excludeHeaders,
        includeBody,
        sanitize,
        bodyMaxLength,
        redactKeys
      });

      req.log.info(requestLog as unknown as Record<string, unknown>, 'Request started');
    }

    // Capture original res.end to log response
    const originalEnd = res.end;
    res.end = function(this: Response, ...args: any[]) {
      const responseTime = Date.now() - startTime;
      
      if (span) {
        tracer!.setTag(span, 'http.status_code', res.statusCode || 500);
        tracer!.setTag(span, 'http.response_time_ms', responseTime);
        
        if ((res.statusCode || 500) >= 400) {
          tracer!.setTag(span, 'error', true);
        }
        
        tracer!.finishSpan(span);
      }

      if (autoLogging && req.log && !shouldSkipLogging(res.statusCode || 500, skipSuccessfulRequests)) {
        const responseLog = createResponseLog(req, res, responseTime, {
          includeHeaders,
          excludeHeaders
        });

        const level = getLogLevel(res.statusCode || 500, logLevel);
        const logMethod = req.log[level as keyof TurboLogger] as (obj: Record<string, unknown>, msg: string) => void;
        if (typeof logMethod === 'function') {
          logMethod.call(req.log, responseLog as unknown as Record<string, unknown>, 'Request completed');
        }
      }

      // Add custom fields if provided
      if (options.customFields && req.log) {
        const customData = options.customFields(req, res);
        req.log.info(customData, 'Custom request data');
      }

      return originalEnd ? originalEnd.apply(this, args) : undefined;
    };

    next();
  };
}

function createRequestLog(
  req: Request,
  options: {
    includeHeaders: boolean | string[];
    excludeHeaders: string[];
    includeBody: boolean;
    sanitize: string[];
    bodyMaxLength: number;
    redactKeys: string[];
  }
): RequestLog {
  const log: RequestLog = {
    requestId: req.requestId || 'unknown',
    method: req.method || 'UNKNOWN',
    url: req.url || 'unknown',
    path: req.path || req.url?.split('?')[0] || '/',
    ip: getClientIP(req),
    timestamp: req.startTime || Date.now()
  };

  // Add query parameters
  if (req.query && Object.keys(req.query).length > 0) {
    log.query = sanitizeObject(req.query, options.redactKeys);
  }

  // Add headers
  if (options.includeHeaders) {
    log.headers = filterHeaders(req.headers || {}, options.includeHeaders, options.excludeHeaders);
  }

  // Add user agent
  const userAgent = req.get ? req.get('user-agent') : req.headers?.['user-agent'] as string | undefined;
  if (userAgent) {
    log.userAgent = userAgent;
  }

  // Add body
  if (options.includeBody && req.body) {
    let body = req.body;
    
    // Limit body size
    const bodyStr = JSON.stringify(body);
    if (bodyStr.length > options.bodyMaxLength) {
      body = { 
        _truncated: true, 
        _originalLength: bodyStr.length,
        _preview: bodyStr.substring(0, options.bodyMaxLength) 
      };
    }
    
    log.body = sanitizeObject(body, options.redactKeys);
  }

  return log;
}

function createResponseLog(
  req: Request,
  res: Response,
  responseTime: number,
  options: {
    includeHeaders: boolean | string[];
    excludeHeaders: string[];
  }
): ResponseLog {
  const log: ResponseLog = {
    requestId: req.requestId || 'unknown',
    statusCode: res.statusCode || 500,
    statusMessage: res.statusMessage || 'Unknown',
    responseTime,
    timestamp: Date.now()
  };

  // Add response headers
  if (options.includeHeaders) {
    const responseHeaders = res.getHeaders ? res.getHeaders() : {};
    log.headers = filterHeaders(responseHeaders, options.includeHeaders, options.excludeHeaders);
  }

  // Add content length if available
  const contentLength = res.get ? res.get('content-length') : undefined;
  if (contentLength) {
    log.contentLength = parseInt(contentLength, 10);
  }

  return log;
}

function filterHeaders(
  headers: any,
  include: boolean | string[],
  exclude: string[]
): Record<string, any> {
  if (!include) return {};

  const filtered: Record<string, any> = {};
  const includeHeaders = Array.isArray(include) ? include.map(h => h.toLowerCase()) : null;
  const excludeHeaders = exclude.map(h => h.toLowerCase());

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    
    if (excludeHeaders.includes(lowerKey)) {
      continue;
    }
    
    if (includeHeaders && !includeHeaders.includes(lowerKey)) {
      continue;
    }
    
    filtered[key] = value;
  }

  return filtered;
}

function sanitizeObject(obj: any, redactKeys: string[]): any {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, redactKeys));
  }

  const sanitized: any = {};
  const lowerRedactKeys = redactKeys.map(key => key.toLowerCase());

  for (const [key, value] of Object.entries(obj)) {
    if (lowerRedactKeys.some(redactKey => key.toLowerCase().includes(redactKey))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeObject(value, redactKeys);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

function shouldSkipPath(path: string, skipPaths: (string | RegExp)[]): boolean {
  return skipPaths.some(skipPath => {
    if (typeof skipPath === 'string') {
      // BUG #20 FIX: Prevent partial path matches (e.g., "/api" should not match "/apiv2")
      // Ensure exact match or path starts with skipPath followed by "/"
      return path === skipPath || path.startsWith(skipPath + '/');
    } else {
      return skipPath.test(path);
    }
  });
}

function shouldSkipUserAgent(userAgent: string | undefined, ignoredUserAgents: (string | RegExp)[]): boolean {
  if (!userAgent) return false;
  
  return ignoredUserAgents.some(ignored => {
    if (typeof ignored === 'string') {
      return userAgent.includes(ignored);
    } else {
      return ignored.test(userAgent);
    }
  });
}

function shouldSkipLogging(statusCode: number, skipSuccessfulRequests: boolean): boolean {
  return skipSuccessfulRequests && statusCode >= 200 && statusCode < 400;
}

function getLogLevel(statusCode: number, defaultLevel: string): string {
  if (statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'warn';
  if (statusCode >= 300) return 'info';
  return defaultLevel;
}

function getClientIP(req: Request): string {
  return (
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    (req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    (req.headers?.['x-real-ip'] as string) ||
    'unknown'
  );
}

// Error handling middleware
export function createErrorLogger(
  logger: TurboLogger
): (err: Error, req: Request, _res: Response, next: NextFunction) => void {
  return function errorLogger(err: Error, req: Request, _res: Response, next: NextFunction): void {
    const errorLog = {
      requestId: req.requestId || 'unknown',
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack
      },
      request: {
        method: req.method || 'UNKNOWN',
        url: req.url || 'unknown',
        headers: req.headers || {},
        body: req.body
      },
      timestamp: Date.now()
    };

    const requestLogger = req.log || logger;
    requestLogger.error(errorLog, 'Request error occurred');

    // Add tracing error if available
    const tracer = getTracer();
    if (tracer) {
      const currentContext = tracer.getCurrentContext();
      if (currentContext) {
        const span = tracer.startSpan('error_handling');
        tracer.setError(span, err);
        tracer.finishSpan(span);
      }
    }

    next(err);
  };
}