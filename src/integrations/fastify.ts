// Fastify TurboLogger Plugin
import { TurboLogger } from '../core/logger';

// Fastify types to avoid direct dependency
interface FastifyRequest {
  id: string;
  raw: {
    method?: string;
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
  };
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  ip?: string;
  ips?: string[];
  hostname?: string;
  protocol?: string;
  log?: TurboLogger;
  routerPath?: string;
  startTime?: number;
  connection?: { remoteAddress?: string };
  [key: string]: unknown;
}

interface FastifyReply {
  statusCode: number;
  raw: {
    statusCode?: number;
    statusMessage?: string;
  };
  getResponseTime(): number;
  header(key: string, value: string | number): FastifyReply;
  getHeader(name: string): string | number | string[] | undefined;
  [key: string]: unknown;
}

interface FastifyInstance {
  log: TurboLogger;
  addHook(name: string, hook: (request: FastifyRequest, reply: FastifyReply, error?: Error) => Promise<void>): void;
  get(path: string, handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void;
  decorate(name: string, value: unknown): void;
  decorateRequest(name: string, value: unknown): void;
  register(plugin: (instance: FastifyInstance, options: unknown) => void, options?: unknown): void;
  profile?: (name: string) => () => number;
  withContext?: (context: Record<string, unknown>, fn: () => unknown) => unknown;
}

export interface FastifyTurboLoggerOptions {
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
  autoLogging?: boolean;
  includeBody?: boolean;
  includeHeaders?: boolean | string[];
  excludeHeaders?: string[];
  sanitize?: string[];
  skipPaths?: (string | RegExp)[];
  requestIdHeader?: string;
  generateRequestId?: () => string;
}

// Plugin function
export function fastifyTurboLogger(
  fastify: FastifyInstance,
  options: FastifyTurboLoggerOptions = {}
): void {
  const createTurboLogger = require('../index').default;
  
  // Create logger instance
  const logger = createTurboLogger(options);
  
  // Decorate fastify instance with logger
  fastify.decorate('log', logger);
  
  // Add logger to request object
  fastify.decorateRequest('log', null);
  
  // Generate request ID function
  const generateRequestId = options.generateRequestId || (() => {
    return Math.random().toString(36).substr(2, 9);
  });

  // Request/Response logging hook
  if (options.autoLogging !== false) {
    fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const startTime = Date.now();
      request.startTime = startTime;
      
      // Generate or extract request ID
      const requestIdHeader = options.requestIdHeader || 'x-request-id';
      const requestId = (request.headers[requestIdHeader] as string) || generateRequestId();
      request.id = requestId;
      
      // Set response header
      reply.header(requestIdHeader, requestId);
      
      // Skip logging for certain paths
      if (shouldSkipPath(request.url, options.skipPaths || [])) {
        request.log = logger;
        return;
      }

      // Create request-scoped logger
      request.log = logger.child({
        requestId,
        method: request.method,
        url: request.url,
        userAgent: request.headers['user-agent'] as string | undefined,
        ip: getClientIP(request)
      });

      // Log request
      const requestLog = createRequestLog(request, options);
      if (request.log) {
        request.log.info(requestLog, 'Request started');
      }
    });

    fastify.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.log || shouldSkipPath(request.url, options.skipPaths || [])) {
        return;
      }

      const responseTime = Date.now() - (request.startTime || Date.now());
      
      const responseLog = {
        requestId: request.id,
        statusCode: reply.statusCode,
        responseTime,
        contentLength: reply.getHeader('content-length')
      };

      const level = getLogLevel(reply.statusCode);
      const logMethod = request.log[level as keyof TurboLogger] as (obj: Record<string, unknown>, msg: string) => void;
      if (typeof logMethod === 'function') {
        logMethod.call(request.log, responseLog, 'Request completed');
      }
    });

    // Error logging hook
    fastify.addHook('onError', async (request: FastifyRequest, reply: FastifyReply, error?: Error) => {
      if (!request.log) {
        request.log = logger;
      }

      const responseTime = request.startTime ? Date.now() - request.startTime : 0;
      
      if (!error) {
        return;
      }
      
      const errorLog = {
        requestId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode || 500,
        responseTime,
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack
        }
      };

      if (request.log) {
        request.log.error(errorLog, 'Request error');
      }
    });
  }

  // Add metrics endpoint if enabled
  if (options.observability?.prometheus?.enabled) {
    const metricsEndpoint = options.observability.prometheus.endpoint || '/metrics';
    
    fastify.get(metricsEndpoint, async (_request: FastifyRequest, reply: FastifyReply) => {
      const { TurboMetrics } = require('../index');
      const metrics = new TurboMetrics();
      
      const replyType = reply.type as ((contentType: string) => FastifyReply) | undefined;
      if (replyType) {
        replyType.call(reply, 'text/plain');
      }
      return metrics.getMetrics();
    });
  }

  // Add health check endpoint
  fastify.get('/health', async (request: FastifyRequest, _reply: FastifyReply) => {
    const healthData = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: process.version
    };

    if (request.log) {
      request.log.debug(healthData, 'Health check');
    }
    return healthData;
  });

  // Add request context helper
  fastify.decorate('withContext', (context: Record<string, unknown>, fn: () => unknown) => {
    return logger.withContext(context, fn);
  });

  // Add profiling helpers
  fastify.decorate('profile', (name: string) => {
    const startTime = Date.now();
    return () => {
      const duration = Date.now() - startTime;
      logger.info({ operation: name, duration }, `Operation ${name} completed`);
      return duration;
    };
  });
}

