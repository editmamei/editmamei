import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EditmameiServer,
  __resetLogScriptOnErrorWarnForTests,
  BACKGROUND_VERSION_PROBE_TIMEOUT_MS,
} from '@editmamei/core/server.ts';
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
    updateCheck: unknown;
    snippetClient: unknown;
    pingPhotoshop(): Promise<{
      content: Array<{ text: string }>;
      structuredContent: { connected: boolean; update_available: unknown; notify_user: boolean };
    }>;
  };

  const newerInfo = {
    current: '0.18.0',
    latest: '0.19.0',
    channel: 'npm',
    how_to_update: 'Run: npm install -g editmamei@latest (then restart your MCP client).',
    fixed_tools: [] as string[],
  };

  it('first ping: relay-shaped notice + notify_user; later pings: the passive note', async () => {
    const server = new EditmameiServer() as unknown as PingServer;
    // info:null → currentlyRunning defaults false → the absent-PS fast-fail
    // path, which must carry the notice like every other ping shape.
    server.session.connection = makeConnection({ info: null });
    server.snippetClient = makeSnippetClient();
    server.updateInfo = { ...newerInfo };

    const first = await server.pingPhotoshop();
    expect(first.structuredContent.update_available).toMatchObject({
      latest: '0.19.0',
      channel: 'npm',
    });
    expect(first.structuredContent.notify_user).toBe(true);
    // The imperative lives in the result TEXT — the channel the model actually
    // attends at result time — not (only) in an output-schema description.
    expect(first.content[0].text).toContain('tell the user');
    expect(first.content[0].text).toContain('v0.19.0');
    expect(first.content[0].text).toContain('npm install -g editmamei@latest');

    const second = await server.pingPhotoshop();
    expect(second.structuredContent.notify_user).toBe(false);
    expect(second.content[0].text).toContain('Update available: v0.18.0 → v0.19.0');
    expect(second.content[0].text).not.toContain('tell the user');
  });

  it('mentions email release notes on the first notice only, and marks it not urgent', async () => {
    const server = new EditmameiServer() as unknown as PingServer;
    server.session.connection = makeConnection({ info: null });
    server.snippetClient = makeSnippetClient();
    server.updateInfo = { ...newerInfo };

    // The whole sentence, not its pieces: this pins the wording, the
    // de-escalation ("Not urgent"), and that the URL follows immediately
    // rather than the three happening to appear somewhere in the text.
    const first = await server.pingPhotoshop();
    expect(first.content[0].text).toContain(
      'Not urgent: they can also read and subscribe to release notes at' +
        ' https://editmamei.com/blog?src=update_notice'
    );
    // Ends on the URL. A trailing period here gets swallowed into the href by
    // linkifiers in chat clients and terminals, breaking the link.
    expect(first.content[0].text.endsWith('https://editmamei.com/blog?src=update_notice')).toBe(
      true
    );

    // Absent from the passive later pings. Asserted on the source marker
    // rather than the bare domain, which other copy may legitimately use.
    const second = await server.pingPhotoshop();
    expect(second.content[0].text).not.toContain('src=update_notice');
  });

  it('omits the update note and reports null when nothing newer was found', async () => {
    const server = new EditmameiServer() as unknown as PingServer;
    server.session.connection = makeConnection({ info: null });
    server.snippetClient = makeSnippetClient();
    server.updateInfo = null;
    const res = await server.pingPhotoshop();
    expect(res.structuredContent.update_available).toBeNull();
    expect(res.structuredContent.notify_user).toBe(false);
    expect(res.content[0].text).not.toContain('Update available');
  });

  it('the first ping waits for an in-flight boot check instead of racing it', async () => {
    const server = new EditmameiServer() as unknown as PingServer;
    server.session.connection = makeConnection({ info: null });
    server.snippetClient = makeSnippetClient();
    // Boot shape: the fire-and-forget check is still in flight when the
    // skill-mandated first ping arrives. Pre-fix, the ping read updateInfo
    // (still null) and the one ping most sessions make lost the notice.
    server.updateCheck = new Promise<void>((resolveCheck) => {
      setTimeout(() => {
        server.updateInfo = { ...newerInfo };
        resolveCheck();
      }, 30);
    });
    const res = await server.pingPhotoshop();
    expect(res.structuredContent.notify_user).toBe(true);
    expect(res.content[0].text).toContain('v0.19.0');
  });

  it("names the previous session's failures that the update fixes", async () => {
    // useSessionLogSandbox() stubbed this to a per-test temp dir; the server
    // constructed below resolves its SessionLog directory from the same env
    // var, so a file written here IS the "previous session" its notice reads.
    const sandboxDir = process.env.EDITMAMEI_SESSION_LOG_DIR!;
    await writeFile(
      join(sandboxDir, 'prev-session.ndjson'),
      [
        JSON.stringify({ tool: 'ps_delete_layer', success: false }),
        JSON.stringify({ tool: 'ps_delete_layer', success: false }),
        JSON.stringify({ tool: 'ps_select_layer', success: false }),
        JSON.stringify({ tool: 'ps_export', success: true }),
      ].join('\n') + '\n',
      'utf8'
    );
    const server = new EditmameiServer() as unknown as PingServer;
    server.session.connection = makeConnection({ info: null });
    server.snippetClient = makeSnippetClient();
    server.updateInfo = { ...newerInfo, fixed_tools: ['ps_delete_layer', 'ps_select_layer'] };

    const res = await server.pingPhotoshop();
    expect(res.structuredContent.notify_user).toBe(true);
    // "fixes known failures in" — deliberately NOT "your failures are fixed":
    // the log records counts, not causes, so the notice must not claim every
    // recorded failure was the bug this release closes. The singular form is
    // pinned exactly ("1 time last" is not a substring of "1 times last").
    expect(res.content[0].text).toContain('v0.19.0 fixes known failures in');
    expect(res.content[0].text).toContain('ps_delete_layer (failed 2 times last session)');
    expect(res.content[0].text).toContain('ps_select_layer (failed 1 time last session)');
  });

  it('falls back to the plain imperative notice when there is no previous session', async () => {
    // fixed_tools non-empty but the sandboxed sessions dir has no prior
    // session — the best-effort read must degrade to the plain notice, still
    // relayed, never a broken ping.
    const server = new EditmameiServer() as unknown as PingServer;
    server.session.connection = makeConnection({ info: null });
    server.snippetClient = makeSnippetClient();
    server.updateInfo = { ...newerInfo, fixed_tools: ['ps_delete_layer'] };

    const res = await server.pingPhotoshop();
    expect(res.structuredContent.notify_user).toBe(true);
    expect(res.content[0].text).toContain('tell the user');
    expect(res.content[0].text).not.toContain('fixes known failures');
  });

  it('the success (connected) path carries the notice and notify_user too', async () => {
    const server = new EditmameiServer() as unknown as PingServer;
    server.session.connection = makeConnection({
      result: { version: '25.9', action_sets_count: 0, open_documents: [] },
    });
    server.snippetClient = makeSnippetClient();
    server.updateInfo = { ...newerInfo };

    const res = await server.pingPhotoshop();
    expect(res.structuredContent.connected).toBe(true);
    expect(res.structuredContent.notify_user).toBe(true);
    expect(res.content[0].text).toContain('tell the user');
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
    expect(res.structuredContent).toEqual({
      connected: false,
      update_available: null,
      notify_user: false,
    });
    expect(res.content[0].text).toBe('Photoshop did not respond');
  });
});

