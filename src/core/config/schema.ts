// BUG-055 FIX: Handle missing zod dependency gracefully
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let z: any;
let zodAvailable = false;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const zodModule = require('zod');
  z = zodModule.z;
  zodAvailable = true;
} catch {
  // Zod not available - provide minimal mock for type compatibility
  console.warn('Warning: zod package not installed. Configuration validation will be skipped. Install zod for validation: npm install zod');
  z = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    object: () => ({ parse: (config: any) => config, default: (_fn: any) => ({ parse: (c: any) => c }) }),
    string: () => ({ optional: () => ({}) }),
    number: () => ({ min: () => ({ max: () => ({ default: () => ({}) }) }), default: () => ({}) }),
    boolean: () => ({ default: () => ({}) }),
    enum: () => ({ default: () => ({}) }),
    array: () => ({ default: () => ({}) }),
    record: () => ({ default: () => ({}) }),
    function: () => ({ optional: () => ({}) }),
    unknown: () => ({}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    infer: () => undefined as any,
    ZodError: class ZodError extends Error {}
  };
}

// Performance configuration schema
const performanceSchema = zodAvailable ? z.object({
  mode: z.enum(['standard', 'fast', 'ultra']).default('fast'),
  bufferSize: z.number().min(256).max(65536).default(4096),
  flushInterval: z.number().min(10).max(10000).default(100),
  zeroAllocation: z.boolean().default(false),
  enableOptimizations: z.boolean().default(true),
}) : { parse: (config: any) => config || { mode: 'fast', bufferSize: 4096, flushInterval: 100, zeroAllocation: false, enableOptimizations: true } };

// Output configuration schema
const outputSchema = z.object({
  format: z.enum(['json', 'structured', 'compact', 'pretty']).default('json'),
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  timestamp: z.boolean().default(true),
  hostname: z.boolean().default(true),
  pid: z.boolean().default(true),
  stackTrace: z.boolean().default(false),
});

// Security configuration schema
const securitySchema = z.object({
  encryption: z.object({
    enabled: z.boolean().default(false),
    algorithm: z.enum(['aes-256-gcm', 'aes-256-cbc']).default('aes-256-gcm'),
    keyRotation: z.string().optional(),
  }).default(() => ({
    enabled: false,
    algorithm: 'aes-256-gcm' as const,
  })),
  piiMasking: z.object({
    enabled: z.boolean().default(false),
    autoDetect: z.boolean().default(false),
    compliance: z.array(z.enum(['gdpr', 'hipaa', 'pci', 'sox'])).default([]),
    customRules: z.array(z.object({
      field: z.string().optional(),
      pattern: z.string().optional(), // Will be converted to RegExp
      mask: z.string(),
      enabled: z.boolean().default(true),
    })).default([]),
  }).default(() => ({
    enabled: false,
    autoDetect: false,
    compliance: [],
    customRules: [],
  })),
  signing: z.object({
    enabled: z.boolean().default(false),
    algorithm: z.enum(['hmac-sha256', 'rsa-sha256']).default('hmac-sha256'),
  }).default(() => ({
    enabled: false,
    algorithm: 'hmac-sha256' as const,
  })),
});

// Observability configuration schema
const observabilitySchema = z.object({
  metrics: z.object({
    enabled: z.boolean().default(false),
    provider: z.enum(['prometheus', 'statsd', 'custom']).default('prometheus'),
    endpoint: z.string().optional(),
    interval: z.number().min(1000).default(60000),
  }).default(() => ({
    enabled: false,
    provider: 'prometheus' as const,
    interval: 60000,
  })),
  tracing: z.object({
    enabled: z.boolean().default(false),
    provider: z.enum(['jaeger', 'zipkin', 'otel']).default('otel'),
    serviceName: z.string().optional(),
    endpoint: z.string().optional(),
    sampleRate: z.number().min(0).max(1).default(1),
  }).default(() => ({
    enabled: false,
    provider: 'otel' as const,
    sampleRate: 1,
  })),
});

// Transport configuration schema
const transportSchema = z.object({
  type: z.enum(['console', 'file', 'elasticsearch', 'cloudwatch', 'stackdriver', 'azure']),
  enabled: z.boolean().default(true),
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
  format: z.enum(['json', 'structured', 'compact', 'pretty']).optional(),
  options: z.record(z.string(), z.unknown()).default({}),
});

// Main configuration schema
export const configSchema = z.object({
  name: z.string().optional(),
  context: z.record(z.string(), z.unknown()).default({}),
  performance: performanceSchema,
  output: outputSchema,
  security: securitySchema,
  observability: observabilitySchema,
  transports: z.array(transportSchema).default([]),
  plugins: z.array(z.string()).default([]),
  errorHandler: z.function().optional(),
});

// Type definitions - when zod is available, these are inferred from schema
// When zod is not available, they fall back to 'any' type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TurboLoggerConfig = typeof configSchema extends { _output: infer T } ? T : any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PerformanceConfig = typeof performanceSchema extends { _output: infer T } ? T : any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OutputConfig = typeof outputSchema extends { _output: infer T } ? T : any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SecurityConfig = typeof securitySchema extends { _output: infer T } ? T : any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ObservabilityConfig = typeof observabilitySchema extends { _output: infer T } ? T : any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TransportConfig = typeof transportSchema extends { _output: infer T } ? T : any;

export function validateConfig(config: unknown): TurboLoggerConfig {
  // BUG-055 FIX: If zod is not available, skip validation and return config as-is with defaults
  if (!zodAvailable) {
    return {
      name: undefined,
      context: {},
      performance: { mode: 'fast', bufferSize: 4096, flushInterval: 100, zeroAllocation: false, enableOptimizations: true },
      output: { format: 'json', level: 'info', timestamp: true, hostname: true, pid: true, stackTrace: false },
      security: { encryption: { enabled: false, algorithm: 'aes-256-gcm' }, piiMasking: { enabled: false, autoDetect: false, compliance: [], customRules: [] }, signing: { enabled: false, algorithm: 'hmac-sha256' } },
      observability: { metrics: { enabled: false, provider: 'prometheus', interval: 60000 }, tracing: { enabled: false, provider: 'otel', sampleRate: 1 } },
      transports: [],
      plugins: [],
      ...config as any
    } as TurboLoggerConfig;
  }

  try {
    return configSchema.parse(config);
  } catch (error: unknown) {
    // BUG FIX: Proper type checking for unknown error type
    if (zodAvailable && error instanceof z.ZodError) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorMessages = (error as any).issues.map((err: any) =>
        `${err.path.join('.')}: ${err.message}`
      ).join('\n');
      throw new Error(`Configuration validation failed:\n${errorMessages}`);
    }
    throw error;
  }
}

export function createDefaultConfig(): TurboLoggerConfig {
  if (!zodAvailable) {
    return validateConfig({});
  }
  return configSchema.parse({});
}
