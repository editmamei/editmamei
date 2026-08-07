import { Logger } from '../utils/logger.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { generateSessionId } from '../utils/session-log.js';

export interface SessionConfig {
  autoConnect?: boolean;
  /** Override the session ID (used in tests; production allocates one). */
  sessionId?: string;
}

/**
 * One server run: its identity, its Photoshop connection, and when it last did
 * anything.
 */
export class Session {
  private readonly logger: Logger;
  private readonly config: SessionConfig;
  private readonly sessionId: string;

  /**
   * Built on first use rather than in the constructor.
   *
   * Constructing a connection resolves the host platform, which throws where
   * Photoshop cannot exist. Doing that eagerly meant CLI subcommands that never
   * touch Photoshop — installing, reporting status — failed before the command
   * router could even dispatch them. Deferring keeps the CLI usable anywhere;
   * the throw still arrives the moment something genuinely needs Photoshop.
   */
  private connection: PhotoshopConnection | null = null;

  private lastActivity: Date;

  constructor(config: SessionConfig = {}) {
    this.logger = new Logger('Session');
    this.config = { autoConnect: true, ...config };
    this.lastActivity = new Date();
    this.sessionId = config.sessionId ?? generateSessionId();
  }

  private ensureConnection(): PhotoshopConnection {
    if (!this.connection) {
      this.connection = new PhotoshopConnection();
    }
    return this.connection;
  }

  /** Human-sortable, collision-resistant identifier for this server run. */
  getSessionId(): string {
    return this.sessionId;
  }

  async initialize(): Promise<void> {
    this.logger.info('Starting session', this.sessionId);
    if (this.config.autoConnect) {
      await this.connect();
    }
  }

  /** Reach Photoshop and report whether it answered. Never throws. */
  async connect(): Promise<boolean> {
    try {
      const reached = await this.ensureConnection().ping();
      if (reached) {
        this.updateActivity();
        this.logger.info('Photoshop is reachable');
        return true;
      }
      this.logger.warn('Photoshop did not answer');
      return false;
    } catch (error) {
      this.logger.error('Could not reach Photoshop', error);
      return false;
    }
  }

  /**
   * End the session.
   *
   * Nothing to tear down: there is no socket or session held open on the
   * Photoshop side, only per-call child processes that have already exited.
   */
  async disconnect(): Promise<void> {
    this.logger.info('Ending session', this.sessionId);
  }

  getConnection(): PhotoshopConnection {
    return this.ensureConnection();
  }

  updateActivity(): void {
    this.lastActivity = new Date();
  }

  getLastActivity(): Date {
    return this.lastActivity;
  }
}
