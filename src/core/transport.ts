import { Writable } from 'stream';
import { TurboSerializer } from './serializer';
import { promises as fs, createWriteStream, createReadStream } from 'fs';
import { resolve, dirname, extname, basename, join, normalize, relative } from 'path';
import * as path from 'path';
import { createGzip } from 'zlib';
import { promisify } from 'util';
import { pipeline as streamPipeline } from 'stream';

export interface LogData {
  level: number;
  levelLabel: string;
  msg?: string;
  time: number;
  hostname?: string;
  pid?: number;
  name?: string;
  err?: {
    message: string;
    stack?: string;
  };
  [key: string]: unknown;
}

export interface TransportOptions {
  level?: string;
  format?: 'json' | 'pretty' | 'compact';
  destination?: NodeJS.WritableStream;
  filter?: (log: LogData) => boolean;
}

export abstract class Transport {
  protected options: TransportOptions;
  protected serializer: TurboSerializer;
  protected active: boolean = true;

  constructor(options: TransportOptions = {}) {
    this.options = options;
    this.serializer = new TurboSerializer({
      zeroAllocation: true,
      stringCache: true
    });
  }

  abstract write(log: LogData): Promise<void>;
  abstract writeBatch(logs: LogData[]): Promise<void>;

  isActive(): boolean {
    return this.active;
  }

  activate(): void {
    this.active = true;
  }

  deactivate(): void {
    this.active = false;
  }

  shouldWrite(log: LogData): boolean {
    if (this.options.filter) {
      return this.options.filter(log);
    }
    return true;
  }

  destroy(): void {
    this.active = false;
  }
}

export class ConsoleTransport extends Transport {
  private stream: NodeJS.WritableStream;

  constructor(options: TransportOptions = {}) {
    super(options);
    this.stream = options.destination || process.stdout;
  }

  async write(log: LogData): Promise<void> {
    if (!this.shouldWrite(log)) return;

    const formatted = this.format(log);
    await this.writeToStream(formatted);
  }

  async writeBatch(logs: LogData[]): Promise<void> {
    const filtered = logs.filter(log => this.shouldWrite(log));
    if (filtered.length === 0) return;

    const formatted = filtered.map(log => this.format(log)).join('\n');
    await this.writeToStream(formatted + '\n');
  }

  private format(log: LogData): string {
    switch (this.options.format) {
      case 'pretty':
        return this.formatPretty(log);
      case 'compact':
        return this.formatCompact(log);
      default:
        return this.serializer.serialize(log).toString();
    }
  }

  private formatPretty(log: LogData): string {
    const { levelLabel, msg, time, err, ...rest } = log;
    const timestamp = new Date(time).toISOString();
    const levelStr = this.getLevelColor(levelLabel);
    
    let output = `[${timestamp}] ${levelStr}`;
    
    if (msg) {
      output += `: ${msg}`;
    }
    
    if (err) {
      output += `\n  Error: ${err.message}`;
      if (err.stack) {
        output += `\n  Stack: ${err.stack}`;
      }
    }
    
    if (Object.keys(rest).length > 0) {
      output += `\n  ${JSON.stringify(rest, null, 2).replace(/\n/g, '\n  ')}`;
    }
    
    return output;
  }

  private formatCompact(log: LogData): string {
    const { levelLabel, msg, time, ...rest } = log;
    const timestamp = new Date(time).toISOString();
    
    let output = `${timestamp} ${levelLabel.toUpperCase()}`;
    
    if (msg) {
      output += ` ${msg}`;
    }
    
    if (Object.keys(rest).length > 0) {
      output += ` ${JSON.stringify(rest)}`;
    }
    
    return output;
  }

  private getLevelColor(level: string): string {
    const colors = {
      trace: '\x1b[90m',
      debug: '\x1b[36m',
      info: '\x1b[32m',
      warn: '\x1b[33m',
      error: '\x1b[31m',
      fatal: '\x1b[35m'
    };
    
    const color = colors[level as keyof typeof colors] || '';
    const reset = '\x1b[0m';
    
    const isTTY = (this.stream as unknown as { isTTY?: boolean }).isTTY;
    return isTTY ? `${color}${level.toUpperCase()}${reset}` : level.toUpperCase();
  }

  private writeToStream(data: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream.write(data)) {
        this.stream.once('drain', resolve);
      } else {
        resolve();
      }
    });
  }
}

export class FileTransport extends Transport {
  private stream: Writable;
  private path: string;
  private rotation?: {
    size?: number;
    keep?: number;
    compress?: boolean;
  };
  private currentSize: number = 0;
  private fileIndex: number = 0;

  constructor(options: TransportOptions & { 
    path: string; 
    rotation?: { size?: number; keep?: number; compress?: boolean } 
  }) {
    super(options);
    this.path = this.sanitizePath(options.path);
    this.rotation = options.rotation;
    this.stream = this.createStream();
  }

