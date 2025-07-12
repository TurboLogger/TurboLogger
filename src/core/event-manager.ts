/**
 * Event Manager for TurboLogger
 * Implements centralized event system for decoupled communication
 */

import { EventEmitter } from 'events';
import { IEventManager, LogObject, EventData as IEventData } from './container';

// Strongly typed event definitions
export interface LoggerEvents {
  'log.created': {
    log: LogObject;
    timestamp: number;
    level: string;
  };
  'log.processed': {
    log: LogObject;
    timestamp: number;
    processingTime: number;
  };
  'log.serialized': {
    log: LogObject;
    serialized: string;
    size: number;
    duration: number;
  };
  'transport.write': {
    transport: string;
    log: LogObject;
    timestamp: number;
  };
  'transport.error': {
    transport: string;
    error: Error;
    log?: LogObject;
    timestamp: number;
  };
  'transport.batch': {
    transport: string;
    logs: LogObject[];
    count: number;
    timestamp: number;
  };
  'buffer.flush': {
    level: string;
    count: number;
    timestamp: number;
    duration: number;
  };
  'buffer.overflow': {
    level: string;
    dropped: number;
    timestamp: number;
  };
  'performance.alert': {
    metric: string;
    value: number;
    threshold: number;
    timestamp: number;
  };
  'performance.metric': {
    name: string;
    value: number;
    labels?: Record<string, string | number>;
    timestamp: number;
  };
  'memory.warning': {
    usage: number;
    threshold: number;
    timestamp: number;
  };
  'memory.leak': {
    component: string;
    growth: number;
    timestamp: number;
  };
  'plugin.registered': {
    name: string;
    version: string;
    timestamp: number;
  };
  'plugin.error': {
    name: string;
    error: Error;
    timestamp: number;
  };
  'security.violation': {
    type: string;
    input: string;
    timestamp: number;
  };
  'aggregation.summary': {
    period: string;
    metrics: Record<string, unknown>;
    timestamp: number;
  };
}

export type EventName = keyof LoggerEvents;
export type EventData<T extends EventName> = LoggerEvents[T];
export type EventListener<T extends EventName> = (data: EventData<T>) => void;

export interface EventSubscription {
  event: string;
  listener: Function;
  once: boolean;
  timestamp: number;
}

export interface EventMetrics {
  totalEvents: number;
  eventCounts: Record<string, number>;
  listenerCounts: Record<string, number>;
  lastEventTime: Record<string, number>;
  errorCount: number;
}

export class EventManager extends EventEmitter implements IEventManager {
  private metrics: EventMetrics = {
    totalEvents: 0,
    eventCounts: {},
    listenerCounts: {},
    lastEventTime: {},
    errorCount: 0
  };

  private subscriptions = new Set<EventSubscription>();
  private isDestroyed = false;
  private maxListeners = 100;

  constructor() {
    super();
    this.setMaxListeners(this.maxListeners);
    
    // Track listener additions/removals using super methods
    super.on('newListener', this.onNewListener.bind(this));
    super.on('removeListener', this.onRemoveListener.bind(this));
  }

  // Strongly typed emit method
  emit<T extends EventName>(event: T, data: EventData<T>): boolean;
  emit(event: string, data: IEventData): boolean;
  emit<T extends EventName | string>(event: T, data: T extends EventName ? EventData<T> : IEventData): boolean {
    if (this.isDestroyed) {
      return false;
    }

    try {
      // Update metrics
      this.updateMetrics(event as string);

      // Emit with error handling
      const result = super.emit(event as string, data);
      
      return result;
    } catch (error) {
      this.metrics.errorCount++;
      console.error(`Error emitting event '${event}':`, error);
      
      // Emit error event (avoid recursion)
      const eventStr = event as string;
      if (eventStr !== 'error') {
        super.emit('error', error);
      }
      
      return false;
    }
  }

