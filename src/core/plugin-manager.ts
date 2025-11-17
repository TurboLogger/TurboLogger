/**
 * Plugin Manager for TurboLogger
 * Implements modular plugin architecture for extensibility
 */

import { ILoggerPlugin, IPluginManager, LogObject } from './container';

export interface PluginContext {
  logger: unknown;
  config: Record<string, unknown>;
  container: unknown;
}

export interface PluginMetadata {
  name: string;
  version: string;
  author?: string;
  description?: string;
  dependencies?: string[];
  priority?: number;
}

export interface PluginRegistration {
  plugin: ILoggerPlugin;
  metadata: PluginMetadata;
  initialized: boolean;
  enabled: boolean;
  error?: Error;
}

export class PluginManager implements IPluginManager {
  private plugins = new Map<string, PluginRegistration>();
  private pluginOrder: string[] = [];
  private context?: PluginContext;
  private isDestroyed = false;

  constructor(context?: PluginContext) {
    this.context = context;
  }

  setContext(context: PluginContext): void {
    this.context = context;
  }

  async register(plugin: ILoggerPlugin): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('Plugin manager has been destroyed');
    }

    const name = plugin.name;
    
    if (this.plugins.has(name)) {
      throw new Error(`Plugin '${name}' is already registered`);
    }

    // Validate plugin interface
    this.validatePlugin(plugin);

    // Extract metadata
    const metadata = this.extractMetadata(plugin);

    // Create registration
    const registration: PluginRegistration = {
      plugin,
      metadata,
      initialized: false,
      enabled: true
    };

    try {
      // Initialize plugin if context is available
      if (this.context) {
        await plugin.initialize(this.context.logger);
        registration.initialized = true;
      }

      // Add to plugins map
      this.plugins.set(name, registration);

      // Update execution order based on priority
      this.updatePluginOrder();

      console.log(`Plugin '${name}' registered successfully`);
    } catch (error) {
      registration.error = error as Error;
      registration.enabled = false;
      this.plugins.set(name, registration);
      
      console.error(`Failed to initialize plugin '${name}':`, error);
      throw error;
    }
  }

  unregister(name: string): void {
    const registration = this.plugins.get(name);
    if (!registration) {
      throw new Error(`Plugin '${name}' is not registered`);
    }

    try {
      // Destroy plugin
      if (registration.initialized) {
        registration.plugin.destroy();
      }
    } catch (error) {
      console.error(`Error destroying plugin '${name}':`, error);
    }

    // Remove from maps and order
    this.plugins.delete(name);
    this.pluginOrder = this.pluginOrder.filter(n => n !== name);

    console.log(`Plugin '${name}' unregistered`);
  }

  async processLog(log: LogObject): Promise<LogObject> {
    if (this.isDestroyed) {
      return log;
    }

    let processedLog = log;

    // Process through plugins in priority order
    for (const pluginName of this.pluginOrder) {
      const registration = this.plugins.get(pluginName);
      
      if (!registration || !registration.enabled || !registration.initialized) {
        continue;
      }

      // BUG-016 FIX: Validate that plugin has process method before calling
      if (typeof registration.plugin.process !== 'function') {
        console.error(`Plugin '${pluginName}' does not implement process() method`);
        registration.enabled = false;
        continue;
      }

      try {
        processedLog = await registration.plugin.process(processedLog);
      } catch (error) {
        console.error(`Plugin '${pluginName}' processing failed:`, error);
        
        // Disable problematic plugin
        registration.enabled = false;
        registration.error = error as Error;
        
        // Continue with other plugins
        continue;
      }
    }

    return processedLog;
  }

  getPlugin(name: string): ILoggerPlugin | undefined {
    const registration = this.plugins.get(name);
    return registration?.plugin;
  }

  getAllPlugins(): ILoggerPlugin[] {
    return Array.from(this.plugins.values())
      .filter(r => r.enabled)
      .map(r => r.plugin);
  }

  getPluginRegistration(name: string): PluginRegistration | undefined {
    return this.plugins.get(name);
  }

  getAllRegistrations(): PluginRegistration[] {
    return Array.from(this.plugins.values());
  }

  enablePlugin(name: string): void {
    const registration = this.plugins.get(name);
    if (!registration) {
      throw new Error(`Plugin '${name}' is not registered`);
    }
    
    registration.enabled = true;
    registration.error = undefined;
  }

  disablePlugin(name: string): void {
    const registration = this.plugins.get(name);
    if (!registration) {
      throw new Error(`Plugin '${name}' is not registered`);
    }
    
    registration.enabled = false;
  }

  async initializeAllPlugins(): Promise<void> {
    if (!this.context) {
      throw new Error('Plugin context not set');
    }

    const initPromises: Promise<void>[] = [];

    for (const [name, registration] of this.plugins) {
      if (registration.initialized) continue;

      const initPromise = registration.plugin
        .initialize(this.context.logger)
        .then(() => {
          registration.initialized = true;
          registration.enabled = true;
          registration.error = undefined;
        })
        .catch((error) => {
          registration.error = error;
          registration.enabled = false;
          console.error(`Failed to initialize plugin '${name}':`, error);
        });

      initPromises.push(initPromise);
    }

    await Promise.all(initPromises);
  }

  async destroy(): Promise<void> {
    if (this.isDestroyed) return;

    const destroyPromises: Promise<void>[] = [];

    for (const [name, registration] of this.plugins) {
      if (!registration.initialized) continue;

      const destroyPromise = registration.plugin
        .destroy()
        .catch((error) => {
          console.error(`Error destroying plugin '${name}':`, error);
        });

      destroyPromises.push(destroyPromise);
    }

    await Promise.all(destroyPromises);

    this.plugins.clear();
    this.pluginOrder = [];
    this.context = undefined;
    this.isDestroyed = true;
  }

  // Plugin health and diagnostics
  getHealthStatus(): Record<string, any> {
    const status: Record<string, any> = {
      totalPlugins: this.plugins.size,
      enabledPlugins: 0,
      disabledPlugins: 0,
      erroredPlugins: 0,
      plugins: {}
    };

    for (const [name, registration] of this.plugins) {
      if (registration.enabled) status.enabledPlugins++;
      if (!registration.enabled) status.disabledPlugins++;
      if (registration.error) status.erroredPlugins++;

      status.plugins[name] = {
        enabled: registration.enabled,
        initialized: registration.initialized,
        version: registration.metadata.version,
        error: registration.error?.message,
        priority: registration.metadata.priority || 0
      };
    }

    return status;
  }

  private validatePlugin(plugin: ILoggerPlugin): void {
    if (!plugin.name || typeof plugin.name !== 'string') {
      throw new Error('Plugin must have a valid name');
    }

    if (!plugin.version || typeof plugin.version !== 'string') {
      throw new Error('Plugin must have a valid version');
    }

    if (typeof plugin.initialize !== 'function') {
      throw new Error('Plugin must implement initialize method');
    }

    if (typeof plugin.process !== 'function') {
      throw new Error('Plugin must implement process method');
    }

    if (typeof plugin.destroy !== 'function') {
      throw new Error('Plugin must implement destroy method');
    }
  }

  private extractMetadata(plugin: ILoggerPlugin): PluginMetadata {
    const metadata: PluginMetadata = {
      name: plugin.name,
      version: plugin.version
    };

    // Extract additional metadata if available
    const pluginExtended = plugin as ILoggerPlugin & {
      author?: string;
      description?: string;
      dependencies?: string[];
      priority?: number;
    };
    
    if (pluginExtended.author) metadata.author = pluginExtended.author;
    if (pluginExtended.description) metadata.description = pluginExtended.description;
    if (pluginExtended.dependencies) metadata.dependencies = pluginExtended.dependencies;
    if (pluginExtended.priority !== undefined) metadata.priority = pluginExtended.priority;

    return metadata;
  }

  private updatePluginOrder(): void {
    // Sort plugins by priority (higher priority first)
    const sorted = Array.from(this.plugins.entries())
      .sort(([, a], [, b]) => {
        const priorityA = a.metadata.priority || 0;
        const priorityB = b.metadata.priority || 0;
        return priorityB - priorityA;
      })
      .map(([name]) => name);

    this.pluginOrder = sorted;
  }
}

// Base plugin class for easier plugin development
export abstract class BasePlugin implements ILoggerPlugin {
  public abstract readonly name: string;
  public abstract readonly version: string;
  public readonly author?: string;
  public readonly description?: string;
  public readonly dependencies?: string[];
  public readonly priority?: number;

  protected logger?: unknown;
  protected isInitialized = false;

  async initialize(logger: unknown): Promise<void> {
    if (this.isInitialized) {
      throw new Error(`Plugin '${this.name}' is already initialized`);
    }

    this.logger = logger;
    await this.onInitialize(logger);
    this.isInitialized = true;
  }

  async process(log: LogObject): Promise<LogObject> {
    if (!this.isInitialized) {
      throw new Error(`Plugin '${this.name}' is not initialized`);
    }

    return await this.onProcess(log);
  }

  async destroy(): Promise<void> {
    if (!this.isInitialized) return;

    await this.onDestroy();
    this.logger = undefined;
    this.isInitialized = false;
  }

  protected abstract onInitialize(logger: unknown): Promise<void>;
  protected abstract onProcess(log: LogObject): Promise<LogObject>;
  protected abstract onDestroy(): Promise<void>;
}