/**
 * Security utilities for TurboLogger
 * Provides input validation, sanitization, and protection against common attacks
 */

import { resolve, extname, normalize } from 'path';

export interface SecurityOptions {
  maxStringLength?: number;
  maxObjectDepth?: number;
  maxArrayLength?: number;
  allowedFileExtensions?: string[];
  enablePathTraversalProtection?: boolean;
  enablePrototypePollutionProtection?: boolean;
}

export class SecurityValidator {
  private readonly maxStringLength: number;
  private readonly maxObjectDepth: number;
  private readonly maxArrayLength: number;
  private readonly allowedFileExtensions: string[];
  private readonly enablePathTraversalProtection: boolean;
  private readonly enablePrototypePollutionProtection: boolean;

  constructor(options: SecurityOptions = {}) {
    this.maxStringLength = options.maxStringLength ?? 10000;
    this.maxObjectDepth = options.maxObjectDepth ?? 10;
    this.maxArrayLength = options.maxArrayLength ?? 1000;
    this.allowedFileExtensions = options.allowedFileExtensions ?? ['.log', '.txt', '.json'];
    this.enablePathTraversalProtection = options.enablePathTraversalProtection ?? true;
    this.enablePrototypePollutionProtection = options.enablePrototypePollutionProtection ?? true;
  }

  /**
   * Validates and sanitizes a file path to prevent directory traversal
   */
  validateFilePath(filePath: string): string {
    if (!this.enablePathTraversalProtection) {
      return filePath;
    }

    if (typeof filePath !== 'string') {
      throw new Error('File path must be a string');
    }

    if (filePath.length === 0) {
      throw new Error('File path cannot be empty');
    }

    if (filePath.length > this.maxStringLength) {
      throw new Error(`File path too long (max ${this.maxStringLength} characters)`);
    }

    // Resolve to absolute path
    const resolved = resolve(filePath);
    
    // Check for path traversal attempts
    const normalized = normalize(filePath);
    if (normalized.includes('..') || normalized.includes('~') || resolved.includes('..')) {
      throw new Error('Path traversal detected in file path');
    }

    // Validate file extension
    const ext = extname(resolved);
    if (ext && !this.allowedFileExtensions.includes(ext)) {
      throw new Error(`Invalid file extension: ${ext}. Allowed: ${this.allowedFileExtensions.join(', ')}`);
    }

    // Check for dangerous characters
    const dangerousChars = /[<>"|*?]/;
    if (dangerousChars.test(resolved)) {
      throw new Error('File path contains dangerous characters');
    }

    return resolved;
  }

  /**
   * Validates object for prototype pollution attacks
   */
  validateObject(obj: unknown, depth = 0): boolean {
    if (!this.enablePrototypePollutionProtection) {
      return true;
    }

    if (depth > this.maxObjectDepth) {
      throw new Error(`Object depth exceeds maximum (${this.maxObjectDepth})`);
    }

    if (obj === null || typeof obj !== 'object') {
      return true;
    }

    if (Array.isArray(obj)) {
      if (obj.length > this.maxArrayLength) {
        throw new Error(`Array length exceeds maximum (${this.maxArrayLength})`);
      }
      
      for (const item of obj) {
        this.validateObject(item, depth + 1);
      }
      return true;
    }

    const keys = Object.getOwnPropertyNames(obj);
    for (const key of keys) {
      // Check for dangerous property names
      if (this.isDangerousKey(key)) {
        throw new Error(`Dangerous property name detected: ${key}`);
      }

      try {
        const value = (obj as Record<string, unknown>)[key];
        this.validateObject(value, depth + 1);
      } catch (err) {
        // Skip properties that throw on access
        continue;
      }
    }

    return true;
  }

  /**
   * Validates string input for length and dangerous content
   */
  validateString(str: string): boolean {
    if (typeof str !== 'string') {
      return false;
    }

    if (str.length > this.maxStringLength) {
      throw new Error(`String length exceeds maximum (${this.maxStringLength})`);
    }

    // Check for potential script injection
    const scriptPatterns = [
      /<script[^>]*>/i,
      /javascript:/i,
      /on\w+\s*=/i,
      /data:text\/html/i
    ];

    for (const pattern of scriptPatterns) {
      if (pattern.test(str)) {
        throw new Error('Potential script injection detected in string');
      }
    }

    return true;
  }

  /**
   * Sanitizes log data to remove dangerous content
   */
  sanitizeLogData(data: unknown): unknown {
    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data === 'string') {
      this.validateString(data);
      return this.sanitizeString(data);
    }

    if (typeof data === 'number' || typeof data === 'boolean') {
      return data;
    }

    if (Array.isArray(data)) {
      if (data.length > this.maxArrayLength) {
        throw new Error(`Array too large (${data.length} > ${this.maxArrayLength})`);
      }
      return data.map(item => this.sanitizeLogData(item));
    }

    if (typeof data === 'object') {
      this.validateObject(data);
      const sanitized: Record<string, unknown> = {};
      
      const keys = Object.getOwnPropertyNames(data);
      for (const key of keys) {
        if (!this.isDangerousKey(key)) {
          try {
            const value = (data as Record<string, unknown>)[key];
            sanitized[key] = this.sanitizeLogData(value);
          } catch (err) {
            // Skip properties that can't be accessed
            sanitized[key] = '[Inaccessible Property]';
          }
        }
      }
      
      return sanitized;
    }

    return String(data);
  }

  /**
   * Rate limiting based on source
   */
  private rateLimiters = new Map<string, { count: number; resetTime: number }>();

  checkRateLimit(source: string, maxRequests = 1000, windowMs = 60000): boolean {
    const now = Date.now();
    const limiter = this.rateLimiters.get(source);

    if (!limiter || now > limiter.resetTime) {
      this.rateLimiters.set(source, { count: 1, resetTime: now + windowMs });
      return true;
    }

    if (limiter.count >= maxRequests) {
      return false;
    }

    limiter.count++;
    return true;
  }

  /**
   * Clean up rate limiters periodically
   */
  cleanupRateLimiters(): void {
    const now = Date.now();
    for (const [source, limiter] of this.rateLimiters.entries()) {
      if (now > limiter.resetTime) {
        this.rateLimiters.delete(source);
      }
    }
  }

  private isDangerousKey(key: string): boolean {
    const dangerousKeys = [
      '__proto__',
      'constructor',
      'prototype',
      '__defineGetter__',
      '__defineSetter__',
      '__lookupGetter__',
      '__lookupSetter__',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toString',
      'valueOf'
    ];

    return dangerousKeys.includes(key) || key.startsWith('__');
  }

  private sanitizeString(str: string): string {
    return str
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  }
}

export const defaultSecurityValidator = new SecurityValidator();