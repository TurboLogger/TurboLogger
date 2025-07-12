/**
 * Improved Dependency Injection Container
 * Provides better type safety, lifecycle management, and circular dependency detection
 */

export type ServiceLifecycle = 'singleton' | 'transient' | 'scoped';

export interface ServiceDefinition<T = unknown> {
  factory: (...args: unknown[]) => T | Promise<T>;
  lifecycle: ServiceLifecycle;
  dependencies?: string[];
  tags?: string[];
}

export interface ServiceMetadata {
  name: string;
  lifecycle: ServiceLifecycle;
  dependencies: string[];
  tags: string[];
  created: Date;
  lastAccessed?: Date;
  accessCount: number;
}

export class DIContainer {
  private services = new Map<string, ServiceDefinition>();
  private instances = new Map<string, unknown>();
  private scopedInstances = new Map<string, Map<string, unknown>>();
  private metadata = new Map<string, ServiceMetadata>();
  private currentScope = 'default';
  private circularDetection = new Set<string>();

  /**
   * Register a service with the container
   */
  register<T>(
    name: string,
    factory: (...args: unknown[]) => T | Promise<T>,
    options: Partial<ServiceDefinition> = {}
  ): this {
    const definition: ServiceDefinition<T> = {
      factory,
      lifecycle: options.lifecycle || 'singleton',
      dependencies: options.dependencies || [],
      tags: options.tags || [],
    };

    this.services.set(name, definition);
    this.metadata.set(name, {
      name,
      lifecycle: definition.lifecycle,
      dependencies: definition.dependencies,
      tags: definition.tags,
      created: new Date(),
      accessCount: 0,
    });

    return this;
  }

  /**
   * Register a singleton service
   */
  singleton<T>(
    name: string,
    factory: (...args: unknown[]) => T | Promise<T>,
    dependencies: string[] = []
  ): this {
    return this.register(name, factory, { lifecycle: 'singleton', dependencies });
  }

  /**
   * Register a transient service
   */
  transient<T>(
    name: string,
    factory: (...args: unknown[]) => T | Promise<T>,
    dependencies: string[] = []
  ): this {
    return this.register(name, factory, { lifecycle: 'transient', dependencies });
  }

  /**
   * Register a scoped service
   */
  scoped<T>(
    name: string,
    factory: (...args: unknown[]) => T | Promise<T>,
    dependencies: string[] = []
  ): this {
    return this.register(name, factory, { lifecycle: 'scoped', dependencies });
  }

  /**
   * Resolve a service by name
   */
  async resolve<T = unknown>(name: string): Promise<T> {
    if (this.circularDetection.has(name)) {
      throw new Error(`Circular dependency detected: ${Array.from(this.circularDetection).join(' -> ')} -> ${name}`);
    }

    const definition = this.services.get(name);
    if (!definition) {
      throw new Error(`Service '${name}' not found in container`);
    }

    // Update metadata
    const meta = this.metadata.get(name)!;
    meta.lastAccessed = new Date();
    meta.accessCount++;

    // Handle different lifecycles
    switch (definition.lifecycle) {
      case 'singleton':
        return this.resolveSingleton<T>(name, definition);
      
      case 'transient':
        return this.resolveTransient<T>(name, definition);
      
      case 'scoped':
        return this.resolveScoped<T>(name, definition);
      
      default:
        throw new Error(`Unknown lifecycle: ${definition.lifecycle}`);
    }
  }

  /**
   * Resolve a singleton instance
   */
  private async resolveSingleton<T>(name: string, definition: ServiceDefinition): Promise<T> {
    if (this.instances.has(name)) {
      return this.instances.get(name) as T;
    }

    const instance = await this.createInstance<T>(name, definition);
    this.instances.set(name, instance);
    return instance;
  }

  /**
   * Resolve a transient instance (always creates new)
   */
  private async resolveTransient<T>(name: string, definition: ServiceDefinition): Promise<T> {
    return this.createInstance<T>(name, definition);
  }

  /**
   * Resolve a scoped instance
   */
  private async resolveScoped<T>(name: string, definition: ServiceDefinition): Promise<T> {
    if (!this.scopedInstances.has(this.currentScope)) {
      this.scopedInstances.set(this.currentScope, new Map());
    }

    const scopeMap = this.scopedInstances.get(this.currentScope)!;
    if (scopeMap.has(name)) {
      return scopeMap.get(name) as T;
    }

    const instance = await this.createInstance<T>(name, definition);
    scopeMap.set(name, instance);
    return instance;
  }

  /**
   * Create a new instance with dependency injection
   */
  private async createInstance<T>(name: string, definition: ServiceDefinition): Promise<T> {
    this.circularDetection.add(name);

    try {
      // Resolve dependencies
      const dependencies = await Promise.all(
        definition.dependencies.map(dep => this.resolve(dep))
      );

      // Create instance
      const instance = await definition.factory(...dependencies);
      
      return instance as T;
    } finally {
      this.circularDetection.delete(name);
    }
  }

  /**
   * Check if a service is registered
   */
  has(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * Get all services with a specific tag
   */
  async resolveByTag<T = unknown>(tag: string): Promise<T[]> {
    const taggedServices = Array.from(this.services.entries())
      .filter(([, definition]) => definition.tags?.includes(tag))
      .map(([name]) => name);

    return Promise.all(taggedServices.map(name => this.resolve<T>(name)));
  }

  /**
   * Create a new scope
   */
  createScope(scopeName: string): DIContainer {
    const scopedContainer = Object.create(this);
    scopedContainer.currentScope = scopeName;
    scopedContainer.scopedInstances = new Map(this.scopedInstances);
    return scopedContainer;
  }

  /**
   * Clear a scope
   */
  clearScope(scopeName: string = this.currentScope): void {
    this.scopedInstances.delete(scopeName);
  }

  /**
   * Get service metadata
   */
  getMetadata(name: string): ServiceMetadata | undefined {
    return this.metadata.get(name);
  }

  /**
   * Get all registered service names
   */
  getServiceNames(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Get services by lifecycle
   */
  getServicesByLifecycle(lifecycle: ServiceLifecycle): string[] {
    return Array.from(this.services.entries())
      .filter(([, definition]) => definition.lifecycle === lifecycle)
      .map(([name]) => name);
  }

  /**
   * Clear all instances (useful for testing)
   */
  clear(): void {
    this.instances.clear();
    this.scopedInstances.clear();
    this.circularDetection.clear();
  }

  /**
   * Dispose of the container and cleanup resources
   */
  async dispose(): Promise<void> {
    // Dispose instances that implement IDisposable
    for (const [name, instance] of this.instances) {
      if (instance && typeof (instance as any).dispose === 'function') {
        try {
          await (instance as any).dispose();
        } catch (error) {
          console.error(`Error disposing service '${name}':`, error);
        }
      }
    }

    this.clear();
    this.services.clear();
    this.metadata.clear();
  }
}

// Global container instance
export const container = new DIContainer();
