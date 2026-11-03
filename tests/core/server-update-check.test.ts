import { describe, it, expect, vi } from 'vitest';
import { EditmameiServer } from '@editmamei/core/server.ts';
import type { UpdateCheckResult } from '@editmamei/update/check.ts';
import { useSessionLogSandbox } from '../fixtures/session-log-sandbox.ts';

/**
 * The boot-time update check's wiring to telemetry (`src/core/server.ts`, the
 * `checkForUpdateWithStatus().then(...)` block in the constructor): 'newer' ->
 * setBehindLatest(true), 'current' -> setBehindLatest(false), 'failed' -> neither call.
 * `shouldCheckForUpdate` always returns false under vitest (see update/check.ts), so
 * without the injectable seam below this block never runs in the test suite at all —
 * exercised here via `EditmameiServerOptions` rather than mocking the whole module, so
 * the rest of the (much larger) integration suite is untouched.
 */
useSessionLogSandbox();

type UpdateCheckTestServer = {
  telemetry: { setBehindLatest: ReturnType<typeof vi.fn> };
  updateCheck: Promise<void> | null;
};

function spyTelemetry(): { setBehindLatest: ReturnType<typeof vi.fn> } {
  return { setBehindLatest: vi.fn() };
}

describe('boot-time update check -> telemetry.setBehindLatest wiring', () => {
  it('status "newer" calls setBehindLatest(true)', async () => {
    const server = new EditmameiServer({
      shouldCheckForUpdate: () => true,
      checkForUpdateWithStatus: async (): Promise<UpdateCheckResult> => ({
        status: 'newer',
        info: null,
      }),
    }) as unknown as UpdateCheckTestServer;
    // Replacing this synchronously, before any microtask runs, still lands ahead of the
    // constructor's `.then()` callback — the injected check above resolves immediately,
    // but its continuation can't run until this synchronous block finishes.
    const telemetry = spyTelemetry();
    server.telemetry = telemetry;

    await server.updateCheck;

    expect(telemetry.setBehindLatest).toHaveBeenCalledWith(true);
    expect(telemetry.setBehindLatest).toHaveBeenCalledTimes(1);
  });

  it('status "current" calls setBehindLatest(false)', async () => {
    const server = new EditmameiServer({
      shouldCheckForUpdate: () => true,
      checkForUpdateWithStatus: async (): Promise<UpdateCheckResult> => ({
        status: 'current',
        info: null,
      }),
    }) as unknown as UpdateCheckTestServer;
    const telemetry = spyTelemetry();
    server.telemetry = telemetry;

    await server.updateCheck;

    expect(telemetry.setBehindLatest).toHaveBeenCalledWith(false);
    expect(telemetry.setBehindLatest).toHaveBeenCalledTimes(1);
  });

  it('status "failed" calls setBehindLatest neither way (field stays omitted, not a false false)', async () => {
    const server = new EditmameiServer({
      shouldCheckForUpdate: () => true,
      checkForUpdateWithStatus: async (): Promise<UpdateCheckResult> => ({
        status: 'failed',
        info: null,
      }),
    }) as unknown as UpdateCheckTestServer;
    const telemetry = spyTelemetry();
    server.telemetry = telemetry;

    await server.updateCheck;

    expect(telemetry.setBehindLatest).not.toHaveBeenCalled();
  });

  it('a rejected check promise does not throw out of the constructor, and updateCheck settles', async () => {
    let server: UpdateCheckTestServer | undefined;
    expect(() => {
      server = new EditmameiServer({
        shouldCheckForUpdate: () => true,
        checkForUpdateWithStatus: async (): Promise<UpdateCheckResult> => {
          throw new Error('registry unreachable');
        },
      }) as unknown as UpdateCheckTestServer;
    }).not.toThrow();
    const telemetry = spyTelemetry();
    server!.telemetry = telemetry;

    await expect(server!.updateCheck).resolves.toBeUndefined();
    expect(telemetry.setBehindLatest).not.toHaveBeenCalled();
  });

  it('does not run at all when shouldCheckForUpdate returns false (production default under vitest)', () => {
    const checkForUpdateWithStatus = vi.fn();
    const server = new EditmameiServer({
      shouldCheckForUpdate: () => false,
      checkForUpdateWithStatus,
    }) as unknown as UpdateCheckTestServer;

    expect(checkForUpdateWithStatus).not.toHaveBeenCalled();
    expect(server.updateCheck).toBeNull();
  });
});