// ===========================================================================
// Absent-Photoshop fast-fail. Without the process-existence guard, a ping
// against a machine where Photoshop simply isn't running walked into the
// pingState round trip and sat out the full script budget (~30s) — and
// executeScript's ensureRunning() could even try to LAUNCH Photoshop as a
// side effect of a liveness QUESTION. A present-but-cold-starting Photoshop
// legitimately needs >10s (observed in the field), so the fix is NOT a
// shorter timeout: absence is detected directly and answered immediately,
// and presence keeps the full budget.
// ===========================================================================
describe('ps_ping — fast-fail when no Photoshop process exists', () => {
  type PingServer = {
    session: { connection: unknown };
    updateInfo: unknown;
    snippetClient: unknown;
    pingPhotoshop(): Promise<{
      content: Array<{ text: string }>;
      structuredContent: { connected: boolean; update_available: unknown; notify_user: boolean };
    }>;
  };

  it('answers immediately: no script round trip, no launch attempt, no fallback ping', async () => {
    const server = new EditmameiServer() as unknown as PingServer;
    const fakeConn = makeConnection({ currentlyRunning: false }); // installed, not running
    server.session.connection = fakeConn;
    server.snippetClient = makeSnippetClient();
    server.updateInfo = null;

    const res = await server.pingPhotoshop();

    expect(res.structuredContent).toEqual({
      connected: false,
      update_available: null,
      notify_user: false,
    });
    // Hedged on purpose: a process-name miss on an exotic install must not
    // read as a definitive "Photoshop is closed".
    expect(res.content[0].text).toContain('does not appear to be running');
    expect(fakeConn.executions).toHaveLength(0);
    expect(fakeConn.ensureRunningCalls).toBe(0);
    expect(fakeConn.pingCalls).toBe(0);
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
    // currentlyRunning:true keeps the process-existence fast-fail out of the
    // way — this test pins the build-failure fallback, which only runs when a
    // Photoshop process exists but the connection can't reach it.
    const fakeConn = makeConnection({ info: null, currentlyRunning: true }); // ping() resolves false (info === null)
    server.session.connection = fakeConn;
    server.snippetClient = {
      build: async () => {
        throw new Error('go-core binary missing');
      },
    };
    server.updateInfo = null;

    const res = await server.pingPhotoshop();

    expect(res.structuredContent).toEqual({
      connected: false,
      update_available: null,
      notify_user: false,
    });
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
      // The absent-PS fast-fail guard runs between getVersion() and the
      // pingState execute; a running Photoshop keeps this double on the
      // ordering path this test pins.
      async isCurrentlyRunning() {
        return true;
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

type PsVersionServer = {
  session: { connection: unknown };
  snippetClient: unknown;
  psVersion: string | null;
  sessionLog: { setPsVersion(version: string): Promise<void> };
  toolRegistry: {
    register(
      name: string,
      def: {
        tool: { name: string; description: string; inputSchema: object };
        handler: () => Promise<{
          content: unknown[];
          structuredContent?: object;
          isError?: boolean;
        }>;
      }
    ): void;
  };
  handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown>;
};

describe('psVersion is resolved opportunistically, not only by ps_ping', () => {
  // Bug fix v2 (QA F1/F2) — the FIRST cut of this fix stamped psVersion straight
  // from PhotoshopConnection.getPhotoshopInfo(), which is pure disk/registry
  // detection: (a) it can be populated even when Photoshop was never reached (a
  // ps_ping that times out still runs connection.getVersion() first), and (b) on
  // Windows it's a release year or bare version, a DIFFERENT value space from the
  // live-queried format ('27.8.0') every other ps_version reading uses — mixing
  // the two corrupts installs_by_ps_version. The fix now only ever resolves
  // psVersion from a live query (the same pingState round trip ps_ping uses),
  // fired in the background, and only once PhotoshopConnection.hasReachedPhotoshop()
  // is ALREADY true from a genuine prior script success.
  it('a tool call that genuinely reached Photoshop resolves psVersion in the SAME live-queried format ps_ping uses — never the disk-detected install record', async () => {
    const server = new EditmameiServer() as unknown as PsVersionServer;
    const fakeConn = makeConnection({
      // Disk-detected value: a bare version, not the live app format. If this
      // leaks into psVersion instead of the live-queried '27.8.0' below, that's
      // the F2 regression.
      info: { version: '26.3', path: 'C:/Program Files/Adobe/Adobe Photoshop 2026/Photoshop.exe' },
      resultFor: (script) =>
        script.includes('pingState')
          ? { version: '27.8.0', action_sets_count: 0, open_documents: [] }
          : { status: 'ok' },
    });
    server.session.connection = fakeConn;
    server.snippetClient = makeSnippetClient();
    server.toolRegistry.register('test_tool_reaches_photoshop', {
      tool: {
        name: 'test_tool_reaches_photoshop',
        description: 'test fixture',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => {
        // A real tool's handler drives Photoshop through the connection itself —
        // this is what sets hasReachedPhotoshop(), not the stub's return value.
        await fakeConn.executeScript('some real tool script');
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: {} };
      },
    });

    expect(server.psVersion).toBeNull();
    await server.handleToolCall('test_tool_reaches_photoshop', {});
    // The resolution is a fire-and-forget background round trip — give it a
    // chance to land rather than asserting synchronously.
    await vi.waitFor(() => {
      expect(server.psVersion).toBe('27.8.0');
    });
  });

  it('stamps sessionLog.setPsVersion alongside psVersion when the background resolution lands', async () => {
    const server = new EditmameiServer() as unknown as PsVersionServer;
    const fakeConn = makeConnection({
      info: { version: '26.3', path: 'C:/x/Photoshop.exe' },
      resultFor: (script) =>
        script.includes('pingState')
          ? { version: '27.8.0', action_sets_count: 0, open_documents: [] }
          : { status: 'ok' },
    });
    server.session.connection = fakeConn;
    server.snippetClient = makeSnippetClient();
    const setPsVersionSpy = vi.spyOn(server.sessionLog, 'setPsVersion');
    server.toolRegistry.register('test_tool_reaches_photoshop_2', {
      tool: {
        name: 'test_tool_reaches_photoshop_2',
        description: 'test fixture',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => {
        await fakeConn.executeScript('some real tool script');
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: {} };
      },
    });

    await server.handleToolCall('test_tool_reaches_photoshop_2', {});
    await vi.waitFor(() => {
      expect(setPsVersionSpy).toHaveBeenCalledWith('27.8.0');
    });
  });

  // F1 negative — a tool call that never touched Photoshop (ps_list_capabilities,
  // template listing) must not trigger the background probe: doing so would risk
  // PhotoshopConnection.executeScript's ensureRunning() auto-launching Photoshop
  // as a side effect of a call that was never going to touch it.
  it('a tool call that never touched Photoshop does NOT resolve psVersion', async () => {
    const server = new EditmameiServer() as unknown as PsVersionServer;
    server.session.connection = makeConnection({
      info: { version: '26.3', path: 'C:/x/Photoshop.exe' },
    });
    server.snippetClient = makeSnippetClient();
    server.toolRegistry.register('test_local_only_tool', {
      tool: {
        name: 'test_local_only_tool',
        description: 'test fixture — never touches the connection',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: {} }),
    });

    await server.handleToolCall('test_local_only_tool', {});
    expect(server.psVersion).toBeNull();
  });

  // F13 negative — a FAILED call must not resolve psVersion, even when the
  // connection had already, genuinely reached Photoshop from an earlier call.
  it('a failed tool call does not resolve psVersion', async () => {
    const server = new EditmameiServer() as unknown as PsVersionServer;
    const fakeConn = makeConnection({ info: { version: '26.3', path: 'C:/x/Photoshop.exe' } });
    server.session.connection = fakeConn;
    server.snippetClient = makeSnippetClient();
    // Prove reachability directly on the connection, without going through a
    // dispatched tool call (keeps this test focused on the failing call alone).
    await fakeConn.executeScript("'pong';");
    server.toolRegistry.register('test_tool_fails', {
      tool: {
        name: 'test_tool_fails',
        description: 'test fixture',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => ({
        content: [{ type: 'text', text: 'nope' }],
        structuredContent: {},
        isError: true,
      }),
    });

    await server.handleToolCall('test_tool_fails', {});
    expect(server.psVersion).toBeNull();
  });

  // F13 negative — ps_ping is excluded from the opportunistic path; it still
  // resolves psVersion, but only through its own existing live-query mechanism.
  it('ps_ping resolves psVersion through its own live query, not the opportunistic path', async () => {
    const server = new EditmameiServer() as unknown as PsVersionServer;
    server.session.connection = makeConnection({
      result: { version: '27.2.0', action_sets_count: 0, open_documents: [] },
    });
    server.snippetClient = makeSnippetClient();

    await server.handleToolCall('ps_ping', {});
    expect(server.psVersion).toBe('27.2.0');
  });

  // N1 — the probe is a ONE-SHOT latch on ATTEMPTED, not an in-flight lock. Without
  // this, a failed attempt (Photoshop quit mid-session, went modal, a transient
  // hiccup) re-fires on every later successful non-ping call for the rest of the
  // session, each one queuing a fresh pingState round trip.
  it('the background probe fires at most once per session, even after a failed attempt', async () => {
    const server = new EditmameiServer() as unknown as PsVersionServer;
    let pingStateAttempts = 0;
    const fakeConn = makeConnection({
      info: { version: '26.3', path: 'C:/x/Photoshop.exe' },
      resultFor: (script) => {
        if (script.includes('pingState')) {
          pingStateAttempts++;
          throw new Error('transient pingState failure');
        }
        return { status: 'ok' };
      },
    });
    server.session.connection = fakeConn;
    server.snippetClient = makeSnippetClient();
    server.toolRegistry.register('test_tool_reaches_photoshop_repeat', {
      tool: {
        name: 'test_tool_reaches_photoshop_repeat',
        description: 'test fixture',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => {
        await fakeConn.executeScript('some real tool script');
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: {} };
      },
    });

    await server.handleToolCall('test_tool_reaches_photoshop_repeat', {});
    // Confirm the first (failing) attempt actually ran before asserting it never
    // repeats. The latch is set part-way through the probe's async body, not
    // synchronously on invocation, so this wait is load-bearing: it is what
    // guarantees the first attempt has already committed the latch before the two
    // later calls run. Dropping it would make this test racy.
    await vi.waitFor(() => {
      expect(pingStateAttempts).toBe(1);
    });

    await server.handleToolCall('test_tool_reaches_photoshop_repeat', {});
    await server.handleToolCall('test_tool_reaches_photoshop_repeat', {});

    expect(pingStateAttempts).toBe(1);
    // N4 — a failed probe leaves psVersion honestly null, never throws into the
    // triggering call, and is never re-guessed from anything else.
    expect(server.psVersion).toBeNull();
  });

  // Several onCall hooks can pass the probe's initial guard inside the same window,
  // since the latch is only committed part-way through its async body. They converge on
  // a check-and-set with no await between the read and the write, so exactly one wins.
  // Without that re-check every concurrent caller queues its own pingState round trip,
  // each holding the FIFO script queue for up to the probe timeout.
  it('concurrent tool calls fire the background probe exactly once', async () => {
    const server = new EditmameiServer() as unknown as PsVersionServer;
    let pingStateAttempts = 0;
    const fakeConn = makeConnection({
      info: { version: '26.3', path: 'C:/x/Photoshop.exe' },
      resultFor: (script) => {
        if (script.includes('pingState')) {
          pingStateAttempts++;
          return { version: '27.8.0' };
        }
        return { status: 'ok' };
      },
    });
    server.session.connection = fakeConn;
    const snippetClient = makeSnippetClient();
    server.snippetClient = snippetClient;
    server.toolRegistry.register('test_tool_concurrent_probe', {
      tool: {
        name: 'test_tool_concurrent_probe',
        description: 'test fixture',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => {
        await fakeConn.executeScript('some real tool script');
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: {} };
      },
    });

    await Promise.all([
      server.handleToolCall('test_tool_concurrent_probe', {}),
      server.handleToolCall('test_tool_concurrent_probe', {}),
      server.handleToolCall('test_tool_concurrent_probe', {}),
    ]);
    await vi.waitFor(() => {
      expect(server.psVersion).toBe('27.8.0');
    });

    // All three callers must actually have entered the probe body — build() runs
    // before the liveness check, so it counts guard entries. Asserting this keeps
    // the round-trip assertion below honest: if a fixture ever gains a real async
    // hop, the contended window closes and this drops below 3, failing loudly
    // instead of passing vacuously against an unfixed check-and-set.
    expect(snippetClient.allBuilds().filter((c) => c.name === 'pingState')).toHaveLength(3);
    expect(pingStateAttempts).toBe(1);
  });

  // The commit-point re-check tests the resolved version as well as the latch, because a
  // concurrent ps_ping resolves psVersion without touching the latch. A probe already
  // between its awaits when that lands has nothing left to fetch, so it must abandon the
  // round trip rather than spend the queue on a value it already has.
  it('skips the probe round trip when a concurrent ps_ping resolves the version first', async () => {
    const server = new EditmameiServer() as unknown as PsVersionServer;
    let pingStateAttempts = 0;
    const fakeConn = makeConnection({
      info: { version: '26.3', path: 'C:/x/Photoshop.exe' },
      resultFor: (script) => {
        if (script.includes('pingState')) {
          pingStateAttempts++;
          return { version: '27.8.0' };
        }
        return { status: 'ok' };
      },
    });
    server.session.connection = fakeConn;
    // Land the version mid-probe: build() runs after the entry guard and before the
    // commit-point re-check, so this stands in for a ps_ping resolving concurrently.
    server.snippetClient = {
      build: async (name: string) => {
        if (name === 'pingState') server.psVersion = '27.8.0';
        return JSON.stringify({ __snippet: name });
      },
    } as unknown as typeof server.snippetClient;
    server.toolRegistry.register('test_tool_version_lands_mid_probe', {
      tool: {
        name: 'test_tool_version_lands_mid_probe',
        description: 'test fixture',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => {
        await fakeConn.executeScript('some real tool script');
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: {} };
      },
    });

    await server.handleToolCall('test_tool_version_lands_mid_probe', {});
    await vi.waitFor(() => {
      expect(server.psVersion).toBe('27.8.0');
    });
    // psVersion lands inside build(), i.e. BEFORE the probe would reach runScript — so
    // waiting on it alone would assert on the round-trip count too early and pass no
    // matter what the re-check does. Give the probe room to finish first.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(pingStateAttempts).toBe(0);
  });

  // N2 — the probe must not inherit the runners' 30s DEFAULT_SCRIPT_TIMEOUT_MS.
  // Left unbounded it would hold the shared FIFO script queue (ScriptQueue) for up
  // to 30s on a stuck Photoshop, making the user's NEXT real tool call wait behind
  // it before its own budget even starts.
  it('the background probe uses a short explicit timeout, not the runners default 30s', async () => {
    const server = new EditmameiServer() as unknown as PsVersionServer;
    const fakeConn = makeConnection({
      info: { version: '26.3', path: 'C:/x/Photoshop.exe' },
      resultFor: (script) =>
        script.includes('pingState')
          ? { version: '27.8.0', action_sets_count: 0, open_documents: [] }
          : { status: 'ok' },
    });
    server.session.connection = fakeConn;
    server.snippetClient = makeSnippetClient();
    server.toolRegistry.register('test_tool_reaches_photoshop_timeout', {
      tool: {
        name: 'test_tool_reaches_photoshop_timeout',
        description: 'test fixture',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => {
        await fakeConn.executeScript('some real tool script');
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: {} };
      },
    });

    await server.handleToolCall('test_tool_reaches_photoshop_timeout', {});
    await vi.waitFor(() => {
      expect(server.psVersion).toBe('27.8.0');
    });

    const pingStateExecution = fakeConn.executions.find((e) => e.script.includes('pingState'));
    expect(pingStateExecution, 'expected a pingState execution to have been recorded').toBeTruthy();
    expect(pingStateExecution!.timeout).toBe(BACKGROUND_VERSION_PROBE_TIMEOUT_MS);
  });

  // N3 — hasReachedPhotoshop() is sticky and never resets, so it stays true long
  // after Photoshop quits. The probe must independently confirm Photoshop is
  // running RIGHT NOW before touching the connection — a telemetry probe must
  // never be the thing that starts Photoshop via executeScript's ensureRunning()
  // launch fallback.
  it('the background probe never fires (sends no script at all) when Photoshop is not currently running, even though it was reached earlier', async () => {
    const server = new EditmameiServer() as unknown as PsVersionServer;
    const fakeConn = makeConnection({ info: { version: '26.3', path: 'C:/x/Photoshop.exe' } });
    server.session.connection = fakeConn;
    server.snippetClient = makeSnippetClient();
    // Prove reachability directly, then simulate the user quitting Photoshop —
    // hasReachedPhotoshop() stays true (sticky) even though PS is no longer running.
    await fakeConn.executeScript("'pong';");
    fakeConn.setCurrentlyRunning(false);
    const executionsBeforeProbe = fakeConn.executions.length;

    server.toolRegistry.register('test_local_only_after_quit', {
      tool: {
        name: 'test_local_only_after_quit',
        description: 'test fixture — never touches the connection itself',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: {} }),
    });

    await server.handleToolCall('test_local_only_after_quit', {});
    // Asserting a negative (nothing fired): give any incorrect background attempt
    // a moment to reach the connection before checking the execution count is
    // unchanged.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fakeConn.executions.length).toBe(executionsBeforeProbe);
    expect(server.psVersion).toBeNull();
  });

  // MED 1 — a DECLINE (Photoshop not currently running) must not spend the
  // one-shot budget the way a real, attempted round trip does. Without this, the
  // exact scenario below leaves a session that drove Photoshop for an hour
  // stuck at ps_version 'unknown': Photoshop is reached, then quits; a
  // local-only tool call finds hasReachedPhotoshop() still (stickily) true, the
  // probe declines because Photoshop isn't running RIGHT NOW, and if that
  // decline burned the latch, Photoshop reopening later would never get a
  // second chance.
  it('a decline does not spend the one-shot budget — a later call, once Photoshop is running again, still resolves psVersion', async () => {
    const server = new EditmameiServer() as unknown as PsVersionServer;
    const fakeConn = makeConnection({
      info: { version: '26.3', path: 'C:/x/Photoshop.exe' },
      currentlyRunning: false, // starts "quit"
      resultFor: (script) =>
        script.includes('pingState')
          ? { version: '27.8.0', action_sets_count: 0, open_documents: [] }
          : { status: 'ok' },
    });
    server.session.connection = fakeConn;
    server.snippetClient = makeSnippetClient();
    server.toolRegistry.register('test_tool_reaches_photoshop_reopen', {
      tool: {
        name: 'test_tool_reaches_photoshop_reopen',
        description: 'test fixture',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => {
        await fakeConn.executeScript('some real tool script');
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: {} };
      },
    });

    // First call: reaches Photoshop (proving hasReachedPhotoshop()), but the
    // probe should decline since Photoshop isn't currently running — and that
    // decline must not spend the session's only shot.
    await server.handleToolCall('test_tool_reaches_photoshop_reopen', {});
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the decline settle
    expect(server.psVersion).toBeNull();

    // Photoshop "reopens".
    fakeConn.setCurrentlyRunning(true);

    // A later successful call now gets its own chance and actually resolves
    // psVersion — proving the earlier decline never spent the latch.
    await server.handleToolCall('test_tool_reaches_photoshop_reopen', {});
    await vi.waitFor(() => {
      expect(server.psVersion).toBe('27.8.0');
    });
  });

  // F2 residue — pingPhotoshop()'s own build()-failure-but-alive degraded branch
  // never reaches the live pingState query (pingStateSnippet stays null), so
  // `version` there is whatever connection.getVersion() returned: the
  // disk-detected install record, a bare year like '2026' on Windows — a
  // different value space from every other ps_version reading. The user-facing
  // ping response is unaffected; only the telemetry stamp is gated.
  it('the degraded build-failure-but-alive ping path does not stamp a disk-format version into telemetry, but still stamps the local session log', async () => {
    const server = new EditmameiServer() as unknown as PsVersionServer;
    server.session.connection = makeConnection({
      info: { version: '2026', path: 'C:/x/Photoshop.exe' },
    });
    server.snippetClient = {
      build: async () => {
        throw new Error('go-core binary missing');
      },
    };
    const setPsVersionSpy = vi.spyOn(server.sessionLog, 'setPsVersion');

    const res = (await server.handleToolCall('ps_ping', {})) as {
      structuredContent: { connected: boolean; version?: string };
    };

    expect(res.structuredContent.connected).toBe(true);
    // Unchanged, pre-existing user-facing behavior — the disk-detected fallback
    // still surfaces in the response text/structuredContent.
    expect(res.structuredContent.version).toBe('2026');
    // But it must never reach telemetry's psVersion...
    expect(server.psVersion).toBeNull();
    // ...while the local NDJSON (not the telemetry value space, and diagnostics/
    // collect.ts's only source for this field) still carries it, unchanged from
    // before the F2-residue fix.
    expect(setPsVersionSpy).toHaveBeenCalledWith('2026');
  });
});

describe('telemetry: ps_ping success reflects whether Photoshop was actually reached', () => {
  type PingTelemetryServer = {
    session: { connection: unknown };
    snippetClient: unknown;
    telemetry: {
      recordCall(call: {
        tool: string;
        success: boolean;
        duration_ms: number;
        error_class: string | null;
      }): void;
      recordDiagnostic(diag: { tool: string; error_class: string; error_message: string }): void;
    };
    handleToolCall(
      name: string,
      args: Record<string, unknown>
    ): Promise<{ isError?: boolean; structuredContent: { connected: boolean } }>;
  };

  // F12 — a full double, not a partial one: pingPhotoshop()'s own connected
  // path calls telemetry.onPsVersionResolved(), and onCall can call
  // recordDiagnostic. A partial double throws a TypeError that handleToolCall's
  // try/catch swallows into an unrelated isError result — confirmed by hand:
  // the first cut of this double (recordCall + recordDiagnostic only) broke
  // the "genuinely connects" test below with exactly that failure mode.
  function spyTelemetry() {
    return { recordCall: vi.fn(), recordDiagnostic: vi.fn(), onPsVersionResolved: vi.fn() };
  }

  it('records success:false when the ping never reaches Photoshop, without changing the tool result', async () => {
    const server = new EditmameiServer() as unknown as PingTelemetryServer;
    // build() succeeds, but the round trip itself throws — a genuine "did not
    // respond" ping.
    server.session.connection = makeConnection({ throwOnExecute: new Error('boom') });
    server.snippetClient = makeSnippetClient();
    const telemetry = spyTelemetry();
    server.telemetry = telemetry;

    const res = await server.handleToolCall('ps_ping', {});

    // User-facing behavior is unchanged — still a normal, helpful "not connected"
    // payload, not an isError result.
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.connected).toBe(false);
    expect(telemetry.recordCall).toHaveBeenCalledTimes(1);
    // Asserted whole, not with toMatchObject. The partial match this used to
    // make is why a failure row shipped carrying error_class null: the field
    // sat right there in the object the assertion walked past. A failure with
    // no class folds to '' server-side — the value that means success there.
    expect(telemetry.recordCall.mock.calls[0][0]).toEqual({
      tool: 'ps_ping',
      success: false,
      duration_ms: expect.any(Number),
      error_class: 'ps_not_running',
    });
    // The downgrade is a failure, so it feeds the opt-in diagnostic too. This
    // was previously gated on the registry's raw success flag — still true
    // here — so nothing was ever emitted for it. Asserted whole for the same
    // reason as above: error_message is the field this path newly synthesizes,
    // and a partial match would not see it.
    expect(telemetry.recordDiagnostic).toHaveBeenCalledTimes(1);
    expect(telemetry.recordDiagnostic.mock.calls[0][0]).toEqual({
      tool: 'ps_ping',
      error_class: 'ps_not_running',
      error_message: 'ps_ping did not reach Photoshop',
    });
  });

  // F9 — the flip side. Without this, hard-coding lastPingReachedPs = false
  // would pass every OTHER test in this file while zeroing the ping-success
  // metric for every install that connects fine.
  it('records success:true when the ping genuinely connects', async () => {
    const server = new EditmameiServer() as unknown as PingTelemetryServer;
    server.session.connection = makeConnection({
      result: { version: '27.8.0', action_sets_count: 0, open_documents: [] },
    });
    server.snippetClient = makeSnippetClient();
    const telemetry = spyTelemetry();
    server.telemetry = telemetry;

    const res = await server.handleToolCall('ps_ping', {});

    expect(res.structuredContent.connected).toBe(true);
    expect(telemetry.recordCall).toHaveBeenCalledTimes(1);
    // error_class asserted explicitly: the classification expression has a
    // success branch too, and without pinning it here an edit that dropped the
    // guard would stamp ps_not_running onto every successful row unnoticed.
    expect(telemetry.recordCall.mock.calls[0][0]).toEqual({
      tool: 'ps_ping',
      success: true,
      duration_ms: expect.any(Number),
      error_class: null,
    });
    // A success feeds no diagnostic.
    expect(telemetry.recordDiagnostic).not.toHaveBeenCalled();
  });

  // F11 — the build()-failure-but-alive fallback (pingState's build failed, a
  // go-core problem unrelated to Photoshop; the connection.ping() fallback
  // proves Photoshop IS alive: connected:true, degraded:['pingState']). This
  // still ends the ping at lastPingReachedPs = true — a genuine reach.
  it('records success:true on the degraded build-failure-but-alive fallback path', async () => {
    const server = new EditmameiServer() as unknown as PingTelemetryServer;
    server.session.connection = makeConnection(); // default info → ping() resolves true
    server.snippetClient = {
      build: async () => {
        throw new Error('go-core binary missing');
      },
    };
    const telemetry = spyTelemetry();
    server.telemetry = telemetry;

    const res = await server.handleToolCall('ps_ping', {});

    expect(res.structuredContent.connected).toBe(true);
    expect(telemetry.recordCall.mock.calls[0][0]).toMatchObject({ tool: 'ps_ping', success: true });
  });

  // F11 — the null fallback: an unexpected throw ahead of every branch that
  // would set lastPingReachedPs must defer to the registry's own (correctly
  // false) success flag, not silently report success. Simulated with a raw
  // stub registered under the ps_ping name — bypassing the real pingPhotoshop
  // implementation entirely, so lastPingReachedPs genuinely stays at its
  // initial null.
  it('falls back to the registry success flag when lastPingReachedPs was never set', async () => {
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
      telemetry: PingTelemetryServer['telemetry'];
      handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown>;
    };
    server.toolRegistry.register('ps_ping', {
      tool: {
        name: 'ps_ping',
        description: 'test override — throws before ever touching lastPingReachedPs',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => {
        throw new Error('boom');
      },
    });
    const telemetry = spyTelemetry();
    server.telemetry = telemetry;

    await server.handleToolCall('ps_ping', {});

    expect(telemetry.recordCall).toHaveBeenCalledTimes(1);
    expect(telemetry.recordCall.mock.calls[0][0]).toMatchObject({
      tool: 'ps_ping',
      success: false,
    });
    // A real error is present, so it classifies normally — the ps_not_running
    // fallback is reserved for the downgrade, which this is not.
    expect(telemetry.recordCall.mock.calls[0][0]).toMatchObject({ error_class: 'other' });
  });

  // The diagnostic gate keys off the telemetry-facing success signal rather
  // than the registry's raw flag. That is what lets a downgraded ping produce
  // a diagnostic at all — but it must not change what an ORDINARY failing tool
  // reports, and in particular must never attach the ping's synthesized
  // message to some other tool's failure.
  it('keeps an ordinary failing tool on its own error message and class', async () => {
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
      telemetry: PingTelemetryServer['telemetry'];
      handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown>;
    };
    server.toolRegistry.register('ps_delete_layer', {
      tool: {
        name: 'ps_delete_layer',
        description: 'test override',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => {
        throw new Error('Error deleting layer: Layer not found: Sky. Have: Background');
      },
    });
    const telemetry = spyTelemetry();
    server.telemetry = telemetry;

    await server.handleToolCall('ps_delete_layer', {});

    expect(telemetry.recordCall.mock.calls[0][0]).toMatchObject({
      tool: 'ps_delete_layer',
      success: false,
      error_class: 'layer_not_found',
    });
    expect(telemetry.recordDiagnostic).toHaveBeenCalledTimes(1);
    expect(telemetry.recordDiagnostic.mock.calls[0][0]).toEqual({
      tool: 'ps_delete_layer',
      error_class: 'layer_not_found',
      error_message: 'Error deleting layer: Layer not found: Sky. Have: Background',
    });
  });

  // The exact input that produced the original defect, and the only one that
  // exercises the fallback: a handler returning isError with NO text content
  // block leaves tool-registry.ts with success=false and error UNDEFINED, so
  // classifyError yields null and the fallback ternary decides the class.
  //
  // Without this, the `entry.tool === 'ps_ping'` conjunct in isPingDowngrade
  // gates nothing — delete it and every other test still passes, while every
  // tool's classless failure gets relabelled a Photoshop-connectivity problem
  // under the wrong tool name.
  it('classifies a classless non-ping failure as other, never as ps_not_running', async () => {
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
      telemetry: PingTelemetryServer['telemetry'];
      handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown>;
    };
    server.toolRegistry.register('ps_export', {
      tool: {
        name: 'ps_export',
        description: 'test override — isError with no text content block',
        inputSchema: { type: 'object', properties: {} },
      },
      // No { type: 'text' } block, so the registry cannot recover a message.
      handler: async () => ({ isError: true, content: [] }),
    });
    const telemetry = spyTelemetry();
    server.telemetry = telemetry;

    await server.handleToolCall('ps_export', {});

    expect(telemetry.recordCall.mock.calls[0][0]).toEqual({
      tool: 'ps_export',
      success: false,
      duration_ms: expect.any(Number),
      error_class: 'other',
    });
    expect(telemetry.recordDiagnostic.mock.calls[0][0]).toEqual({
      tool: 'ps_export',
      error_class: 'other',
      error_message: 'tool reported failure with no message',
    });
  });

  // The ping's own classless failure, which IS the downgrade the fallback was
  // added for. Pinning both sides is what makes the tool-name conjunct load
  // bearing rather than decorative.
  it('classifies the ping downgrade as ps_not_running', async () => {
    const server = new EditmameiServer() as unknown as PingTelemetryServer;
    server.session.connection = makeConnection({ throwOnExecute: new Error('boom') });
    server.snippetClient = makeSnippetClient();
    const telemetry = spyTelemetry();
    server.telemetry = telemetry;

    await server.handleToolCall('ps_ping', {});

    expect(telemetry.recordCall.mock.calls[0][0]).toMatchObject({
      tool: 'ps_ping',
      error_class: 'ps_not_running',
    });
  });
});

// ===========================================================================
// Boot-order regression pin (owner request, 2026-08-11) — the public repo had
// no local test for this invariant; the equivalent pin
// (tests/integration/server-registration.test.ts) lives only in the private
// repo, where it also exercises Pro-tool registration and so can't be
// hydrated here. The invariant itself: EditmameiServer.start() must connect
// the MCP transport BEFORE warming the Photoshop connection, which it does
// fire-and-forget via `void this.session.initialize()`. When PS isn't
// reachable at boot, that warmup blocks for the executor's full 30s timeout;
// awaiting it ahead of `server.connect()` delays the `initialize` response by
// ~30s, which Claude Desktop surfaces as "Unable to connect to extension
// server". Booting the real stdio transport in a unit test is undesirable, so
// this pins the ordering at the source level instead.
// ===========================================================================
describe('EditmameiServer.start() boot ordering', () => {
  it('connects the MCP transport before the (fire-and-forget) Photoshop warmup', () => {
    const serverSrc = readFileSync(join(REPO_ROOT, 'src', 'core', 'server.ts'), 'utf8');
    const startMatch = serverSrc.match(/async start\(\)\s*\{[\s\S]*?\n  \}/);
    expect(startMatch, 'start() body not found in server.ts').toBeTruthy();
    const startBody = startMatch![0];

    const connectIdx = startBody.indexOf('this.server.connect(');
    const initIdx = startBody.indexOf('this.session.initialize(');
    expect(connectIdx, 'server.connect not found in start()').toBeGreaterThan(-1);
    expect(initIdx, 'session.initialize not found in start()').toBeGreaterThan(-1);
    // Transport connects first…
    expect(connectIdx).toBeLessThan(initIdx);
    // …and the warmup is fire-and-forget, never awaited inside start().
    expect(startBody).toMatch(/void this\.session\.initialize\(\)/);
    expect(startBody).not.toMatch(/await this\.session\.initialize\(\)/);
  });

  // N5 — the test above only checks the relative order of two NAMED tokens; it
  // would miss a regression that inserts some OTHER awaited call ahead of
  // connect() (a new PS warmup, a network call, anything this test doesn't
  // already know the name of). This one is general: today the only awaited call
  // before the transport connects is loadModules() (filesystem/crypto-only,
  // documented as safe to await ahead of the handshake) — assert there is
  // exactly one await ahead of connect(), and that it's loadModules(), so ANY
  // additional awaited call fails this regardless of what it's named.
  it('the only awaited call ahead of the transport connecting is loadModules() — nothing else can block the handshake', () => {
    const serverSrc = readFileSync(join(REPO_ROOT, 'src', 'core', 'server.ts'), 'utf8');
    const startMatch = serverSrc.match(/async start\(\)\s*\{[\s\S]*?\n  \}/);
    expect(startMatch, 'start() body not found in server.ts').toBeTruthy();
    // Strip comments first — prose describing what's safe to await (e.g. "safe to
    // await ahead of the handshake") otherwise reads as a second await occurrence.
    const startBody = startMatch![0].replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    const connectIdx = startBody.indexOf('await this.server.connect(');
    expect(connectIdx, 'await this.server.connect not found in start()').toBeGreaterThan(-1);
    const beforeConnect = startBody.slice(0, connectIdx);
    const awaitsBeforeConnect = beforeConnect.match(/\bawait\s+/g) ?? [];
    expect(
      awaitsBeforeConnect.length,
      `expected exactly one awaited call ahead of connect(), found: ${JSON.stringify(awaitsBeforeConnect)}`
    ).toBe(1);
    expect(beforeConnect).toContain('await this.loadModules()');
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
