/**
 * Process-global ring buffer of recent log lines.
 *
 * `Logger` (src/utils/logger.ts) writes every emitted line to stderr — which an
 * MCP stdio client swallows, so the user never sees it. To let a user hand us
 * those lines when something breaks, `Logger.log()` ALSO tees each formatted line
 * here (after the level gate, so the buffer mirrors exactly what reached stderr).
 * The `ps_report_problem` tool and `editmamei report` CLI snapshot this
 * buffer into a sanitized diagnostic bundle.
 *
 * Bounded (default 1000 lines) so a long-lived server can't grow it without
 * limit — once full, the oldest line is overwritten. In-memory only; nothing is
 * persisted here, and a push never throws into the logging path.
 */

const DEFAULT_CAPACITY = 1000;

export class LogRingBuffer {
  private readonly buf: (string | undefined)[];
  private readonly capacity: number;
  private next = 0;
  private full = false;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.buf = new Array<string | undefined>(this.capacity);
  }

  /** Append one line. Once capacity is reached the oldest line is overwritten. */
  push(line: string): void {
    this.buf[this.next] = line;
    this.next = (this.next + 1) % this.capacity;
    if (this.next === 0) this.full = true;
  }

  /** Oldest-to-newest snapshot of the retained lines. */
  snapshot(): string[] {
    if (!this.full) return this.buf.slice(0, this.next) as string[];
    return [
      ...(this.buf.slice(this.next) as string[]),
      ...(this.buf.slice(0, this.next) as string[]),
    ];
  }

  /** Number of retained lines. */
  get size(): number {
    return this.full ? this.capacity : this.next;
  }

  /** Drop all retained lines (used by tests). */
  clear(): void {
    this.buf.fill(undefined);
    this.next = 0;
    this.full = false;
  }
}

/** The shared buffer every `Logger` instance writes into. */
export const sharedLogBuffer = new LogRingBuffer();

/** Tee a formatted log line into the shared buffer. Never throws. */
export function recordLogLine(line: string): void {
  try {
    sharedLogBuffer.push(line);
  } catch {
    /* logging must never throw into the caller */
  }
}
