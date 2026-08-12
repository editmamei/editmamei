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
import { markRawOpened, clearPendingRawDevelop } from './raw-develop-state.js';
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
 * First-run disclosure (see docs/privacy.md, "What you control"). The MCP server has no UI, so the
 * one place we can plainly state what Category-A telemetry collects + how to opt out is
 * stderr on the run that creates settings.json. Content-never guarantee stated up front.
 */
const FIRST_RUN_DISCLOSURE =
  'First run: Editmamei collects anonymous, content-free usage telemetry (tool name, ' +
  'success, duration, version/edition/OS/PS-version, install channel) to find what breaks. ' +
  'It never sends image content, file paths, or personal data. Opt out anytime: ' +
  '`editmamei config set telemetry.usage false` (or edit ~/.editmamei/settings.json). ' +
  'Opt in to sanitized diagnostics: `editmamei config set telemetry.diagnostics true`.';

/**
 * Timeout for the background ps_version probe (resolveLiveVersionInBackground) —
 * deliberately short. This is a telemetry nicety piggybacking on an already-successful
 * tool call, and it rides the SAME FIFO script queue every other tool call goes
 * through (ScriptQueue in platform/script-queue.ts); left at the runners' 30s
 * DEFAULT_SCRIPT_TIMEOUT_MS default, a stuck probe would hold up the user's NEXT
 * command behind it for up to 30s. A normal pingState round trip takes ~1.2s; 3s
 * leaves generous headroom for a slow machine. Worst-case queue occupancy is this
 * value PLUS the runner's SIGTERM kill grace (killGraceMs, 2s — see run-child.ts)
 * before a timed-out probe actually releases the queue, so ~5s, not 3s — still a
 * large improvement over the 30s default. Abandoning the probe when Photoshop is
 * slow to answer is strictly better than making a real user wait on it — the
 * version just stays 'unknown' a while longer, which is honest, not wrong.
 */
