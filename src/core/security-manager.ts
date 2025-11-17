/**
 * Security Manager for TurboLogger
 * Implements comprehensive security features including input sanitization and PII detection
 */

import { resolve, normalize, sep } from 'path';
import { ISecurityManager } from './container';

export interface SecurityConfig {
  enableInputSanitization?: boolean;
  enablePathValidation?: boolean;
  enablePiiDetection?: boolean;
  enablePiiMasking?: boolean;
  allowedPathPrefixes?: string[];
  piiPatterns?: PIIPattern[];
  maxInputLength?: number;
  sanitizationRules?: SanitizationRule[];
}

export interface PIIPattern {
  name: string;
  pattern: RegExp;
  mask: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface SanitizationRule {
  name: string;
  pattern: RegExp;
  replacement: string;
  enabled: boolean;
}

export interface SecurityViolation {
  type: string;
  input: string;
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: number;
  action: 'sanitized' | 'blocked' | 'masked';
}

export interface SecurityReport {
  violations: SecurityViolation[];
  stats: {
    totalInputs: number;
    sanitizedInputs: number;
    blockedInputs: number;
    piiDetections: number;
    pathViolations: number;
  };
  patterns: {
    mostCommonViolations: Array<{ type: string; count: number }>;
    recentViolations: SecurityViolation[];
  };
}

// Default PII patterns
const DEFAULT_PII_PATTERNS: PIIPattern[] = [
  {
    name: 'ssn',
    pattern: /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/gi,
    mask: '***-**-****',
    severity: 'critical'
  },
  {
    name: 'credit_card',
    pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/gi,
    mask: '**** **** **** ****',
    severity: 'critical'
  },
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi,
    mask: '***@***.***',
    severity: 'medium'
  },
  {
    name: 'phone',
    pattern: /\b(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b/gi,
    mask: '(***) ***-****',
    severity: 'medium'
  },
  {
    name: 'ip_address',
    pattern: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/gi,
    mask: '***.***.***.***',
    severity: 'low'
  },
  {
    name: 'api_key',
    pattern: /\b(?:api[_-]?key|token|secret)["\s:=]+[a-zA-Z0-9+/=]{20,}\b/gi,
    mask: '***API_KEY***',
    severity: 'critical'
  },
  {
    name: 'password',
    pattern: /\b(?:password|pwd|pass)["\s:=]+[^\s"]{8,}\b/gi,
    mask: '***PASSWORD***',
    severity: 'critical'
  }
];

// Default sanitization rules
const DEFAULT_SANITIZATION_RULES: SanitizationRule[] = [
  {
    name: 'script_tags',
    pattern: /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    replacement: '[SCRIPT_REMOVED]',
    enabled: true
  },
  {
    name: 'html_tags',
    pattern: /<[^>]*>/g,
    replacement: '',
    enabled: true
  },
  {
    name: 'sql_injection',
    // BUG-005 FIX: More specific SQL injection pattern requiring SQL syntax context
    // Old pattern flagged legitimate text like "I need to SELECT a book"
    // New pattern requires SQL syntax like "SELECT...FROM", "INSERT...INTO", "DROP TABLE", etc.
    pattern: /(\b(SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+.+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|DATABASE)|CREATE\s+(TABLE|DATABASE)|ALTER\s+TABLE|EXEC\s*\(|UNION\s+(ALL\s+)?SELECT)\b)/gi,
    replacement: '[SQL_PATTERN]',
    enabled: true
  },
  {
    name: 'javascript_protocol',
    pattern: /javascript\s*:/gi,
    replacement: '[JS_PROTOCOL]',
    enabled: true
  },
  {
    name: 'control_chars',
    pattern: /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,
    replacement: '',
    enabled: true
  }
];

export class SecurityManager implements ISecurityManager {
  private readonly config: Required<SecurityConfig>;
  private readonly violations: SecurityViolation[] = [];
  private readonly stats = {
    totalInputs: 0,
    sanitizedInputs: 0,
    blockedInputs: 0,
    piiDetections: 0,
    pathViolations: 0
  };
  private readonly MAX_VIOLATIONS_HISTORY = 1000;

  constructor(config: SecurityConfig = {}) {
    this.config = {
      enableInputSanitization: config.enableInputSanitization ?? true,
      enablePathValidation: config.enablePathValidation ?? true,
      enablePiiDetection: config.enablePiiDetection ?? true,
      enablePiiMasking: config.enablePiiMasking ?? true,
      allowedPathPrefixes: config.allowedPathPrefixes ?? [
        resolve(process.cwd()),
        resolve('/tmp'),
        resolve('/var/log'),
        resolve(require('os').tmpdir())
      ],
      // NEW-BUG-002 FIX: Clone PII patterns to avoid shared regex state mutation
      // Each instance needs its own regex objects to prevent lastIndex conflicts
      piiPatterns: (config.piiPatterns ?? DEFAULT_PII_PATTERNS).map(p => ({
        ...p,
        pattern: new RegExp(p.pattern.source, p.pattern.flags)
      })),
      maxInputLength: config.maxInputLength ?? 100000,
      sanitizationRules: config.sanitizationRules ?? DEFAULT_SANITIZATION_RULES
    };
  }

  sanitizeInput(input: string): string {
    if (!this.config.enableInputSanitization) {
      return input;
    }

    this.stats.totalInputs++;

    // Check input length
    if (input.length > this.config.maxInputLength) {
      this.recordViolation({
        type: 'input_length_exceeded',
        input: input.substring(0, 100) + '...',
        reason: `Input length ${input.length} exceeds maximum ${this.config.maxInputLength}`,
        severity: 'medium',
        timestamp: Date.now(),
        action: 'sanitized'
      });
      
      input = input.substring(0, this.config.maxInputLength);
    }

    let sanitized = input;
    let wasSanitized = false;

    // Apply sanitization rules
    for (const rule of this.config.sanitizationRules) {
      if (!rule.enabled) continue;

      const original = sanitized;
      sanitized = sanitized.replace(rule.pattern, rule.replacement);
      
      if (sanitized !== original) {
        wasSanitized = true;
        this.recordViolation({
          type: rule.name,
          input: original.substring(0, 100),
          reason: `Applied sanitization rule: ${rule.name}`,
          severity: 'medium',
          timestamp: Date.now(),
          action: 'sanitized'
        });
      }
    }

    if (wasSanitized) {
      this.stats.sanitizedInputs++;
    }

    return sanitized;
  }

  validatePath(path: string): string {
    if (!this.config.enablePathValidation) {
      return path;
    }

    try {
      // Normalize and resolve the path
      const normalizedPath = resolve(normalize(path));
      
      // Check if path is within allowed prefixes
      const isAllowed = this.config.allowedPathPrefixes.some(prefix => {
        const normalizedPrefix = resolve(normalize(prefix));
        return normalizedPath.startsWith(normalizedPrefix + sep) || 
               normalizedPath === normalizedPrefix;
      });

      if (!isAllowed) {
        const violation: SecurityViolation = {
          type: 'path_traversal',
          input: path,
          reason: 'Path is outside allowed directories',
          severity: 'high',
          timestamp: Date.now(),
          action: 'blocked'
        };
        
        this.recordViolation(violation);
        this.stats.pathViolations++;
        
        throw new Error(`Path validation failed: ${path} is not within allowed directories`);
      }

      // Check for suspicious path patterns
      const suspiciousPatterns = [
        /\.\.[\/\\]/,  // Path traversal
        /[<>:"|?*]/,   // Invalid characters
        /^\\\\.*$/,    // UNC paths
        /^[a-z]:\\/i   // Windows drive paths on non-Windows systems
      ];

      for (const pattern of suspiciousPatterns) {
        if (pattern.test(normalizedPath)) {
          const violation: SecurityViolation = {
            type: 'suspicious_path',
            input: path,
            reason: 'Path contains suspicious patterns',
            severity: 'high',
            timestamp: Date.now(),
            action: 'blocked'
          };
          
          this.recordViolation(violation);
          this.stats.pathViolations++;
          
          throw new Error(`Path validation failed: ${path} contains suspicious patterns`);
        }
      }

      return normalizedPath;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Path validation failed')) {
        throw error;
      }
      
      // Handle other path resolution errors
      const violation: SecurityViolation = {
        type: 'path_resolution_error',
        input: path,
        reason: `Path resolution failed: ${error}`,
        severity: 'medium',
        timestamp: Date.now(),
        action: 'blocked'
      };
      
      this.recordViolation(violation);
      this.stats.pathViolations++;
      
      throw new Error(`Path validation failed: Unable to resolve path ${path}`);
    }
  }

  detectPII(content: string): boolean {
    if (!this.config.enablePiiDetection) {
      return false;
    }

    for (const pattern of this.config.piiPatterns) {
      // FIX NEW-002: Reset regex lastIndex to prevent stateful regex bugs
      // Global regexes maintain state via lastIndex, causing inconsistent results
      pattern.pattern.lastIndex = 0;

      if (pattern.pattern.test(content)) {
        // Reset again after test to ensure clean state
        pattern.pattern.lastIndex = 0;

        this.stats.piiDetections++;

        this.recordViolation({
          type: 'pii_detected',
          input: content.substring(0, 100),
          reason: `PII pattern detected: ${pattern.name}`,
          severity: pattern.severity,
          timestamp: Date.now(),
          action: 'masked'
        });

        return true;
      }
    }

    return false;
  }

  maskPII(content: string): string {
    if (!this.config.enablePiiMasking) {
      return content;
    }

    let masked = content;
    let wasModified = false;

    for (const pattern of this.config.piiPatterns) {
      // FIX NEW-002: Reset regex lastIndex to prevent stateful regex bugs
      pattern.pattern.lastIndex = 0;

      const matches = masked.match(pattern.pattern);
      if (matches) {
        // Reset again before replace to ensure clean state
        pattern.pattern.lastIndex = 0;
        masked = masked.replace(pattern.pattern, pattern.mask);
        // Reset after replace
        pattern.pattern.lastIndex = 0;

        wasModified = true;

        this.recordViolation({
          type: 'pii_masked',
          input: `${matches.length} ${pattern.name} pattern(s)`,
          reason: `Masked PII pattern: ${pattern.name}`,
          severity: pattern.severity,
          timestamp: Date.now(),
          action: 'masked'
        });
      }
    }

    if (wasModified) {
      this.stats.piiDetections++;
    }

    return masked;
  }

  // Advanced security features
  analyzeContent(content: string): {
    hasPII: boolean;
    hasSuspiciousPatterns: boolean;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    detectedPatterns: string[];
  } {
    const detectedPatterns: string[] = [];
    let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';
    
    // Check for PII
    const hasPII = this.detectPII(content);
    if (hasPII) {
      detectedPatterns.push('PII detected');
      riskLevel = 'high';
    }

    // Check for suspicious patterns
    const suspiciousPatterns = [
      { name: 'potential_injection', pattern: /['"`;\\]/g },
      { name: 'suspicious_functions', pattern: /\b(eval|exec|system|shell_exec)\b/gi },
      { name: 'file_operations', pattern: /\b(fopen|fwrite|file_get_contents|include|require)\b/gi },
      { name: 'network_operations', pattern: /\b(curl|wget|http|ftp|socket)\b/gi }
    ];

    let hasSuspiciousPatterns = false;
    for (const { name, pattern } of suspiciousPatterns) {
      if (pattern.test(content)) {
        detectedPatterns.push(name);
        hasSuspiciousPatterns = true;
        if (riskLevel === 'low') riskLevel = 'medium';
      }
    }

    // Adjust risk level based on content characteristics
    if (content.length > 50000) {
      detectedPatterns.push('large_content');
      if (riskLevel === 'low') riskLevel = 'medium';
    }

    return {
      hasPII,
      hasSuspiciousPatterns,
      riskLevel,
      detectedPatterns
    };
  }

  private recordViolation(violation: SecurityViolation): void {
    this.violations.push(violation);
    
    // Limit violation history to prevent memory growth
    if (this.violations.length > this.MAX_VIOLATIONS_HISTORY) {
      this.violations.splice(0, this.violations.length - this.MAX_VIOLATIONS_HISTORY);
    }
  }

  getSecurityReport(): SecurityReport {
    const violationCounts = new Map<string, number>();
    for (const violation of this.violations) {
      violationCounts.set(violation.type, (violationCounts.get(violation.type) || 0) + 1);
    }

    const mostCommonViolations = Array.from(violationCounts.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const recentViolations = this.violations
      .slice(-20)
      .sort((a, b) => b.timestamp - a.timestamp);

    return {
      violations: [...this.violations],
      stats: { ...this.stats },
      patterns: {
        mostCommonViolations,
        recentViolations
      }
    };
  }

  // Configuration management
  updateConfig(newConfig: Partial<SecurityConfig>): void {
    Object.assign(this.config, newConfig);
  }

  addPIIPattern(pattern: PIIPattern): void {
    this.config.piiPatterns.push(pattern);
  }

  removePIIPattern(name: string): boolean {
    const index = this.config.piiPatterns.findIndex(p => p.name === name);
    if (index !== -1) {
      this.config.piiPatterns.splice(index, 1);
      return true;
    }
    return false;
  }

  addSanitizationRule(rule: SanitizationRule): void {
    this.config.sanitizationRules.push(rule);
  }

  removeSanitizationRule(name: string): boolean {
    const index = this.config.sanitizationRules.findIndex(r => r.name === name);
    if (index !== -1) {
      this.config.sanitizationRules.splice(index, 1);
      return true;
    }
    return false;
  }

  // Utility methods
  clearViolationHistory(): void {
    this.violations.length = 0;
  }

  resetStats(): void {
    this.stats.totalInputs = 0;
    this.stats.sanitizedInputs = 0;
    this.stats.blockedInputs = 0;
    this.stats.piiDetections = 0;
    this.stats.pathViolations = 0;
  }

  isHealthy(): boolean {
    const recentViolations = this.violations.filter(
      v => Date.now() - v.timestamp < 60000 // Last minute
    );
    
    const criticalViolations = recentViolations.filter(v => v.severity === 'critical');
    const highViolations = recentViolations.filter(v => v.severity === 'high');
    
    // Consider unhealthy if too many recent critical or high-severity violations
    return criticalViolations.length < 5 && highViolations.length < 20;
  }

  destroy(): void {
    this.violations.length = 0;
    this.resetStats();
  }
}

// Export singleton instance
export const securityManager = new SecurityManager();