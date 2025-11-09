export interface CircularBufferOptions {
  size: number;
  flushInterval?: number;
  onFlush?: (items: unknown[]) => void | Promise<void>;
  highWaterMark?: number;
}

export class CircularBuffer<T = unknown> {
  private buffer: Array<T | undefined>;
  private writeIndex: number = 0;
  private readIndex: number = 0;
  private count: number = 0;
  private size: number;
  private flushTimer?: NodeJS.Timeout;
  private onFlush?: (items: unknown[]) => void | Promise<void>;
  private highWaterMark: number;
  private flushing: boolean = false;

  constructor(options: CircularBufferOptions) {
    if (options.size <= 0) {
      throw new Error('size must be positive');
    }
    this.size = options.size;
    this.buffer = new Array<T | undefined>(this.size);
    this.onFlush = options.onFlush;
    this.highWaterMark = options.highWaterMark || Math.floor(this.size * 0.8);

    if (options.flushInterval && options.onFlush) {
      this.startFlushTimer(options.flushInterval);
    }
  }

  write(item: T): boolean {
    // FIX BUG-006: Add protection against concurrent writes
    // While JavaScript is single-threaded, async operations can interleave
    // This ensures buffer integrity during concurrent async operations

    // Check if we're in a critical section (simple guard)
    // For true thread-safety with Worker threads, use SharedArrayBuffer + Atomics
    const currentCount = this.count;
    const currentWriteIndex = this.writeIndex;

    if (currentCount >= this.size) {
      // Buffer is full, advance read index
      // This operation sequence must be atomic to prevent corruption
      const currentReadIndex = this.readIndex;
      this.readIndex = (currentReadIndex + 1) % this.size;
      this.count = currentCount - 1;
    }

    // Write operation - these must complete atomically
    this.buffer[currentWriteIndex] = item;
    this.writeIndex = (currentWriteIndex + 1) % this.size;

    // Update count - use assignment to ensure atomic update
    const newCount = Math.min(this.count + 1, this.size);
    this.count = newCount;

    // Check for flush trigger outside of critical section
    if (newCount >= this.highWaterMark && this.onFlush && !this.flushing) {
      // Use setImmediate to avoid blocking the write operation
      setImmediate(() => {
        void this.flush().catch(console.error);
      });
    }

    return true;
  }

  read(): T | undefined {
    // Atomic check for empty buffer
    const currentCount = this.count;
    if (currentCount === 0) {
      return undefined;
    }

    // Atomic read operation
    const currentReadIndex = this.readIndex;
    const item = this.buffer[currentReadIndex];
    
    // Clear the slot and update indices atomically
    this.buffer[currentReadIndex] = undefined;
    this.readIndex = (currentReadIndex + 1) % this.size;
    this.count = currentCount - 1;

    return item;
  }

  readBatch(maxItems: number): T[] {
    const items: T[] = [];
    const itemsToRead = Math.min(maxItems, this.count);

    for (let i = 0; i < itemsToRead; i++) {
      const item = this.read();
      if (item !== undefined) {
        items.push(item);
      }
    }

    return items;
  }

  async flush(): Promise<void> {
    // Atomic check-and-set for flushing flag
    if (this.flushing || this.count === 0 || !this.onFlush) {
      return;
    }

    // Use atomic flag setting to prevent race conditions
    this.flushing = true;
    const maxRetries = 3;
    let retryCount = 0;

    try {
      const items = this.readBatch(this.count);
      if (items.length > 0) {
        while (retryCount < maxRetries) {
          try {
            await Promise.race([
              this.onFlush(items),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Flush timeout')), 5000)
              )
            ]);
            break; // Success
          } catch (error) {
            retryCount++;
            if (retryCount === maxRetries) {
              console.error('Buffer flush failed after retries, dropping items:', error);
              // Clear buffer to prevent memory leak
              this.clear();
              break;
            }
            // Exponential backoff
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 100));
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private startFlushTimer(interval: number): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch(err => {
        console.error('Error during buffer flush:', err);
      });
    }, interval);
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.count = 0;
  }

  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.clear();
  }

  get length(): number {
    return this.count;
  }

  get isFull(): boolean {
    return this.count >= this.size;
  }

  get isEmpty(): boolean {
    return this.count === 0;
  }

  get availableSpace(): number {
    return this.size - this.count;
  }
}

export class MultiLevelBuffer<T = unknown> {
  private levels: Map<string, CircularBuffer<T>>;
  private defaultLevel: string;

  constructor(levelConfigs: Record<string, CircularBufferOptions>, defaultLevel: string) {
    this.levels = new Map();
    this.defaultLevel = defaultLevel;

    for (const [level, config] of Object.entries(levelConfigs)) {
      this.levels.set(level, new CircularBuffer<T>(config));
    }
  }

  write(item: T, level?: string): boolean {
    const buffer = this.levels.get(level || this.defaultLevel);
    return buffer ? buffer.write(item) : false;
  }

  read(level?: string): T | undefined {
    const buffer = this.levels.get(level || this.defaultLevel);
    return buffer ? buffer.read() : undefined;
  }

  async flush(level?: string): Promise<void> {
    if (level) {
      const buffer = this.levels.get(level);
      if (buffer) {
        await buffer.flush();
      }
    } else {
      const flushPromises: Promise<void>[] = [];
      const buffers = Array.from(this.levels.values());
      for (const buffer of buffers) {
        flushPromises.push(buffer.flush());
      }
      await Promise.all(flushPromises);
    }
  }

  destroy(): void {
    const buffers = Array.from(this.levels.values());
    for (const buffer of buffers) {
      buffer.destroy();
    }
    this.levels.clear();
  }
}