  // Strongly typed on method
  on<T extends EventName>(event: T, listener: EventListener<T>): this;
  on(event: string, listener: (data: IEventData) => void): this;
  on<T extends EventName | string>(event: T, listener: T extends EventName ? EventListener<T> : (data: IEventData) => void): this {
    if (this.isDestroyed) {
      return this;
    }

    super.on(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  // Strongly typed once method
  once<T extends EventName>(event: T, listener: EventListener<T>): this {
    if (this.isDestroyed) {
      return this;
    }

    super.once(event, listener);
    return this;
  }

  // Strongly typed off method
  off<T extends EventName>(event: T, listener: EventListener<T>): this;
  off(event: string, listener: (data: IEventData) => void): this;
  off<T extends EventName | string>(event: T, listener: T extends EventName ? EventListener<T> : (data: IEventData) => void): this {
    super.off(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  // Advanced subscription management
  subscribe<T extends EventName>(
    event: T, 
    listener: EventListener<T>, 
    options: { once?: boolean } = {}
  ): () => void {
    const subscription: EventSubscription = {
      event,
      listener,
      once: options.once || false,
      timestamp: Date.now()
    };

    this.subscriptions.add(subscription);

    if (options.once) {
      this.once(event, listener);
    } else {
      this.on(event, listener);
    }

    // Return unsubscribe function
    return () => {
      this.subscriptions.delete(subscription);
      this.off(event, listener);
    };
  }

  // Batch event emission for performance
  emitBatch(events: Array<{ event: EventName; data: EventData<EventName> }>): void {
    if (this.isDestroyed) return;

    for (const { event, data } of events) {
      this.emit(event, data);
    }
  }

  // Event filtering and transformation
  filter<T extends EventName>(
    event: T,
    predicate: (data: EventData<T>) => boolean,
    listener: EventListener<T>
  ): () => void {
    const wrappedListener = (data: EventData<T>) => {
      if (predicate(data)) {
        listener(data);
      }
    };

    return this.subscribe(event, wrappedListener);
  }

  transform<T extends EventName, U>(
    event: T,
    transformer: (data: EventData<T>) => U,
    listener: (data: U) => void
  ): () => void {
    const wrappedListener = (data: EventData<T>) => {
      try {
        const transformed = transformer(data);
        listener(transformed);
      } catch (error) {
        console.error(`Error transforming event '${event}':`, error);
      }
    };

    return this.subscribe(event, wrappedListener);
  }

  // Event aggregation
  aggregate<T extends EventName, U>(
    event: T,
    windowMs: number,
    aggregator: (events: EventData<T>[]) => U,
    listener: (aggregated: U) => void
  ): () => void {
    const events: EventData<T>[] = [];
    let timer: NodeJS.Timeout | null = null;

    const flush = () => {
      if (events.length > 0) {
        const aggregated = aggregator([...events]);
        listener(aggregated);
        events.length = 0;
      }
      timer = null;
    };

    const wrappedListener = (data: EventData<T>) => {
      events.push(data);
      
      if (!timer) {
        timer = setTimeout(flush, windowMs);
      }
    };

    const unsubscribe = this.subscribe(event, wrappedListener);

    // Return cleanup function
    return () => {
      if (timer) {
        clearTimeout(timer);
        flush(); // Flush remaining events
      }
      unsubscribe();
    };
  }

  // Debugging and monitoring
  getMetrics(): EventMetrics {
    return { ...this.metrics };
  }

  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  getActiveEvents(): string[] {
    return Object.keys(this.metrics.eventCounts);
  }

  getListenerCount(event?: EventName): number {
    if (event) {
      return super.listenerCount(event);
    }
    return this.getMaxListeners();
  }

  // Health check
  isHealthy(): boolean {
    return !this.isDestroyed && 
           this.metrics.errorCount < 100 && 
           this.subscriptions.size < this.maxListeners;
  }

  // Cleanup and destruction
  removeAllListeners(event?: EventName): this {
    if (event) {
      // Remove from subscriptions
      for (const subscription of this.subscriptions) {
        if (subscription.event === event) {
          this.subscriptions.delete(subscription);
        }
      }
    } else {
      this.subscriptions.clear();
    }

    super.removeAllListeners(event);
    return this;
  }

  destroy(): void {
    if (this.isDestroyed) return;

    this.removeAllListeners();
    this.subscriptions.clear();
    this.isDestroyed = true;

    // Reset metrics
    this.metrics = {
      totalEvents: 0,
      eventCounts: {},
      listenerCounts: {},
      lastEventTime: {},
      errorCount: 0
    };
  }

  private updateMetrics(event: string): void {
    this.metrics.totalEvents++;
    this.metrics.eventCounts[event] = (this.metrics.eventCounts[event] || 0) + 1;
    this.metrics.lastEventTime[event] = Date.now();
  }

  private onNewListener(event: string): void {
    this.metrics.listenerCounts[event] = (this.metrics.listenerCounts[event] || 0) + 1;
  }

  private onRemoveListener(event: string): void {
    if (this.metrics.listenerCounts[event]) {
      this.metrics.listenerCounts[event]--;
      if (this.metrics.listenerCounts[event] <= 0) {
        delete this.metrics.listenerCounts[event];
      }
    }
  }
}

// Convenience functions for common event patterns
export class EventUtils {
  static createPerformanceAlert(
    metric: string, 
    value: number, 
    threshold: number
  ): EventData<'performance.alert'> {
    return {
      metric,
      value,
      threshold,
      timestamp: Date.now()
    };
  }

  static createTransportError(
    transport: string, 
    error: Error, 
    log?: LogObject
  ): EventData<'transport.error'> {
    return {
      transport,
      error,
      log,
      timestamp: Date.now()
    };
  }

  static createLogProcessed(
    log: LogObject, 
    processingTime: number
  ): EventData<'log.processed'> {
    return {
      log,
      timestamp: Date.now(),
      processingTime
    };
  }
}