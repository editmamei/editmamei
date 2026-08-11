import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EditmameiServer, __resetLogScriptOnErrorWarnForTests } from '@editmamei/core/server.ts';
import { getPendingRawDevelop, __clearRawDevelopState } from '@editmamei/core/raw-develop-state.ts';
import { makeConnection } from '../fixtures/fake-connection.ts';
import { makeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import { useSessionLogSandbox } from '../fixtures/session-log-sandbox.ts';

// Every `new EditmameiServer()` below builds its own SessionLog with no `dir`
// override — redirect it to a per-test temp dir so this file's many
// constructions (several per test) never write real NDJSON into the user's
// ~/.editmamei/sessions/.
useSessionLogSandbox();

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
// Pro tool sources aren't part of every checkout of this repo (Pro ships as
// a separate module loaded at runtime). Without it, loadModules() has
// nothing to dynamically import, so gate the one case that asserts the Pro
// surface appears after the load.
const PRO_SOURCES_PRESENT = existsSync(join(REPO_ROOT, 'src', 'modules', 'pro', 'index.ts'));
const proIt = PRO_SOURCES_PRESENT ? it : it.skip;

/**
 * EditmameiServer construction smoke test: instantiating it should not
 * touch Photoshop, since it only builds platform-specific objects. We can
 * then patch in a fake connection and exercise the internal tool registry.
 */
describe('EditmameiServer construction', () => {
  it('instantiates without touching Photoshop or stdio', () => {
    expect(() => new EditmameiServer()).not.toThrow();
  });

  it('registers the CE built-in surface (+ ping) at construction time', () => {
    const server = new EditmameiServer() as unknown as {
      toolRegistry: { count(): number; list(): Array<{ name: string }> };
    };
    // CE is the built-in module, loaded synchronously in the constructor; the
    // Pro module is loaded later via dynamic import (loadModules / start).
    expect(server.toolRegistry.count()).toBeGreaterThan(50);
    const names = server.toolRegistry.list().map((t) => t.name);
    expect(names, 'ps_ping should be registered').toContain('ps_ping');
    // A Pro tool must NOT be present until the downloaded module loads.
    // (ps_select_subject is community tier, so it's a built-in now —
    // ps_apply_camera_raw stays Pro, so it's the not-yet-loaded probe.)
    expect(names).not.toContain('ps_apply_camera_raw');
  });

  proIt('loadModules() registers the Pro surface via dynamic import', async () => {
    const server = new EditmameiServer() as unknown as {
      toolRegistry: { list(): Array<{ name: string }> };
      loadModules(): Promise<void>;
    };
    expect(server.toolRegistry.list().map((t) => t.name)).not.toContain('ps_apply_camera_raw');
    await server.loadModules();
    const names = server.toolRegistry.list().map((t) => t.name);
    // Pro tools appear only after the dynamic load (dev edition sees the full set).
    // (ps_apply_camera_raw is Pro; ps_select_subject is community now, present at boot.)
    expect(names).toContain('ps_apply_camera_raw');
    expect(names).toContain('ps_template_apply');
  });

  // ===========================================================================
  // T08 P2 surfacing. The LOG_SCRIPT_ON_ERROR env var dumps
  // fully-interpolated failing scripts to stderr including any
  // user-supplied args. Previously the warning lived only in a comment
  // inside platform/connection.ts; users who enabled the flag never saw
  // the caveat. Server boot now surfaces a WARN if the flag is set.
  // ===========================================================================
  describe('LOG_SCRIPT_ON_ERROR boot warning', () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    afterEach(() => {
      stderrSpy.mockRestore();
      // vi.stubEnv is isolation-safe under vitest's threads pool — the
      // env mutation is scoped to this test rather than process-global.
      // Pre-Bundle-H1 this test mutated process.env directly, which would
      // race with parallel tests if the pool ever flipped from forks to
      // threads.
      vi.unstubAllEnvs();
      __resetLogScriptOnErrorWarnForTests();
    });

    it('emits a stderr WARN when LOG_SCRIPT_ON_ERROR=1 at boot', () => {
      vi.stubEnv('LOG_SCRIPT_ON_ERROR', '1');
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      new EditmameiServer();
      const lines = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const warn = lines.find((l: string) => /LOG_SCRIPT_ON_ERROR=1 is set/.test(l));
      expect(warn, 'expected boot WARN for LOG_SCRIPT_ON_ERROR=1').toBeTruthy();
      expect(warn).toMatch(/WARN/);
    });

    it('does NOT emit the warning when the env var is unset', () => {
      vi.stubEnv('LOG_SCRIPT_ON_ERROR', '');
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      new EditmameiServer();
      const lines = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const warn = lines.find((l: string) => /LOG_SCRIPT_ON_ERROR=1 is set/.test(l));
      expect(warn).toBeUndefined();
    });

    it('does NOT emit the warning when env var is set to something other than "1"', () => {
      vi.stubEnv('LOG_SCRIPT_ON_ERROR', 'true');
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      new EditmameiServer();
      const lines = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const warn = lines.find((l: string) => /LOG_SCRIPT_ON_ERROR=1 is set/.test(l));
      expect(warn).toBeUndefined();
    });

    // ===========================================================================
    // The warning is one-shot per process, NOT per server
    // instance. Tests + hosts that re-instantiate EditmameiServer (e.g.
    // smoke-test loops, multi-server-in-one-process setups) previously
    // would have spammed stderr with the same WARN. The flag at module
    // scope guarantees a single emission.
    // ===========================================================================
    it('fires the warning at most once per process even across multiple instances', () => {
      vi.stubEnv('LOG_SCRIPT_ON_ERROR', '1');
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      new EditmameiServer();
      new EditmameiServer();
      new EditmameiServer();
      const lines = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const warns = lines.filter((l: string) => /LOG_SCRIPT_ON_ERROR=1 is set/.test(l));
      expect(warns).toHaveLength(1);
    });
  });

  it('routes a tool call through the registry when the connection is swapped for a fake', async () => {
    const server = new EditmameiServer() as unknown as {
      session: { connection: unknown };
      toolRegistry: {
        execute(name: string, args: Record<string, unknown>): Promise<{ content: unknown[] }>;
      };
    };
    const fakeConn = makeConnection();
    server.session.connection = fakeConn;

    // Re-register: the server captured the original connection at construction
    // time. Easiest way to swap is to ask the test fixture directly — we just
    // verify the registry path here through a tool that uses session indirectly.
    // (Concrete script-dispatching is covered in server-registration.test.ts.)
    expect(typeof server.toolRegistry.execute).toBe('function');
  });
});

