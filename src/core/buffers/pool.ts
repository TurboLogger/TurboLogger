/**
 * Memory Pool for Buffer Management
 * Reduces GC pressure by reusing buffer instances
 */

export interface PoolOptions {
  initialSize: number;
  maxSize: number;
  itemFactory: () => unknown;
  resetItem?: (item: unknown) => void;
  validateItem?: (item: unknown) => boolean;
}

export class MemoryPool<T> {
  private pool: T[] = [];
  private inUse = new Set<T>();
  private options: PoolOptions;
  private stats = {
    created: 0,
    reused: 0,
    destroyed: 0,
    currentSize: 0,
    maxSizeReached: 0,
  };

  constructor(options: PoolOptions) {
    this.options = options;
    this.preFill();
  }

  /**
   * Pre-fill the pool with initial items
   */
  private preFill(): void {
    for (let i = 0; i < this.options.initialSize; i++) {
      const item = this.options.itemFactory() as T;
      this.pool.push(item);
      this.stats.created++;
    }
    this.stats.currentSize = this.pool.length;
  }

  /**
   * Acquire an item from the pool
   */
  acquire(): T {
    let item: T;

    if (this.pool.length > 0) {
      item = this.pool.pop()!;
      this.stats.reused++;
    } else {
      if (this.inUse.size >= this.options.maxSize) {
        this.stats.maxSizeReached++;
        throw new Error('Memory pool exhausted');
      }
      item = this.options.itemFactory() as T;
      this.stats.created++;
    }

    this.inUse.add(item);
    return item;
  }

  /**
   * Release an item back to the pool
   */
  release(item: T): void {
    if (!this.inUse.has(item)) {
      return; // Item not from this pool
    }

    this.inUse.delete(item);

    // Validate item before returning to pool
    if (this.options.validateItem && !this.options.validateItem(item)) {
      this.stats.destroyed++;
      return;
    }

    // Reset item if resetFn provided
    if (this.options.resetItem) {
      this.options.resetItem(item);
    }

    // Return to pool if under max size
    if (this.pool.length < this.options.maxSize) {
      this.pool.push(item);
    } else {
      this.stats.destroyed++;
    }

    this.stats.currentSize = this.pool.length;
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      ...this.stats,
      availableItems: this.pool.length,
      itemsInUse: this.inUse.size,
      totalItems: this.pool.length + this.inUse.size,
    };
  }

  /**
   * Clear the pool
   */
  clear(): void {
    this.pool.length = 0;
    this.inUse.clear();
    this.stats.currentSize = 0;
  }

  /**
   * Dispose of the pool
   */
  dispose(): void {
    this.clear();
  }
}

/**
 * Optimized Circular Buffer with Memory Pooling
 */
export interface OptimizedBufferOptions {
  size: number;
  onFlush?: (items: unknown[]) => Promise<void> | void;
  flushInterval?: number;
  highWaterMark?: number;
  useMemoryPool?: boolean;
  itemFactory?: () => unknown;
  itemReset?: (item: unknown) => void;
}

export class OptimizedCircularBuffer<T> {
  private buffer: (T | undefined)[];
  private writeIndex = 0;
  private readIndex = 0;
  private count = 0;
  private readonly size: number;
  private readonly onFlush?: (items: T[]) => Promise<void> | void;
  private readonly highWaterMark: number;
  private flushTimer?: NodeJS.Timeout;
  private flushing = false;
  private memoryPool?: MemoryPool<T>;

  // Performance optimizations
  private readonly sizeMask: number; // For power-of-2 sizes
  private readonly isPowerOf2: boolean;

