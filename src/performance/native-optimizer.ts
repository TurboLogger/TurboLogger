// Native performance optimization module for TurboLogger
// This module provides interfaces for optional native optimizations
import * as zlib from 'zlib';
import * as crypto from 'crypto';

// Type definitions
export type SerializableValue = string | number | boolean | null | undefined | SerializableObject | SerializableArray;
export interface SerializableObject {
  [key: string]: SerializableValue;
}
export interface SerializableArray extends Array<SerializableValue> {}

export interface Schema {
  type: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  [key: string]: unknown;
}

export interface TestData {
  serialize?: SerializableObject;
  compress?: string;
  parse?: string;
  regex?: { text: string; pattern: string };
}

export interface BenchmarkResult {
  operation: string;
  iterations: number;
  native: {
    available: boolean;
    totalTime: number;
    avgTime: number;
    opsPerSec: number;
  };
  fallback: {
    totalTime: number;
    avgTime: number;
    opsPerSec: number;
  };
  improvement: {
    percentage: number;
    factor: number;
  };
}

export interface PerformanceStats {
  serialization?: {
    native: boolean;
    avgTime: number;
    opsPerSec: number;
  };
  compression?: {
    native: boolean;
    avgTime: number;
    opsPerSec: number;
    ratio: number;
  };
  parsing?: {
    native: boolean;
    avgTime: number;
    opsPerSec: number;
  };
  regex?: {
    native: boolean;
    avgTime: number;
    opsPerSec: number;
  };
}

// TestData interface already defined above

type NativeModule = {
  serialize?: (obj: SerializableObject, schema?: Schema) => string | Buffer;
  deserialize?: (data: string | Buffer) => SerializableObject;
  compress?: (data: string | Buffer) => Buffer;
  decompress?: (data: Buffer) => string | Buffer;
  parse?: (data: string) => unknown;
  test?: (text: string, pattern: string | RegExp) => boolean;
  [key: string]: unknown;
};

export interface NativeOptimizerOptions {
  enabled?: boolean;
  serialization?: {
    enabled?: boolean;
    fallbackToJS?: boolean;
  };
  compression?: {
    enabled?: boolean;
    algorithm?: 'gzip' | 'lz4' | 'snappy';
    level?: number;
  };
  jsonParsing?: {
    enabled?: boolean;
    useSimdJson?: boolean;
  };
  stringOperations?: {
    enabled?: boolean;
    useNativeRegex?: boolean;
  };
}

export interface NativeModuleInfo {
  name: string;
  version: string;
  available: boolean;
  performance: {
    serialization?: number; // ops/sec
    compression?: number;
    parsing?: number;
  };
}

export class NativeOptimizer {
  private options: Required<NativeOptimizerOptions>;
  private nativeModules: Map<string, NativeModule> = new Map();
  private fallbackMethods: Map<string, Function> = new Map();
  private performanceStats: Map<string, number[]> = new Map();

  constructor(options: NativeOptimizerOptions = {}) {
    this.options = {
      enabled: true,
      serialization: {
        enabled: true,
        fallbackToJS: true
      },
      compression: {
        enabled: true,
        algorithm: 'gzip',
        level: 6
      },
      jsonParsing: {
        enabled: true,
        useSimdJson: false
      },
      stringOperations: {
        enabled: true,
        useNativeRegex: true
      },
      ...options
    };

    if (this.options.enabled) {
      this.loadNativeModules();
      this.setupFallbacks();
    }
  }

  // In zero-dependency mode, no external modules are allowed
  // Comment out as not used
  /*
  private static readonly ALLOWED_MODULES = new Set([
    'fast-json-stringify',
    'msgpack',
    'snappy',
    'lz4',
    'zstd',
    'simdjson',
    're2',
    '@oxog/turbologger-native',
    'node-gyp-build',
    'detect-libc',
    'v8-profiler-next',
    'heapdump',
    'worker_threads'
  ]);
  */

  private async loadNativeModules(): Promise<void> {
    // No external modules to load in zero-dependency mode
    console.log('Running in zero-dependency mode - using built-in optimizations only');
  }

  // Comment out as not used
  /*
  private async tryLoadModule(name: string): Promise<void> {
    // No external modules in zero-dependency mode
    console.log(`⚠ External module ${name} not loaded - using built-in fallback`);
  }
  */