// ===========================================================================
// Boot-time update check — its result rides ps_ping (an MCP server's
// stderr never reaches the user; a tool result does). The not-connected ping
// path still builds + attempts the pingState round trip (
// pingState is now the sole liveness probe), but a null `PhotoshopInfo`
// makes that attempt fail fast (createAPI() throws before any script would
// reach a real Photoshop), so it's still the clean seam to assert the
// update_available surfacing without a live PS.
// ===========================================================================
describe('ps_ping surfaces update_available', () => {
  type PingServer = {
    session: { connection: unknown };
    updateInfo: unknown;
    snippetClient: unknown;
    pingPhotoshop(): Promise<{
      content: Array<{ text: string }>;
      structuredContent: { connected: boolean; update_available: unknown };
    }>;
  };

  it('reports a newer version in both the text and structuredContent', async () => {
    const server = new EditmameiServer() as unknown as PingServer;
    server.session.connection = makeConnection({ info: null }); // pingState round trip fails fast (early return)
    server.snippetClient = makeSnippetClient();
    server.updateInfo = {
      current: '0.18.0',
      latest: '0.19.0',
      channel: 'npm',
      how_to_update: 'Run: npm install -g editmamei@latest (then restart your MCP client).',
    };
    const res = await server.pingPhotoshop();
    expect(res.structuredContent.update_available).toMatchObject({
      latest: '0.19.0',
      channel: 'npm',
    });
    expect(res.content[0].text).toContain('Update available: v0.18.0 → v0.19.0');
    expect(res.content[0].text).toContain('npm install -g editmamei@latest');
  });

  it('omits the update note and reports null when nothing newer was found', async () => {
    const server = new EditmameiServer() as unknown as PingServer;
    server.session.connection = makeConnection({ info: null });
    server.snippetClient = makeSnippetClient();
    server.updateInfo = null;
    const res = await server.pingPhotoshop();
    expect(res.structuredContent.update_available).toBeNull();
    expect(res.content[0].text).not.toContain('Update available');
  });
});