  constructor(options: OptimizedBufferOptions) {
    if (options.size <= 0) {
      throw new Error('Buffer size must be positive');
    }

    this.size = options.size;
    this.isPowerOf2 = (options.size & (options.size - 1)) === 0;
    this.sizeMask = this.isPowerOf2 ? options.size - 1 : 0;
    
    this.buffer = new Array(this.size);
    this.onFlush = options.onFlush;
    this.highWaterMark = options.highWaterMark || Math.floor(this.size * 0.8);

    // Initialize memory pool if enabled
    if (options.useMemoryPool && options.itemFactory) {
      this.memoryPool = new MemoryPool<T>({
        initialSize: Math.min(this.size, 100),
        maxSize: this.size * 2,
        itemFactory: options.itemFactory,
        resetItem: options.itemReset,
      });
    }

    if (options.flushInterval && this.onFlush) {
      this.startFlushTimer(options.flushInterval);
    }
  }

  /**
   * Write an item to the buffer (optimized for performance)
   */
  write(item: T): boolean {
    // Fast path for power-of-2 sizes
    const writeIdx = this.isPowerOf2 
      ? this.writeIndex & this.sizeMask
      : this.writeIndex % this.size;

    // Handle buffer overflow
    if (this.count >= this.size) {
      // Advance read index (oldest item is overwritten)
      this.readIndex = this.isPowerOf2
        ? (this.readIndex + 1) & this.sizeMask
        : (this.readIndex + 1) % this.size;
      this.count--;
    }

    // Write item
    this.buffer[writeIdx] = item;
    this.writeIndex = this.isPowerOf2
      ? (this.writeIndex + 1) & this.sizeMask
      : (this.writeIndex + 1) % this.size;
    
    this.count = Math.min(this.count + 1, this.size);

    // Trigger flush if high water mark reached
    if (this.count >= this.highWaterMark && this.onFlush && !this.flushing) {
      setImmediate(() => this.flush().catch(console.error));
    }

    return true;
  }

  /**
   * Read an item from the buffer (optimized for performance)
   */
  read(): T | undefined {
    if (this.count === 0) {
      return undefined;
    }

    const readIdx = this.isPowerOf2
      ? this.readIndex & this.sizeMask
      : this.readIndex % this.size;

    const item = this.buffer[readIdx];
    this.buffer[readIdx] = undefined; // Clear reference

    this.readIndex = this.isPowerOf2
      ? (this.readIndex + 1) & this.sizeMask
      : (this.readIndex + 1) % this.size;
    
    this.count--;

    return item;
  }

  /**
   * Read multiple items efficiently
   */
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

  /**
   * Flush buffer contents
   */
  async flush(): Promise<void> {
    if (this.flushing || this.count === 0 || !this.onFlush) {
      return;
    }

    this.flushing = true;

    try {
      const items = this.readBatch(this.count);
      if (items.length > 0) {
        await this.onFlush(items);
        
        // Return items to memory pool if available
        if (this.memoryPool) {
          items.forEach(item => this.memoryPool!.release(item));
        }
      }
    } catch (error) {
      console.error('Buffer flush failed:', error);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Start periodic flush timer
   */
  private startFlushTimer(interval: number): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch(console.error);
    }, interval);
  }

  /**
   * Get buffer statistics
   */
  getStats() {
    return {
      size: this.size,
      count: this.count,
      writeIndex: this.writeIndex,
      readIndex: this.readIndex,
      utilization: (this.count / this.size) * 100,
      flushing: this.flushing,
      memoryPool: this.memoryPool?.getStats(),
    };
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    // Return all items to memory pool before clearing
    if (this.memoryPool) {
      for (let i = 0; i < this.size; i++) {
        const item = this.buffer[i];
        if (item !== undefined) {
          this.memoryPool.release(item);
        }
      }
    }

    this.buffer.fill(undefined);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.count = 0;
  }

  /**
   * Dispose of the buffer
   */
  dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    this.clear();
    this.memoryPool?.dispose();
  }

  // Getters
  get length(): number { return this.count; }
  get isFull(): boolean { return this.count >= this.size; }
  get isEmpty(): boolean { return this.count === 0; }
  get availableSpace(): number { return this.size - this.count; }
}
