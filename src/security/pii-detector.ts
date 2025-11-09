export interface PIIRule {
  name: string;
  pattern: RegExp;
  mask: string | ((match: string) => string);
  confidence: number;
  description: string;
}

export interface PIIDetectionResult {
  field: string;
  type: string;
  confidence: number;
  original: string;
  masked: string;
}

export class PIIDetector {
  private rules: PIIRule[] = [];
  private customPatterns: Map<string, PIIRule> = new Map();

  constructor() {
    this.setupDefaultRules();
  }

  private setupDefaultRules(): void {
    const defaultRules: PIIRule[] = [
      {
        name: 'email',
        pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
        mask: (match) => {
          // FIX NEW-010: Validate email format before masking to prevent crashes
          const parts = match.split('@');
          if (parts.length !== 2) return '***@***.***';

          const [local, domain] = parts;
          if (!local || !domain) return '***@***.***';

          const domainParts = domain.split('.');
          if (domainParts.length < 2) return '***@***.***';

          const [name, ...tldParts] = domainParts;
          const tld = tldParts.join('.');

          if (!name || !tld) return '***@***.***';

          return `${local.charAt(0)}***@${name.charAt(0)}***.${tld}`;
        },
        confidence: 0.95,
        description: 'Email address'
      },
      {
        name: 'ssn',
        pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
        mask: 'XXX-XX-****',
        confidence: 0.9,
        description: 'Social Security Number'
      },
      {
        name: 'credit_card',
        pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
        mask: '**** **** **** ****',
        confidence: 0.85,
        description: 'Credit card number'
      },
      {
        name: 'phone',
        pattern: /\b(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b/g,
        mask: '(***) ***-****',
        confidence: 0.8,
        description: 'Phone number'
      },
      {
        name: 'ip_address',
        pattern: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g,
        mask: 'XXX.XXX.XXX.XXX',
        confidence: 0.7,
        description: 'IP address'
      },
      {
        name: 'mac_address',
        pattern: /\b([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})\b/g,
        mask: 'XX:XX:XX:XX:XX:XX',
        confidence: 0.9,
        description: 'MAC address'
      },
      {
        name: 'date_of_birth',
        pattern: /\b(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12][0-9]|3[01])\/(?:19|20)\d{2}\b/g,
        mask: 'MM/DD/YYYY',
        confidence: 0.75,
        description: 'Date of birth (MM/DD/YYYY)'
      },
      {
        name: 'api_key',
        pattern: /\b[A-Za-z0-9]{32,}\b/g,
        mask: '[REDACTED_API_KEY]',
        confidence: 0.6,
        description: 'API key or token'
      },
      {
        name: 'password',
        pattern: /\b(?:password|passwd|pwd)["']?\s*[:=]\s*["']?([^\s"',;]+)/gi,
        mask: '[REDACTED_PASSWORD]',
        confidence: 0.9,
        description: 'Password field'
      },
      {
        name: 'aws_key',
        pattern: /AKIA[0-9A-Z]{16}/g,
        mask: '[REDACTED_AWS_KEY]',
        confidence: 0.95,
        description: 'AWS Access Key'
      },
      {
        name: 'jwt_token',
        pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
        mask: '[REDACTED_JWT]',
        confidence: 0.9,
        description: 'JWT Token'
      }
    ];

