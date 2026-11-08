import { describe, it, expect, vi, afterEach } from 'vitest';
import { platform } from 'os';
import {
  Client,
  InMemoryTransport,
  type VersionNegotiationMode,
} from '@modelcontextprotocol/client';
import type { Transport } from '@modelcontextprotocol/server';
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

  // A scanner may speak either protocol revision: a 2025 client opens with `initialize`, a
  // 2026-07-28 one sends per-request `_meta` (`auto` probes with server/discover first).
  const modes: Array<[string, VersionNegotiationMode]> = [
    ['2025 (initialize)', 'legacy'],
    ['a probing client (server/discover, then whichever the server offers)', 'auto'],
    ['2026-07-28 (per-request _meta)', { pin: '2026-07-28' }],
  ];
  it.each(modes)('completes the MCP handshake and answers tools/list: %s', async (_label, mode) => {
    // The assertion that matches what a scanner actually does. Constructing
    // the server is not the bar — the bar is a client connecting and getting
    // an inventory back. start() binds stdio, so this drives the same
    // sequence (loadModules, then serve) over a linked in-memory pair.
    vi.mocked(platform).mockReturnValue('linux');
    const editmamei = new EditmameiServer();
    await editmamei.loadModules();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    (editmamei as unknown as { serve(wire: Transport): void }).serve(serverTransport);
    const client = new Client(
      { name: 'scanner', version: '0.0.0' },
      { versionNegotiation: { mode } }
    );

    await client.connect(clientTransport);
    const listed = await client.listTools();

    expect(listed.tools.length).toBeGreaterThan(0);
    expect(listed.tools.map((t) => t.name)).toContain('ps_ping');
    await client.close();
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

  it('ps_ping explains the platform instead of blaming a closed Photoshop', async () => {
    // The tool a scanner (or a confused WSL user) reaches for first. Without
    // the reason it reports "Photoshop did not respond", which reads as an
    // application that is merely closed and sends the reader after a fix that
    // cannot work here.
    vi.mocked(platform).mockReturnValue('linux');
    const server = new EditmameiServer() as unknown as {
      pingPhotoshop(): Promise<{
        content: Array<{ text: string }>;
        structuredContent: { connected: boolean };
      }>;
    };
    const res = await server.pingPhotoshop();

    expect(res.structuredContent.connected).toBe(false);
    expect(res.content[0].text).toMatch(/"linux"/);
    expect(res.content[0].text).toMatch(/Windows and macOS/);
  });
});
