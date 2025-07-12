import { EventEmitter } from 'events';
import { createServer, Server } from 'http';
import { createHash } from 'crypto';
import type { WebSocketServer as WSServer, WebSocket as WS } from 'ws';
import type { IncomingMessage } from 'http';

type WebSocket = WS;
type WebSocketServer = WSServer;

// Type definitions for log and metrics data
export interface LogData {
  level?: string;
  msg?: string;
  message?: string;
  time?: number;
  service?: string;
  [key: string]: unknown;
}

export interface MetricsData {
  server: {
    uptime: number;
    memory: NodeJS.MemoryUsage;
    cpu: NodeJS.CpuUsage;
  };
  streaming: {
    connectedClients: number;
    totalLogsSent: number;
    bufferSize: number;
    averageSessionDuration: number;
  };
  rateLimit: {
    activeRateLimits: number;
    maxConnectionsReached: boolean;
  };
}

export interface ErrorData {
  message: string;
  [key: string]: unknown;
}

export interface HeartbeatData {
  status: string;
  [key: string]: unknown;
}

export interface ClientMessage {
  type: string;
  filters?: RealtimeOptions['filters'];
  [key: string]: unknown;
}

export interface RealtimeOptions {
  port: number;
  path: string;
  auth?: {
    type: 'bearer' | 'basic' | 'custom';
    token?: string;
    username?: string;
    password?: string;
    validator?: (req: IncomingMessage) => boolean;
  };
  filters?: {
    levels?: string[];
    services?: string[];
    minTimestamp?: number;
  };
  rateLimit?: {
    maxConnections: number;
    maxLogsPerSecond: number;
  };
  compression?: boolean;
  enableMetrics?: boolean;
}

export interface LogStreamMessage {
  type: 'log' | 'metrics' | 'error' | 'heartbeat';
  timestamp: number;
  data: LogData | MetricsData | ErrorData | HeartbeatData;
  id: string;
}

export interface ClientSession {
  id: string;
  ws: WebSocket;
  connectedAt: number;
  filters: RealtimeOptions['filters'];
  lastActivity: number;
  logCount: number;
  isAuthenticated: boolean;
}

export class RealtimeLogStreamer extends EventEmitter {
  private server?: Server;
  private wss?: WebSocketServer;
  private options: RealtimeOptions;
  private clients: Map<string, ClientSession> = new Map();
  private logBuffer: LogStreamMessage[] = [];
  private bufferMaxSize: number = 1000;
  private metricsInterval?: NodeJS.Timeout;
  private rateLimitMap: Map<string, number[]> = new Map();