// ===========================================================================
// Audit finding 10 — pingState is now THE liveness signal for ps_ping,
// replacing a separate connection.ping() ('pong') round trip that used to
// run first. The double-probe cost ~300-700ms per ping for no extra
// information pingState didn't already carry. These tests pin: (a) the
// happy path now issues exactly one script execution (not two, and
// connection.ping() itself is never called from pingPhotoshop — it's still
// used by Session.connect() at boot, a separate caller); (b) a pingState
// failure — even one that looks like "PS was reachable but this script
// blew up" — collapses into the same "Photoshop did not respond"
// shape the old ping()-false branch produced, since there is no longer a
// cheaper separate reachability probe to distinguish the two cases.
// ===========================================================================
describe('ps_ping — pingState is the sole liveness probe', () => {
  type PingServerFull = {
    session: { connection: unknown };
    updateInfo: unknown;
    snippetClient: unknown;
    pingPhotoshop(): Promise<{
      content: Array<{ text: string }>;
      structuredContent: {
        connected: boolean;
        update_available: unknown;
        version?: string;
        custom_action_sets?: number;
        user_templates?: number;
        open_documents?: string[];
        degraded?: string[];
      };
    }>;
  };

  it('issues exactly one script execution on the happy path, and never calls connection.ping()', async () => {
    const server = new EditmameiServer() as unknown as PingServerFull;
    const fakeConn = makeConnection({
      result: { version: '25.9', action_sets_count: 2, open_documents: ['a.psd'] },
    });
    server.session.connection = fakeConn;
    server.snippetClient = makeSnippetClient();
    server.updateInfo = null;

    const res = await server.pingPhotoshop();

    expect(fakeConn.pingCalls).toBe(0);
    expect(fakeConn.executions).toHaveLength(1);
    expect(res.structuredContent.connected).toBe(true);
    expect(res.structuredContent.version).toBe('25.9');
    expect(res.structuredContent.custom_action_sets).toBe(2);
    expect(res.structuredContent.open_documents).toEqual(['a.psd']);
    expect(res.structuredContent.degraded).toEqual([]);
  });

  it('maps a pingState script failure to the same "Failed to connect" shape an unreachable PS produces', async () => {
    const server = new EditmameiServer() as unknown as PingServerFull;
    const fakeConn = makeConnection({ throwOnExecute: new Error('boom') });
    server.session.connection = fakeConn;
    server.snippetClient = makeSnippetClient();
    server.updateInfo = null;

    const res = await server.pingPhotoshop();

    expect(fakeConn.pingCalls).toBe(0);
    expect(fakeConn.executions).toHaveLength(1); // one round trip attempted, no fallback ping
    expect(res.structuredContent).toEqual({ connected: false, update_available: null });
    expect(res.content[0].text).toBe('Photoshop did not respond');
  });
});

