import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../utils/logger.js';
import { ToolRegistry, type ToolResult } from './tool-registry.js';
import { tierOf } from './tool-tiers.js';
import { groupOf, GROUPS, type ToolGroup } from './tool-groups.js';
import { EDITION } from '../edition.js';
import { VERSION } from '../version.js';
import { Session } from './session.js';
import { SessionLog, classifyError } from '../utils/session-log.js';
import {
  loadSettings,
  applyTelemetryEnvOverrides,
  applyUpdateCheckEnvOverride,
} from './settings.js';
import { TelemetryClient } from '../telemetry/client.js';
import type { ModuleStatusInfo } from '../telemetry/events.js';
import { resolveInstallChannel } from '../install-channel.js';
import { checkForUpdate, shouldCheckForUpdate, type UpdateInfo } from '../update/check.js';
import { join } from 'node:path';
import { GoSnippetClient, coreBinaryName } from '../api/snippet-client.js';
import { isProEntitled } from '../license/entitlement.js';
import { createPingLicenseRefresher } from '../license/ping-refresh.js';
import type { ProvisionOptions } from '../delivery/provision.js';
import { runScript } from '../utils/run-script.js';
import { listTemplates } from '../utils/template-storage.js';
import { toolErrorResult } from '../utils/tool-helpers.js';
import { Kernel } from '../kernel/kernel.js';
import { ceModule } from '../modules/ce/index.js';
import { hostDetectionRuntime } from '../detection/runtime.js';
import { ModuleLifecycle, classifyModuleOutcome } from '../kernel/module-lifecycle.js';
import { unsupportedHostReason } from '../platform/host-platform.js';

// Re-exported for tests + call sites that import the taxonomy from server.ts
// (its historical home) rather than reaching into kernel/module-lifecycle.ts.
export { classifyModuleOutcome };

// Module-scope so the LOG_SCRIPT_ON_ERROR warning fires at most once per
// process boot, no matter how many EditmameiServer instances get
// constructed. Exposed via __resetForTests so unit tests can re-arm it.
let logScriptOnErrorWarned = false;

function warnLogScriptOnErrorOnce(logger: Logger): void {
  if (logScriptOnErrorWarned) return;
  if (process.env.LOG_SCRIPT_ON_ERROR !== '1') return;
  logScriptOnErrorWarned = true;
  logger.warn(
    'LOG_SCRIPT_ON_ERROR=1 is set. Failing scripts will be dumped in full ' +
      'to stderr including any interpolated args (file paths, layer names, ' +
      'pasted code). Unset the env var before sharing terminal output.'
  );
}

/** Test-only — re-arm the one-shot warn so each test can verify it. @internal */
export function __resetLogScriptOnErrorWarnForTests(): void {
  logScriptOnErrorWarned = false;
}

/**
 * First-run disclosure (telemetry-and-settings.md §8). The MCP server has no UI, so the
 * one place we can plainly state what Category-A telemetry collects + how to opt out is
 * stderr on the run that creates settings.json. Content-never guarantee stated up front.
 */
const FIRST_RUN_DISCLOSURE =
  'First run: Editmamei collects anonymous, content-free usage telemetry (tool name, ' +
  'success, duration, version/edition/OS/PS-version, install channel) to find what breaks. ' +
  'It never sends image content, file paths, or personal data. Opt out anytime: ' +
  '`editmamei config set telemetry.usage false` (or edit ~/.editmamei/settings.json). ' +
  'Opt in to sanitized diagnostics: `editmamei config set telemetry.diagnostics true`.';

