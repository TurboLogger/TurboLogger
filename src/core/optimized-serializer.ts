/**
 * Optimized Serializer for TurboLogger
 * Implements high-performance JSON serialization with buffer chunking and escape optimization
 */

export interface SerializationOptions {
  enableBufferChunking?: boolean;
  chunkSize?: number;
  maxStringLength?: number;
  enableEscapeOptimization?: boolean;
  enableCircularDetection?: boolean;
  maxDepth?: number;
}

export interface SerializationResult {
  serialized: string;
  size: number;
  duration: number;
  chunks?: number;
  metadata?: {
    circularReferences: number;
    truncatedStrings: number;
    depth: number;
  };
}

// Pre-computed escape lookup table for common characters
const ESCAPE_LOOKUP: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t'
};

// Characters that need escaping (ASCII codes)
const NEEDS_ESCAPE = new Set([8, 9, 10, 12, 13, 34, 92]);

export class OptimizedSerializer {
  private readonly options: Required<SerializationOptions>;
  private readonly stringCache = new Map<string, string>();
  private readonly bufferPool: Buffer[] = [];
  private readonly MAX_CACHE_SIZE = 10000;
  private readonly BUFFER_POOL_SIZE = 50;

  constructor(options: SerializationOptions = {}) {
    this.options = {
      enableBufferChunking: options.enableBufferChunking ?? true,
      chunkSize: options.chunkSize ?? 64 * 1024, // 64KB chunks
      maxStringLength: options.maxStringLength ?? 100000,
      enableEscapeOptimization: options.enableEscapeOptimization ?? true,
      enableCircularDetection: options.enableCircularDetection ?? true,
      maxDepth: options.maxDepth ?? 100
    };

    // Pre-warm buffer pool
    this.initializeBufferPool();
  }

  serialize(obj: unknown): SerializationResult {
    const startTime = process.hrtime.bigint();
    
    try {
      let serialized: string;
      let chunks = 0;
      let metadata = {
        circularReferences: 0,
        truncatedStrings: 0,
        depth: 0
      };

      if (this.options.enableBufferChunking && this.shouldUseBufferChunking(obj)) {
        const result = this.serializeWithBufferChunking(obj);
        serialized = result.serialized;
        chunks = result.chunks;
        metadata = { ...metadata, ...result.metadata };
      } else {
        const context = new SerializationContext();
        serialized = this.serializeValue(obj, context);
        metadata = context.getMetadata();
      }

      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds

      return {
        serialized,
        size: Buffer.byteLength(serialized, 'utf8'),
        duration,
        chunks,
        metadata
      };
    } catch (error) {
      // BUG-032 FIX: Fallback to standard JSON.stringify with error handling
      try {
        const fallbackStart = process.hrtime.bigint();
        // Handle BigInt and other non-JSON-serializable values
        const fallbackResult = JSON.stringify(obj, (key, value) => {
          if (typeof value === 'bigint') {
            return value.toString() + 'n';
          }
          return value;
        });
        const fallbackEnd = process.hrtime.bigint();

        return {
          serialized: fallbackResult,
          size: Buffer.byteLength(fallbackResult, 'utf8'),
          duration: Number(fallbackEnd - fallbackStart) / 1000000,
          chunks: 0,
          metadata: {
            circularReferences: 0,
            truncatedStrings: 0,
            depth: 0
          }
        };
      } catch (fallbackError) {
        // Last resort: return error representation
        const errorMsg = `[Serialization Error: ${error instanceof Error ? error.message : 'Unknown error'}]`;
        return {
          serialized: JSON.stringify({ error: errorMsg, type: typeof obj }),
          size: Buffer.byteLength(errorMsg, 'utf8'),
          duration: 0,
          chunks: 0,
          metadata: {
            circularReferences: 0,
            truncatedStrings: 0,
            depth: 0
          }
        };
      }
    }
  }