// ===========================================================================
// C1+C2 — a `snippetClient.build('pingState')` failure (go-core binary
// missing/broken) is a packaging/runtime problem with THIS process, unrelated
// to whether Photoshop is reachable. It must not be misdiagnosed as
// "Photoshop not running": pingPhotoshop now falls back to the cheap
// connection.ping() probe for liveness in that case, surfacing the missing
// signal as `degraded: ['pingState']` (with zero-valued state fields) rather
// than collapsing to connected:false — unless the probe ALSO fails, in which
// case it's still genuinely unreachable and connected:false is correct.
// A pingState SCRIPT failure (build succeeds, runScript throws) is
// unaffected — that stays the existing connected:false path (pinned above).
// ===========================================================================
describe('ps_ping — build() failure falls back to a liveness probe instead of misdiagnosing Photoshop (C1+C2)', () => {
  type PingServerFull = {
    session: { connection: unknown };
    updateInfo: unknown;
    snippetClient: unknown;
    pingPhotoshop(): Promise<{
      content: Array<{ text: string }>;
      structuredContent: {
        connected: boolean;
        update_available: unknown;
        version?: string;
        custom_action_sets?: number;
        user_templates?: number;
        open_documents?: string[];
        degraded?: string[];
      };
    }>;
  };

  it('build() throws but the connection is alive: falls back to ping(), connected:true, degraded ["pingState"] (Q3)', async () => {
    const server = new EditmameiServer() as unknown as PingServerFull;
    const fakeConn = makeConnection(); // default info → ping() resolves true
    server.session.connection = fakeConn;
    server.snippetClient = {
      build: async () => {
        throw new Error('go-core binary missing');
      },
    };
    server.updateInfo = null;

    const res = await server.pingPhotoshop();

    expect(res.structuredContent.connected).toBe(true);
    expect(res.structuredContent.degraded).toEqual(['pingState']);
    expect(fakeConn.pingCalls).toBe(1); // fell back to the cheap probe
    expect(fakeConn.executions).toHaveLength(0); // never reached runScript/pingState
    expect(res.structuredContent.custom_action_sets).toBe(0); // zero-valued state field
    expect(res.structuredContent.open_documents).toEqual([]); // zero-valued state field
  });

  it('build() throws AND the ping() probe also fails: connected:false (Q3)', async () => {
    const server = new EditmameiServer() as unknown as PingServerFull;
    const fakeConn = makeConnection({ info: null }); // ping() resolves false (info === null)
    server.session.connection = fakeConn;
    server.snippetClient = {
      build: async () => {
        throw new Error('go-core binary missing');
      },
    };
    server.updateInfo = null;

    const res = await server.pingPhotoshop();

    expect(res.structuredContent).toEqual({ connected: false, update_available: null });
    expect(res.content[0].text).toBe('Photoshop did not respond');
  });

  it('happy path (build succeeds, pingState succeeds): degraded stays empty (Q2)', async () => {
    const server = new EditmameiServer() as unknown as PingServerFull;
    const fakeConn = makeConnection({
      result: { version: '25.9', action_sets_count: 1, open_documents: [] },
    });
    server.session.connection = fakeConn;
    server.snippetClient = makeSnippetClient();
    server.updateInfo = null;

    const res = await server.pingPhotoshop();

    expect(res.structuredContent.connected).toBe(true);
    expect(res.structuredContent.degraded).toEqual([]);
  });

  it('the degraded field description in the output schema reflects the new pingState semantics (build failure, not a script failure)', () => {
    const server = new EditmameiServer() as unknown as {
      toolRegistry: {
        list(): Array<{
          name: string;
          outputSchema?: { properties?: Record<string, { description?: string }> };
        }>;
      };
    };
    const pingTool = server.toolRegistry.list().find((t) => t.name === 'ps_ping');
    const desc = pingTool?.outputSchema?.properties?.degraded?.description ?? '';
    expect(desc).toContain('pingState');
    expect(desc).toMatch(/go-core snippet builder/i);
    expect(desc).not.toMatch(/in-PS state snippet failed/i);
  });

  // C3+Q4 — getVersion() is called first specifically because, on the real
  // PhotoshopConnection, it's what populates `photoshopInfo`
  // (detector.detect() caches it) — load-bearing for the runScript() call
  // right after: PhotoshopAPIFactory.createAPI() throws "Photoshop info not
  // available" whenever getPhotoshopInfo() is still null. This fake mirrors
  // that same getVersion()-populates-info shape instead of the always-
  // populated FakePhotoshopConnection fixture, so the ordering is actually
  // exercised rather than incidentally satisfied.
  it("getVersion() runs before pingState's build/execute and populates photoshopInfo, which runScript()'s createAPI() needs (C3/Q4)", async () => {
    const server = new EditmameiServer() as unknown as PingServerFull;
    let info: { version: string } | null = null;
    const orderedCalls: string[] = [];
    const fakeConn = {
      async getVersion() {
        orderedCalls.push('getVersion');
        info = { version: '25.9' };
        return info.version;
      },
      getPhotoshopInfo() {
        return info;
      },
      // PhotoshopAPIFactory.createAPI() AWAITS this now (2026-08-01) instead of
      // reading getPhotoshopInfo() synchronously — it is the first gate every
      // runScript passes, so the double must provide it.
      async ensureDetected() {
        return info;
      },
      async executeScript() {
        orderedCalls.push('executeScript');
        return { version: '25.9', action_sets_count: 0, open_documents: [] };
      },
      async ping() {
        return info !== null;
      },
    };
    server.session.connection = fakeConn;
    server.snippetClient = makeSnippetClient();
    server.updateInfo = null;

    const res = await server.pingPhotoshop();

    // Historically this ordering was LOAD-BEARING: createAPI() read
    // getPhotoshopInfo() synchronously, so if getVersion() hadn't populated it
    // first the ping collapsed to the connected:false branch. Since 2026-08-01
    // createAPI() awaits connection.ensureDetected() itself (single-flight), so
    // a call arriving before detection finishes now WAITS instead of failing —
    // that fragile ordering dependency is gone. The order is still pinned here
    // because getVersion() is what supplies the version string, and a
    // regression that reversed it would be worth knowing about.
    expect(orderedCalls).toEqual(['getVersion', 'executeScript']);
    expect(res.structuredContent.connected).toBe(true);
  });
});