export class EditmameiServer {
  private server: Server;
  private logger: Logger;
  private toolRegistry: ToolRegistry;
  private session: Session;
  private sessionLog: SessionLog;
  private telemetry: TelemetryClient;
  /** The kernel — owns the registry, module loader, and invokeTool broker. Set in registerTools(). */
  private kernel!: Kernel;
  /**
   * Owns resolving/loading the Pro module, the module_status classification, and
   * the self-heal/freshness background tasks (see kernel/module-lifecycle.ts). Set
   * in registerTools(); `moduleSkipReason` below forwards its skip-reason state for
   * callers (and tests) that reached `this.moduleSkipReason` before the extraction.
   */
  private moduleLifecycle!: ModuleLifecycle;
  /**
   * Forwards to `this.moduleLifecycle.moduleSkipReason` — see ModuleLifecycle for
   * the full doc. Public only as a test seam (server-module-load.test.ts asserts
   * on it); `private` trips TS6133 under the build config since the S5 extraction
   * moved every production reader into ModuleLifecycle.
   * @internal
   */
  get moduleSkipReason(): 'corrupt' | 'incompatible' | null {
    return this.moduleLifecycle.moduleSkipReason;
  }
  /** Latest known Photoshop version string; populated on first successful ping. */
  private psVersion: string | null = null;
  /** A newer published version, if the boot-time check found one. Surfaced on ps_ping. */
  private updateInfo: UpdateInfo | null = null;
  // The host/community Go snippet core seam — the CE go-core binary, used by the
  // CE module's tools, by the Pro module's composite client as the fallback for
  // the community snippets its handlers build, and by the server's own pingState
  // read (pingPhotoshop).
  private snippetClient = new GoSnippetClient();
  /**
   * WO-7 — fires the self-gating license staleness refresh on every ps_ping.
   * Long-lived Claude Desktop hosts can cross the staleness line (and
   * eventually the grace cliff) without ever restarting to hit the boot
   * refresh (WO-1). Outbound traffic is bounded twice: refreshIfStale's cache
   * age gate (fresh → local no-op) and the trigger's own attempt throttle
   * (PING_REFRESH_MIN_INTERVAL_MS, covering the persistent-failure case).
   * Fire-and-forget, so it adds zero latency to the ping, and a hard no-op
   * under the test runner.
   */
  private readonly refreshLicenseOnPing = createPingLicenseRefresher();