  private serializeWithBufferChunking(obj: unknown): {
    serialized: string;
    chunks: number;
    metadata: {
      circularReferences: number;
      truncatedStrings: number;
      depth: number;
    };
  } {
    const context = new SerializationContext();
    const chunks: Buffer[] = [];
    let currentChunk = this.getBuffer();
    let chunkOffset = 0;
    
    const writeToChunk = (data: string) => {
      const dataBuffer = Buffer.from(data, 'utf8');
      
      if (chunkOffset + dataBuffer.length > this.options.chunkSize) {
        // Current chunk is full, start a new one
        chunks.push(currentChunk.subarray(0, chunkOffset));
        currentChunk = this.getBuffer();
        chunkOffset = 0;
      }
      
      dataBuffer.copy(currentChunk, chunkOffset);
      chunkOffset += dataBuffer.length;
    };

    // Serialize with chunked writing
    this.serializeValue(obj, context, writeToChunk);
    
    // Add final chunk if it has data
    if (chunkOffset > 0) {
      chunks.push(currentChunk.subarray(0, chunkOffset));
    }

    // Return buffer to pool
    this.returnBuffer(currentChunk);

    // Combine chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = Buffer.allocUnsafe(totalLength);
    let offset = 0;
    
    for (const chunk of chunks) {
      chunk.copy(combined, offset);
      offset += chunk.length;
    }

    return {
      serialized: combined.toString('utf8'),
      chunks: chunks.length,
      metadata: context.getMetadata()
    };
  }

  private serializeValue(
    value: unknown, 
    context: SerializationContext,
    chunkWriter?: (data: string) => void
  ): string {
    if (context.depth > this.options.maxDepth) {
      context.metadata.depth = Math.max(context.metadata.depth, context.depth);
      return '"[Max Depth Exceeded]"';
    }

    context.depth++;

    try {
      switch (typeof value) {
        case 'string':
          return this.serializeString(value, context);
        case 'number':
          return this.serializeNumber(value);
        case 'boolean':
          return value ? 'true' : 'false';
        case 'object':
          return this.serializeObject(value, context, chunkWriter);
        case 'undefined':
          return 'null';
        case 'function':
          return 'null';
        case 'symbol':
          return 'null';
        case 'bigint':
          return `"${value.toString()}"`;
        default:
          return 'null';
      }
    } finally {
      context.depth--;
    }
  }

  private serializeString(str: string, context: SerializationContext): string {
    if (str.length > this.options.maxStringLength) {
      context.metadata.truncatedStrings++;
      str = str.substring(0, this.options.maxStringLength) + '...';
    }

    // Check cache first
    const cached = this.stringCache.get(str);
    if (cached) {
      return cached;
    }

    let result: string;
    
    if (this.options.enableEscapeOptimization) {
      result = this.fastEscapeString(str);
    } else {
      result = JSON.stringify(str);
    }

    // Cache frequently used strings
    if (str.length < 1000 && this.stringCache.size < this.MAX_CACHE_SIZE) {
      this.stringCache.set(str, result);
    }

    return result;
  }

  private fastEscapeString(str: string): string {
    let result = '"';
    let lastIndex = 0;
    
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      const code = char.charCodeAt(0);
      
      if (NEEDS_ESCAPE.has(code)) {
        // Add unescaped portion
        if (i > lastIndex) {
          result += str.slice(lastIndex, i);
        }
        
        // Add escaped character
        result += ESCAPE_LOOKUP[char] || `\\u${code.toString(16).padStart(4, '0')}`;
        lastIndex = i + 1;
      } else if (code < 32) {
        // Control characters
        if (i > lastIndex) {
          result += str.slice(lastIndex, i);
        }
        result += `\\u${code.toString(16).padStart(4, '0')}`;
        lastIndex = i + 1;
      }
    }
    
    // Add remaining unescaped portion
    if (lastIndex < str.length) {
      result += str.slice(lastIndex);
    }
    