  private setupFallbacks(): void {
    // Setup JavaScript fallback methods
    this.fallbackMethods.set('serialize', (obj: SerializableObject) => JSON.stringify(obj));
    this.fallbackMethods.set('parse', (str: string) => JSON.parse(str));
    this.fallbackMethods.set('compress', (data: Buffer) => zlib.gzipSync(data));
    this.fallbackMethods.set('decompress', (data: Buffer) => zlib.gunzipSync(data));
    this.fallbackMethods.set('createRegex', (pattern: string, flags?: string) => new RegExp(pattern, flags));
  }

  // High-performance JSON serialization
  serialize(obj: SerializableObject, schema?: Schema): string | Buffer {
    const startTime = process.hrtime.bigint();
    
    try {
      // Use optimized JSON.stringify with schema hints
      if (schema && this.options.serialization.enabled) {
        const result = this.optimizedStringify(obj, schema);
        this.recordPerformance('serialize-optimized', startTime);
        return result;
      }

      // Fallback to JSON.stringify
      const result = this.fallbackMethods.get('serialize')!(obj);
      this.recordPerformance('serialize-fallback', startTime);
      return result;

    } catch (error) {
      // Always fallback to JSON.stringify on error
      const result = this.fallbackMethods.get('serialize')!(obj);
      this.recordPerformance('serialize-error-fallback', startTime);
      return result;
    }
  }
  
  private optimizedStringify(obj: SerializableObject, schema: Schema): string {
    // Simple schema-based optimization
    if (schema.type === 'object' && schema.properties) {
      const props = Object.keys(schema.properties);
      const filtered: any = {};
      for (const prop of props) {
        if (prop in obj) {
          filtered[prop] = obj[prop];
        }
      }
      return JSON.stringify(filtered);
    }
    return JSON.stringify(obj);
  }

  // High-performance JSON parsing
  parse(data: string | Buffer): unknown {
    const startTime = process.hrtime.bigint();
    
    try {
      // Fallback to JSON.parse
      const result = this.fallbackMethods.get('parse')!(data.toString());
      this.recordPerformance('parse-fallback', startTime);
      return result;

    } catch (error) {
      // Always fallback to JSON.parse on error
      const result = this.fallbackMethods.get('parse')!(data.toString());
      this.recordPerformance('parse-error-fallback', startTime);
      return result;
    }
  }

  // High-performance compression
  compress(data: Buffer | string): Buffer {
    const startTime = process.hrtime.bigint();
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    
    try {
      // Use built-in compression
      const algorithm = this.options.compression.algorithm;
      let result: Buffer;
      
      if (algorithm === 'gzip' || !algorithm) {
        result = zlib.gzipSync(buffer, { level: this.options.compression.level });
        this.recordPerformance('compress-gzip', startTime);
      } else {
        // Fallback to gzip for unsupported algorithms
        result = zlib.gzipSync(buffer, { level: this.options.compression.level });
        this.recordPerformance('compress-fallback', startTime);
      }
      
      return result;

    } catch (error) {
      // Always fallback to gzip on error
      const result = this.fallbackMethods.get('compress')!(buffer);
      this.recordPerformance('compress-error-fallback', startTime);
      return result;
    }
  }

  // High-performance decompression
  decompress(data: Buffer, algorithm?: string): Buffer {
    const startTime = process.hrtime.bigint();
    
    try {
      const algo = algorithm || this.options.compression.algorithm;
      
      // Use built-in decompression
      let result: Buffer;
      
      if (algo === 'gzip' || !algo) {
        result = zlib.gunzipSync(data);
        this.recordPerformance('decompress-gzip', startTime);
      } else {
        // Fallback to gunzip for unsupported algorithms
        result = zlib.gunzipSync(data);
        this.recordPerformance('decompress-fallback', startTime);
      }
      
      return result;

    } catch (error) {
      // Always fallback to gunzip on error
      const result = this.fallbackMethods.get('decompress')!(data);
      this.recordPerformance('decompress-error-fallback', startTime);
      return result;
    }
  }