// Helper functions
function shouldSkipPath(path: string, skipPaths: (string | RegExp)[]): boolean {
  return skipPaths.some(skipPath => {
    if (typeof skipPath === 'string') {
      return path === skipPath || path.startsWith(skipPath);
    } else {
      return skipPath.test(path);
    }
  });
}

function getClientIP(request: FastifyRequest): string {
  return request.ip ||
         request.connection?.remoteAddress ||
         (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
         (request.headers['x-real-ip'] as string) ||
         'unknown';
}

function createRequestLog(request: FastifyRequest, options: FastifyTurboLoggerOptions): Record<string, unknown> {
  const log: Record<string, unknown> = {
    requestId: request.id,
    method: request.method,
    url: request.url,
    path: request.routerPath || request.url.split('?')[0],
    ip: getClientIP(request),
    timestamp: request.startTime
  };

  // Add query parameters
  if (request.query && Object.keys(request.query).length > 0) {
    log.query = sanitizeObject(request.query, options.sanitize || []);
  }

  // Add headers
  if (options.includeHeaders) {
    log.headers = filterHeaders(
      request.headers,
      options.includeHeaders,
      options.excludeHeaders || ['authorization', 'cookie', 'x-api-key']
    );
  }

  // Add user agent
  if (request.headers['user-agent']) {
    log.userAgent = request.headers['user-agent'] as string;
  }

  // Add body
  if (options.includeBody && request.body) {
    log.body = sanitizeObject(request.body, options.sanitize || []);
  }

  return log;
}

function filterHeaders(
  headers: Record<string, string | string[] | undefined>,
  include: boolean | string[],
  exclude: string[]
): Record<string, unknown> {
  if (!include) return {};

  const filtered: Record<string, unknown> = {};
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

function sanitizeObject(obj: unknown, redactKeys: string[]): unknown {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, redactKeys));
  }

  const sanitized: Record<string, unknown> = {};
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

function getLogLevel(statusCode: number): string {
  if (statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'warn';
  return 'info';
}

// Plugin metadata
(fastifyTurboLogger as unknown as Record<symbol, unknown>)[Symbol.for('skip-override')] = true;
(fastifyTurboLogger as unknown as Record<symbol, unknown>)[Symbol.for('fastify.display-name')] = 'fastify-@oxog/turbologger';

// Example usage
export function createFastifyApp(options: FastifyTurboLoggerOptions = {}) {
  const fastify = require('fastify')({
    logger: false // Disable default logger
  });

  // Register TurboLogger plugin
  fastify.register(fastifyTurboLogger, {
    performance: { mode: 'ultra' },
    autoLogging: true,
    includeHeaders: ['user-agent', 'content-type'],
    sanitize: ['password', 'token', 'secret'],
    observability: {
      metrics: true,
      prometheus: { enabled: true }
    },
    ...options
  });

  // Example route with logging
  fastify.get('/api/users/:id', async (request: FastifyRequest, _reply: FastifyReply) => {
    const params = request.params as Record<string, string>;
    const id = params.id;
    
    // Use request-scoped logger
    if (request.log) {
      request.log.info({ userId: id }, 'Fetching user');
    }
    
    // Simulate async operation with profiling
    const endProfile = fastify.profile ? fastify.profile('fetch-user') : () => 0;
    
    try {
      // Simulate database call
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const user = { id, name: `User ${id}`, email: `user${id}@example.com` };
      
      const duration = endProfile();
      if (request.log) {
        request.log.info({ userId: id, duration }, 'User fetched successfully');
      }
      
      return user;
    } catch (error) {
      endProfile();
      if (request.log) {
        request.log.error(error as Error, 'Failed to fetch user');
      }
      throw error;
    }
  });

  return fastify;
}

// Type definitions for TypeScript users
export interface FastifyWithTurboLogger {
  log: TurboLogger;
  withContext: (context: Record<string, unknown>, fn: () => unknown) => unknown;
  profile: (name: string) => () => number;
}

export interface FastifyRequestWithLogger {
  log: TurboLogger;
  id: string;
  startTime: number;
}