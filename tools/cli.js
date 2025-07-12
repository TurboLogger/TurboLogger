#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const turbologger = require('../lib');

program
  .name('oxog-turbologger')
  .description('TurboLogger CLI - Next-generation Node.js logging toolkit')
  .version('1.0.0');

// Initialize command
program
  .command('init')
  .description('Initialize TurboLogger in your project')
  .option('-f, --force', 'Overwrite existing configuration')
  .option('-t, --template <type>', 'Configuration template (basic, express, microservice)', 'basic')
  .action(async (options) => {
    console.log('🚀 Initializing TurboLogger...\n');
    
    const configPath = path.join(process.cwd(), 'turbologger.config.js');
    
    if (fs.existsSync(configPath) && !options.force) {
      console.error('❌ Configuration file already exists. Use --force to overwrite.');
      process.exit(1);
    }
    
    const templates = {
      basic: `module.exports = {
  performance: {
    mode: 'fast',
    bufferSize: 4096,
    flushInterval: 100
  },
  output: {
    format: 'json',
    level: 'info',
    timestamp: true,
    hostname: true
  },
  security: {
    piiMasking: {
      enabled: true,
      autoDetect: true
    }
  }
};`,
      express: `module.exports = {
  performance: {
    mode: 'ultra',
    zeroAllocation: true
  },
  output: {
    format: 'json',
    level: 'info'
  },
  observability: {
    metrics: true,
    traces: true,
    prometheus: {
      enabled: true,
      port: 9090
    }
  },
  security: {
    piiMasking: {
      enabled: true,
      rules: [
        { field: 'password', mask: '[REDACTED]' },
        { field: 'token', mask: '[REDACTED]' },
        { field: 'apiKey', mask: '[REDACTED]' }
      ]
    }
  },
  transports: [
    {
      type: 'console',
      format: 'pretty'
    },
    {
      type: 'file',
      path: './logs/app.log',
      rotation: {
        size: '10MB',
        keep: 5
      }
    }
  ]
};`,
      microservice: `module.exports = {
  performance: {
    mode: 'ultra',
    zeroAllocation: true,
    bufferSize: 8192
  },
  output: {
    format: 'json',
    level: process.env.LOG_LEVEL || 'info'
  },
  observability: {
    metrics: true,
    traces: true,
    opentelemetry: true,
    prometheus: {
      enabled: true,
      port: process.env.METRICS_PORT || 9090
    }
  },
  cloud: {
    kubernetes: true,
    serviceDiscovery: true
  },
  security: {
    encryption: process.env.LOG_ENCRYPTION_ALG || 'aes-256-gcm',
    signing: true,
    piiMasking: {
      enabled: true,
      autoDetect: true,
      compliance: ['gdpr', 'hipaa']
    }
  },
  transports: [
    {
      type: 'console',
      format: 'json'
    },
    {
      type: 'elasticsearch',
      node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
      index: process.env.SERVICE_NAME || 'microservice',
      indexPattern: 'logs-{YYYY.MM.DD}'
    }
  ]
};`
    };
    
    const config = templates[options.template];
    if (!config) {
      console.error(`❌ Unknown template: ${options.template}`);
      process.exit(1);
    }
    
    fs.writeFileSync(configPath, config);
    console.log(`✅ Created ${options.template} configuration: ${configPath}`);
    
    // Create logs directory for file transport
    if (options.template !== 'basic') {
      const logsDir = path.join(process.cwd(), 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir);
        console.log('✅ Created logs directory');
      }
    }
    
    console.log('\n📖 Next steps:');
    console.log('1. npm install @oxog/turbologger');
    console.log('2. const logger = require("@oxog/turbologger")(require("./turbologger.config.js"));');
    console.log('3. logger.info("Hello from TurboLogger!");');
  });

