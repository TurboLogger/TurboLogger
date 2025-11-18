import { OptimizedSerializer, SerializationOptions } from './optimized-serializer';

interface SerializerOptions {
  zeroAllocation?: boolean;
  bufferSize?: number;
  stringCache?: boolean;
  dateFormat?: 'epoch' | 'iso';
  useOptimizedSerializer?: boolean;
  optimizedOptions?: SerializationOptions;
}

// Type guard for objects with toJSON method
function hasToJSON(obj: unknown): obj is { toJSON(): unknown } {
  return typeof obj === 'object' && obj !== null && typeof (obj as Record<string, unknown>).toJSON === 'function';
}

interface ObjectPool<T> {
  acquire(): T;
  release(item: T): void;
  clear(): void;
}

export class BufferPool implements ObjectPool<Buffer> {
  private pool: Buffer[] = [];
  private maxSize: number;
  private bufferSize: number;

  constructor(maxSize: number = 100, bufferSize: number = 4096) {
    this.maxSize = maxSize;
    this.bufferSize = bufferSize;
  }

  acquire(): Buffer {
    const buffer = this.pool.pop();
    return buffer !== undefined 
      ? buffer 
      : Buffer.allocUnsafe(this.bufferSize);
  }

  release(buffer: Buffer): void {
    if (this.pool.length < this.maxSize) {
      buffer.fill(0);
      this.pool.push(buffer);
    }
  }

  clear(): void {
    this.pool.length = 0;
  }
}

export class TurboSerializer {
  private options: SerializerOptions;
  private bufferPool: BufferPool;
  private stringCache: Map<string, Buffer>;
  private cacheHits: number = 0;
  private cacheMisses: number = 0;
  private readonly MAX_CACHE_SIZE = 1000; // Limit cache size to prevent memory leaks
  private currentBuffer: Buffer | null = null;
  private offset: number = 0;
  private readonly INITIAL_BUFFER_SIZE = 4096;
  private seen: WeakSet<object> | null = null;
  private optimizedSerializer?: OptimizedSerializer;

  constructor(options: SerializerOptions = {}) {
    this.options = {
      zeroAllocation: false,
      bufferSize: this.INITIAL_BUFFER_SIZE,
      stringCache: true,
      dateFormat: 'epoch',
      useOptimizedSerializer: true,
      ...options
    };
    
    this.bufferPool = new BufferPool(100, this.options.bufferSize || this.INITIAL_BUFFER_SIZE);
    this.stringCache = new Map();
    
    // Initialize optimized serializer if enabled
    if (this.options.useOptimizedSerializer) {
      this.optimizedSerializer = new OptimizedSerializer(this.options.optimizedOptions);
    }
  }

  serialize(obj: unknown): string | Buffer {
    // Use optimized serializer if available and not in zero-allocation mode
    if (this.optimizedSerializer && !this.options.zeroAllocation) {
      const result = this.optimizedSerializer.serialize(obj);
      return result.serialized;
    }
    
    if (this.options.zeroAllocation) {
      return this.serializeToBuffer(obj);
    }
    return this.serializeToString(obj);
  }

  private serializeToBuffer(obj: unknown): Buffer {
    this.currentBuffer = this.bufferPool.acquire();
    this.offset = 0;
    this.seen = new WeakSet();
    
    try {
      this.writeValue(obj);
      const result = Buffer.allocUnsafe(this.offset);
      this.currentBuffer.copy(result, 0, 0, this.offset);
      return result;
    } finally {
      if (this.currentBuffer) {
        this.bufferPool.release(this.currentBuffer);
        this.currentBuffer = null;
      }
      this.seen = null;
    }
  }

  private serializeToString(obj: unknown): string {
    const buffer = this.serializeToBuffer(obj);
    return buffer.toString('utf8');
  }

