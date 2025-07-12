const {
  default: turbologger,
  TurboMetrics,
  initializeTracing,
  createExpressLogger,
  RealtimeLogStreamer,
  ElasticsearchTransport,
  PIIDetector,
  PerformanceMonitor
} = require('../lib');

async function demonstrateAdvancedFeatures() {
  console.log('🚀 TurboLogger Advanced Features Demo\n');

  // 1. Performance Monitoring
  console.log('1. Performance Monitoring:');
  const monitor = new PerformanceMonitor();
  monitor.startMonitoring(1000);
  
  monitor.on('metrics', (metrics) => {
    console.log(`   CPU: ${metrics.cpu.percent.toFixed(1)}% | Memory: ${(metrics.memory.heapUsed / 1024 / 1024).toFixed(1)}MB`);
  });

  const logger = turbologger({
    performance: {
      mode: 'ultra',
      zeroAllocation: true,
      bufferSize: 8192
    },
    output: {
      format: 'pretty',
      level: 'debug'
    }
  });

  // 2. Metrics Collection
  console.log('\n2. Metrics Collection:');
  const metrics = new TurboMetrics();
  metrics.startPrometheusServer(9091);

  const requestCounter = metrics.counter({
    name: 'http_requests_total',
    type: 'counter',
    help: 'Total HTTP requests',
    labels: ['method', 'status']
  });

  const responseTime = metrics.histogram({
    name: 'http_response_time_ms',
    type: 'histogram',
    help: 'HTTP response time in milliseconds',
    buckets: [10, 50, 100, 200, 500, 1000]
  });

  // Simulate some requests
  for (let i = 0; i < 10; i++) {
    requestCounter.inc(1, { method: 'GET', status: '200' });
    responseTime.observe(Math.random() * 200 + 50);
  }

  console.log('   Metrics server running on http://localhost:9091/metrics');

  // 3. Distributed Tracing
  console.log('\n3. Distributed Tracing:');
  const tracer = initializeTracing({
    serviceName: 'demo-service',
    sampler: 'probabilistic',
    probability: 1.0
  });

  await tracer.withSpanAsync('demo-operation', async (span) => {
    tracer.setTag(span, 'user.id', '12345');
    tracer.log(span, { event: 'processing_start' });
    
    logger.info('Processing user request', { userId: '12345' });
    
    // Simulate some work
    await new Promise(resolve => setTimeout(resolve, 100));
    
    tracer.log(span, { event: 'processing_complete' });
  });

  // 4. PII Detection and Masking
  console.log('\n4. PII Detection and Masking:');
  const piiDetector = new PIIDetector();
  
  const sensitiveData = {
    user: 'john.doe',
    email: 'john.doe@company.com',
    phone: '555-123-4567',
    ssn: '123-45-6789',
    creditCard: '4532-1234-5678-9012',
    apiKey: 'sk_live_abcdef123456789',
    message: 'User logged in successfully'
  };

  const { masked, detections } = piiDetector.detectAndMask(sensitiveData);
  
  console.log('   Original:', JSON.stringify(sensitiveData, null, 2));
  console.log('   Masked:', JSON.stringify(masked, null, 2));
  console.log(`   Detections: ${detections.length} PII items found`);

  // 5. Real-time Log Streaming
  console.log('\n5. Real-time Log Streaming:');
  const streamer = new RealtimeLogStreamer({
    port: 8080,
    path: '/logs',
    auth: {
      type: 'bearer',
      token: 'demo-token-123'
    },
    filters: {
      levels: ['info', 'warn', 'error']
    }
  });

  try {
    await streamer.start();
    console.log('   WebSocket server started on ws://localhost:8080/logs');
    console.log('   Connect with: wscat -c ws://localhost:8080/logs -H "Authorization: Bearer demo-token-123"');

    // Stream some logs
    for (let i = 0; i < 5; i++) {
      const logData = {
        level: 'info',
        msg: `Streaming log message ${i + 1}`,
        timestamp: Date.now(),
        service: 'demo-service',
        userId: Math.floor(Math.random() * 1000)
      };
      
      streamer.streamLog(logData);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    console.log('   WebSocket demo skipped (port may be in use)');
  }

  // 6. Security Features
  console.log('\n6. Security Features (Log Encryption):');
  const secureLogger = turbologger({
    security: {
      encryption: 'aes-256-gcm',
      signing: true,
      piiMasking: {
        enabled: true,
        autoDetect: true,
        rules: [
          { field: 'email', mask: '***@***.***' },
          { field: 'phone', mask: '***-***-****' }
        ]
      }
    },
    output: {
      format: 'json'
    }
  });

  secureLogger.info({
    message: 'Secure transaction processed',
    amount: 1000,
    email: 'customer@example.com',
    phone: '555-987-6543'
  });

  // 7. Express.js Integration Example
  console.log('\n7. Express.js Integration:');
  console.log('   // Express middleware example:');
  console.log('   app.use(createExpressLogger(logger, {');
  console.log('     autoLogging: true,');
  console.log('     includeBody: false,');
  console.log('     sanitize: ["password", "token"]');
  console.log('   }));');

  // 8. Multiple Transport Example
  console.log('\n8. Multiple Transports:');
  try {
    const multiTransportLogger = turbologger({
      transports: [
        new (require('../lib').ConsoleTransport)({ 
          format: 'compact' 
        }),
        new (require('../lib').FileTransport)({
          path: './demo-logs.log',
          rotation: { size: 1024 * 1024 } // 1MB
        })
        // ElasticsearchTransport would require ES instance
        // new ElasticsearchTransport({
        //   node: 'http://localhost:9200',
        //   index: 'demo-logs'
        // })
      ]
    });

    multiTransportLogger.info('This log goes to both console and file');
    console.log('   ✓ Logged to console and file (demo-logs.log)');
  } catch (error) {
    console.log('   Multi-transport demo completed');
  }

  // 9. Performance Profiling
  console.log('\n9. Performance Profiling:');
  const endProfile = monitor.profile('complex-operation');
  
  // Simulate complex operation
  await new Promise(resolve => {
    let sum = 0;
    for (let i = 0; i < 1000000; i++) {
      sum += Math.sqrt(i);
    }
    setTimeout(resolve, 50);
  });
  
  const duration = endProfile();
  console.log(`   Complex operation took: ${duration.toFixed(2)}ms`);

  // 10. Compliance Validation
  console.log('\n10. Compliance Validation:');
  const testData = {
    user: 'jane.smith@company.com',
    ssn: '987-65-4321',
    diagnosis: 'Patient recovering well',
    creditCard: '4111-1111-1111-1111'
  };

  const gdprResult = piiDetector.validateCompliance(testData, ['gdpr']);
  const hipaaResult = piiDetector.validateCompliance(testData, ['hipaa']);

  console.log(`   GDPR Compliant: ${gdprResult.compliant} (${gdprResult.violations.length} violations)`);
  console.log(`   HIPAA Compliant: ${hipaaResult.compliant} (${hipaaResult.violations.length} violations)`);

  // Cleanup
  setTimeout(async () => {
    console.log('\n🎯 Demo completed successfully!');
    console.log('\nTurboLogger Features Demonstrated:');
    console.log('   ✓ Ultra-fast performance monitoring');
    console.log('   ✓ Prometheus metrics collection');
    console.log('   ✓ Distributed tracing');
    console.log('   ✓ Automatic PII detection and masking');
    console.log('   ✓ Real-time log streaming via WebSocket');
    console.log('   ✓ Enterprise security features');
    console.log('   ✓ Multiple transport support');
    console.log('   ✓ Performance profiling');
    console.log('   ✓ Compliance validation (GDPR, HIPAA)');
    
    monitor.destroy();
    metrics.destroy();
    await streamer.stop();
    process.exit(0);
  }, 3000);
}

// Run the demo
demonstrateAdvancedFeatures().catch(console.error);