  constructor() {
    this.logger = new Logger('EditmameiServer');
    this.session = new Session();

    // Session-level NDJSON tool-call log at ~/.editmamei/sessions/<id>.ndjson.
    // The registry's onCall hook fires after every dispatch; the log writes
    // are fire-and-forget so telemetry can never break a tool call.
    this.sessionLog = new SessionLog(this.session.getSessionId());
    this.logger.info(`Session ${this.session.getSessionId()} → ${this.sessionLog.path}`);

    // Telemetry client (content-free, consent-gated, fire-and-forget). loadSettings mints
    // the anonymous install_id on first run and never throws; the client is inert in the
    // dev edition and under the test runner, so this is a no-op outside CE/Pro builds.
    const { settings, created } = loadSettings();
    // In Claude Desktop (no terminal for `editmamei config`), the .mcpb manifest's telemetry
    // toggles arrive as env vars and override consent for this process; settings.json still
    // stands on the npm / CLI path. File stays the source of truth (override is in-memory).
    const effectiveSettings = applyUpdateCheckEnvOverride(applyTelemetryEnvOverrides(settings));
    this.telemetry = new TelemetryClient({
      settings: effectiveSettings,
      getPsVersion: () => this.psVersion,
      // Runtime entitlement, NOT the build edition: the shipped host is always
      // EDITION='community' and Pro is a downloaded module, so without this every
      // event mis-reports 'community'. isProEntitled() is a cached read, correct here
      // (maybeActivateFromEnv already ran in index.ts) and stable for the session.
      edition: isProEntitled() ? 'pro' : 'community',
      channel: resolveInstallChannel(),
      // Read at start() time (a getter), after loadModules() has settled proModule +
      // moduleSkipReason. Null for a pure-CE install → no module_status event.
      getModuleStatus: () => this.computeModuleStatus(),
    });
    if (created) this.logger.info(FIRST_RUN_DISCLOSURE);

    // Boot-time update check (opt-out via settings.update_check; never under the test
    // runner). One anonymous, content-free GET to the npm registry, fire-and-forget — the
    // result rides ps_ping (an MCP server's stderr never reaches the user, a tool
    // result does). checkForUpdate is fail-silent, so this never throws and never blocks boot.
    if (shouldCheckForUpdate(effectiveSettings.update_check)) {
      void checkForUpdate().then((info) => {
        this.updateInfo = info;
      });
    }

    // LOG_SCRIPT_ON_ERROR=1 dumps fully-interpolated ExtendScript on every
    // failed call, including any string args (file paths, layer names,
    // freeform text). Surface the privacy implication once per process
    // (NOT per server instance — tests + hosts that re-instantiate would
    // otherwise spam stderr). Pre-Bundle-H this warning lived only in a
    // code comment inside platform/connection.ts and never reached users
    // who enabled the flag.
    warnLogScriptOnErrorOnce(this.logger);

    this.toolRegistry = new ToolRegistry({
      onCall: (entry) => {
        // Local NDJSON evidence log — fire-and-forget (append never throws).
        void this.sessionLog.append(
          {
            tool: entry.tool,
            args: entry.args,
            success: entry.success,
            duration_ms: entry.duration_ms,
            ...(entry.error ? { error: entry.error } : {}),
          },
          entry.result
        );
        // Tee the same call into content-free telemetry (Category A, opt-out). Failures
        // additionally feed an opt-in Category-B diagnostic (sanitized message). Both are
        // gated/inert inside the client; nothing here can throw into the tool-call path.
        const errorClass = classifyError(entry.error);
        this.telemetry.recordCall({
          tool: entry.tool,
          success: entry.success,
          duration_ms: entry.duration_ms,
          error_class: errorClass,
        });
        if (!entry.success && entry.error) {
          this.telemetry.recordDiagnostic({
            tool: entry.tool,
            error_class: errorClass ?? 'other',
            error_message: entry.error,
          });
        }
      },
    });

    this.server = new Server(
      {
        name: 'editmamei',
        // Sourced from src/version.ts (hand-synced with package.json). The
        // hardcoded '0.2.0' that lived here pre-2026-06-07 was never
        // refreshed during release work and MCP clients logged a stale
        // identifier for support cases.
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Register a lazy getter for the MCP client identity. The initialize
    // handshake populates _clientVersion before any tool calls fire, so
    // by the time the first `append` triggers meta-line emission the
    // client name + version are available.
    const srv = this.server as unknown as {
      getClientVersion?(): { name: string; version: string } | undefined;
    };
    this.sessionLog.setMcpClientGetter(() => srv.getClientVersion?.() ?? null);

    this.registerTools();
    this.setupHandlers();
  }

  private registerTools() {
    // Register basic tools
    this.toolRegistry.register('ps_ping', {
      tool: {
        name: 'ps_ping',
        description:
          'Test connection to Photoshop and report session-start discovery signals. Read-only and idempotent. Call this once at the start of a session to confirm liveness before invoking any other tool. **If the user has given you an open-ended editing task, ALSO call `ps_overview` after this** — it returns the workflow contract + capabilities map + verification primitives so you can plan well. Returns `version` (folds the removed get-version tool), `custom_action_sets` (count of Action Sets loaded in the Photoshop Actions palette — non-zero means recorded workflows exist; if action tools are available in this build they will appear in `tools/list`), `user_templates` (count of saved Editmamei templates), and `open_documents` (names of documents already open in Photoshop, so the LLM does not have to ask which doc to edit).',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        outputSchema: {
          type: 'object',
          properties: {
            connected: { type: 'boolean' },
            version: { type: 'string' },
            custom_action_sets: { type: 'number' },
            user_templates: { type: 'number' },
            open_documents: { type: 'array', items: { type: 'string' } },
            degraded: {
              type: 'array',
              items: { type: 'string' },
              description:
                'List of optional discovery signals that could not be gathered (e.g. "pingState" if the go-core snippet builder itself failed to produce the in-PS state script — a broken/missing local install, unrelated to whether Photoshop is reachable; liveness falls back to a cheap ping probe in that case — "templates" if ~/.editmamei/templates was unreadable). Empty when all signals were collected cleanly. Returned defaults for any degraded field cannot be trusted as ground truth.',
            },
            update_available: {
              type: ['object', 'null'],
              description:
                'Set when a newer Editmamei version is published, else null. When present, TELL THE USER: relay current → latest and how_to_update verbatim. { current, latest, channel (npm/mcpb/dev), how_to_update }. Anonymous npm-registry check at boot; opt out with `editmamei config set update_check false`.',
              properties: {
                current: { type: 'string' },
                latest: { type: 'string' },
                channel: { type: 'string' },
                how_to_update: { type: 'string' },
              },
            },
          },
        },
        annotations: {
          title: 'Ping Photoshop',
          readOnlyHint: true,
          idempotentHint: true,
        },
      },
      handler: async () => await this.pingPhotoshop(),
    });

    // ps_list_capabilities — a read-only, LIVE map of the whole tool
    // surface organized by capability group (each group's purpose + the tools
    // registered in it, for this build/edition). Complements ps_overview
    // ("how to work") and tools/list (full schemas): a compact "what exists"
    // index to re-orient mid-session, especially in clients that defer tool
    // schemas via search. Host-level meta-tool, registered ad-hoc like ping.
    this.toolRegistry.register('ps_list_capabilities', {
      tool: {
        name: 'ps_list_capabilities',
        description:
          'Live map of every tool this MCP exposes, grouped by capability — each group is a one-line purpose plus the tool names in it. Read-only and cheap. Reach for it to re-orient mid-session (what exists, what to reach for) when the overview brief has scrolled out of context, or to learn which tool names to look up. ps_overview tells you HOW to combine tools; this tells you WHAT exists, currently; tools/list has the full schema for any one you pick.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
          type: 'object',
          properties: {
            tool_count: { type: 'number' },
            group_count: { type: 'number' },
            groups: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  purpose: { type: 'string' },
                  tools: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        annotations: {
          title: 'List Capabilities',
          readOnlyHint: true,
          idempotentHint: true,
        },
      },
      handler: async () => this.listCapabilities(),
    });

    // The old dedicated version-check tool was removed on 2026-05-31 —
    // `ps_ping` already returns the version string.

    // Feature tools are owned by modules and loaded through the kernel.
    // The kernel contains no tools — only the registry, the loader, and the
    // invokeTool broker. The CE module
    // is the free built-in tool set, loaded synchronously here. The Pro module
    // is a DOWNLOADED module: dynamically imported in `loadModules()` (from
    // start()), never statically linked into the host bundle.
    // Module-lifecycle: resolving where the Pro module loads from, the load
    // itself, module_status classification, and the self-heal/freshness
    // background tasks all live in ModuleLifecycle (kernel/module-lifecycle.ts).
    // resolveProModule() must run BEFORE the Kernel is constructed — its
    // resolveModuleSnippet closure below needs the resolved location's binDir —
    // so the Kernel is threaded into the lifecycle afterwards via setKernel().
    this.moduleLifecycle = new ModuleLifecycle({
      toolRegistry: this.toolRegistry,
      logger: this.logger,
      assertToolsClassified: () => this.assertToolsClassified(),
    });
    const proModule = this.moduleLifecycle.resolveProModule();
    this.kernel = new Kernel({
      registry: this.toolRegistry,
      connection: this.session.getConnection(),
      snippet: this.snippetClient,
      // The host's local-vision ONNX runtime, handed to downloaded modules as
      // `HostApi.detection` so their detectors reuse the host's configured
      // onnxruntime-web + CE weights instead of resolving from their relocated
      // bundle.
      detection: hostDetectionRuntime(),
      // A module that declares its own go-core snippets (the Pro module) is
      // built by its OWN binary; the kernel composes that with the host binary
      // for the community snippets its handlers also build. The Pro binary
      // (resolved alongside the module location) carries only Pro JSX, so the
      // two arms genuinely diverge: Pro snippets → Pro binary, community
      // snippets → host binary. A module with no own snippets (CE) — or no
      // resolved Pro module — uses the host/community client directly.
      resolveModuleSnippet: (manifest) =>
        manifest.goCoreSnippets && manifest.goCoreSnippets.length > 0 && proModule
          ? new GoSnippetClient({ binaryPath: join(proModule.binDir, coreBinaryName()) })
          : null,
      sessionId: this.session.getSessionId(),
      logger: this.logger,
    });
    this.moduleLifecycle.setKernel(this.kernel);
    this.kernel.loadBuiltins([ceModule]);
    this.assertToolsClassified();

    this.logger.info(`Registered ${this.toolRegistry.count()} tools (edition: ${EDITION})`);
  }

  // resolveProModule, loadModules, computeModuleStatus, reprovisionIfModuleSkipped,
  // and ensureEntitledModuleFresh now live in ModuleLifecycle
  // (src/kernel/module-lifecycle.ts). The wrapper methods below keep the same
  // names so start()'s boot-order sequence and existing tests that reach through
  // the server instance (`server.loadModules()`, `server.moduleSkipReason`, etc.)
  // are unaffected.
  /**
   * @internal exposed for tests so they can register the Pro surface without
   * booting the stdio transport. Delegates to `ModuleLifecycle.loadModules` — see
   * there for the ABI gate / rollback nets and the filesystem-only boot-ordering
   * contract this must keep (awaited in start() BEFORE the transport connects).
   */
  async loadModules(): Promise<void> {
    return this.moduleLifecycle.loadModules();
  }

  /**
   * Boot-time Pro-module outcome for the `module_status` telemetry event. Delegates
   * to `ModuleLifecycle.computeModuleStatus` — see there for the taxonomy. Read at
   * telemetry `start()` time (a getter), after `loadModules()` has settled.
   */
  private computeModuleStatus(): ModuleStatusInfo | null {
    return this.moduleLifecycle.computeModuleStatus();
  }

  /**
   * Background self-heal (v0.22.1) — delegates to
   * `ModuleLifecycle.reprovisionIfModuleSkipped`. MUST run only AFTER the transport
   * connects (the v0.20.0 no-network-before-connect invariant) and stay
   * fire-and-forget in start() — see there.
   */
  private async reprovisionIfModuleSkipped(
    delivery: Pick<ProvisionOptions, 'config' | 'fetchImpl' | 'signingKeys' | 'sleep'> = {}
  ): Promise<void> {
    return this.moduleLifecycle.reprovisionIfModuleSkipped(delivery);
  }

  /**
   * Background Pro-module freshness check (the .mcpb auto-update-gap fix) —
   * delegates to `ModuleLifecycle.ensureEntitledModuleFresh`. Same post-connect,
   * fire-and-forget boot-ordering contract as the self-heal above; mutually
   * exclusive with it on `moduleSkipReason`.
   */
  private async ensureEntitledModuleFresh(
    delivery: Pick<ProvisionOptions, 'config' | 'fetchImpl' | 'signingKeys' | 'sleep'> = {}
  ): Promise<void> {
    return this.moduleLifecycle.ensureEntitledModuleFresh(delivery);
  }

  /**
   * Every registered tool must be classified in src/core/tool-tiers.ts (which
   * EDITION it ships in) AND grouped in src/core/tool-groups.ts (which
   * capability group presents it). Both `tierOf` and `groupOf` throw on unknown
   * names — surface a startup-time error so a newly-added tool that was never
   * tiered or grouped fails fast rather than slipping into the wrong build
   * bundle (or landing ungroupable) silently. Run after each load phase (CE at
   * construction, Pro after dynamic load).
   */
  private assertToolsClassified(): void {
    for (const tool of this.toolRegistry.list()) {
      tierOf(tool.name);
      groupOf(tool.name);
    }
  }

  // ---- Capability map ----

  /**
   * ps_list_capabilities handler — a read-only, LIVE map of the tool
   * surface grouped by capability (each group's purpose + the tool names
   * registered in it, for this build/edition). Groups with no registered tools
   * are omitted. Pure read; no Photoshop, no filesystem, no state.
   */
  private listCapabilities(): ToolResult {
    const registered = this.toolRegistry.list();
    const toolsByGroup = new Map<ToolGroup, string[]>();
    for (const tool of registered) {
      const g = groupOf(tool.name);
      const arr = toolsByGroup.get(g) ?? [];
      arr.push(tool.name);
      toolsByGroup.set(g, arr);
    }
    const groups = (Object.keys(GROUPS) as ToolGroup[])
      .map((id) => ({
        id,
        label: GROUPS[id].label,
        purpose: GROUPS[id].purpose,
        tools: (toolsByGroup.get(id) ?? []).sort(),
      }))
      .filter((g) => g.tools.length > 0);
    const text =
      `Editmamei exposes ${registered.length} tools across ${groups.length} capability groups. ` +
      `This is the live map of WHAT exists; ps_overview is HOW to combine them, and ` +
      `tools/list has the full schema for any one tool.\n\n` +
      groups
        .map((g) => `${g.label} (${g.tools.length}) — ${g.purpose}\n  ${g.tools.join(', ')}`)
        .join('\n');
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: {
        tool_count: registered.length,
        group_count: groups.length,
        groups,
      },
    };
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.logger.debug('Reporting the registered tool surface');
      return {
        tools: this.toolRegistry.list(),
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logger.debug(`Received a call for ${request.params.name}`);
      const args = (request.params.arguments as Record<string, unknown>) || {};
      return this.handleToolCall(request.params.name, args);
    });
  }

  /**
   * The tools/call dispatch wrapper, factored out of setupHandlers so it can be
   * tested without a transport (audit M13). It is the DoS guard: a thrown handler
   * (or an unknown tool name, which the registry throws on) is converted into a
   * clean `{ isError: true }` result instead of propagating out and tearing down
   * the long-lived stdio server. @internal — exercised directly by server tests.
   */
  private async handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = await this.toolRegistry.execute(name, args);
      // Update session activity
      this.session.updateActivity();
      return result;
    } catch (error) {
      this.logger.error(`Tool execution failed: ${name}`, error);
      return toolErrorResult('Error', error);
    }
  }

  private async pingPhotoshop() {
    // WO-7: piggyback a once-per-process license staleness refresh here (not
    // gated on the PS connection — license I/O is independent of Photoshop).
    // Fire-and-forget; never awaited, so the ping result never waits on it.
    this.refreshLicenseOnPing();

    const connection = this.session.getConnection();

    // Discovery-signal fetch. Each branch is independent; failures in one
    // path (e.g. PS hiccup mid-snippet, ~/.editmamei missing) degrade the
    // payload but never break the ping. Track each degraded signal by
    // name so the caller can see which fields it should NOT treat as
    // ground truth — the pre-2026-06-07 ping mixed defaulted-zero values
    // with real reads and the LLM had no way to tell them apart.
    let version = 'Unknown';
    let actionSetsCount = 0;
    let openDocuments: string[] = [];
    const degraded: string[] = [];

    // C3/Q4: getVersion() runs FIRST, ahead of the pingState build/execute
    // below. On the real PhotoshopConnection this call is what populates
    // `photoshopInfo` (connection.getVersion() → detector.detect() caches
    // it there — see src/platform/connection.ts) — load-bearing, not
    // incidental: PhotoshopAPIFactory.createAPI() (inside runScript())
    // throws "Photoshop info not available" whenever getPhotoshopInfo() is
    // still null, and runScript() below wraps this SAME connection
    // instance. Keep this call ahead of anything that reaches runScript().
    try {
      const detected = await connection.getVersion();
      if (detected) version = detected;
    } catch {
      /* fall through with default; pingState may still populate version */
    }

    // C1+C2: build the pingState snippet OUTSIDE the liveness try/catch
    // below. A build() failure means the go-core binary is missing or
    // broken on THIS machine — a packaging/runtime problem with the
    // process, unrelated to whether Photoshop itself is reachable.
    // Conflating the two (the prior shape) misdiagnosed a broken install
    // as "Photoshop not running." Fall back to the cheap connection.ping()
    // probe for liveness instead, and — when that probe says PS IS
    // reachable — surface the missing signal as `degraded: ['pingState']`
    // with zero-valued state fields, the pre-2026-06-07 intermediate
    // shape. When the probe also fails, this collapses to the same
    // "not connected" shape a pingState SCRIPT failure produces below.
    let pingStateSnippet: string | null = null;
    try {
      pingStateSnippet = await this.snippetClient.build('pingState');
    } catch (err) {
      this.logger.warn(
        `pingState snippet build failed (go-core binary missing/broken?): ${err instanceof Error ? err.message : String(err)}`
      );
      const alive = await connection.ping().catch(() => false);
      if (!alive) {
        // On an OS Photoshop does not ship for, "did not respond" reads as a
        // closed application and sends the reader after the wrong fix. The
        // host knows the real reason; say it.
        const reason = unsupportedHostReason();
        return {
          content: [
            {
              type: 'text' as const,
              text: (reason ?? 'Photoshop did not respond') + this.updateNote(),
            },
          ],
          structuredContent: { connected: false, update_available: this.updateInfo },
        };
      }
      degraded.push('pingState');
    }

    // Audit finding 10: pingState IS the liveness probe now, not a
    // second full round trip after a separate connection.ping() ('pong')
    // check. A successful pingState run already proves PS is reachable
    // AND returns the state — the old double-probe paid a full extra PS
    // round trip (~300-700ms) on every ps_ping for a signal pingState
    // already carried. Since there is no longer a cheaper, separate
    // reachability probe on this path, any pingState SCRIPT failure — PS
    // unreachable, a mid-script error, a timeout — still produces exactly
    // the same "not connected" shape the old ping()-false branch did
    // (unlike a build() failure above, which is caught before this point
    // and never reaches here).
    if (pingStateSnippet !== null) {
      let state: { version?: string; action_sets_count?: number; open_documents?: string[] };
      try {
        state = (await runScript(connection, pingStateSnippet)) as {
          version?: string;
          action_sets_count?: number;
          open_documents?: string[];
        };
      } catch (err) {
        this.logger.warn(
          `pingState snippet failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return {
          content: [
            { type: 'text' as const, text: 'Photoshop did not respond' + this.updateNote() },
          ],
          structuredContent: { connected: false, update_available: this.updateInfo },
        };
      }
      if (state.version) version = state.version;
      if (typeof state.action_sets_count === 'number') actionSetsCount = state.action_sets_count;
      if (Array.isArray(state.open_documents)) openDocuments = state.open_documents;
    }

    let userTemplates = 0;
    try {
      const templates = await listTemplates();
      userTemplates = templates.length;
    } catch (err) {
      this.logger.warn(`listTemplates failed: ${err instanceof Error ? err.message : String(err)}`);
      degraded.push('templates');
    }

    // Update ps_version in the session-log meta line + telemetry dimensions once we know
    // it. Fire-and-forget — telemetry must never affect the ping result.
    if (version !== 'Unknown') {
      this.psVersion = version;
      void this.sessionLog.setPsVersion(version);
      // Re-stamp the telemetry session-state snapshot now the version is known, so a later
      // hard-kill reconstructs the summary with the real ps_version, not the pre-ping
      // placeholder. Best-effort + content-free; never affects the ping result.
      this.telemetry.onPsVersionResolved();
    }

    const degradedNote = degraded.length ? ` (degraded: ${degraded.join(', ')})` : '';
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Connected to Photoshop (v${version}). ` +
            `${actionSetsCount} custom action set(s), ${userTemplates} saved template(s), ` +
            `${openDocuments.length} open document(s)${openDocuments.length ? ': ' + openDocuments.join(', ') : ''}` +
            `${degradedNote}.` +
            this.updateNote(),
        },
      ],
      structuredContent: {
        connected: true,
        version,
        custom_action_sets: actionSetsCount,
        user_templates: userTemplates,
        open_documents: openDocuments,
        degraded,
        update_available: this.updateInfo,
      },
    };
  }

  /** A one-line, user-facing "update available" suffix for the ping text, or '' when the
   * boot check found nothing newer (or hasn't completed / is disabled). */
  private updateNote(): string {
    const u = this.updateInfo;
    if (!u) return '';
    return ` Update available: v${u.current} → v${u.latest}. ${u.how_to_update}`;
  }

  async start() {
    // Load downloaded modules (Pro) via dynamic import BEFORE announcing the
    // transport, so the first tools/list already reflects the licensed surface.
    // This is filesystem + crypto work bounded in milliseconds; it never talks to
    // Photoshop, so it is safe to await ahead of the handshake.
    await this.loadModules();

    // Connect the transport FIRST so the MCP `initialize` handshake answers
    // immediately. The Photoshop warmup below MUST NOT gate this: session.initialize()
    // pings Photoshop over osascript/COM, which blocks for the runner's full 30s
    // timeout when PS isn't reachable at boot (closed, launching, or the macOS
    // Automation permission ungranted). Awaiting it here delayed the `initialize`
    // response by ~30s, which Claude Desktop surfaces as "Unable to connect to
    // extension server" (diagnosed 2026-06-27 from the client MCP logs).
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Warm the Photoshop connection in the background — fire-and-forget. Every tool
    // call (and ps_ping) establishes the connection lazily on first use, so
    // nothing here is required for correctness; this just pays the first-connect cost
    // ahead of the first real tool call when PS is already up. connect() swallows its
    // own errors, so an unreachable Photoshop at boot is a silent no-op here. The
    // trailing .catch guards the one path connect() can't — a synchronous throw from
    // the PhotoshopConnection constructor — so it can't surface as an unhandledRejection.
    void this.session.initialize().catch(() => undefined);

    // Background self-heal — the FIRST network of boot, deliberately AFTER connect
    // (v0.20.0 invariant: loadModules stays filesystem/crypto-only; nothing reaches
    // the network before the handshake). No-op unless loadModules flagged a skipped
    // module; fully swallowed, so an offline/lapsed/down delivery just stays Community.
    void this.reprovisionIfModuleSkipped();

    // Background auto-update — the complement to the self-heal on the HEALTHY path:
    // when the on-disk Pro module loaded fine but a NEWER version is published, pull
    // it (closes the .mcpb auto-update gap).
    // Mutually exclusive with the self-heal above (that owns moduleSkipReason !== null),
    // so exactly one runs per boot. Same post-connect, fire-and-forget, swallowed shape.
    void this.ensureEntitledModuleFresh();

    // Start the periodic telemetry flush, and flush a final batch + session summary when
    // the client disconnects. Transport close (stdin EOF) is the session-end signal for
    // clients that close the pipe instead of sending SIGTERM — e.g. Claude Desktop on
    // macOS. We can't await inside onclose, but shutdown()'s in-flight POST (+ its 4s
    // AbortController timer) is a ref'd handle that keeps the event loop alive until the
    // flush completes, so the process exits naturally only AFTER the summary lands. If a
    // SIGTERM also arrives, index.ts's handler awaits shutdown() too — memoized, so it
    // waits on this same flush rather than racing process.exit ahead of it. Both no-ops
    // when telemetry is inert.
    this.telemetry.start();
    // Deliver anything a previous run left in the durable outbox (final batches + a
    // session_summary from a session the host killed before a clean shutdown). Fire-and-
    // forget — runs once now, while the event loop is healthy.
    void this.telemetry.flushOutboxOnStartup();
    this.server.onclose = () => {
      void this.telemetry.shutdown();
    };

    this.logger.info('Editmamei is listening on stdio');
  }

  async stop() {
    await this.telemetry.shutdown();
    await this.session.disconnect();
    // Release the session log's held append handle (opened lazily on first
    // write; harmless if never opened). After close, late fire-and-forget
    // writes no-op by design.
    await this.sessionLog.close();
    this.logger.info('Editmamei has shut down');
  }
}
