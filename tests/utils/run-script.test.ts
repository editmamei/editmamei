import { describe, it, expect, vi, afterEach } from 'vitest';
import { runScript } from '@editmamei/utils/run-script.ts';
import { PhotoshopAPIFactory } from '@editmamei/api/photoshop-api.ts';
import { makeConnection } from '../fixtures/fake-connection.ts';

/**
 * Audit finding 16 / perf M8: `runScript` is the single chokepoint every
 * tool handler routes through, so it memoizes the constructed `PhotoshopAPI`
 * per `PhotoshopConnection` instead of rebuilding a fresh
 * `PhotoshopAPIFactory` + `ExtendScriptPhotoshopAPI` + `Logger` on every
 * script. `PhotoshopAPIFactory.prototype.createAPI` is the constructor
 * chokepoint — spying on it counts how many `PhotoshopAPI` instances get
 * built, independent of how many scripts actually execute.
 */
describe('runScript — per-connection API memoization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('two runScript calls on the same connection construct exactly one API', async () => {
    const createSpy = vi.spyOn(PhotoshopAPIFactory.prototype, 'createAPI');
    const conn = makeConnection();

    await runScript(conn.asConnection(), 'return 1;');
    await runScript(conn.asConnection(), 'return 2;');

    expect(createSpy).toHaveBeenCalledTimes(1);
    // Both scripts still executed — memoization reuses the API, it doesn't
    // skip the call.
    expect(conn.executions).toHaveLength(2);
  });

  it('different connections each get their own API', async () => {
    const createSpy = vi.spyOn(PhotoshopAPIFactory.prototype, 'createAPI');
    const connA = makeConnection();
    const connB = makeConnection();

    await runScript(connA.asConnection(), 'return 1;');
    await runScript(connB.asConnection(), 'return 2;');

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(connA.executions).toHaveLength(1);
    expect(connB.executions).toHaveLength(1);
  });

  it('does not cache across a failed construction (info not yet detected)', async () => {
    const createSpy = vi.spyOn(PhotoshopAPIFactory.prototype, 'createAPI');
    const conn = makeConnection({ info: null });

    await expect(runScript(conn.asConnection(), 'return 1;')).rejects.toThrow(
      /Photoshop info not available/
    );

    // Nothing was cached on failure, so a retry attempts construction again
    // rather than being permanently stuck.
    conn.reset();
    await expect(runScript(conn.asConnection(), 'return 1;')).rejects.toThrow(
      /Photoshop info not available/
    );
    expect(createSpy).toHaveBeenCalledTimes(2);
  });
});