  constructor(options: RealtimeOptions) {
    super();
    this.options = {
      compression: true,
      enableMetrics: true,
      rateLimit: {
        maxConnections: 100,
        maxLogsPerSecond: 1000
      },
      ...options
    };
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = createServer();
        
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { WebSocketServer: WSSImpl } = require('ws') as { WebSocketServer: new (options: { server: Server; path: string; perMessageDeflate: boolean }) => WebSocketServer };
        this.wss = new WSSImpl({
          server: this.server,
          path: this.options.path,
          perMessageDeflate: this.options.compression ?? true
        });

        this.setupWebSocketHandlers();
        
        if (this.options.enableMetrics) {
          this.startMetricsCollection();
        }

        this.server.listen(this.options.port, () => {
          // Server started successfully
          this.emit('started', { port: this.options.port, path: this.options.path });
          resolve();
        });

        this.server.on('error', reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.metricsInterval) {
        clearInterval(this.metricsInterval);
      }

      // Close all client connections
      for (const client of this.clients.values()) {
        client.ws.close(1000, 'Server shutting down');
      }
      this.clients.clear();

      if (this.wss) {
        this.wss.close(() => {
          if (this.server) {
            this.server.close(() => {
              this.emit('stopped');
              resolve();
            });
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  private setupWebSocketHandlers(): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const clientId = this.generateClientId();
      
      // Check connection limit
      if (this.options.rateLimit && this.clients.size >= this.options.rateLimit.maxConnections) {
        ws.close(1008, 'Too many connections');
        return;
      }

      // Authenticate if required
      if (this.options.auth && !this.authenticateClient(req)) {
        ws.close(1008, 'Authentication failed');
        return;
      }

      const session: ClientSession = {
        id: clientId,
        ws,
        connectedAt: Date.now(),
        filters: this.options.filters || {},
        lastActivity: Date.now(),
        logCount: 0,
        isAuthenticated: !this.options.auth || this.authenticateClient(req)
      };

      this.clients.set(clientId, session);
      
      this.emit('clientConnected', {
        clientId,
        connectedAt: session.connectedAt,
        clientCount: this.clients.size
      });

      // Send buffered logs to new client
      this.sendBufferedLogs(session);

      // Handle client messages
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const message = JSON.parse(String(data));
          this.handleClientMessage(session, message as ClientMessage);
        } catch (error) {
          this.sendToClient(session, {
            type: 'error',
            timestamp: Date.now(),
            data: { message: 'Invalid JSON message' },
            id: this.generateMessageId()
          });
        }
      });

      // Handle client disconnect
      ws.on('close', () => {
        this.clients.delete(clientId);
        this.rateLimitMap.delete(clientId);
        
        this.emit('clientDisconnected', {
          clientId,
          duration: Date.now() - session.connectedAt,
          logsSent: session.logCount,
          clientCount: this.clients.size
        });
      });

      // Handle errors
      ws.on('error', (error: Error) => {
        console.error(`WebSocket error for client ${clientId}:`, error);
        this.clients.delete(clientId);
      });

      // Send welcome message
      this.sendToClient(session, {
        type: 'log',
        timestamp: Date.now(),
        data: {
          level: 'info',
          msg: 'Connected to TurboLogger real-time stream',
          clientId,
          bufferSize: this.logBuffer.length
        },
        id: this.generateMessageId()
      });
    });
  }

  private authenticateClient(req: IncomingMessage): boolean {
    if (!this.options.auth) return true;

    const auth = this.options.auth;
    
    switch (auth.type) {
      case 'bearer': {
        const token = this.extractBearerToken(req);
        return token === auth.token;
      }
        
      case 'basic': {
        const credentials = this.extractBasicAuth(req);
        return credentials?.username === auth.username && 
               credentials?.password === auth.password;
      }
               
      case 'custom':
        return auth.validator ? auth.validator(req) : false;
        
      default:
        return false;
    }
  }

  private extractBearerToken(req: IncomingMessage): string | null {
    const authorization = req.headers.authorization;
    if (authorization && authorization.startsWith('Bearer ')) {
      return authorization.substring(7);
    }
    return null;
  }

  private extractBasicAuth(req: IncomingMessage): { username: string; password: string } | null {
    const authorization = req.headers.authorization;
    if (authorization && authorization.startsWith('Basic ')) {
      const encoded = authorization.substring(6);
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const [username, password] = decoded.split(':');
      return { username, password };
    }
    return null;
  }

  private handleClientMessage(session: ClientSession, message: ClientMessage): void {
    session.lastActivity = Date.now();
    
    switch (message.type) {
      case 'setFilters':
        session.filters = { ...session.filters, ...message.filters };
        this.sendToClient(session, {
          type: 'log',
          timestamp: Date.now(),
          data: { 
            level: 'info', 
            msg: 'Filters updated',
            filters: session.filters
          },
          id: this.generateMessageId()
        });
        break;
        
      case 'getMetrics':
        this.sendMetrics(session);
        break;
        
      case 'heartbeat':
        this.sendToClient(session, {
          type: 'heartbeat',
          timestamp: Date.now(),
          data: { status: 'alive' },
          id: this.generateMessageId()
        });
        break;
        
      default:
        this.sendToClient(session, {
          type: 'error',
          timestamp: Date.now(),
          data: { message: `Unknown message type: ${message.type}` },
          id: this.generateMessageId()
        });
    }
  }

  streamLog(logData: LogData): void {
    const message: LogStreamMessage = {
      type: 'log',
      timestamp: Date.now(),
      data: logData,
      id: this.generateMessageId()
    };

    // Add to buffer
    this.logBuffer.push(message);
    if (this.logBuffer.length > this.bufferMaxSize) {
      this.logBuffer.shift();
    }

    // Stream to connected clients
    for (const session of this.clients.values()) {
      if (this.shouldSendToClient(session, logData)) {
        if (this.checkRateLimit(session)) {
          this.sendToClient(session, message);
          session.logCount++;
        }
      }
    }

    this.emit('logStreamed', { 
      messageId: message.id,
      clientCount: this.clients.size,
      logLevel: logData.level
    });
  }

  private shouldSendToClient(session: ClientSession, logData: LogData): boolean {
    const filters = session.filters;
    
    // Filter by log level
    if (filters?.levels && logData.level && !filters.levels.includes(logData.level)) {
      return false;
    }
    
    // Filter by service
    if (filters?.services && logData.service && !filters.services.includes(logData.service)) {
      return false;
    }
    
    // Filter by timestamp
    if (filters?.minTimestamp && logData.time && logData.time < filters.minTimestamp) {
      return false;
    }
    
    return true;
  }

  private checkRateLimit(session: ClientSession): boolean {
    const now = Date.now();
    const clientRates = this.rateLimitMap.get(session.id) || [];
    
    // Remove timestamps older than 1 second
    const recentRates = clientRates.filter(timestamp => now - timestamp < 1000);
    
    if (this.options.rateLimit && recentRates.length >= this.options.rateLimit.maxLogsPerSecond) {
      return false;
    }
    
    recentRates.push(now);
    this.rateLimitMap.set(session.id, recentRates);
    
    return true;
  }

  private sendToClient(session: ClientSession, message: LogStreamMessage): void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const WebSocket = require('ws') as { OPEN: number };
    if ((session.ws as unknown as { readyState: number }).readyState === WebSocket.OPEN) {
      try {
        session.ws.send(JSON.stringify(message));
      } catch (error) {
        console.error(`Failed to send message to client ${session.id}:`, error);
        this.clients.delete(session.id);
      }
    }
  }

  private sendBufferedLogs(session: ClientSession): void {
    for (const message of this.logBuffer) {
      if (this.shouldSendToClient(session, message.data as LogData)) {
        this.sendToClient(session, message);
      }
    }
  }

  private startMetricsCollection(): void {
    this.metricsInterval = setInterval(() => {
      const metrics = this.collectMetrics();
      
      // Send metrics to all connected clients
      for (const session of this.clients.values()) {
        this.sendToClient(session, {
          type: 'metrics',
          timestamp: Date.now(),
          data: metrics,
          id: this.generateMessageId()
        });
      }
    }, 5000); // Send metrics every 5 seconds
  }

  private sendMetrics(session: ClientSession): void {
    const metrics = this.collectMetrics();
    this.sendToClient(session, {
      type: 'metrics',
      timestamp: Date.now(),
      data: metrics,
      id: this.generateMessageId()
    });
  }

  private collectMetrics(): MetricsData {
    const now = Date.now();
    const clients = Array.from(this.clients.values());
    
    return {
      server: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage()
      },
      streaming: {
        connectedClients: clients.length,
        totalLogsSent: clients.reduce((sum, client) => sum + client.logCount, 0),
        bufferSize: this.logBuffer.length,
        averageSessionDuration: clients.length > 0 
          ? clients.reduce((sum, client) => sum + (now - client.connectedAt), 0) / clients.length / 1000
          : 0
      },
      rateLimit: {
        activeRateLimits: this.rateLimitMap.size,
        maxConnectionsReached: this.options.rateLimit ? clients.length >= this.options.rateLimit.maxConnections : false
      }
    };
  }

  private generateClientId(): string {
    return createHash('sha256')
      .update(Date.now().toString() + Math.random().toString())
      .digest('hex')
      .substring(0, 16);
  }

  private generateMessageId(): string {
    return createHash('sha256')
      .update(Date.now().toString() + Math.random().toString())
      .digest('hex')
      .substring(0, 12);
  }

  getConnectedClients(): Array<{
    id: string;
    connectedAt: number;
    lastActivity: number;
    logCount: number;
    filters: RealtimeOptions['filters'];
  }> {
    return Array.from(this.clients.values()).map(session => ({
      id: session.id,
      connectedAt: session.connectedAt,
      lastActivity: session.lastActivity,
      logCount: session.logCount,
      filters: session.filters
    }));
  }

  broadcastMessage(message: LogData): void {
    const streamMessage: LogStreamMessage = {
      type: 'log',
      timestamp: Date.now(),
      data: message,
      id: this.generateMessageId()
    };

    for (const session of this.clients.values()) {
      this.sendToClient(session, streamMessage);
    }
  }
}