// Validate command
program
  .command('validate')
  .description('Validate TurboLogger configuration')
  .option('-c, --config <file>', 'Configuration file path', './turbologger.config.js')
  .action((options) => {
    console.log('🔍 Validating TurboLogger configuration...\n');
    
    const configPath = path.resolve(options.config);
    
    if (!fs.existsSync(configPath)) {
      console.error(`❌ Configuration file not found: ${configPath}`);
      process.exit(1);
    }
    
    try {
      const config = require(configPath);
      
      // Basic validation
      const issues = [];
      
      if (config.performance?.mode && !['standard', 'fast', 'ultra'].includes(config.performance.mode)) {
        issues.push('Invalid performance mode. Must be: standard, fast, or ultra');
      }
      
      if (config.output?.level && !['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(config.output.level)) {
        issues.push('Invalid log level. Must be: trace, debug, info, warn, error, or fatal');
      }
      
      if (config.output?.format && !['json', 'pretty', 'compact'].includes(config.output.format)) {
        issues.push('Invalid output format. Must be: json, pretty, or compact');
      }
      
      if (issues.length > 0) {
        console.log('❌ Configuration issues found:');
        issues.forEach(issue => console.log(`   • ${issue}`));
        process.exit(1);
      }
      
      console.log('✅ Configuration is valid');
      console.log(`📊 Performance mode: ${config.performance?.mode || 'default'}`);
      console.log(`📝 Log level: ${config.output?.level || 'info'}`);
      console.log(`🎨 Output format: ${config.output?.format || 'json'}`);
      
      if (config.observability?.metrics) {
        console.log('📈 Metrics collection: enabled');
      }
      
      if (config.observability?.traces) {
        console.log('🔍 Distributed tracing: enabled');
      }
      
      if (config.security?.piiMasking?.enabled) {
        console.log('🔒 PII masking: enabled');
      }
      
    } catch (error) {
      console.error(`❌ Failed to load configuration: ${error.message}`);
      process.exit(1);
    }
  });

// Benchmark command
program
  .command('benchmark')
  .description('Run performance benchmarks')
  .option('-i, --iterations <number>', 'Number of iterations', '10000')
  .option('-c, --compare', 'Compare with other loggers (requires pino, winston)')
  .action(async (options) => {
    console.log('🏃‍♂️ Running TurboLogger benchmarks...\n');
    
    const PerformanceBenchmark = require('../benchmarks/performance-comparison');
    const benchmark = new PerformanceBenchmark();
    
    await benchmark.runBenchmarks();
  });

// Tail command (real-time log viewing)
program
  .command('tail')
  .description('Stream real-time logs')
  .option('-f, --file <path>', 'Log file to tail')
  .option('-s, --service <name>', 'Service name filter')
  .option('-l, --level <level>', 'Minimum log level')
  .option('-p, --port <number>', 'WebSocket port', '8080')
  .action(async (options) => {
    console.log('👀 Starting real-time log streaming...\n');
    
    const { RealtimeLogStreamer } = turbologger;
    
    const streamer = new RealtimeLogStreamer({
      port: parseInt(options.port),
      path: '/logs',
      filters: {
        levels: options.level ? [options.level] : undefined,
        services: options.service ? [options.service] : undefined
      }
    });
    
    try {
      await streamer.start();
      console.log(`🌐 WebSocket server running on ws://localhost:${options.port}/logs`);
      console.log('💡 Connect with: wscat -c ws://localhost:8080/logs');
      console.log('Press Ctrl+C to stop\n');
      
      // Keep the process running
      process.on('SIGINT', async () => {
        console.log('\n📴 Stopping log streamer...');
        await streamer.stop();
        process.exit(0);
      });
      
    } catch (error) {
      console.error(`❌ Failed to start streamer: ${error.message}`);
      process.exit(1);
    }
  });

// Analyze command
program
  .command('analyze')
  .description('Analyze log files for patterns and issues')
  .option('-f, --file <path>', 'Log file to analyze', './logs/app.log')
  .option('-p, --pattern <regex>', 'Pattern to search for')
  .option('-e, --errors', 'Focus on error analysis')
  .action((options) => {
    console.log('📊 Analyzing log file...\n');
    
    if (!fs.existsSync(options.file)) {
      console.error(`❌ Log file not found: ${options.file}`);
      process.exit(1);
    }
    
    const content = fs.readFileSync(options.file, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    
    console.log(`📄 File: ${options.file}`);
    console.log(`📏 Total lines: ${lines.length.toLocaleString()}`);
    
    // Analyze log levels
    const levels = {};
    const errors = [];
    const patterns = {};
    
    lines.forEach((line, index) => {
      try {
        const log = JSON.parse(line);
        
        // Count levels
        const level = log.level || log.levelLabel || 'unknown';
        levels[level] = (levels[level] || 0) + 1;
        
        // Collect errors
        if (options.errors && (level === 'error' || level === 50)) {
          errors.push({ line: index + 1, log });
        }
        
        // Pattern matching
        if (options.pattern) {
          const regex = new RegExp(options.pattern, 'i');
          if (regex.test(line)) {
            patterns[index + 1] = line;
          }
        }
        
      } catch (e) {
        // Skip invalid JSON lines
      }
    });
    
    console.log('\n📊 Log Level Distribution:');
    Object.entries(levels)
      .sort(([,a], [,b]) => b - a)
      .forEach(([level, count]) => {
        const percentage = ((count / lines.length) * 100).toFixed(1);
        console.log(`   ${level.padEnd(8)}: ${count.toLocaleString().padStart(8)} (${percentage}%)`);
      });
    
    if (options.errors && errors.length > 0) {
      console.log(`\n❌ Error Analysis (${errors.length} errors found):`);
      errors.slice(0, 5).forEach(({ line, log }) => {
        console.log(`   Line ${line}: ${log.msg || log.message || 'Unknown error'}`);
      });
      
      if (errors.length > 5) {
        console.log(`   ... and ${errors.length - 5} more errors`);
      }
    }
    
    if (options.pattern && Object.keys(patterns).length > 0) {
      console.log(`\n🔍 Pattern matches (${Object.keys(patterns).length} found):`);
      Object.entries(patterns).slice(0, 10).forEach(([line, content]) => {
        console.log(`   Line ${line}: ${content.substring(0, 100)}...`);
      });
    }
    
    console.log('\n✅ Analysis complete');
  });

// Export command
program
  .command('export')
  .description('Export logs to different formats')
  .requiredOption('-f, --file <path>', 'Source log file')
  .requiredOption('-o, --output <path>', 'Output file')
  .option('--format <type>', 'Output format (json, csv, txt)', 'json')
  .option('--filter <level>', 'Filter by log level')
  .option('--from <date>', 'Start date (ISO string)')
  .option('--to <date>', 'End date (ISO string)')
  .action((options) => {
    console.log('📤 Exporting logs...\n');
    
    if (!fs.existsSync(options.file)) {
      console.error(`❌ Source file not found: ${options.file}`);
      process.exit(1);
    }
    
    const content = fs.readFileSync(options.file, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    
    let logs = [];
    lines.forEach(line => {
      try {
        const log = JSON.parse(line);
        
        // Apply filters
        if (options.filter && log.level !== options.filter && log.levelLabel !== options.filter) {
          return;
        }
        
        if (options.from || options.to) {
          const logDate = new Date(log.time || log.timestamp || log['@timestamp']);
          if (options.from && logDate < new Date(options.from)) return;
          if (options.to && logDate > new Date(options.to)) return;
        }
        
        logs.push(log);
      } catch (e) {
        // Skip invalid JSON
      }
    });
    
    let output = '';
    
    switch (options.format) {
      case 'json':
        output = JSON.stringify(logs, null, 2);
        break;
        
      case 'csv':
        if (logs.length > 0) {
          const headers = Object.keys(logs[0]);
          output = headers.join(',') + '\n';
          output += logs.map(log => 
            headers.map(h => JSON.stringify(log[h] || '')).join(',')
          ).join('\n');
        }
        break;
        
      case 'txt':
        output = logs.map(log => 
          `${new Date(log.time || log.timestamp).toISOString()} [${log.level || log.levelLabel}] ${log.msg || log.message || JSON.stringify(log)}`
        ).join('\n');
        break;
        
      default:
        console.error(`❌ Unknown format: ${options.format}`);
        process.exit(1);
    }
    
    fs.writeFileSync(options.output, output);
    console.log(`✅ Exported ${logs.length.toLocaleString()} logs to ${options.output}`);
  });

program.parse();