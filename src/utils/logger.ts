import { recordLogLine } from './log-buffer.js';

/**
 * Severity levels, ordered so a numeric comparison decides whether a line is
 * emitted.
 *
 * A plain object rather than a TypeScript `enum`: an enum compiles to a runtime
 * object carrying a reverse name mapping, which is machinery we do not need for
 * four constants. The value and the type are named separately because a const
 * and a same-named type, while legal, read as a redeclaration to tooling.
 */
export const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

export type LogLevel = (typeof LOG_LEVELS)[keyof typeof LOG_LEVELS];

/** Display labels, indexed by level. */
const LEVEL_LABELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;

/** One emitted line, before it is rendered to text. */
interface LogRecord {
  readonly at: Date;
  readonly level: LogLevel;
  readonly scope: string;
  readonly message: string;
  readonly details: readonly unknown[];
}

/**
 * Render a value that was passed alongside a log message.
 *
 * Errors need their own branch because `JSON.stringify` on one returns `{}` —
 * `message`, `name` and `stack` are all non-enumerable. Without this, every
 * `logger.error('failed:', error)` in the codebase logged `failed: {}`, which
 * removed the single most useful piece of information from every failure.
 */
function describeLogValue(value: unknown): string {
  if (value instanceof Error) {
    const parts = [`${value.name}: ${value.message}`];
    if (value.stack) parts.push(value.stack);

    // Anything the thrower attached to the error beyond the standard fields.
    const extras: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (key !== 'name' && key !== 'message' && key !== 'stack') {
        extras[key] = (value as unknown as Record<string, unknown>)[key];
      }
    }
    if (Object.keys(extras).length > 0) {
      try {
        parts.push(JSON.stringify(extras));
      } catch {
        /* circular or otherwise unserializable — the standard fields are enough */
      }
    }

    return parts.join('\n');
  }

  if (value === null || value === undefined) return String(value);

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

/** Render a record to the single line that reaches stderr. */
function formatRecord(record: LogRecord): string {
  const prefix = `[${record.at.toISOString()}] [${LEVEL_LABELS[record.level]}] [${record.scope}]`;
  const details = record.details.map(describeLogValue).join(' ');
  return `${prefix} ${record.message} ${details}`.trim();
}

/**
 * Resolve the `LOG_LEVEL` environment variable to a level.
 *
 * Accepts either the numeric value or the level name, case-insensitively, and
 * falls back for anything unset, empty or unrecognized. Parsing the name
 * matters: reading the variable as a bare integer meant `LOG_LEVEL=debug`
 * produced `NaN`, every comparison against it was false, and logging went
 * silent — which reads to a user as the server having hung.
 *
 * Exported for unit tests; production callers reach it through the constructor.
 *
 * @internal
 */
export function parseLogLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  if (raw === undefined || raw === '') return fallback;

  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum >= LOG_LEVELS.debug && asNum <= LOG_LEVELS.error) {
    return asNum as LogLevel;
  }

  switch (raw.toUpperCase()) {
    case 'DEBUG':
      return LOG_LEVELS.debug;
    case 'INFO':
      return LOG_LEVELS.info;
    case 'WARN':
    case 'WARNING':
      return LOG_LEVELS.warn;
    case 'ERROR':
      return LOG_LEVELS.error;
    default:
      return fallback;
  }
}

/** Truthy `EDITMAMEI_VERBOSE_LOGGING` value (`true` / `1`). Anything else is off. */
function isVerboseEnabled(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s === 'true' || s === '1';
}

/**
 * A scoped logger.
 *
 * Every line is written to stderr and never to stdout. That is not a style
 * preference: stdout is the MCP transport, carrying JSON-RPC frames to the
 * client, and a single stray write into it corrupts the protocol and drops the
 * connection. Anything writing to the console in this codebase is a bug.
 */
export class Logger {
  private readonly scope: string;
  private readonly logLevel: LogLevel;

  constructor(scope: string, logLevel: LogLevel = LOG_LEVELS.info) {
    this.scope = scope;
    // The verbose toggle exists for clients with no terminal to set an
    // environment variable from, so a user reproducing a problem can capture
    // full detail from the UI. An explicit LOG_LEVEL still outranks it.
    const fallback = isVerboseEnabled(process.env.EDITMAMEI_VERBOSE_LOGGING)
      ? LOG_LEVELS.debug
      : logLevel;
    this.logLevel = parseLogLevel(process.env.LOG_LEVEL, fallback);
  }

  private log(level: LogLevel, message: string, ...details: unknown[]): void {
    if (level < this.logLevel) return;

    const line = formatRecord({
      at: new Date(),
      level,
      scope: this.scope,
      message,
      details,
    });

    process.stderr.write(line + '\n');

    // Also kept in memory so a diagnostic bundle can carry recent logs — an
    // MCP client swallows stderr, so this is the only way a user can hand them
    // over. Teed after the level check, so the buffer holds exactly what was
    // emitted.
    recordLogLine(line);
  }

  /**
   * Whether debug output would be emitted.
   *
   * For callers whose debug argument is expensive to build — slicing and
   * interpolating a large script body, say. `debug()` checks the level
   * internally, but its arguments are evaluated before the call, so the check
   * cannot prevent work that has already happened. Guard the construction with
   * this instead.
   */
  isDebugEnabled(): boolean {
    return this.logLevel <= LOG_LEVELS.debug;
  }

  debug(message: string, ...details: unknown[]): void {
    this.log(LOG_LEVELS.debug, message, ...details);
  }

  info(message: string, ...details: unknown[]): void {
    this.log(LOG_LEVELS.info, message, ...details);
  }

  warn(message: string, ...details: unknown[]): void {
    this.log(LOG_LEVELS.warn, message, ...details);
  }

  error(message: string, ...details: unknown[]): void {
    this.log(LOG_LEVELS.error, message, ...details);
  }
}
