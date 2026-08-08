import { describe, it, expect, vi, afterEach } from 'vitest';
import { platform } from 'os';
import { EditmameiServer } from '@editmamei/core/server.ts';
import { useSessionLogSandbox } from '../fixtures/session-log-sandbox.ts';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, platform: vi.fn(actual.platform) };
});

useSessionLogSandbox();

/**
 * The directory-scanner scenario. MCP directories (Glama and friends) build
 * this server from source in a Linux sandbox and run it behind a stdio proxy:
 * the listing needs the process to boot, answer `initialize`, and enumerate
 * tools — never to perform an edit. Platform resolution stays eager (a boot on
 * an unsupported OS is a data point worth keeping visible); what changed is
 * that resolution SUCCEEDS with inert ports instead of throwing, so the
 * refusal lands per call, naming the OS. A 2026-08-08 Glama scan died at
 * exactly the construction path this file pins open.
 */
describe('boot on an unsupported OS', () => {
  const realPlatform = process.platform;

  afterEach(() => {
    vi.mocked(platform).mockReturnValue(realPlatform);
  });

  it('registers exactly the surface a supported OS gets', () => {
    // The listing a scanner sees on Linux must be the listing a user sees on
    // Windows — same registry, same count. Comparing the two constructions
    // directly pins that without hardcoding a number that drifts.
    vi.mocked(platform).mockReturnValue('win32');
    const onWindows = (new EditmameiServer() as unknown as { toolRegistry: { count(): number } })
      .toolRegistry;

    vi.mocked(platform).mockReturnValue('linux');
    const onLinux = (new EditmameiServer() as unknown as { toolRegistry: { count(): number } })
      .toolRegistry;

    expect(onLinux.count()).toBeGreaterThan(0);
    expect(onLinux.count()).toBe(onWindows.count());
  });

  it('refuses an actual Photoshop call, naming the OS', async () => {
    vi.mocked(platform).mockReturnValue('linux');
    const server = new EditmameiServer() as unknown as {
      session: { getConnection(): { executeScript(s: string): Promise<unknown> } };
    };
    await expect(server.session.getConnection().executeScript('$.__mcp__ = 1;')).rejects.toThrow(
      /Windows and macOS/
    );
  });
});
