import * as crypto from 'crypto';
const { createHash, createHmac, randomBytes, createSign, createVerify, createCipheriv, createDecipheriv, generateKeyPairSync } = crypto;

export interface EncryptionOptions {
  algorithm: string;
  key: string | Buffer;
  iv?: string | Buffer;
}

export interface SigningOptions {
  algorithm: string;
  privateKey: string | Buffer;
  publicKey?: string | Buffer;
}

export class LogEncryption {
  private algorithm: string;
  private key: Buffer;
  private iv?: Buffer;

  constructor(options: EncryptionOptions) {
    this.algorithm = options.algorithm;
    this.key = typeof options.key === 'string' ? Buffer.from(options.key, 'hex') : options.key;
    this.iv = options.iv ? (typeof options.iv === 'string' ? Buffer.from(options.iv, 'hex') : options.iv) : undefined;
  }

  encrypt(data: string | Buffer): { encrypted: string; iv?: string } {
    try {
      const input = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      
      if (this.algorithm.includes('gcm')) {
        return this.encryptGCM(input);
      } else if (this.algorithm.includes('cbc') || this.algorithm.includes('ctr')) {
        return this.encryptWithIV(input);
      } else {
        // Use secure IV-based encryption for all algorithms
        const iv = randomBytes(16); // Standard 128-bit IV
        const cipher = createCipheriv(this.algorithm, this.key, iv);
        let encrypted = cipher.update(input, undefined, 'hex');
        encrypted += cipher.final('hex');
        return { encrypted, iv: iv.toString('hex') };
      }
    } catch (error) {
      throw new Error(`Encryption failed: ${error}`);
    }
  }

  private encryptGCM(data: Buffer): { encrypted: string; iv: string; tag: string } {
    const iv = this.iv || randomBytes(12);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
    
    // Type-safe check for GCM cipher methods
    if (!('getAuthTag' in cipher) || typeof cipher.getAuthTag !== 'function') {
      throw new Error(`Algorithm ${this.algorithm} is not a GCM cipher`);
    }
    
    let encrypted = cipher.update(data, undefined, 'hex');
    encrypted += cipher.final('hex');
    const tag = (cipher as crypto.CipherGCM).getAuthTag();
    
    return {
      encrypted,
      iv: iv.toString('hex'),
      tag: tag.toString('hex')
    };
  }

  private encryptWithIV(data: Buffer): { encrypted: string; iv: string } {
    const iv = this.iv || randomBytes(16);
    const cipher = createCipheriv(this.algorithm, this.key, iv);
    
    let encrypted = cipher.update(data, undefined, 'hex');
    encrypted += cipher.final('hex');
    
    return {
      encrypted,
      iv: iv.toString('hex')
    };
  }

  decrypt(encryptedData: string, iv?: string, tag?: string): string {
    try {
      if (this.algorithm.includes('gcm') && tag) {
        return this.decryptGCM(encryptedData, iv!, tag);
      } else if (iv) {
        return this.decryptWithIV(encryptedData, iv);
      } else {
        // Require IV for secure decryption
        if (!iv) {
          throw new Error('IV is required for secure decryption');
        }
        const decipher = createDecipheriv(this.algorithm, this.key, Buffer.from(iv, 'hex'));
        let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      }
    } catch (error) {
      throw new Error(`Decryption failed: ${error}`);
    }
  }