  private writeValue(value: unknown): void {
    if (value === null) {
      this.writeRaw('null');
    } else if (value === undefined) {
      this.writeRaw('null');
    } else if (typeof value === 'boolean') {
      this.writeRaw(value ? 'true' : 'false');
    } else if (typeof value === 'number') {
      this.writeNumber(value);
    } else if (typeof value === 'string') {
      this.writeString(value);
    } else if (value instanceof Date) {
      this.writeDate(value);
    } else if (Array.isArray(value)) {
      this.writeArray(value);
    } else if (typeof value === 'bigint') {
      this.writeString(value.toString() + 'n');
    } else if (typeof value === 'symbol') {
      this.writeString(value.toString());
    } else if (value instanceof Error) {
      this.writeError(value);
    } else if (value instanceof RegExp) {
      this.writeString(value.toString());
    } else if (value instanceof Set) {
      this.writeArray(Array.from(value));
    } else if (value instanceof Map) {
      // Convert Map to object safely
      const mapAsObject: Record<string, unknown> = {};
      for (const [key, val] of value.entries()) {
        if (typeof key === 'string') {
          mapAsObject[key] = val;
        } else {
          mapAsObject[String(key)] = val;
        }
      }
      this.writeObject(mapAsObject);
    } else if (Buffer.isBuffer(value)) {
      this.writeObject({ type: 'Buffer', data: Array.from(value) });
    } else if (typeof value === 'object') {
      this.writeObject(value as Record<string, unknown>);
    } else if (typeof value === 'function') {
      // Skip functions
      this.writeRaw('undefined');
    } else {
      this.writeString(String(value));
    }
  }

  private writeRaw(str: string): void {
    const len = Buffer.byteLength(str);
    this.ensureCapacity(len);
    if (this.currentBuffer) {
      this.currentBuffer.write(str, this.offset);
      this.offset += len;
    }
  }

  private writeNumber(num: number): void {
    if (Number.isInteger(num) && num >= -9007199254740991 && num <= 9007199254740991) {
      this.writeRaw(num.toString());
    } else {
      this.writeRaw(JSON.stringify(num));
    }
  }

  private writeString(str: string): void {
    // FIX BUG-015: Enhanced undefined check for cache access
    if (this.options.stringCache && this.stringCache.has(str)) {
      const cached = this.stringCache.get(str);
      // Explicit undefined check to ensure type safety
      if (cached !== undefined && this.currentBuffer !== undefined) {
        this.ensureCapacity(cached.length);
        cached.copy(this.currentBuffer, this.offset);
        this.offset += cached.length;
        this.cacheHits++;
        return;
      }
    }
    this.cacheMisses++;

    this.writeRaw('"');
    
    let i = 0;
    while (i < str.length) {
      const char = str.charCodeAt(i);
      
      if (char < 0x20 || char === 0x22 || char === 0x5c) {
        switch (char) {
          case 0x08: this.writeRaw('\\b'); break;
          case 0x09: this.writeRaw('\\t'); break;
          case 0x0a: this.writeRaw('\\n'); break;
          case 0x0c: this.writeRaw('\\f'); break;
          case 0x0d: this.writeRaw('\\r'); break;
          case 0x22: this.writeRaw('\\"'); break;
          case 0x5c: this.writeRaw('\\\\'); break;
          default:
            this.writeRaw('\\u00');
            this.writeRaw(char.toString(16).padStart(2, '0'));
        }
        i++;
      } else if (char <= 0x7F) {
        this.ensureCapacity(1);
        if (this.currentBuffer) {
          this.currentBuffer.writeUInt8(char, this.offset++);
        }
        i++;
      } else {
        // Handle multi-byte UTF-8 including surrogate pairs
        let charLength = 1;
        
        // Check for surrogate pair
        if (char >= 0xD800 && char <= 0xDBFF && i + 1 < str.length) {
          const next = str.charCodeAt(i + 1);
          if (next >= 0xDC00 && next <= 0xDFFF) {
            // Full surrogate pair detected
            charLength = 2;
          }
        }

        // BUG #48 FIX: Use .slice() instead of deprecated .substr()
        const chars = charLength === 2 ? str.slice(i, i + 2) : str.charAt(i);
        const encoded = Buffer.from(chars, 'utf8');
        this.ensureCapacity(encoded.length);
        if (this.currentBuffer) {
          encoded.copy(this.currentBuffer, this.offset);
          this.offset += encoded.length;
        }
        i += charLength;
      }
    }
    
    this.writeRaw('"');

    if (this.options.stringCache && str.length < 100 && this.currentBuffer) {
      // Enforce cache size limit to prevent memory leaks
      if (this.stringCache.size >= this.MAX_CACHE_SIZE) {
        // Remove oldest entries (first entries in Map)
        const keysToDelete = Array.from(this.stringCache.keys()).slice(0, 100);
        keysToDelete.forEach(key => this.stringCache.delete(key));
      }
      
      const start = this.offset - Buffer.byteLength(str) - 2;
      const cached = Buffer.allocUnsafe(this.offset - start);
      this.currentBuffer.copy(cached, 0, start, this.offset);
      this.stringCache.set(str, cached);
    }
  }