    this.rules = defaultRules;
  }

  addCustomRule(rule: PIIRule): void {
    this.customPatterns.set(rule.name, rule);
  }

  removeCustomRule(name: string): void {
    this.customPatterns.delete(name);
  }

  detectAndMask(data: unknown, confidenceThreshold: number = 0.7): {
    masked: unknown;
    detections: PIIDetectionResult[];
  } {
    const detections: PIIDetectionResult[] = [];
    const masked = this.processValue(data, '', detections, confidenceThreshold);
    
    return { masked, detections };
  }

  private processValue(
    value: unknown,
    path: string,
    detections: PIIDetectionResult[],
    confidenceThreshold: number
  ): unknown {
    if (typeof value === 'string') {
      return this.maskString(value, path, detections, confidenceThreshold);
    } else if (Array.isArray(value)) {
      return value.map((item, index) =>
        this.processValue(item, `${path}[${index}]`, detections, confidenceThreshold)
      );
    } else if (typeof value === 'object' && value !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        const fieldPath = path ? `${path}.${key}` : key;
        
        // Check if field name itself indicates PII
        if (this.isFieldNamePII(key)) {
          result[key] = this.maskByFieldName(key, val as string);
          detections.push({
            field: fieldPath,
            type: 'field_name',
            confidence: 0.9,
            original: String(val),
            masked: result[key] as string
          });
        } else {
          result[key] = this.processValue(val, fieldPath, detections, confidenceThreshold);
        }
      }
      return result;
    }
    
    return value;
  }

  private maskString(
    text: string,
    path: string,
    detections: PIIDetectionResult[],
    confidenceThreshold: number
  ): string {
    let result = text;
    const allRules = [...this.rules, ...this.customPatterns.values()];

    for (const rule of allRules) {
      if (rule.confidence >= confidenceThreshold) {
        const matches = text.match(rule.pattern);
        if (matches) {
          // FIX NEW-012: Track replaced positions to avoid multiple replacements
          // Using replaceAll would replace all instances, not just the detected ones
          // Process matches in reverse order to maintain correct indices
          const uniqueMatches = Array.from(new Set(matches)).reverse();

          for (const match of uniqueMatches) {
            const masked = typeof rule.mask === 'function'
              ? rule.mask(match)
              : rule.mask;

            // Replace only the first occurrence to avoid double-masking
            const index = result.indexOf(match);
            if (index !== -1) {
              result = result.substring(0, index) + masked + result.substring(index + match.length);

              detections.push({
                field: path,
                type: rule.name,
                confidence: rule.confidence,
                original: match,
                masked
              });
            }
          }
        }
      }
    }

    return result;
  }

  private isFieldNamePII(fieldName: string): boolean {
    const piiFieldNames = [
      'password', 'passwd', 'pwd', 'secret', 'token', 'key',
      'email', 'mail', 'ssn', 'social', 'credit', 'card',
      'phone', 'mobile', 'birth', 'dob', 'address'
    ];
    
    const lowerField = fieldName.toLowerCase();
    return piiFieldNames.some(pii => lowerField.includes(pii));
  }

  private maskByFieldName(fieldName: string, value: string): string {
    const lowerField = fieldName.toLowerCase();
    
    if (lowerField.includes('password') || lowerField.includes('secret')) {
      return '[REDACTED]';
    } else if (lowerField.includes('email')) {
      return this.maskEmail(value);
    } else if (lowerField.includes('phone')) {
      return '***-***-****';
    } else if (lowerField.includes('token') || lowerField.includes('key')) {
      return '[REDACTED_TOKEN]';
    }
    
    return '[REDACTED]';
  }

  private maskEmail(email: string): string {
    try {
      // FIX NEW-010: Validate email format before processing
      const parts = email.split('@');
      if (parts.length !== 2) return '***@***.***';

      const [local, domain] = parts;
      if (!local || !domain) return '***@***.***';

      const domainParts = domain.split('.');
      if (domainParts.length < 2) return '***@***.***';

      const maskedLocal = local.charAt(0) + '*'.repeat(Math.max(0, local.length - 2)) + local.charAt(local.length - 1);

      // Handle multi-level domains (e.g., example.co.uk)
      const tld = domainParts[domainParts.length - 1];
      const domainName = domainParts.slice(0, -1).join('.');

      if (!domainName || !tld) return '***@***.***';

      const maskedDomain = domainName.charAt(0) + '*'.repeat(Math.max(0, domainName.length - 2)) + domainName.charAt(domainName.length - 1);
      return `${maskedLocal}@${maskedDomain}.${tld}`;
    } catch {}

    return '***@***.***';
  }

  // FIX NEW-009: Cache compiled regexes to avoid recompilation on every call
  private compiledPatternCache = new WeakMap<PIIRule, RegExp>();

  analyzeText(text: string): Array<{
    type: string;
    confidence: number;
    position: { start: number; end: number };
    value: string;
  }> {
    const results: Array<{
      type: string;
      confidence: number;
      position: { start: number; end: number };
      value: string;
    }> = [];

    const allRules = [...this.rules, ...this.customPatterns.values()];

    for (const rule of allRules) {
      // FIX NEW-009: Use cached regex instead of recompiling every time
      let regex = this.compiledPatternCache.get(rule);
      if (!regex) {
        regex = new RegExp(rule.pattern.source, rule.pattern.flags);
        this.compiledPatternCache.set(rule, regex);
      }

      // Reset lastIndex for global regexes to ensure clean state
      regex.lastIndex = 0;

      let match;
      while ((match = regex.exec(text)) !== null) {
        results.push({
          type: rule.name,
          confidence: rule.confidence,
          position: {
            start: match.index,
            end: match.index + match[0].length
          },
          value: match[0]
        });

        if (!rule.pattern.global) break;
      }
    }

    return results.sort((a, b) => b.confidence - a.confidence);
  }

  validateCompliance(data: unknown, standards: string[] = ['gdpr', 'hipaa']): {
    compliant: boolean;
    violations: Array<{
      standard: string;
      field: string;
      issue: string;
    }>;
  } {
    const violations: Array<{
      standard: string;
      field: string;
      issue: string;
    }> = [];
    
    const { detections } = this.detectAndMask(data, 0.5);
    
    for (const detection of detections) {
      for (const standard of standards) {
        switch (standard.toLowerCase()) {
          case 'gdpr':
            if (['email', 'phone', 'ip_address'].includes(detection.type)) {
              violations.push({
                standard: 'GDPR',
                field: detection.field,
                issue: `Personal data (${detection.type}) detected`
              });
            }
            break;
          case 'hipaa':
            if (['ssn', 'date_of_birth', 'email', 'phone'].includes(detection.type)) {
              violations.push({
                standard: 'HIPAA',
                field: detection.field,
                issue: `PHI data (${detection.type}) detected`
              });
            }
            break;
          case 'pci':
            if (detection.type === 'credit_card') {
              violations.push({
                standard: 'PCI DSS',
                field: detection.field,
                issue: 'Credit card data detected'
              });
            }
            break;
        }
      }
    }
    
    return {
      compliant: violations.length === 0,
      violations
    };
  }
}