// ===========================================================================
// Telemetry defects (2026-08-11) — two "the metric silently lied" bugs found
// by reading the live rollups. Neither changes the MCP response a client
// sees; both change only what gets recorded to telemetry.
// ===========================================================================
describe('psVersion is stamped opportunistically, not only by ps_ping', () => {
  it('a successful tool call other than ps_ping resolves psVersion even when ps_ping was never called', async () => {
    const server = new EditmameiServer() as unknown as {
      session: { connection: unknown };
      psVersion: string | null;
      toolRegistry: {
        register(
          name: string,
          def: {
            tool: { name: string; description: string; inputSchema: object };
            handler: () => Promise<{ content: unknown[]; structuredContent?: object }>;
          }
        ): void;
      };
      handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown>;
    };
    server.session.connection = makeConnection({
      info: {
        version: '26.3',
        path: 'C:/Program Files/Adobe/Adobe Photoshop 2026/Photoshop.exe',
      },
    });
    server.toolRegistry.register('test_tool_reaches_photoshop', {
      tool: {
        name: 'test_tool_reaches_photoshop',
        description: 'test fixture',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: {} }),
    });

    expect(server.psVersion).toBeNull();
    await server.handleToolCall('test_tool_reaches_photoshop', {});
    expect(server.psVersion).toBe('26.3');
  });
});

describe('telemetry: a ps_ping that never reached Photoshop is not recorded as a success', () => {
  it('records success:false for telemetry on a not-connected ping, without changing the tool result', async () => {
    const server = new EditmameiServer() as unknown as {
      session: { connection: unknown };
      snippetClient: unknown;
      telemetry: {
        recordCall(call: {
          tool: string;
          success: boolean;
          duration_ms: number;
          error_class: string | null;
        }): void;
      };
      handleToolCall(
        name: string,
        args: Record<string, unknown>
      ): Promise<{ isError?: boolean; structuredContent: { connected: boolean } }>;
    };
    // Same shape as the "pingState script failure" case above: build() succeeds,
    // but the round trip itself throws — a genuine "did not respond" ping.
    server.session.connection = makeConnection({ throwOnExecute: new Error('boom') });
    server.snippetClient = makeSnippetClient();
    const recordCallSpy = vi.fn();
    server.telemetry = { recordCall: recordCallSpy };

    const res = await server.handleToolCall('ps_ping', {});

    // User-facing behavior is unchanged — still a normal, helpful "not connected"
    // payload, not an isError result.
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.connected).toBe(false);

    // But telemetry must not count a ping that never reached Photoshop as a success.
    expect(recordCallSpy).toHaveBeenCalledTimes(1);
    expect(recordCallSpy.mock.calls[0][0]).toMatchObject({ tool: 'ps_ping', success: false });
  });
});

