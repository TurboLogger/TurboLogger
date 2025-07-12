const { createLogger } = require('../../dist/src/core/logger');
const { createExpressLogger } = require('../../dist/src/integrations/express');
const { CloudWatchTransport } = require('../../dist/src/transports/cloud/cloudwatch');
const { StackdriverTransport } = require('../../dist/src/transports/cloud/stackdriver');
const { AzureMonitorTransport } = require('../../dist/src/transports/cloud/azure-monitor');
const { TurboMetrics } = require('../../dist/src/observability/metrics');
const { initializeTracing } = require('../../dist/src/observability/tracing');
const express = require('express');
const path = require('path');
const fs = require('fs');

// Load configuration
const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config', 'production.json');
let config = {};

try {
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
} catch (error) {
  console.error('Failed to load configuration:', error.message);
  process.exit(1);
}

// Initialize observability
const metrics = new TurboMetrics({
  collectDefaultMetrics: true,
  prefix: 'turbologger_production_'
});

const tracer = initializeTracing({
  serviceName: 'turbologger-production',
  sampler: 'parentbased_traceidratio',
  samplingRate: 0.1
});

// Create cloud transports based on environment
const transports = [...(config.transports || [])];

// Add cloud transports if credentials are available
if (process.env.AWS_REGION && process.env.CLOUDWATCH_LOG_GROUP) {
  transports.push(new CloudWatchTransport({
    logGroupName: process.env.CLOUDWATCH_LOG_GROUP,
    region: process.env.AWS_REGION,
    batchSize: 10000,
    batchInterval: 5000
  }));
}

if (process.env.GCP_PROJECT_ID && process.env.STACKDRIVER_LOG_NAME) {
  transports.push(new StackdriverTransport({
    projectId: process.env.GCP_PROJECT_ID,
    logName: process.env.STACKDRIVER_LOG_NAME,
    batchSize: 1000,
    batchInterval: 5000
  }));
}

if (process.env.AZURE_CONNECTION_STRING) {
  transports.push(new AzureMonitorTransport({
    connectionString: process.env.AZURE_CONNECTION_STRING,
    batchSize: 100,
    batchInterval: 5000
  }));
}

// Create logger with production configuration
const logger = createLogger({
  ...config,
  transports,
  observability: {
    ...config.observability,
    metrics: metrics,
    tracer: tracer
  }
});

// Create Express app
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Add TurboLogger middleware
app.use(createExpressLogger(logger, {
  autoLogging: true,
  includeBody: false,
  includeHeaders: ['user-agent', 'content-type', 'x-request-id'],
  sanitize: ['password', 'token', 'secret', 'authorization'],
  skipPaths: ['/health', '/ready', '/metrics'],
  customFields: (req) => ({
    userAgent: req.headers['user-agent'],
    ip: req.ip,
    kubernetes: {
      namespace: process.env.KUBERNETES_NAMESPACE,
      pod: process.env.KUBERNETES_POD_NAME,
      node: process.env.KUBERNETES_NODE_NAME
    }
  })
}));

// Routes
app.get('/health', (req, res) => {
  const healthData = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: process.version,
    environment: process.env.NODE_ENV || 'development'
  };

  logger.debug(healthData, 'Health check performed');
  res.json(healthData);
});

app.get('/ready', (req, res) => {
  // Check if logger and transports are ready
  const readinessChecks = {
    logger: true,
    transports: transports.map(transport => ({
      type: transport.constructor.name,
      active: transport.active
    })),
    metrics: !!metrics,
    tracing: !!tracer
  };

  const isReady = readinessChecks.transports.every(t => t.active);
  
  res.status(isReady ? 200 : 503).json({
    status: isReady ? 'ready' : 'not ready',
    checks: readinessChecks,
    timestamp: new Date().toISOString()
  });
});

app.get('/metrics', async (req, res) => {
  try {
    const metricsData = metrics.getMetrics();
    res.set('Content-Type', 'text/plain');
    res.send(metricsData);
  } catch (error) {
    logger.error(error, 'Failed to generate metrics');
    res.status(500).json({ error: 'Failed to generate metrics' });
  }
});

// Example API endpoints
app.get('/api/logs/test', async (req, res) => {
  const testId = Math.random().toString(36).substr(2, 9);
  
  req.log.info({ testId, action: 'test_started' }, 'Starting log test');
  
  // Generate various log levels
  req.log.debug({ testId, data: 'debug information' }, 'Debug message');
  req.log.info({ testId, operation: 'processing' }, 'Processing request');
  req.log.warn({ testId, warning: 'rate limit approaching' }, 'Warning message');
  
  // Simulate error occasionally
  if (Math.random() < 0.1) {
    const error = new Error('Simulated error for testing');
    req.log.error({ testId, error }, 'Simulated error occurred');
    return res.status(500).json({ error: 'Simulated error', testId });
  }
  
  req.log.info({ testId, action: 'test_completed' }, 'Log test completed');
  
  res.json({
    message: 'Log test completed',
    testId,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/logs/bulk', async (req, res) => {
  const { logs = [], count = 100 } = req.body;
  const batchId = Math.random().toString(36).substr(2, 9);
  
  req.log.info({ batchId, count }, 'Starting bulk log test');
  
  const promises = [];
  for (let i = 0; i < count; i++) {
    promises.push(
      Promise.resolve().then(() => {
        req.log.info({
          batchId,
          logIndex: i,
          data: `Bulk log entry ${i}`,
          timestamp: Date.now()
        }, `Bulk log message ${i}`);
      })
    );
  }
  
  await Promise.all(promises);
  
  req.log.info({ batchId, count, completed: true }, 'Bulk log test completed');
  
  res.json({
    message: `Generated ${count} log entries`,
    batchId,
    timestamp: new Date().toISOString()
  });
});

// Performance monitoring endpoint
app.get('/api/performance', (req, res) => {
  const performanceData = {
    memory: process.memoryUsage(),
    cpu: process.cpuUsage(),
    uptime: process.uptime(),
    loadAverage: require('os').loadavg(),
    freeMemory: require('os').freemem(),
    totalMemory: require('os').totalmem()
  };
  
  req.log.info(performanceData, 'Performance data requested');
  
  res.json(performanceData);
});

// Error handling middleware
app.use((error, req, res, next) => {
  const errorId = Math.random().toString(36).substr(2, 9);
  
  req.log.error({
    errorId,
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack
    },
    request: {
      method: req.method,
      url: req.url,
      headers: req.headers
    }
  }, 'Unhandled application error');
  
  res.status(500).json({
    error: 'Internal server error',
    errorId,
    timestamp: new Date().toISOString()
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, starting graceful shutdown');
  
  try {
    await new Promise(resolve => {
      server.close(resolve);
    });
    
    logger.info('HTTP server closed');
    
    // Flush logger
    await logger.flush();
    logger.info('Logger flushed');
    
    // Close metrics
    if (metrics) {
      metrics.destroy();
    }
    
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error(error, 'Error during graceful shutdown');
    process.exit(1);
  }
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, starting graceful shutdown');
  process.emit('SIGTERM');
});

// Unhandled promise rejection handler
process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({
    reason: String(reason),
    promise: promise.toString()
  }, 'Unhandled promise rejection');
  
  process.exit(1);
});

// Uncaught exception handler
process.on('uncaughtException', (error) => {
  logger.fatal(error, 'Uncaught exception');
  
  // Attempt to flush logs before exiting
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

// Start server
const server = app.listen(port, () => {
  logger.info({
    port,
    environment: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
    pid: process.pid
  }, `TurboLogger production app started on port ${port}`);
});

module.exports = app;