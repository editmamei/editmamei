import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, LOG_LEVELS, parseLogLevel } from '@editmamei/utils/logger.ts';

describe('Logger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env.LOG_LEVEL;
    delete process.env.EDITMAMEI_VERBOSE_LOGGING;
  });

  it('writes log messages to stderr, never stdout (MCP protocol guarantee)', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = new Logger('test', LOG_LEVELS.debug);
    log.info('hello');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it('respects the level threshold passed in the constructor', () => {
    const log = new Logger('ctx', LOG_LEVELS.warn);
    log.debug('skipped');
    log.info('skipped');
    log.warn('kept');
    log.error('kept');
    expect(stderrSpy).toHaveBeenCalledTimes(2);
  });

  it('honors LOG_LEVEL env var over the constructor default', () => {
    process.env.LOG_LEVEL = String(LOG_LEVELS.error);
    const log = new Logger('ctx', LOG_LEVELS.debug);
    log.debug('skipped');
    log.warn('skipped');
    log.error('kept');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('EDITMAMEI_VERBOSE_LOGGING=true lowers the default to DEBUG', () => {
    process.env.EDITMAMEI_VERBOSE_LOGGING = 'true';
    // Constructor default is INFO; the verbose toggle should drop it to DEBUG.
    const log = new Logger('ctx');
    log.debug('kept-by-verbose');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('an explicit LOG_LEVEL still wins over EDITMAMEI_VERBOSE_LOGGING', () => {
    process.env.EDITMAMEI_VERBOSE_LOGGING = 'true';
    process.env.LOG_LEVEL = String(LOG_LEVELS.warn);
    const log = new Logger('ctx');
    log.debug('skipped');
    log.info('skipped');
    log.warn('kept');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('isDebugEnabled reflects whether DEBUG-level lines would be emitted', () => {
    expect(new Logger('ctx', LOG_LEVELS.debug).isDebugEnabled()).toBe(true);
    expect(new Logger('ctx', LOG_LEVELS.info).isDebugEnabled()).toBe(false);
    expect(new Logger('ctx', LOG_LEVELS.warn).isDebugEnabled()).toBe(false);
    expect(new Logger('ctx', LOG_LEVELS.error).isDebugEnabled()).toBe(false);
  });

  it('includes the context tag in the output', () => {
    const log = new Logger('MyContext', LOG_LEVELS.debug);
    log.info('a message');
    const text = String(stderrSpy.mock.calls[0]?.[0]);
    expect(text).toContain('[MyContext]');
    expect(text).toContain('[INFO]');
    expect(text).toContain('a message');
  });

  it('serializes object arguments as JSON', () => {
    const log = new Logger('ctx', LOG_LEVELS.debug);
    log.debug('payload', { foo: 'bar' });
    const text = String(stderrSpy.mock.calls[0]?.[0]);
    expect(text).toContain('{"foo":"bar"}');
  });

  // ===========================================================================
  // Bug F — Error instances must serialize to message + stack, not `{}`
  //
  // The macOS 2026-05-30 server log was full of:
  //   [ERROR] [PhotoshopConnection] Script execution failed: {}
  // because `JSON.stringify(err)` returns `{}` for Error instances — every
  // own property on Error (.name, .message, .stack) is non-enumerable. The
  // Logger now detects Error and emits a useful payload.
  // ===========================================================================
  it('serializes Error instances with name, message, and stack (NOT empty {})', () => {
    const log = new Logger('ctx', LOG_LEVELS.debug);
    const err = new Error('boom');
    log.error('Script execution failed:', err);
    const text = String(stderrSpy.mock.calls[0]?.[0]);
    // The pre-fix bug produced `Script execution failed: {}`.
    expect(text).not.toMatch(/Script execution failed:\s*\{\}/);
    // Must include the error message.
    expect(text).toContain('Error: boom');
    // Must include at least part of a stack trace (the function frame line).
    expect(text).toMatch(/at /);
  });

  it('serializes Error subclasses with their actual name', () => {
    const log = new Logger('ctx', LOG_LEVELS.debug);
    class CustomError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = 'CustomError';
      }
    }
    log.error('failed', new CustomError('xyz'));
    const text = String(stderrSpy.mock.calls[0]?.[0]);
    expect(text).toContain('CustomError: xyz');
  });

  it('preserves custom enumerable properties attached to Error instances', () => {
    const log = new Logger('ctx', LOG_LEVELS.debug);
    const err = Object.assign(new Error('contextual'), {
      psVersion: '27.7.0',
      tool: 'ps_add_adjustment_layer',
    });
    log.error('failed', err);
    const text = String(stderrSpy.mock.calls[0]?.[0]);
    expect(text).toContain('Error: contextual');
    expect(text).toContain('27.7.0');
    expect(text).toContain('ps_add_adjustment_layer');
  });

  it('still serializes plain objects as JSON (regression guard for non-Error path)', () => {
    const log = new Logger('ctx', LOG_LEVELS.debug);
    log.debug('payload', { foo: 'bar', n: 5 });
    const text = String(stderrSpy.mock.calls[0]?.[0]);
    expect(text).toContain('{"foo":"bar","n":5}');
  });
});

// ===========================================================================
// parseLogLevel — added 2026-06-07.
//
// The previous Logger constructor called `parseInt(process.env.LOG_LEVEL, 10)`
// directly. A user setting `LOG_LEVEL=debug` (symbolic, not numeric) got NaN
// back, `level < NaN` was always false, and the Logger silently dropped every
// log line. Users assumed Editmamei was frozen.
// ===========================================================================
describe('parseLogLevel', () => {
  it('returns fallback for undefined / empty', () => {
    expect(parseLogLevel(undefined, LOG_LEVELS.info)).toBe(LOG_LEVELS.info);
    expect(parseLogLevel('', LOG_LEVELS.warn)).toBe(LOG_LEVELS.warn);
  });

  it('accepts numeric strings inside the level range', () => {
    expect(parseLogLevel('0', LOG_LEVELS.info)).toBe(LOG_LEVELS.debug);
    expect(parseLogLevel('1', LOG_LEVELS.info)).toBe(LOG_LEVELS.info);
    expect(parseLogLevel('2', LOG_LEVELS.info)).toBe(LOG_LEVELS.warn);
    expect(parseLogLevel('3', LOG_LEVELS.info)).toBe(LOG_LEVELS.error);
  });

  it('falls back for numeric strings outside the range', () => {
    expect(parseLogLevel('-1', LOG_LEVELS.info)).toBe(LOG_LEVELS.info);
    expect(parseLogLevel('99', LOG_LEVELS.info)).toBe(LOG_LEVELS.info);
  });

  it('accepts symbolic names case-insensitively', () => {
    expect(parseLogLevel('debug', LOG_LEVELS.info)).toBe(LOG_LEVELS.debug);
    expect(parseLogLevel('INFO', LOG_LEVELS.error)).toBe(LOG_LEVELS.info);
    expect(parseLogLevel('Warn', LOG_LEVELS.error)).toBe(LOG_LEVELS.warn);
    expect(parseLogLevel('warning', LOG_LEVELS.error)).toBe(LOG_LEVELS.warn);
    expect(parseLogLevel('ERROR', LOG_LEVELS.info)).toBe(LOG_LEVELS.error);
  });

  it('falls back for unrecognized values instead of silently dropping logs', () => {
    expect(parseLogLevel('verbose', LOG_LEVELS.info)).toBe(LOG_LEVELS.info);
    expect(parseLogLevel('quiet', LOG_LEVELS.warn)).toBe(LOG_LEVELS.warn);
    expect(parseLogLevel('NaN', LOG_LEVELS.info)).toBe(LOG_LEVELS.info);
  });
});
