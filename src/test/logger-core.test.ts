import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { TurboLogger } from '../core/logger/logger-core.js';
import { MockTransport, createTestConfig, waitFor } from '../test/utils/test-utils.js';

describe('TurboLogger Core', () => {
  test('should create logger with basic configuration', async () => {
    const config = createTestConfig();
    const logger = new TurboLogger(config);
    
    assert.ok(logger);
    assert.equal(logger.getConfig().name, 'test-logger');
  });

  test('should log messages with different levels', async () => {
    const mockTransport = new MockTransport();
    const config = createTestConfig({
      transports: [mockTransport]
    });
    
    const logger = new TurboLogger(config);
    
    logger.info('Test info message');
    logger.warn('Test warn message');
    logger.error('Test error message');
    
    // Wait for async operations
    await waitFor(() => mockTransport.entries.length >= 3);
    
    assert.equal(mockTransport.entries.length, 3);
    assert.equal(mockTransport.entries[0].levelName, 'info');
    assert.equal(mockTransport.entries[1].levelName, 'warn');
    assert.equal(mockTransport.entries[2].levelName, 'error');
  });

  test('should handle transport errors gracefully', async () => {
    const mockTransport = new MockTransport();
    mockTransport.setShouldFail(true);
    
    const config = createTestConfig({
      transports: [mockTransport]
    });
    
    const logger = new TurboLogger(config);
    
    // This should not throw
    logger.error('Test error with failing transport');
    
    // Wait a bit for async operations
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Transport should have been called but failed
    assert.equal(mockTransport.writeCallCount, 1);
    assert.equal(mockTransport.entries.length, 0);
  });

  test('should support context in log entries', async () => {
    const mockTransport = new MockTransport();
    const config = createTestConfig({
      transports: [mockTransport]
    });
    
    const logger = new TurboLogger(config);
    
    logger.info('Test message', { userId: 123, action: 'login' });
    
    await waitFor(() => mockTransport.entries.length >= 1);
    
    assert.equal(mockTransport.entries.length, 1);
    assert.equal(mockTransport.entries[0].context?.userId, 123);
    assert.equal(mockTransport.entries[0].context?.action, 'login');
  });

  test('should properly destroy logger and transports', async () => {
    const mockTransport = new MockTransport();
    const config = createTestConfig({
      transports: [mockTransport]
    });
    
    const logger = new TurboLogger(config);
    
    // Add some entries
    logger.info('Test message');
    await waitFor(() => mockTransport.entries.length >= 1);
    
    // Destroy should cleanup
    await logger.destroy();
    
    // Transport should be cleaned up
    assert.equal(mockTransport.entries.length, 0);
  });

  test('should handle high-volume logging', async () => {
    const mockTransport = new MockTransport();
    const config = createTestConfig({
      transports: [mockTransport],
      performance: {
        mode: 'fast',
        bufferSize: 100,
        flushInterval: 50,
        zeroAllocation: false,
        enableOptimizations: true
      }
    });
    
    const logger = new TurboLogger(config);
    const messageCount = 50;
    
    // Log many messages quickly
    for (let i = 0; i < messageCount; i++) {
      logger.info(`Message ${i}`, { iteration: i });
    }
    
    // Wait for all messages to be processed
    await waitFor(() => mockTransport.entries.length >= messageCount, 2000);
    
    assert.equal(mockTransport.entries.length, messageCount);
    
    // Check that messages are in order
    for (let i = 0; i < messageCount; i++) {
      assert.equal(mockTransport.entries[i].context?.iteration, i);
    }
  });
});
