// Simple Logger (working version)
import { 
  SimpleLogger, 
  SimpleLogEntry, 
  SimpleTransport, 
  SimpleLoggerConfig,
  ConsoleTransport as SimpleConsoleTransport, 
  BufferedTransport, 
  createSimpleLogger,
  logger as simpleLogger
} from './simple-logger';

// Advanced components (when ready)
// import { TurboLogger, TurboLoggerOptions, createLogger } from './core/logger';
// import { Transport, ConsoleTransport, FileTransport } from './core/transport';
// import { TurboSerializer } from './core/serializer';
// import { CircularBuffer, MultiLevelBuffer } from './core/buffer';
// import { PerformanceMonitor, LoggerProfiler } from './core/performance';
// import { TurboMetrics } from './observability/metrics';
// import { TurboTracer, initializeTracing, getTracer, trace, traceAsync } from './observability/tracing';
// import { LogEncryption, LogSigner, SecureLogProcessor } from './security/encryption';
// import { PIIDetector } from './security/pii-detector';
// import { createExpressLogger, createErrorLogger } from './integrations/express';
// import { RealtimeLogStreamer } from './dev/realtime';
// import { ElasticsearchTransport } from './transports/elasticsearch';

export {
  // Simple Logger (working version)
  SimpleLogger,
  SimpleLogEntry,
  SimpleTransport,
  SimpleLoggerConfig,
  SimpleConsoleTransport as ConsoleTransport,
  BufferedTransport,
  createSimpleLogger,
  simpleLogger as logger
  
  // Advanced components (when ready)
  // TurboLogger,
  // TurboLoggerOptions,
  // createLogger,
  // Transport,
  // FileTransport,
  // ElasticsearchTransport,
  // TurboSerializer,
  // CircularBuffer,
  // MultiLevelBuffer,
  // PerformanceMonitor,
  // LoggerProfiler,
  // TurboMetrics,
  // TurboTracer,
  // initializeTracing,
  // getTracer,
  // trace,
  // traceAsync,
  // LogEncryption,
  // LogSigner,
  // SecureLogProcessor,
  // PIIDetector,
  // createExpressLogger,
  // createErrorLogger,
  // RealtimeLogStreamer
};

// Main factory function - creates a logger
export function createLogger(config?: SimpleLoggerConfig): SimpleLogger {
  return createSimpleLogger(config);
}

// Default export for easy usage
export default function createTurboLogger(options?: SimpleLoggerConfig): SimpleLogger {
  return createSimpleLogger(options);
}
