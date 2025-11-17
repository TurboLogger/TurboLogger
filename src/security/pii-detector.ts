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
    // FIX BUG-001: ReDoS protection - safer regex patterns with bounded quantifiers
    // All patterns now have explicit length limits to prevent catastrophic backtracking
    const defaultRules: PIIRule[] = [
      {
        name: 'email',
        // Safer email pattern with bounded quantifiers (max 64 chars for local, 255 for domain)
        pattern: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Z|a-z]{2,10}\b/g,
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
        // Already safe - exact length match
        pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
        mask: 'XXX-XX-****',
        confidence: 0.9,
        description: 'Social Security Number'
      },
      {
        name: 'credit_card',
        // Safer credit card pattern - explicit repetition instead of nested quantifiers
        pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
        mask: '**** **** **** ****',
        confidence: 0.85,
        description: 'Credit card number'
      },
      {
        name: 'phone',
        // Safer phone pattern - simplified to avoid complex backtracking
        pattern: /\b(?:\+?1[-.\s]?)?(?:\([0-9]{3}\)|[0-9]{3})[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g,
        mask: '(***) ***-****',
        confidence: 0.8,
        description: 'Phone number'
      },
      {
        name: 'ip_address',
        // Already safe - bounded repetition
        pattern: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g,
        mask: 'XXX.XXX.XXX.XXX',
        confidence: 0.7,
        description: 'IP address'
      },
      {
        name: 'mac_address',
        // Already safe - exact length match
        pattern: /\b([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})\b/g,
        mask: 'XX:XX:XX:XX:XX:XX',
        confidence: 0.9,
        description: 'MAC address'
      },
      {
        name: 'date_of_birth',
        // Already safe - exact length match
        pattern: /\b(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12][0-9]|3[01])\/(?:19|20)\d{2}\b/g,
        mask: 'MM/DD/YYYY',
        confidence: 0.75,
        description: 'Date of birth (MM/DD/YYYY)'
      },
      {
        name: 'api_key',
        // FIX BUG-001: Bounded API key length to prevent ReDoS (32-128 chars)
        pattern: /\b[A-Za-z0-9]{32,128}\b/g,
        mask: '[REDACTED_API_KEY]',
        confidence: 0.6,
        description: 'API key or token'
      },
      {
        name: 'password',
        // FIX BUG-001: Safer password pattern with bounded quantifiers
        pattern: /\b(?:password|passwd|pwd)["']?[\s]{0,5}[:=][\s]{0,5}["']?([^\s"',;]{1,128})/gi,
        mask: '[REDACTED_PASSWORD]',
        confidence: 0.9,
        description: 'Password field'
      },
      {
        name: 'aws_key',
        // Already safe - exact length match
        pattern: /AKIA[0-9A-Z]{16}/g,
        mask: '[REDACTED_AWS_KEY]',
        confidence: 0.95,
        description: 'AWS Access Key'
      },
      {
        name: 'jwt_token',
        // FIX BUG-001: Bounded JWT token parts to prevent ReDoS (max 2048 chars per part)
        pattern: /eyJ[A-Za-z0-9_-]{1,2048}\.eyJ[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,2048}/g,
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
    // BUG-044 FIX: Early return for empty strings to avoid unnecessary processing
    if (text.length === 0) {
      return text;
    }

    // FIX BUG-001: Additional ReDoS protection - skip extremely long strings
    // Strings longer than 100KB are unlikely to need PII detection and could cause ReDoS
    const MAX_STRING_LENGTH = 100000; // 100KB
    if (text.length > MAX_STRING_LENGTH) {
      console.warn(`[PII Detector] Skipping string longer than ${MAX_STRING_LENGTH} chars to prevent ReDoS`);
      return '[REDACTED_OVERSIZED_CONTENT]';
    }

    // NEW-BUG-008 FIX: Collect all matches with positions first to avoid overlapping replacements
    // Multiple PII rules on the same string can cause index misalignment if applied sequentially
    // Solution: Find all matches, sort by position (descending), apply non-overlapping
    interface MatchInfo {
      start: number;
      end: number;
      original: string;
      masked: string;
      rule: { name: string; confidence: number };
    }

    const allMatches: MatchInfo[] = [];
    const allRules = [...this.rules, ...this.customPatterns.values()];

    // Collect all matches from all rules
    for (const rule of allRules) {
      if (rule.confidence >= confidenceThreshold) {
        // Use exec to get index information
        const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
        let match: RegExpExecArray | null;

        while ((match = regex.exec(text)) !== null) {
          const masked = typeof rule.mask === 'function'
            ? rule.mask(match[0])
            : rule.mask;

          allMatches.push({
            start: match.index,
            end: match.index + match[0].length,
            original: match[0],
            masked,
            rule: { name: rule.name, confidence: rule.confidence }
          });

          // Prevent infinite loop on zero-width matches
          if (match.index === regex.lastIndex) {
            regex.lastIndex++;
          }
        }
      }
    }

    // Sort matches by position (descending) to apply from end to start
    // This preserves indices as we replace
    allMatches.sort((a, b) => b.start - a.start);

    // Remove overlapping matches - keep the first one (highest confidence/earliest)
    const nonOverlapping: MatchInfo[] = [];
    for (const current of allMatches) {
      const overlaps = nonOverlapping.some(
        existing => current.start < existing.end && current.end > existing.start
      );
      if (!overlaps) {
        nonOverlapping.push(current);
      }
    }

    // Apply replacements from end to start to preserve indices
    let result = text;
    for (const match of nonOverlapping) {
      result = result.substring(0, match.start) + match.masked + result.substring(match.end);

      detections.push({
        field: path,
        type: match.rule.name,
        confidence: match.rule.confidence,
        original: match.original,
        masked: match.masked
      });
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