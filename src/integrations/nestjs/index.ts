import { TurboLogger } from '../../core/logger';

export {
  TurboLoggerModule,
  TurboLoggerService,
  TurboLoggerInterceptor,
  TurboLoggerExceptionFilter,
  TurboLoggerGuard,
  TurboLoggerModuleOptions,
  TurboLoggerModuleAsyncOptions
} from './turbologger.module';

// Decorators for enhanced logging
export function LogMethod(level: string = 'info') {
  return function (target: object, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (this: { logger?: TurboLogger }, ...args: unknown[]) {
      const logger = this.logger || { [level]: console.log.bind(console), error: console.error.bind(console) } as unknown as TurboLogger; // Fallback to console
      const className = target.constructor.name;
      const methodName = propertyKey;

      const startTime = Date.now();
      
      const logMethod = logger[level as keyof TurboLogger] as (obj: Record<string, unknown>, msg: string) => void;
      if (typeof logMethod === 'function') {
        logMethod.call(logger, {
          type: 'method_start',
          class: className,
          method: methodName,
          args: args.length
        }, `Starting ${className}.${methodName}`);
      }

      try {
        const result = await originalMethod.apply(this, args);
        const duration = Date.now() - startTime;
        
        const endLogMethod = logger[level as keyof TurboLogger] as (obj: Record<string, unknown>, msg: string) => void;
        if (typeof endLogMethod === 'function') {
          endLogMethod.call(logger, {
            type: 'method_end',
            class: className,
            method: methodName,
            duration,
            success: true
          }, `Completed ${className}.${methodName}`);
        }

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        
        if (logger.error) {
          logger.error({
            type: 'method_error',
            class: className,
            method: methodName,
            duration,
            error: {
              name: (error as Error).name,
              message: (error as Error).message,
              stack: (error as Error).stack
            }
          }, `Failed ${className}.${methodName}`);
        }

        throw error;
      }
    };

    return descriptor;
  };
}

export function LogProperty(level: string = 'debug') {
  return function (target: object, propertyKey: string) {
    let value = (target as Record<string, unknown>)[propertyKey];

    const getter = () => {
      return value;
    };

    const setter = (newValue: unknown) => {
      const logger = (target as { logger?: TurboLogger }).logger || { [level]: console.log.bind(console) } as unknown as TurboLogger;
      const className = target.constructor.name;

      const logMethod = logger[level as keyof TurboLogger] as (obj: Record<string, unknown>, msg: string) => void;
      if (typeof logMethod === 'function') {
        logMethod.call(logger, {
          type: 'property_change',
          class: className,
          property: propertyKey,
          oldValue: value,
          newValue: newValue
        }, `Property ${className}.${propertyKey} changed`);
      }

      value = newValue;
    };

    Object.defineProperty(target, propertyKey, {
      get: getter,
      set: setter,
      enumerable: true,
      configurable: true
    });
  };
}

// Example usage in a NestJS service
// @Injectable()
// export class ExampleService {
//   constructor(private readonly logger: TurboLoggerService) {}
//
//   @LogMethod('info')
//   async findUser(id: string): Promise<any> {
//     // Method implementation
//     return { id, name: 'User' };
//   }
// }