  private sanitizePath(filePath: string): string {
    // FIX BUG-002: Enhanced path traversal protection
    // Check for null byte first (before any processing)
    if (filePath.includes('\0')) {
      throw new Error('Null byte detected in file path');
    }

    // Check for Windows UNC paths and device paths
    if (process.platform === 'win32') {
      if (filePath.startsWith('\\\\?\\') || filePath.startsWith('\\\\.\\')) {
        throw new Error('Windows device paths and UNC paths are not allowed');
      }
      if (filePath.startsWith('\\\\')) {
        throw new Error('UNC paths are not allowed');
      }
    }

    // Normalize and resolve to absolute path
    const normalized = normalize(filePath);
    const resolved = resolve(normalized);

    // Define allowed base directories
    const allowedDirs = [
      resolve(process.cwd()),
      resolve('/tmp'),
      resolve('/var/log'),
      resolve(process.platform === 'win32' ? process.env.TEMP || 'C:\\temp' : '/tmp')
    ];

    // Check if resolved path is within allowed directories using strict validation
    let isAllowed = false;
    for (const allowedDir of allowedDirs) {
      // Use resolve to ensure both paths are absolute and normalized
      const normalizedAllowedDir = resolve(allowedDir);
      const normalizedResolved = resolve(resolved);

      // Check if resolved path starts with allowed directory
      // This prevents bypasses via symlinks or ".." sequences
      if (normalizedResolved.startsWith(normalizedAllowedDir + path.sep) ||
          normalizedResolved === normalizedAllowedDir) {
        // Additional validation: ensure no ".." in the relative path
        const relativePath = relative(normalizedAllowedDir, normalizedResolved);
        if (!relativePath.includes('..') && !path.isAbsolute(relativePath)) {
          isAllowed = true;
          break;
        }
      }
    }

    if (!isAllowed) {
      throw new Error(`Path outside allowed directories: ${resolved}`);
    }

    // Additional security checks
    // Check for invalid path characters
    if (/[<>:"|?*]/.test(normalized)) {
      throw new Error('Invalid characters in file path');
    }

    // Validate file extension if specified
    const allowedExtensions = ['.log', '.txt', '.json'];
    const ext = extname(resolved);
    if (ext && !allowedExtensions.includes(ext)) {
      throw new Error(`Invalid file extension: ${ext}. Allowed: ${allowedExtensions.join(', ')}`);
    }

    return resolved;
  }

  private createStream(): Writable {
    return createWriteStream(this.path, { flags: 'a' });
  }

  async write(log: LogData): Promise<void> {
    if (!this.shouldWrite(log)) return;

    const serialized = this.serializer.serialize(log);
    const data = (typeof serialized === 'string' ? serialized : serialized.toString()) + '\n';
    await this.writeToFile(data);
  }

  async writeBatch(logs: LogData[]): Promise<void> {
    const filtered = logs.filter(log => this.shouldWrite(log));
    if (filtered.length === 0) return;

    const data = filtered
      .map(log => this.serializer.serialize(log))
      .join('\n') + '\n';
    
    await this.writeToFile(data);
  }

  private async writeToFile(data: string | Buffer): Promise<void> {
    const size = Buffer.byteLength(data);
    
    if (this.rotation && this.rotation.size && this.currentSize + size > this.rotation.size) {
      await this.rotate();
    }
    
    return new Promise((resolve, reject) => {
      this.stream.write(data, (err) => {
        if (err) reject(err);
        else {
          this.currentSize += size;
          resolve();
        }
      });
    });
  }

  private async rotate(): Promise<void> {
    this.stream.end();
    
    const dir = dirname(this.path);
    const ext = extname(this.path);
    const baseName = basename(this.path, ext);
    
    this.fileIndex++;
    const newPath = join(dir, `${baseName}.${this.fileIndex}${ext}`);
    
    await fs.rename(this.path, newPath);
    
    if (this.rotation?.compress) {
      await this.compressFile(newPath);
    }
    
    if (this.rotation?.keep && this.fileIndex > this.rotation.keep) {
      await this.cleanOldFiles();
    }
    
    this.stream = this.createStream();
    this.currentSize = 0;
  }

  private async compressFile(filePath: string): Promise<void> {
    const pipeline = promisify(streamPipeline);
    
    await pipeline(
      createReadStream(filePath),
      createGzip(),
      createWriteStream(`${filePath}.gz`)
    );
    
    await fs.unlink(filePath);
  }

  private async cleanOldFiles(): Promise<void> {
    const dir = dirname(this.path);
    const ext = extname(this.path);
    const baseName = basename(this.path, ext);
    
    const oldIndex = this.fileIndex - (this.rotation?.keep || 0);
    const oldPath = join(dir, `${baseName}.${oldIndex}${ext}`);
    const oldGzPath = `${oldPath}.gz`;
    
    try {
      await fs.unlink(oldPath);
    } catch (err) {
      // File may not exist, ignore error
    }
    
    try {
      await fs.unlink(oldGzPath);
    } catch (err) {
      // File may not exist, ignore error
    }
  }

  destroy(): void {
    super.destroy();
    // FIX BUG-011: Properly close stream to prevent file handle leak
    // Use destroy() instead of end() for immediate cleanup
    // This ensures file handles are released promptly
    if (this.stream && !this.stream.destroyed) {
      this.stream.destroy();
    }
  }
}