    result += '"';
    return result;
  }

  private serializeNumber(num: number): string {
    if (!isFinite(num)) {
      return 'null';
    }
    return num.toString();
  }

  private serializeObject(
    obj: unknown, 
    context: SerializationContext,
    chunkWriter?: (data: string) => void
  ): string {
    if (obj === null) {
      return 'null';
    }

    // Handle circular references
    if (this.options.enableCircularDetection) {
      if (typeof obj === 'object' && obj !== null && context.seen.has(obj)) {
        context.metadata.circularReferences++;
        return '"[Circular Reference]"';
      }
      if (typeof obj === 'object' && obj !== null) {
        context.seen.add(obj);
      }
    }

    try {
      // Handle special object types
      if (obj instanceof Date) {
        return `"${obj.toISOString()}"`;
      }

      if (obj instanceof Error) {
        return this.serializeError(obj, context, chunkWriter);
      }

      if (Array.isArray(obj)) {
        return this.serializeArray(obj, context, chunkWriter);
      }

      if (Buffer.isBuffer(obj)) {
        return `"${obj.toString('base64')}"`;
      }

      // Handle regular objects
      return this.serializeRegularObject(obj, context, chunkWriter);
    } finally {
      if (this.options.enableCircularDetection && typeof obj === 'object' && obj !== null) {
        context.seen.delete(obj);
      }
    }
  }

  private serializeArray(
    arr: unknown[], 
    context: SerializationContext,
    chunkWriter?: (data: string) => void
  ): string {
    if (arr.length === 0) {
      return '[]';
    }

    let result = '[';
    
    for (let i = 0; i < arr.length; i++) {
      if (i > 0) {
        result += ',';
      }
      result += this.serializeValue(arr[i], context, chunkWriter);
    }
    
    result += ']';
    return result;
  }

  private serializeRegularObject(
    obj: unknown, 
    context: SerializationContext,
    chunkWriter?: (data: string) => void
  ): string {
    if (typeof obj !== 'object' || !obj) {
      return '{}';
    }
    
    const objRecord = obj as Record<string, unknown>;
    const keys = Object.keys(objRecord);
    if (keys.length === 0) {
      return '{}';
    }

    let result = '{';
    let first = true;
    
    for (const key of keys) {
      const value = objRecord[key];
      
      // Skip undefined values and functions
      if (value === undefined || typeof value === 'function') {
        continue;
      }

      if (!first) {
        result += ',';
      }
      first = false;

      result += this.serializeString(key, context);
      result += ':';
      result += this.serializeValue(value, context, chunkWriter);
    }
    
    result += '}';
    return result;
  }

  private serializeError(
    error: Error, 
    context: SerializationContext,
    chunkWriter?: (data: string) => void
  ): string {
    const errorObj: Record<string, unknown> = {
      type: error.constructor.name,
      message: error.message
    };

    if (error.stack) {
      errorObj.stack = error.stack;
    }

    // Include other enumerable properties
    const errorAsRecord = error as unknown as Record<string, unknown>;
    for (const key in errorAsRecord) {
      if (Object.prototype.hasOwnProperty.call(errorAsRecord, key) && !(key in errorObj)) {
        errorObj[key] = errorAsRecord[key];
      }
    }

    return this.serializeRegularObject(errorObj, context, chunkWriter);
  }

  private shouldUseBufferChunking(obj: unknown): boolean {
    if (!this.options.enableBufferChunking) {
      return false;
    }

    // Use rough heuristic to determine if object is large enough for chunking
    try {
      const sample = JSON.stringify(obj);
      return sample.length > this.options.chunkSize / 2;
    } catch {
      return true; // If we can't stringify easily, use chunking for safety
    }
  }

  private initializeBufferPool(): void {
    for (let i = 0; i < this.BUFFER_POOL_SIZE; i++) {
      this.bufferPool.push(Buffer.allocUnsafe(this.options.chunkSize));
    }
  }

  private getBuffer(): Buffer {
    return this.bufferPool.pop() || Buffer.allocUnsafe(this.options.chunkSize);
  }

  private returnBuffer(buffer: Buffer): void {
    if (this.bufferPool.length < this.BUFFER_POOL_SIZE) {
      this.bufferPool.push(buffer);
    }
  }

  // Cache management
  clearCaches(): void {
    this.stringCache.clear();
  }

  getCacheStats(): {
    stringCacheSize: number;
    bufferPoolSize: number;
    maxCacheSize: number;
  } {
    return {
      stringCacheSize: this.stringCache.size,
      bufferPoolSize: this.bufferPool.length,
      maxCacheSize: this.MAX_CACHE_SIZE
    };
  }

  // Cleanup
  destroy(): void {
    this.clearCaches();
    this.bufferPool.length = 0;
  }
}

class SerializationContext {
  public depth = 0;
  public seen = new Set<object>();
  public metadata = {
    circularReferences: 0,
    truncatedStrings: 0,
    depth: 0
  };

  constructor() {}

  getMetadata() {
    return { ...this.metadata };
  }
}

// Export singleton instance with optimized defaults
export const optimizedSerializer = new OptimizedSerializer({
  enableBufferChunking: true,
  chunkSize: 64 * 1024,
  maxStringLength: 100000,
  enableEscapeOptimization: true,
  enableCircularDetection: true,
  maxDepth: 100
});