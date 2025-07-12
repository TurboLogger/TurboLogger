#!/usr/bin/env node

/**
 * Cross-platform test runner for TurboLogger
 * Windows compatible test execution
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { glob } = require('glob');

class TestRunner {
  constructor() {
    this.testFiles = [];
    this.failedTests = [];
    this.passedTests = [];
    this.totalTests = 0;
    this.startTime = Date.now();
  }

  log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const colors = {
      info: '\x1b[36m',
      success: '\x1b[32m',
      error: '\x1b[31m',
      warn: '\x1b[33m',
      reset: '\x1b[0m'
    };
    
    const color = colors[level] || colors.info;
    console.log(`${color}[${timestamp}] ${message}${colors.reset}`);
  }

  async findTestFiles(pattern = 'lib/test/**/*.test.js') {
    try {
      // Use glob to find test files cross-platform
      const files = await glob(pattern, { 
        cwd: process.cwd(),
        windowsPathsNoEscape: true 
      });
      
      this.testFiles = files.filter(file => 
        fs.existsSync(file) && path.extname(file) === '.js'
      );
      
      this.log(`Found ${this.testFiles.length} test files`);
      return this.testFiles;
    } catch (error) {
      this.log(`Error finding test files: ${error.message}`, 'error');
      return [];
    }
  }

  async runSingleTest(testFile) {
    return new Promise((resolve) => {
      this.log(`Running: ${testFile}`);
      
      const child = spawn('node', ['--test', testFile], {
        stdio: ['inherit', 'pipe', 'pipe'],
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'test' }
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        const result = {
          file: testFile,
          success: code === 0,
          stdout,
          stderr,
          code
        };

        if (result.success) {
          this.passedTests.push(testFile);
          this.log(`✅ PASSED: ${testFile}`, 'success');
        } else {
          this.failedTests.push(testFile);
          this.log(`❌ FAILED: ${testFile}`, 'error');
          if (stderr) {
            this.log(`Error output: ${stderr}`, 'error');
          }
        }

        resolve(result);
      });

      child.on('error', (error) => {
        this.log(`Error running test ${testFile}: ${error.message}`, 'error');
        this.failedTests.push(testFile);
        resolve({
          file: testFile,
          success: false,
          error: error.message,
          code: -1
        });
      });
    });
  }

  async runAllTests() {
    if (this.testFiles.length === 0) {
      this.log('No test files found!', 'warn');
      return false;
    }

    this.log(`Starting test execution for ${this.testFiles.length} files...`);
    
    for (const testFile of this.testFiles) {
      await this.runSingleTest(testFile);
      this.totalTests++;
    }

    return this.failedTests.length === 0;
  }

  printSummary() {
    const duration = Date.now() - this.startTime;
    const durationSec = (duration / 1000).toFixed(2);

    console.log('\n' + '='.repeat(60));
    console.log('TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total Tests: ${this.totalTests}`);
    console.log(`Passed: ${this.passedTests.length}`);
    console.log(`Failed: ${this.failedTests.length}`);
    console.log(`Duration: ${durationSec}s`);

    if (this.failedTests.length > 0) {
      console.log('\nFailed Tests:');
      this.failedTests.forEach(test => {
        console.log(`  ❌ ${test}`);
      });
    }

    console.log('='.repeat(60));
  }

  async runBasicTest() {
    this.log('Running basic TurboLogger test...');
    
    try {
      // Test basic functionality without compiled tests
      const basicTest = `
        const { createLogger } = require('./lib/index.js');
        
        console.log('Testing basic logger functionality...');
        
        const logger = createLogger({
          output: { level: 'debug' }
        });
        
        logger.info('Test message');
        logger.debug('Debug message');
        logger.error(new Error('Test error'));
        
        console.log('Basic test completed successfully!');
      `;

      const tempFile = path.join(process.cwd(), 'temp-test.js');
      fs.writeFileSync(tempFile, basicTest);

      const result = await new Promise((resolve) => {
        const child = spawn('node', [tempFile], {
          stdio: 'inherit',
          cwd: process.cwd()
        });

        child.on('close', (code) => {
          resolve(code === 0);
        });

        child.on('error', () => {
          resolve(false);
        });
      });

      // Cleanup
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }

      return result;
    } catch (error) {
      this.log(`Basic test failed: ${error.message}`, 'error');
      return false;
    }
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const isWatch = args.includes('--watch');
  const pattern = args.find(arg => !arg.startsWith('--')) || 'lib/test/**/*.test.js';

  const runner = new TestRunner();

  // Check if compiled tests exist
  const hasCompiledTests = fs.existsSync('lib/test');
  
  if (!hasCompiledTests) {
    runner.log('No compiled tests found, running basic functionality test...', 'warn');
    
    // Check if main library is built
    if (!fs.existsSync('lib/index.js')) {
      runner.log('Library not built! Please run: npm run build', 'error');
      process.exit(1);
    }

    const basicResult = await runner.runBasicTest();
    if (basicResult) {
      runner.log('✅ Basic test passed!', 'success');
      process.exit(0);
    } else {
      runner.log('❌ Basic test failed!', 'error');
      process.exit(1);
    }
  }

  async function runTests() {
    await runner.findTestFiles(pattern);
    const success = await runner.runAllTests();
    runner.printSummary();
    
    if (!isWatch) {
      process.exit(success ? 0 : 1);
    }
  }

  if (isWatch) {
    runner.log('Starting watch mode...', 'info');
    
    // Simple watch implementation
    let timeout;
    const watchCallback = () => {
      clearTimeout(timeout);
      timeout = setTimeout(async () => {
        runner.log('Files changed, re-running tests...', 'info');
        await runTests();
      }, 1000);
    };

    if (fs.watch) {
      try {
        fs.watch('lib', { recursive: true }, watchCallback);
        runner.log('Watching lib/ directory for changes...', 'info');
      } catch (error) {
        runner.log('Watch mode not supported, falling back to single run', 'warn');
      }
    }
  }

  await runTests();
}

// Handle errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('Test runner error:', error);
    process.exit(1);
  });
}

module.exports = TestRunner;
