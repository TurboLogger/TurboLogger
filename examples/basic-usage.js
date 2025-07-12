const logger = require('../lib')();

// Basic logging
logger.info('Hello World');
logger.error(new Error('Something went wrong'));
logger.debug({ userId: 123 }, 'User action performed');

// With custom configuration
const customLogger = require('../lib')({
  performance: {
    mode: 'ultra',
    zeroAllocation: true
  },
  output: {
    format: 'pretty',
    level: 'debug'
  },
  dev: {
    stackTrace: true
  }
});

// Log different levels
customLogger.trace('This is a trace message');
customLogger.debug('Debug information', { extra: 'data' });
customLogger.info('Information message');
customLogger.warn('Warning message');
customLogger.error(new Error('Error with stack trace'));
customLogger.fatal('Fatal error occurred');

// Child logger with context
const userLogger = customLogger.child({ userId: 456, sessionId: 'abc123' });
userLogger.info('User logged in');
userLogger.info('User performed action', { action: 'click_button' });

// Context propagation
logger.withContext({ requestId: 'req-123' }, () => {
  logger.info('Processing request');
  
  // Nested context
  logger.withContext({ operation: 'payment' }, () => {
    logger.info('Processing payment');
  });
});

// File transport example
const fileLogger = require('../lib')({
  transports: [
    new (require('../lib').ConsoleTransport)({ format: 'pretty' }),
    new (require('../lib').FileTransport)({
      path: './app.log',
      rotation: {
        size: 10 * 1024 * 1024, // 10MB
        keep: 5,
        compress: true
      }
    })
  ]
});

fileLogger.info('This will be logged to both console and file');

// Performance mode
const perfLogger = require('../lib')({
  performance: {
    mode: 'ultra',
    bufferSize: 8192,
    flushInterval: 50,
    zeroAllocation: true
  }
});

// High-performance logging
for (let i = 0; i < 1000; i++) {
  perfLogger.info({ iteration: i }, 'High-speed logging');
}