  private decryptGCM(encrypted: string, iv: string, tag: string): string {
    const decipher = crypto.createDecipheriv(this.algorithm, this.key, Buffer.from(iv, 'hex'));
    
    // Type-safe check for GCM decipher methods
    if (!('setAuthTag' in decipher) || typeof decipher.setAuthTag !== 'function') {
      throw new Error(`Algorithm ${this.algorithm} is not a GCM cipher`);
    }
    
    (decipher as crypto.DecipherGCM).setAuthTag(Buffer.from(tag, 'hex'));
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  private decryptWithIV(encrypted: string, iv: string): string {
    const decipher = createDecipheriv(this.algorithm, this.key, Buffer.from(iv, 'hex'));
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  static generateKey(algorithm: string): Buffer {
    const keyLengths: Record<string, number> = {
      'aes-128-gcm': 16,
      'aes-192-gcm': 24,
      'aes-256-gcm': 32,
      'aes-128-cbc': 16,
      'aes-192-cbc': 24,
      'aes-256-cbc': 32
    };
    
    const length = keyLengths[algorithm] || 32;
    return randomBytes(length);
  }
}

export class LogSigner {
  private algorithm: string;
  private privateKey: string | Buffer;
  private publicKey?: string | Buffer;

  constructor(options: SigningOptions) {
    this.algorithm = options.algorithm;
    this.privateKey = options.privateKey;
    this.publicKey = options.publicKey;
  }

  sign(data: string | Buffer): string {
    try {
      const input = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      
      if (this.algorithm.startsWith('RS') || this.algorithm.startsWith('ES')) {
        // RSA or ECDSA signing
        const sign = createSign(this.algorithm);
        sign.update(input);
        return sign.sign(this.privateKey, 'hex');
      } else {
        // HMAC signing
        const hmac = createHmac(this.algorithm, this.privateKey);
        hmac.update(input);
        return hmac.digest('hex');
      }
    } catch (error) {
      throw new Error(`Signing failed: ${error}`);
    }
  }

  verify(data: string | Buffer, signature: string): boolean {
    try {
      const input = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      
      if (this.algorithm.startsWith('RS') || this.algorithm.startsWith('ES')) {
        if (!this.publicKey) {
          throw new Error('Public key required for verification');
        }
        const verify = createVerify(this.algorithm);
        verify.update(input);
        return verify.verify(this.publicKey, signature, 'hex');
      } else {
        // HMAC verification
        const expectedSignature = this.sign(input);
        return this.constantTimeCompare(signature, expectedSignature);
      }
    } catch (error) {
      return false;
    }
  }

  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    
    return result === 0;
  }

  static generateKeyPair(algorithm: string = 'rsa'): { privateKey: string; publicKey: string } {
    if (algorithm === 'rsa') {
      const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      });
      return { privateKey, publicKey };
    } else {
      const { privateKey, publicKey } = generateKeyPairSync('ec', {
        namedCurve: 'secp256k1',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      });
      return { privateKey, publicKey };
    }
  }
}

export class SecureLogProcessor {
  private encryption?: LogEncryption;
  private signer?: LogSigner;
  private hashSalt: Buffer;

  constructor(
    encryptionOptions?: EncryptionOptions,
    signingOptions?: SigningOptions
  ) {
    if (encryptionOptions) {
      this.encryption = new LogEncryption(encryptionOptions);
    }
    
    if (signingOptions) {
      this.signer = new LogSigner(signingOptions);
    }
    
    this.hashSalt = randomBytes(32);
  }

  processLog(logData: Record<string, unknown>): {
    data: string;
    signature?: string;
    encrypted: boolean;
    hash: string;
    timestamp: number;
  } {
    let data = typeof logData === 'string' ? logData : JSON.stringify(logData);
    const timestamp = Date.now();
    
    // Add integrity hash
    const hash = this.createHash(data + timestamp);
    
    // Encrypt if configured
    let encrypted = false;
    if (this.encryption) {
      const result = this.encryption.encrypt(data);
      data = JSON.stringify(result);
      encrypted = true;
    }
    
    // Sign if configured
    let signature: string | undefined;
    if (this.signer) {
      signature = this.signer.sign(data + hash + timestamp);
    }
    
    return {
      data,
      signature,
      encrypted,
      hash,
      timestamp
    };
  }

  verifyLog(logEntry: {
    data: string;
    signature?: string;
    encrypted: boolean;
    hash: string;
    timestamp: number;
  }): { valid: boolean; decrypted?: Record<string, unknown> } {
    try {
      // Verify signature if present
      if (logEntry.signature && this.signer) {
        const signatureValid = this.signer.verify(
          logEntry.data + logEntry.hash + logEntry.timestamp,
          logEntry.signature
        );
        
        if (!signatureValid) {
          return { valid: false };
        }
      }
      
      // Decrypt if encrypted
      let data = logEntry.data;
      if (logEntry.encrypted && this.encryption) {
        const encryptedObj = JSON.parse(logEntry.data);
        data = this.encryption.decrypt(
          encryptedObj.encrypted,
          encryptedObj.iv,
          encryptedObj.tag
        );
      }
      
      // Verify integrity hash
      const expectedHash = this.createHash(data + logEntry.timestamp);
      if (expectedHash !== logEntry.hash) {
        return { valid: false };
      }
      
      return {
        valid: true,
        decrypted: logEntry.encrypted ? JSON.parse(data) : data
      };
    } catch (error) {
      return { valid: false };
    }
  }

  private createHash(data: string): string {
    return createHash('sha256')
      .update(data)
      .update(this.hashSalt)
      .digest('hex');
  }

  rotate(newEncryptionOptions?: EncryptionOptions, newSigningOptions?: SigningOptions): void {
    if (newEncryptionOptions) {
      this.encryption = new LogEncryption(newEncryptionOptions);
    }
    
    if (newSigningOptions) {
      this.signer = new LogSigner(newSigningOptions);
    }
    
    this.hashSalt = randomBytes(32);
  }
}