  // High-performance regex operations
  createRegex(pattern: string, flags?: string): RegExp {
    const startTime = process.hrtime.bigint();
    
    try {
      // Use native RegExp
      const result = this.fallbackMethods.get('createRegex')!(pattern, flags);
      this.recordPerformance('regex-native', startTime);
      return result;

    } catch (error) {
      // Always fallback to native RegExp on error
      const result = this.fallbackMethods.get('createRegex')!(pattern, flags);
      this.recordPerformance('regex-error-fallback', startTime);
      return result;
    }
  }

  // String hashing for fast comparisons
  hashString(str: string): number {
    const startTime = process.hrtime.bigint();
    
    try {
      // Use crypto for better hashing
      const hash = crypto.createHash('sha256').update(str).digest();
      // Convert first 4 bytes to 32-bit integer
      const result = hash.readUInt32BE(0);
      
      this.recordPerformance('hash-crypto', startTime);
      return result;

    } catch (error) {
      // Simple fallback hash
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
      }
      
      this.recordPerformance('hash-error-fallback', startTime);
      return hash;
    }
  }

  // Buffer operations
  allocateBuffer(size: number): Buffer {
    try {
      // Use allocUnsafe for better performance
      return Buffer.allocUnsafe(size);
    } catch (error) {
      // Safe fallback
      return Buffer.alloc(size);
    }
  }

  // Copy buffer with potential native optimization
  copyBuffer(source: Buffer, target: Buffer, targetStart?: number, sourceStart?: number, sourceEnd?: number): number {
    try {
      return source.copy(target, targetStart, sourceStart, sourceEnd);
    } catch (error) {
      return source.copy(target, targetStart, sourceStart, sourceEnd);
    }
  }

  private recordPerformance(operation: string, startTime: bigint): void {
    const endTime = process.hrtime.bigint();
    const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds

    if (!this.performanceStats.has(operation)) {
      this.performanceStats.set(operation, []);
    }

    const stats = this.performanceStats.get(operation)!;
    stats.push(duration);

    // Keep only last 1000 measurements
    if (stats.length > 1000) {
      stats.shift();
    }
  }

  // Benchmark native vs fallback performance
  async benchmark(operation: string, iterations: number = 1000, testData?: SerializableObject | Buffer | string): Promise<BenchmarkResult> {
    const nativeResults: number[] = [];
    const fallbackResults: number[] = [];

    // Generate test data if not provided
    if (!testData) {
      testData = this.generateTestData(operation);
    }

    // Benchmark native implementation
    const nativeAvailable = this.isNativeAvailable(operation);
    
    if (nativeAvailable) {
      for (let i = 0; i < iterations; i++) {
        const start = process.hrtime.bigint();
        await this.executeOperation(operation, testData, true);
        const end = process.hrtime.bigint();
        nativeResults.push(Number(end - start) / 1000000);
      }
    }

    // Benchmark fallback implementation
    for (let i = 0; i < iterations; i++) {
      const start = process.hrtime.bigint();
      await this.executeOperation(operation, testData, false);
      const end = process.hrtime.bigint();
      fallbackResults.push(Number(end - start) / 1000000);
    }

    const nativeStats = nativeAvailable ? this.calculateStats(nativeResults) : null;
    const fallbackStats = this.calculateStats(fallbackResults);
    
    const nativeResult = {
      available: nativeAvailable,
      totalTime: nativeStats ? nativeStats.total : 0,
      avgTime: nativeStats ? nativeStats.avg : 0,
      opsPerSec: nativeStats ? nativeStats.ops : 0
    };
    
    const fallbackResult = {
      totalTime: fallbackStats.total,
      avgTime: fallbackStats.avg,
      opsPerSec: fallbackStats.ops
    };
    
    const improvement = {
      percentage: nativeStats ? ((fallbackStats.avg - nativeStats.avg) / fallbackStats.avg) * 100 : 0,
      factor: nativeStats ? fallbackStats.avg / nativeStats.avg : 1
    };

    return {
      operation,
      iterations,
      native: nativeResult,
      fallback: fallbackResult,
      improvement
    };
  }

  private generateTestData(operation: string): SerializableObject | Buffer | string {
    switch (operation) {
      case 'serialize':
      case 'parse':
        return {
          message: 'Test log message',
          level: 'info',
          timestamp: Date.now(),
          data: { key: 'value', nested: { array: [1, 2, 3] } }
        } as SerializableObject;
      case 'compress':
      case 'decompress':
        return Buffer.from('Test data for compression'.repeat(100));
      case 'regex':
        return 'test@example.com user@domain.org admin@site.net';
      case 'hash':
        return 'test string for hashing with some length';
      default:
        return {} as SerializableObject;
    }
  }

  private isNativeAvailable(_operation: string): boolean {
    // In zero-dependency mode, no external native modules are available
    return false;
  }

  private async executeOperation(operation: string, testData: SerializableObject | Buffer | string, useNative: boolean): Promise<unknown> {
    switch (operation) {
      case 'serialize':
        if (typeof testData === 'object' && !Buffer.isBuffer(testData)) {
          return useNative ? this.serialize(testData) : JSON.stringify(testData);
        }
        return null;
      case 'parse':
        const stringData = typeof testData === 'string' ? testData : JSON.stringify(testData);
        return useNative ? this.parse(stringData) : JSON.parse(stringData);
      case 'compress':
        const compressData = typeof testData === 'string' ? testData : Buffer.isBuffer(testData) ? testData : JSON.stringify(testData);
        return useNative ? this.compress(compressData) : zlib.gzipSync(compressData);
      case 'decompress':
        const decompressData = typeof testData === 'string' ? testData : Buffer.isBuffer(testData) ? testData : JSON.stringify(testData);
        const compressed = zlib.gzipSync(decompressData);
        return useNative ? this.decompress(compressed) : zlib.gunzipSync(compressed);
      case 'regex':
        const pattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
        const regexData = typeof testData === 'string' ? testData : testData.toString();
        return useNative ? this.createRegex(pattern.source, 'g').exec(regexData) : pattern.exec(regexData);
      case 'hash':
        const hashData = typeof testData === 'string' ? testData : testData.toString();
        return useNative ? this.hashString(hashData) : hashData.length;
      default:
        return null;
    }
  }

  private calculateStats(values: number[]): { avg: number; min: number; max: number; ops: number; total: number } {
    const total = values.reduce((sum, val) => sum + val, 0);
    const avg = total / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const ops = Math.round(1000 / avg); // Operations per second

    return { avg, min, max, ops, total };
  }

  getAvailableModules(): NativeModuleInfo[] {
    const modules: NativeModuleInfo[] = [];

    for (const [name, module] of this.nativeModules) {
      const stats = this.getModuleStats(name);
      modules.push({
        name,
        version: (module as any).version || 'unknown',
        available: true,
        performance: {
          serialization: stats.serialization?.opsPerSec,
          compression: stats.compression?.opsPerSec,
          parsing: stats.parsing?.opsPerSec
        }
      });
    }

    return modules;
  }

  private getModuleStats(moduleName: string): PerformanceStats {
    const stats: PerformanceStats = {};
    
    for (const [operation, times] of this.performanceStats) {
      if (operation.includes(moduleName) || operation.includes('native')) {
        const avg = times.reduce((sum, time) => sum + time, 0) / times.length;
        const ops = Math.round(1000 / avg);
        
        if (operation.includes('serialize')) {
          stats.serialization = {
            native: operation.includes('native'),
            avgTime: avg,
            opsPerSec: ops
          };
        }
        if (operation.includes('compress')) {
          stats.compression = {
            native: operation.includes('native'),
            avgTime: avg,
            opsPerSec: ops,
            ratio: 0 // Would need to calculate actual compression ratio
          };
        }
        if (operation.includes('parse')) {
          stats.parsing = {
            native: operation.includes('native'),
            avgTime: avg,
            opsPerSec: ops
          };
        }
      }
    }

    return stats;
  }

  getPerformanceStats(): Record<string, unknown> {
    const results: Record<string, { avg: number; ops: number; count: number }> = {};

    for (const [operation, times] of this.performanceStats) {
      const avg = times.reduce((sum, time) => sum + time, 0) / times.length;
      results[operation] = {
        avg,
        ops: Math.round(1000 / avg),
        count: times.length
      };
    }

    return results;
  }

  destroy(): void {
    this.performanceStats.clear();
    this.nativeModules.clear();
    this.fallbackMethods.clear();
  }
}