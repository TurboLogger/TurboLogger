/**
 * File transport for TurboLogger
 * Supports rotation, compression, and async writing
 */

import { createWriteStream, WriteStream, existsSync, mkdirSync, statSync } from 'fs';
import { dirname, join, extname, basename } from 'path';
import { SimpleTransport, SimpleLogEntry } from './simple-logger';

export interface FileTransportConfig {
  filename: string;
  maxSize?: number; // Max file size in bytes (default: 10MB)
  maxFiles?: number; // Max number of rotated files (default: 5)
  enableRotation?: boolean; // Enable file rotation (default: true)
  autoFlush?: boolean; // Auto flush after each write (default: false)
  flushInterval?: number; // Flush interval in ms (default: 1000)
  createDirectory?: boolean; // Create directory if it doesn't exist (default: true)
  format?: 'json' | 'text'; // Output format (default: 'json')
}

export class FileTransport implements SimpleTransport {
  name = 'file';
  private config: Required<FileTransportConfig>;
  private stream: WriteStream | null = null;
  private currentSize = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private writeQueue: string[] = [];
  private isClosing = false;

  constructor(config: FileTransportConfig) {
    this.config = {
      maxSize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      enableRotation: true,
      autoFlush: false,
      flushInterval: 1000,
      createDirectory: true,
      format: 'json',
      ...config
    };

    this.initializeStream();
    this.setupFlushTimer();
  }

  private initializeStream(): void {
    try {
      // Create directory if needed
      if (this.config.createDirectory) {
        const dir = dirname(this.config.filename);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }

      // Get current file size if exists
      if (existsSync(this.config.filename)) {
        this.currentSize = statSync(this.config.filename).size;
      } else {
        this.currentSize = 0;
      }

      // Create write stream
      this.stream = createWriteStream(this.config.filename, { 
        flags: 'a', 
        encoding: 'utf8' 
      });

      this.stream.on('error', (error) => {
        console.error(`FileTransport error: ${error.message}`);
      });

    } catch (error) {
      console.error(`Failed to initialize FileTransport: ${(error as Error).message}`);
    }
  }

  private setupFlushTimer(): void {
    if (!this.config.autoFlush && this.config.flushInterval > 0) {
      this.flushTimer = setInterval(() => {
        this.flush();
      }, this.config.flushInterval);
    }
  }

  private formatEntry(entry: SimpleLogEntry): string {
    if (this.config.format === 'text') {
      const timestamp = entry.timestamp || new Date().toISOString();
      const level = entry.level.toUpperCase().padEnd(5);
      const message = entry.message;
      const context = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
      const metadata = entry.metadata ? ` [${JSON.stringify(entry.metadata)}]` : '';
      
      return `${timestamp} ${level} ${message}${context}${metadata}\n`;
    } else {
      return JSON.stringify(entry) + '\n';
    }
  }

  private async rotateFile(): Promise<void> {
    if (!this.config.enableRotation || !this.stream) {
      return;
    }

    try {
      // Close current stream
      await new Promise<void>((resolve) => {
        this.stream!.end(() => resolve());
      });

      // Rotate files
      for (let i = this.config.maxFiles - 1; i >= 1; i--) {
        const oldFile = this.getRotatedFilename(i);
        const newFile = this.getRotatedFilename(i + 1);
        
        if (existsSync(oldFile)) {
          const fs = require('fs').promises;
          if (i === this.config.maxFiles - 1) {
            // Delete the oldest file
            await fs.unlink(oldFile);
          } else {
            // Rename to next number
            await fs.rename(oldFile, newFile);
          }
        }
      }

      // Move current file to .1
      const fs = require('fs').promises;
      if (existsSync(this.config.filename)) {
        await fs.rename(this.config.filename, this.getRotatedFilename(1));
      }

      // Reinitialize stream
      this.currentSize = 0;
      this.initializeStream();

    } catch (error) {
      console.error(`File rotation failed: ${(error as Error).message}`);
      // Try to reinitialize stream anyway
      this.initializeStream();
    }
  }

  private getRotatedFilename(index: number): string {
    const ext = extname(this.config.filename);
    const base = basename(this.config.filename, ext);
    const dir = dirname(this.config.filename);
    return join(dir, `${base}.${index}${ext}`);
  }

  private async checkRotation(): Promise<void> {
    if (this.config.enableRotation && this.currentSize >= this.config.maxSize) {
      await this.rotateFile();
    }
  }

  write(entry: SimpleLogEntry): void {
    if (this.isClosing || !this.stream) {
      return;
    }

    const formattedEntry = this.formatEntry(entry);
    this.writeQueue.push(formattedEntry);
    this.currentSize += Buffer.byteLength(formattedEntry, 'utf8');

    if (this.config.autoFlush) {
      this.flush();
    }

    // Check if rotation is needed (async, don't block)
    this.checkRotation().catch(error => {
      console.error(`Rotation check failed: ${error.message}`);
    });
  }

  private flush(): void {
    if (!this.stream || this.writeQueue.length === 0) {
      return;
    }

    try {
      const content = this.writeQueue.join('');
      this.writeQueue = [];
      
      this.stream.write(content);
    } catch (error) {
      console.error(`Failed to flush to file: ${(error as Error).message}`);
    }
  }

  async destroy(): Promise<void> {
    this.isClosing = true;

    // Clear flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Final flush
    this.flush();

    // Close stream
    if (this.stream) {
      await new Promise<void>((resolve) => {
        this.stream!.end(() => resolve());
      });
      this.stream = null;
    }
  }

  // Utility methods
  getCurrentSize(): number {
    return this.currentSize;
  }

  getConfig(): Required<FileTransportConfig> {
    return { ...this.config };
  }

  forceRotate(): Promise<void> {
    return this.rotateFile();
  }

  forceFlush(): void {
    this.flush();
  }
}