export const BACKGROUND_VERSION_PROBE_TIMEOUT_MS = 3_000;

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
  /**
   * Latest known Photoshop version string, in the LIVE-queried format (e.g. `'27.8.0'`) —
   * the same value space `ps_ping`'s pingState round trip produces. `ps_ping` sets this
   * from its own live query; a session that never calls `ps_ping` gets it from
   * `resolveLiveVersionInBackground` instead, fired opportunistically the first time
   * some OTHER successful tool call proves Photoshop was genuinely reached (see the
   * `onCall` hook below) — without that, telemetry's `ps_version` would report
   * `'unknown'` for the whole session despite genuinely driving Photoshop.
   *
   * Never stamped from `PhotoshopConnection.getPhotoshopInfo()` OR `.getVersion()` —
   * both read the same pure disk/registry detection (on Windows: a release year or a
   * bare version parsed out of the install path), a DIFFERENT, incompatible value space
   * from the live one. `pingPhotoshop()`'s own build()-failure-but-alive degraded branch
   * is the one path that can otherwise leave `version` at `getVersion()`'s fallback
   * without a live pingState result to overwrite it — see `versionIsLive` there. If a
   * FUTURE change adds another way to resolve `version`, it must set an equivalent
   * "this came from a live query" flag before this field is stamped from it, or repeat
   * this exact bug. Mixing the two value spaces corrupts the ps_version-keyed rollups
   * downstream.
   */
  private psVersion: string | null = null;
  /**
   * Whether the most recent `ps_ping` call actually reached Photoshop — a telemetry-only
   * signal, orthogonal to the MCP response shape. `pingPhotoshop()` returns a normal
   * (non-`isError`) content payload on both the connected and not-connected paths (so the
   * user sees a helpful "not connected" message, not an alarming tool failure), which means
   * the registry's own success flag can't tell the two apart. Reset to `null` as the very
   * first thing every `pingPhotoshop()` call does, so an unexpected throw ahead of the
   * branch that would set it falls back to the registry's own (correctly-false) success
   * signal instead of reusing a stale value from a PRIOR ping.
   *
   * LOAD-BEARING ordering: the `onCall` hook below reads this field synchronously, in the
   * same microtask turn `pingPhotoshop()`'s return resolves — `ToolRegistry.execute()` has
   * no `await` between receiving the handler's result and invoking `onCall` in its
   * `finally` block. That is what makes a shared instance field safe as a side channel
   * between one `ps_ping` call and its own `onCall` invocation. Inserting an `await`
   * anywhere in that span would let a second, concurrent `ps_ping` call's assignment
   * interleave and be read by the first call's `onCall` instead of its own.
   */
  private lastPingReachedPs: boolean | null = null;
  /**
   * One-shot latch for `resolveLiveVersionInBackground` — set only once we
   * actually commit to a round trip (Photoshop confirmed running RIGHT NOW),
   * and never cleared after that, whether the round trip succeeds or fails.
   * This is "at most one ROUND TRIP per session," not an in-flight lock and not
   * "at most one CHECK": a session where the one round trip fails leaves
   * psVersion at 'unknown' for the rest of the session, rather than re-firing a
   * fresh pingState round trip off every later successful tool call for as long
   * as Photoshop stays unreachable.
   *
   * Deliberately NOT set on a DECLINE (Photoshop not currently running) — that
   * path costs one cheap process check and never touches the script queue, so
   * it doesn't need the same one-shot budget as a real attempt. Latching on
   * decline would mean: Photoshop quits, a local-only tool call declines the
   * probe and (if latched here) permanently spends the session's only shot,
   * then the user reopens Photoshop and works for an hour without ever calling
   * ps_ping — ps_version stays 'unknown' for a session that genuinely drove
   * Photoshop the whole time. See resolveLiveVersionInBackground for the full
   * shape: callers that pass the initial guard together converge on a
   * check-and-set at the commit point, so exactly one round trip runs.
   */
  private liveVersionResolutionAttempted = false;
  /** A newer published version, if the boot-time check found one. Surfaced on ps_ping. */
  private updateInfo: UpdateInfo | null = null;
  // The host/community Go snippet core seam — the CE go-core binary, used by the
  // CE module's tools, by the Pro module's composite client as the fallback for
  // the community snippets its handlers build, and by the server's own pingState
  // read (pingPhotoshop).
  private snippetClient = new GoSnippetClient();
  /**
   * Fires the self-gating license staleness refresh on every ps_ping.
   * Long-lived Claude Desktop hosts can cross the staleness line (and
   * eventually the grace cliff) without ever restarting to hit the boot
   * refresh. Outbound traffic is bounded twice: refreshIfStale's cache
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
        // Opportunistic ps_version resolution (see the field doc above): once some
        // OTHER successful tool call has proven the connection genuinely reached
        // Photoshop AT SOME POINT, offer the one-shot background live-version probe
        // a chance to fire. hasReachedPhotoshop() is sticky (stays true even after
        // Photoshop later quits), so it alone does NOT guarantee the probe can't
        // launch Photoshop — resolveLiveVersionInBackground closes that with its own
        // isCurrentlyRunning() check immediately before touching the connection. The
        // gate here is what keeps a tool call that never touched Photoshop at all
        // (ps_list_capabilities, template listing) from being the thing that offers
        // the FIRST chance to probe. Excludes ps_ping: its handler reports success
        // even when it never reached Photoshop (see lastPingReachedPs above), so its
        // own success flag can't be trusted the way every other tool's can — ps_ping
        // resolves psVersion itself, from the same live query, only on the
        // genuinely-connected path.
        if (entry.success && entry.tool !== 'ps_ping' && this.psVersion === null) {
          if (this.session.getConnection().hasReachedPhotoshop()) {
            this.resolveLiveVersionInBackground();
          }
        }
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
        // ps_ping's registry-level success is not the right signal for telemetry — see
        // lastPingReachedPs above — so it can DOWNGRADE entry.success to false here.
        // Deliberately never upgrades: if the handler genuinely threw AFTER already
        // setting lastPingReachedPs = true (entry.success false, field stale-true), the
        // real failure must still win — telemetry success only overrides true → false,
        // never false → true.
        const telemetrySuccess =
          entry.tool === 'ps_ping' && this.lastPingReachedPs === false ? false : entry.success;
        const errorClass = classifyError(entry.error);
        this.telemetry.recordCall({
          tool: entry.tool,
          success: telemetrySuccess,
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
   * tested without a transport. It is the DoS guard: a thrown handler
   * (or an unknown tool name, which the registry throws on) is converted into a
   * clean `{ isError: true }` result instead of propagating out and tearing down
   * the long-lived stdio server. @internal — exercised directly by server tests.
   */
  private async handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = await this.toolRegistry.execute(name, args);
      // Update session activity
      this.session.updateActivity();
      this.trackRawDevelopState(name, result);
      return result;
    } catch (error) {
      this.logger.error(`Tool execution failed: ${name}`, error);
      return toolErrorResult('Error', error);
    }
  }

  /**
   * Maintain the one-slot "raw opened, no develop pass yet" flag off the
   * dispatch stream (see raw-develop-state.ts). Lives here rather than in the
   * onCall observer so it has synchronous access to the registry: the flag is
   * only ever set when a camera-raw develop tool is actually registered, so a
   * session without one never sees advisories about a tool it can't call.
   */
  private trackRawDevelopState(name: string, result: ToolResult): void {
    if (result.isError) return;
    if (name === 'ps_open_document') {
      const sc = result.structuredContent as { is_raw_source?: unknown } | undefined;
      if (sc?.is_raw_source === true && this.toolRegistry.get('ps_apply_camera_raw')) {
        const opened = sc as { document_name?: unknown; file_path?: unknown };
        markRawOpened(String(opened.document_name ?? ''), String(opened.file_path ?? ''));
      } else {
        // The active document changed to a non-raw one — one slot, so any
        // pending flag now refers to a document that is no longer active.
        clearPendingRawDevelop();
      }
    } else if (name === 'ps_apply_camera_raw' || name === 'ps_close_document') {
      clearPendingRawDevelop();
    }
  }

  /**
   * One-shot, fire-and-forget live-version resolution for sessions that drive
   * Photoshop without ever calling `ps_ping`. Reuses the exact same `pingState`
   * round trip `ps_ping` itself uses, so the resolved value lands in the SAME
   * live-queried format (`'27.8.0'`) — never the disk-detected install record.
   *
   * Ordering is deliberate and load-bearing:
   *
   * 1. `snippetClient.build('pingState')` runs FIRST. It's a pure function of
   *    (binary, name, params) with no Photoshop dependency, so it's safe ahead
   *    of the liveness check — and `GoSnippetClient` memoizes it in-process, so
   *    every call after the session's first pays a Map lookup, not a subprocess
   *    spawn. Building first — rather than between the check and the act —
   *    shrinks the check-then-act window below to promise plumbing only.
   * 2. `isCurrentlyRunning()` — a direct, non-launching process check — runs
   *    immediately before the round trip. `hasReachedPhotoshop()` (checked by
   *    the `onCall` caller before this method is even invoked) is STICKY and
   *    never resets, so it stays true long after Photoshop quits; without this
   *    second, live check here, a probe firing after the user closed Photoshop
   *    would fall into `executeScript`'s `ensureRunning()` and silently
   *    relaunch it. This NARROWS that window rather than closing it: if
   *    Photoshop quits between the check passing and `executeScript` running,
   *    `ensureRunning()` can still launch it. Closing it outright would mean a
   *    never-launch mode threaded through `executeScript`, which no caller has
   *    needed yet. A `false` here is a DECLINE, not a failed attempt — see
   *    below.
   * 3. `liveVersionResolutionAttempted` is set ONLY once we commit to the round
   *    trip (step 2 passed) — never on a decline. A decline costs one cheap
   *    process check and never touches the script queue, so it doesn't spend
   *    the one-shot budget: the NEXT successful tool call, whenever Photoshop
   *    is next confirmed running, gets its own chance. Latching on a mere
   *    decline would strand a session that quits-then-reopens Photoshop at
   *    `ps_version: 'unknown'` even after an hour of genuine, un-pinged use —
   *    exactly the corruption this mechanism exists to prevent. See the field
   *    doc for the full scenario.
   *
   * Concurrency: the latch is set inside the async body, not synchronously at
   * the top, so several tool calls whose `onCall` fires in the same short
   * window can all pass the initial guard at line 1. They converge on the
   * check-and-set in step 3, which has no `await` between the read and the
   * write — so exactly one wins and the rest return without touching the
   * script queue. Each write to `psVersion` is separately guarded by its own
   * `=== null` check, so even a losing caller cannot install a mixed or stale
   * value.
   *
   * Best-effort throughout: any failure (including a decline) just leaves the
   * session at the honest `'unknown'` placeholder rather than a guessed value.
   */
  private resolveLiveVersionInBackground(): void {
    if (this.liveVersionResolutionAttempted || this.psVersion !== null) return;
    void (async () => {
      try {
        const connection = this.session.getConnection();
        const snippet = await this.snippetClient.build('pingState');
        if (!(await connection.isCurrentlyRunning())) return; // decline — latch NOT spent
        // Re-check after the two awaits above, against the same pair of conditions as the
        // entry guard: another probe may have committed, or a concurrent ps_ping may have
        // resolved the version outright (it sets psVersion without touching this latch),
        // in which case there is nothing left to go and fetch. This check and the
        // assignment below have no await between them, so exactly one caller can win the
        // latch no matter how many reach this point.
        if (this.liveVersionResolutionAttempted || this.psVersion !== null) return;
        this.liveVersionResolutionAttempted = true; // committed to the round trip
        const state = (await runScript(
          connection,
          snippet,
          BACKGROUND_VERSION_PROBE_TIMEOUT_MS
        )) as { version?: string };
        if (state.version && state.version !== 'Unknown' && this.psVersion === null) {
          this.psVersion = state.version;
          void this.sessionLog.setPsVersion(state.version);
          this.telemetry.onPsVersionResolved();
        }
      } catch (err) {
        this.logger.debug(
          `background ps_version resolution failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })();
  }

  private async pingPhotoshop() {
    // Reset the telemetry-only reached-Photoshop signal — see the field doc. Every
    // branch below that returns sets it explicitly; this default only survives an
    // unexpected throw ahead of all of them, in which case onCall falls back to the
    // registry's own (correctly-false) success flag rather than a stale prior value.
    // Placed before everything else in this method, including the license refresh
    // below, so nothing can throw ahead of it.
    this.lastPingReachedPs = null;

    // Piggyback a once-per-process license staleness refresh here (not
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
    // Tracks whether `version` came from the LIVE pingState query below, as opposed to
    // staying at connection.getVersion()'s disk-detected fallback from the try/catch
    // right after this block. Gates the psVersion (telemetry) stamp near the end of this
    // method — see there — but does NOT affect this response's own `version` field: the
    // disk-detected fallback in the text/structuredContent below is pre-existing,
    // user-facing behavior, unrelated to telemetry's value-space requirement.
    let versionIsLive = false;

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
        this.lastPingReachedPs = false;
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
        this.lastPingReachedPs = false;
        return {
          content: [
            { type: 'text' as const, text: 'Photoshop did not respond' + this.updateNote() },
          ],
          structuredContent: { connected: false, update_available: this.updateInfo },
        };
      }
      if (state.version) {
        version = state.version;
        versionIsLive = true;
      }
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

    // Update the session-log meta line whenever we know SOME version — live or, on the
    // build()-failure-but-alive degraded branch above, connection.getVersion()'s
    // disk-detected fallback. The local NDJSON isn't the telemetry value space and has
    // no mixed-bucket problem to protect, so it's fine to carry the disk value there
    // even though telemetry's psVersion must not. Note this does mean a diagnostics
    // bundle's ps_version can be either format: diagnostics/collect.ts prefers the live
    // value passed in, and falls back to this meta line only when there isn't one.
    // Fire-and-forget — never affects the ping result.
    if (version !== 'Unknown') {
      void this.sessionLog.setPsVersion(version);
    }
    // Telemetry dimensions only ever take the LIVE value — see the psVersion field doc
    // for why mixing in the disk-detected fallback corrupts the ps_version-keyed
    // rollups downstream.
    if (versionIsLive && version !== 'Unknown') {
      this.psVersion = version;
      // Re-stamp the telemetry session-state snapshot now the version is known, so a later
      // hard-kill reconstructs the summary with the real ps_version, not the pre-ping
      // placeholder. Best-effort + content-free; never affects the ping result.
      this.telemetry.onPsVersionResolved();
    }

    // Every path above that didn't already return early DID reach Photoshop — the
    // build-failure branch's degraded fallback included, since it only falls through
    // here after connection.ping() confirmed liveness.
    this.lastPingReachedPs = true;

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