  private writeDate(date: Date): void {
    if (this.options.dateFormat === 'epoch') {
      this.writeNumber(date.getTime());
    } else {
      this.writeString(date.toISOString());
    }
  }

  private writeArray(arr: unknown[]): void {
    // Check for circular reference
    if (this.seen && this.seen.has(arr)) {
      this.writeString('[Circular]');
      return;
    }
    
    if (this.seen) {
      this.seen.add(arr);
    }
    
    this.writeRaw('[');
    
    for (let i = 0; i < arr.length; i++) {
      if (i > 0) this.writeRaw(',');
      // Handle sparse arrays - check if property exists
      if (i in arr) {
        this.writeValue(arr[i]);
      } else {
        this.writeRaw('null');
      }
    }
    
    this.writeRaw(']');
    
    // Remove from seen set after processing
    if (this.seen) {
      this.seen.delete(arr);
    }
  }

  private writeObject(obj: Record<string, unknown>): void {
    // Check for circular reference
    if (this.seen && this.seen.has(obj)) {
      this.writeString('[Circular]');
      return;
    }
    
    // Check for toJSON method
    if (hasToJSON(obj)) {
      try {
        const jsonValue = obj.toJSON();
        this.writeValue(jsonValue);
        return;
      } catch (err) {
        // Fall through to normal serialization
      }
    }
    
    if (this.seen) {
      this.seen.add(obj);
    }
    
    this.writeRaw('{');
    
    let first = true;
    // Use safer iteration to prevent prototype pollution
    const keys = Object.getOwnPropertyNames(obj);
    for (const key of keys) {
      // Additional safety check for key validity
      if (typeof key !== 'string' || key.startsWith('__proto__') || key === 'constructor' || key === 'prototype') {
        continue;
      }
      
      let value;
      try {
        value = obj[key];
      } catch (err) {
        // Handle getter that throws
        if (!first) this.writeRaw(',');
        first = false;
        
        this.writeString(key);
        this.writeRaw(':');
        this.writeString(`[Error: ${err instanceof Error ? err.message : String(err)}]`);
        continue;
      }
      
      if (value === undefined || typeof value === 'function') continue;
      
      if (!first) this.writeRaw(',');
      first = false;
      
      this.writeString(key);
      this.writeRaw(':');
      
      try {
        this.writeValue(value);
      } catch (err) {
        this.writeString(`[Error: ${err instanceof Error ? err.message : String(err)}]`);
      }
    }
    
    this.writeRaw('}');
    
    // Remove from seen set after processing
    if (this.seen) {
      this.seen.delete(obj);
    }
  }
  
  private writeError(error: Error): void {
    const errorObj: Record<string, unknown> = {
      name: error.name,
      message: error.message
    };
    
    if (error.stack) {
      errorObj.stack = error.stack;
    }
    
    // Copy any additional properties safely
    for (const key in error) {
      if (Object.prototype.hasOwnProperty.call(error, key) && key !== 'name' && key !== 'message' && key !== 'stack') {
        try {
          const value = (error as unknown as Record<string, unknown>)[key];
          errorObj[key] = value;
        } catch (err) {
          // Skip properties that can't be accessed
          errorObj[key] = '[Inaccessible Property]';
        }
      }
    }
    
    this.writeObject(errorObj);
  }

  private ensureCapacity(needed: number): void {
    if (!this.currentBuffer || this.offset + needed > this.currentBuffer.length) {
      const newSize = Math.max(this.currentBuffer?.length || 0, this.offset + needed) * 2;
      const newBuffer = Buffer.allocUnsafe(newSize);
      
      if (this.currentBuffer) {
        this.currentBuffer.copy(newBuffer, 0, 0, this.offset);
        this.bufferPool.release(this.currentBuffer);
      }
      
      this.currentBuffer = newBuffer;
    }
  }

  clearCache(): void {
    this.stringCache.clear();
    this.bufferPool.clear();
  }

  reset(): void {
    this.stringCache.clear();
    this.currentBuffer = null;
    this.offset = 0;
  }

  destroy(): void {
    this.clearCache();
    this.reset();
    if (this.optimizedSerializer) {
      this.optimizedSerializer.destroy();
      this.optimizedSerializer = undefined;
    }
  }
}

export function createSerializer(options?: SerializerOptions): TurboSerializer {
  return new TurboSerializer(options);
}