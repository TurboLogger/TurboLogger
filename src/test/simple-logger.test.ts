import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { 
  SimpleLogger, 
  BufferedTransport, 
  ConsoleTransport, 
  createSimpleLogger 
} from '../simple-logger.js';

describe('SimpleLogger', () => {
  test('should create logger with default config', () => {
    const logger = new SimpleLogger();
    const config = logger.getConfig();
    
    assert.equal(config.name, 'simple-logger');
    assert.equal(config.level, 'info');
    assert.equal(config.enableTimestamp, true);
    assert.equal(config.enableMetadata, true);
  });

  test('should create logger with custom config', () => {
    const logger = new SimpleLogger({
      name: 'test-logger',
      level: 'debug',
      enableTimestamp: false,
      enableMetadata: false
    });
    
    const config = logger.getConfig();
    assert.equal(config.name, 'test-logger');
    assert.equal(config.level, 'debug');
    assert.equal(config.enableTimestamp, false);
    assert.equal(config.enableMetadata, false);
  });

  test('should log messages to buffered transport', () => {
    const buffer = new BufferedTransport();
    const logger = new SimpleLogger({
      transports: [buffer]
    });
    
    logger.info('Test message');
    logger.warn('Warning message');
    logger.error('Error message');
    
    const entries = buffer.getEntries();
    assert.equal(entries.length, 3);
    assert.equal(entries[0].level, 'info');
    assert.equal(entries[0].message, 'Test message');
    assert.equal(entries[1].level, 'warn');
    assert.equal(entries[2].level, 'error');
  });

  test('should filter logs by level', () => {
    const buffer = new BufferedTransport();
    const logger = new SimpleLogger({
      level: 'warn',
      transports: [buffer]
    });
    
    logger.debug('Debug message');
    logger.info('Info message');
    logger.warn('Warning message');
    logger.error('Error message');
    
    const entries = buffer.getEntries();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].level, 'warn');
    assert.equal(entries[1].level, 'error');
  });

  test('should include context in log entries', () => {
    const buffer = new BufferedTransport();
    const logger = new SimpleLogger({
      transports: [buffer]
    });
    
    logger.info('Test message', { userId: 123, action: 'login' });
    
    const entries = buffer.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].context?.userId, 123);
    assert.equal(entries[0].context?.action, 'login');
  });

  test('should include metadata when enabled', () => {
    const buffer = new BufferedTransport();
    const logger = new SimpleLogger({
      name: 'test-logger',
      enableMetadata: true,
      transports: [buffer]
    });
    
    logger.info('Test message');
    
    const entries = buffer.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].metadata?.logger, 'test-logger');
    assert.equal(typeof entries[0].metadata?.pid, 'number');
    assert.equal(typeof entries[0].metadata?.hostname, 'string');
  });

  test('should not include metadata when disabled', () => {
    const buffer = new BufferedTransport();
    const logger = new SimpleLogger({
      enableMetadata: false,
      transports: [buffer]
    });
    
    logger.info('Test message');
    
    const entries = buffer.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].metadata, undefined);
  });

  test('should include timestamp when enabled', () => {
    const buffer = new BufferedTransport();
    const logger = new SimpleLogger({
      enableTimestamp: true,
      transports: [buffer]
    });
    
    logger.info('Test message');
    
    const entries = buffer.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(typeof entries[0].timestamp, 'string');
    assert.notEqual(entries[0].timestamp, '');
  });

  test('should not include timestamp when disabled', () => {
    const buffer = new BufferedTransport();
    const logger = new SimpleLogger({
      enableTimestamp: false,
      transports: [buffer]
    });
    
    logger.info('Test message');
    
    const entries = buffer.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].timestamp, '');
  });

  test('should support multiple transports', () => {
    const buffer1 = new BufferedTransport();
    const buffer2 = new BufferedTransport();
    buffer1.name = 'buffer1';
    buffer2.name = 'buffer2';
    
    const logger = new SimpleLogger({
      transports: [buffer1, buffer2]
    });
    
    logger.info('Test message');
    
    assert.equal(buffer1.getEntries().length, 1);
    assert.equal(buffer2.getEntries().length, 1);
  });

  test('should add and remove transports', () => {
    const buffer = new BufferedTransport();
    const logger = new SimpleLogger({
      transports: []
    });
    
    logger.addTransport(buffer);
    assert.equal(logger.getTransports().length, 1);
    
    logger.info('Test message');
    assert.equal(buffer.getEntries().length, 1);
    
    logger.removeTransport('buffered');
    assert.equal(logger.getTransports().length, 0);
  });

  test('should handle transport errors gracefully', () => {
    const faultyTransport = {
      name: 'faulty',
      write: () => {
        throw new Error('Transport error');
      }
    };
    
    const buffer = new BufferedTransport();
    const logger = new SimpleLogger({
      transports: [faultyTransport, buffer]
    });
    
    // Should not throw, despite faulty transport
    logger.info('Test message');
    
    // Other transports should still work
    assert.equal(buffer.getEntries().length, 1);
  });

  test('should use factory function', () => {
    const logger = createSimpleLogger({ name: 'factory-logger' });
    const config = logger.getConfig();
    
    assert.equal(config.name, 'factory-logger');
    assert.ok(logger instanceof SimpleLogger);
  });
});

describe('BufferedTransport', () => {
  test('should buffer entries', () => {
    const transport = new BufferedTransport();
    const entry = {
      timestamp: '2023-01-01T00:00:00.000Z',
      level: 'info',
      message: 'Test message'
    };
    
    transport.write(entry);
    
    const entries = transport.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].message, 'Test message');
  });

  test('should clear buffer', () => {
    const transport = new BufferedTransport();
    const entry = {
      timestamp: '2023-01-01T00:00:00.000Z',
      level: 'info',
      message: 'Test message'
    };
    
    transport.write(entry);
    assert.equal(transport.getEntries().length, 1);
    
    transport.clear();
    assert.equal(transport.getEntries().length, 0);
  });
});
