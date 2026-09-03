import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `EDITMAMEI_SCRIPT_TIMEOUT_MS` is read ONCE at module load, so every test
 * here that varies it must reset the module registry and re-import fresh —
 * mutating `process.env` after the module has already loaded would have no
 * effect on an already-computed scale, which is the whole point of reading
 * it once.
 */
describe('operation-timeouts — EDITMAMEI_SCRIPT_TIMEOUT_MS (module-load-once scaling)', () => {
  const ENV_KEY = 'EDITMAMEI_SCRIPT_TIMEOUT_MS';
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
    vi.restoreAllMocks();
  });

  it('with no env var set, scaling is a no-op', async () => {
    delete process.env[ENV_KEY];
    const { getToolTimeoutMs, DEFAULT_SCRIPT_TIMEOUT_MS } =
      await import('@editmamei/utils/operation-timeouts.ts');
    expect(getToolTimeoutMs('ps_definitely_not_a_real_tool')).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
  });

  it('scales every budget proportionally to the configured value', async () => {
    process.env[ENV_KEY] = '60000'; // 2x the 30000 default
    const { getToolTimeoutMs, DEFAULT_SCRIPT_TIMEOUT_MS } =
      await import('@editmamei/utils/operation-timeouts.ts');
    expect(getToolTimeoutMs('ps_definitely_not_a_real_tool')).toBe(2 * DEFAULT_SCRIPT_TIMEOUT_MS);
    // A tool with its own table entry scales by the same factor, not to a
    // flat number.
    expect(getToolTimeoutMs('ps_export')).toBe(2 * 9_000);
  });

  it('never scales an explicit call-site override — only the table/default lookup', async () => {
    process.env[ENV_KEY] = '60000';
    const { OPEN_DOCUMENT_TIMEOUT_MS } = await import('@editmamei/utils/operation-timeouts.ts');
    // The pre-existing override constants are plain numbers, untouched by
    // any scaling — they are read directly at their own runScript call
    // sites, never through getToolTimeoutMs.
    expect(OPEN_DOCUMENT_TIMEOUT_MS).toBe(120_000);
  });

  it('is read once at module load — a later env change has no effect', async () => {
    process.env[ENV_KEY] = '60000';
    const { getToolTimeoutMs, DEFAULT_SCRIPT_TIMEOUT_MS } =
      await import('@editmamei/utils/operation-timeouts.ts');
    // Mutate the env var AFTER the module has already loaded and computed
    // its scale.
    process.env[ENV_KEY] = '30000';
    expect(getToolTimeoutMs('ps_definitely_not_a_real_tool')).toBe(2 * DEFAULT_SCRIPT_TIMEOUT_MS);
  });

  it('ignores a malformed value and warns, rather than crashing or silently taking 1x', async () => {
    process.env[ENV_KEY] = 'not-a-number';
    const { Logger } = await import('@editmamei/utils/logger.ts');
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { getToolTimeoutMs, DEFAULT_SCRIPT_TIMEOUT_MS } =
      await import('@editmamei/utils/operation-timeouts.ts');
    expect(getToolTimeoutMs('ps_definitely_not_a_real_tool')).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not-a-number'));
  });

  it('ignores a negative or zero value', async () => {
    process.env[ENV_KEY] = '-5000';
    const { Logger } = await import('@editmamei/utils/logger.ts');
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { getToolTimeoutMs, DEFAULT_SCRIPT_TIMEOUT_MS } =
      await import('@editmamei/utils/operation-timeouts.ts');
    expect(getToolTimeoutMs('ps_definitely_not_a_real_tool')).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
  });

  it('clamps the scaled RESULT to the floor rather than letting a tiny value shrink a tool below it', async () => {
    process.env[ENV_KEY] = '100'; // nonsensical, but must not produce a sub-floor budget
    const { getToolTimeoutMs, SCRIPT_TIMEOUT_FLOOR_MS } =
      await import('@editmamei/utils/operation-timeouts.ts');
    expect(getToolTimeoutMs('ps_export')).toBeGreaterThanOrEqual(SCRIPT_TIMEOUT_FLOOR_MS);
    expect(getToolTimeoutMs('ps_definitely_not_a_real_tool')).toBeGreaterThanOrEqual(
      SCRIPT_TIMEOUT_FLOOR_MS
    );
  });
});

/**
 * `getToolTimeoutMs` must not misread an inherited `Object.prototype`
 * member as a configured budget — a plain `{}[name]` lookup for
 * `'toString'` returns the inherited function, not `undefined`, which the
 * old `?? DEFAULT_SCRIPT_TIMEOUT_MS` fallback would happily multiply into
 * `NaN`.
 */
describe('getToolTimeoutMs — Object.prototype collision', () => {
  it('a name that collides with Object.prototype falls back to the default, not NaN', async () => {
    // A prior test in this file may have left the module cache holding an
    // instance loaded under a scaled EDITMAMEI_SCRIPT_TIMEOUT_MS — reset so
    // this import picks up a clean, unscaled module.
    vi.resetModules();
    const { getToolTimeoutMs, DEFAULT_SCRIPT_TIMEOUT_MS } =
      await import('@editmamei/utils/operation-timeouts.ts');
    for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
      expect(getToolTimeoutMs(name)).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
    }
  });
});