// ===========================================================================
// Audit M13 — the tools/call dispatch wrapper (handleToolCall) is the DoS
// guard: a thrown handler or an unknown tool name must become a clean
// { isError: true } result, never propagate out and tear down the long-lived
// stdio server. Previously only the registry's throw-on-unknown was tested,
// not the wrapper that catches it.
// ===========================================================================
describe('tools/call dispatch wrapper', () => {
  it('returns an isError result for an unknown tool name instead of throwing', async () => {
    const server = new EditmameiServer() as unknown as {
      handleToolCall(
        name: string,
        args: Record<string, unknown>
      ): Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;
    };
    const res = await server.handleToolCall('photoshop_does_not_exist', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no tool is registered/i);
  });

  it('converts a throwing tool handler into isError (never propagates)', async () => {
    const server = new EditmameiServer() as unknown as {
      toolRegistry: {
        register(
          name: string,
          def: {
            tool: { name: string; description: string; inputSchema: object };
            handler: () => Promise<unknown>;
          }
        ): void;
      };
      handleToolCall(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean }>;
    };
    server.toolRegistry.register('photoshop_throws_for_test', {
      tool: {
        name: 'photoshop_throws_for_test',
        description: 'always throws (test fixture)',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => {
        throw new Error('boom');
      },
    });
    const res = await server.handleToolCall('photoshop_throws_for_test', {});
    expect(res.isError).toBe(true);
  });
});

// ===========================================================================
// Raw-develop advisory flag — the dispatch wrapper maintains a one-slot
// "raw opened, no develop pass yet" flag (src/core/raw-develop-state.ts).
// Set only when ps_open_document reports is_raw_source AND a camera-raw
// develop tool is registered; cleared by a develop pass, a non-raw open,
// a close, or an error result.
// ===========================================================================
describe('raw develop pending flag (dispatch-level)', () => {
  interface FlagServer {
    toolRegistry: {
      register(
        name: string,
        def: {
          tool: { name: string; description: string; inputSchema: object };
          handler: () => Promise<unknown>;
        }
      ): void;
    };
    handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown>;
  }

  const stub = (name: string, result: Record<string, unknown>, isError = false) => ({
    tool: {
      name,
      description: `${name} (test fixture)`,
      inputSchema: { type: 'object' as const, properties: {} },
    },
    handler: async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: result,
      ...(isError ? { isError: true } : {}),
    }),
  });

  beforeEach(() => {
    __clearRawDevelopState();
  });

  it('a raw open with a camera-raw tool registered sets the flag', async () => {
    const server = new EditmameiServer() as unknown as FlagServer;
    server.toolRegistry.register('ps_apply_camera_raw', stub('ps_apply_camera_raw', {}));
    server.toolRegistry.register(
      'ps_open_document',
      stub('ps_open_document', {
        is_raw_source: true,
        document_name: 'a.dng',
        file_path: '/a.dng',
      })
    );
    await server.handleToolCall('ps_open_document', {});
    expect(getPendingRawDevelop()?.documentName).toBe('a.dng');
  });

  it('a raw open WITHOUT a camera-raw tool registered does not set the flag', async () => {
    const server = new EditmameiServer() as unknown as FlagServer;
    // CE surface: ps_apply_camera_raw is deliberately absent.
    server.toolRegistry.register(
      'ps_open_document',
      stub('ps_open_document', { is_raw_source: true, document_name: 'a.dng' })
    );
    await server.handleToolCall('ps_open_document', {});
    expect(getPendingRawDevelop()).toBeNull();
  });

  it('a non-raw open clears a previously set flag', async () => {
    const server = new EditmameiServer() as unknown as FlagServer;
    server.toolRegistry.register('ps_apply_camera_raw', stub('ps_apply_camera_raw', {}));
    server.toolRegistry.register(
      'ps_open_document',
      stub('ps_open_document', { is_raw_source: true, document_name: 'a.dng' })
    );
    await server.handleToolCall('ps_open_document', {});
    server.toolRegistry.register(
      'ps_open_document',
      stub('ps_open_document', { is_raw_source: false, document_name: 'b.jpg' })
    );
    await server.handleToolCall('ps_open_document', {});
    expect(getPendingRawDevelop()).toBeNull();
  });

  it('a ps_apply_camera_raw dispatch clears the flag', async () => {
    const server = new EditmameiServer() as unknown as FlagServer;
    server.toolRegistry.register('ps_apply_camera_raw', stub('ps_apply_camera_raw', {}));
    server.toolRegistry.register(
      'ps_open_document',
      stub('ps_open_document', { is_raw_source: true, document_name: 'a.dng' })
    );
    await server.handleToolCall('ps_open_document', {});
    await server.handleToolCall('ps_apply_camera_raw', {});
    expect(getPendingRawDevelop()).toBeNull();
  });

  it('a ps_close_document dispatch clears the flag', async () => {
    const server = new EditmameiServer() as unknown as FlagServer;
    server.toolRegistry.register('ps_apply_camera_raw', stub('ps_apply_camera_raw', {}));
    server.toolRegistry.register(
      'ps_open_document',
      stub('ps_open_document', { is_raw_source: true, document_name: 'a.dng' })
    );
    server.toolRegistry.register('ps_close_document', stub('ps_close_document', {}));
    await server.handleToolCall('ps_open_document', {});
    await server.handleToolCall('ps_close_document', {});
    expect(getPendingRawDevelop()).toBeNull();
  });

  it('an isError open result never sets the flag', async () => {
    const server = new EditmameiServer() as unknown as FlagServer;
    server.toolRegistry.register('ps_apply_camera_raw', stub('ps_apply_camera_raw', {}));
    server.toolRegistry.register(
      'ps_open_document',
      stub('ps_open_document', { is_raw_source: true, document_name: 'a.dng' }, true)
    );
    await server.handleToolCall('ps_open_document', {});
    expect(getPendingRawDevelop()).toBeNull();
  });
});
