/**
 * The Pro-module lifecycle — resolving where a downloaded module loads from, the
 * filesystem/crypto-only boot-time load (with its degrade-to-Community nets), the
 * `module_status` telemetry classification, and the two post-connect background
 * network tasks (self-heal + freshness). Extracted out of `EditmameiServer`
 * (Tier-3 S5b review) so it sits beside the kernel it drives rather than mixed
 * into the host's transport/telemetry/ping concerns.
 *
 * Boot-ordering invariant (v0.20.0) — preserved by the CALLER, not this file:
 * `loadModules()` is filesystem/crypto only (no network) and must be awaited
 * BEFORE the MCP transport connects; `reprovisionIfModuleSkipped` /
 * `ensureEntitledModuleFresh` are the first network of boot and must run
 * fire-and-forget AFTER the transport connects. See `EditmameiServer.start()`.
 */

import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { Logger } from '../utils/logger.js';
import { ToolRegistry } from '../core/tool-registry.js';
import { EDITION } from '../edition.js';
import { resolveProBinaryPath } from '../api/snippet-client.js';
import { isProEntitled } from '../license/entitlement.js';
import {
  loadVerifiedModule,
  readInstalledModule,
  installedPath,
  PRO_SKU,
} from '../delivery/store.js';
import {
  provisionModules,
  compareVersions,
  VERSION_RE,
  type ProvisionOptions,
} from '../delivery/provision.js';
import { readLicense } from '../license/store.js';
import type { ModuleStatusInfo } from '../telemetry/events.js';
import { Kernel } from './kernel.js';
import { HOST_MIN_ABI } from './host-api.js';
import { VERSION } from '../version.js';

/** Where a downloaded module's handlers are imported from + its go-core binary dir. */
export interface ProModuleLocation {
  importer: () => Promise<unknown>;
  binDir: string;
  /**
   * The downloaded module's `InstalledModule.abi`, for the host's `HOST_MIN_ABI`
   * gate. `null` for the dev in-tree module (no pointer, always current — the ABI
   * gate is skipped). Carried here so `loadModules` reads the abi from the exact
   * artifact `resolveProModule` chose, never a stale pointer that a dev fallback
   * would otherwise pick up.
   */
  abi: number | null;
  /**
   * The downloaded module's `InstalledModule.version`, for the forward-compat
   * per-tool degrade in `loadModules` (a module strictly NEWER than this host's
   * `VERSION` gets its unrecognized tools skipped individually rather than
   * rolled back whole). `null` for the dev in-tree module (no pointer — always
   * built against this exact host, so the degrade never applies to it).
   */
  version: string | null;
}

/**
 * Classify the boot-time Pro-module outcome for the `module_status` telemetry event
 * from the settled boot state. Pure (no I/O) so the branching is unit-testable without
 * standing up a server. `loaded` requires a resolved module AND no skip flag; the two
 * skip reasons map straight through; otherwise it's `absent` (entitled, awaiting first
 * provision) vs `lapsed` (a license record exists but is no longer entitled).
 */
export function classifyModuleOutcome(inputs: {
  proModuleLoaded: boolean;
  skipReason: 'corrupt' | 'incompatible' | null;
  entitled: boolean;
}): string {
  if (inputs.proModuleLoaded && inputs.skipReason === null) return 'loaded';
  if (inputs.skipReason === 'corrupt') return 'skipped_corrupt';
  if (inputs.skipReason === 'incompatible') return 'skipped_incompatible';
  return inputs.entitled ? 'absent' : 'lapsed';
}

export interface ModuleLifecycleDeps {
  toolRegistry: ToolRegistry;
  logger: Logger;
  /**
   * Every registered tool must be classified (tier + group) — thrown on an
   * unknown name. Injected so the CE-builtins load (host's registerTools) and
   * the Pro dynamic-load path (`loadModules`, under rollback) share the SAME
   * assertion rather than two copies drifting apart.
   */
  assertToolsClassified: () => void;
  /**
   * THE single source of the classification rule (tier + group), for exactly
   * ONE name — throws when unclassified. `assertToolsClassified` above loops
   * this over the whole registry; `loadModules`'s Net 2b forward-compat probe
   * calls it per newly-added tool name so the per-tool check and the
   * whole-registry backstop check the exact same rule rather than two copies
   * drifting apart. Both are injected from the host's single implementation
   * (`EditmameiServer.classifyTool`).
   */
  classifyTool: (name: string) => void;
}

/**
 * Owns the Pro-module lifecycle for one `EditmameiServer` instance. `kernel` is
 * assigned via `setKernel` once the host's `Kernel` exists — `resolveProModule`
 * must run BEFORE the `Kernel` is constructed (its `resolveModuleSnippet` closure
 * needs the resolved location's `binDir`), so the dependency can't be threaded
 * through the constructor.
 */
export class ModuleLifecycle {
  /** Set by the host once its Kernel exists — required before `loadModules()` runs. */
  kernel!: Kernel;
  private _proModule: ProModuleLocation | null = null;
  /**
   * WHY the on-disk Pro module was skipped, or null when there was nothing to
   * skip. Drives the background re-provision (fired AFTER the transport connects
   * — the v0.20.0 no-network-before-connect invariant):
   *   - `'corrupt'`   — entitled + a pointer file exists, but `loadVerifiedModule`
   *                     returned null (bad decrypt / failed signature / a malformed
   *                     or legacy pointer that fails `readInstalledModule`'s shape
   *                     check, e.g. one written before the `abi` field). A
   *                     SAME-version re-download is the cure → re-provision with
   *                     `force`. Set in `resolveProModule` (pure filesystem/crypto).
   *   - `'incompatible'` — a downloaded module that loaded but is too old for this
   *                     host: below `HOST_MIN_ABI`, or its tools failed
   *                     classification and were rolled back. Only a NEWER version
   *                     helps → re-provision without force. Set in `loadModules`.
   * The new module loads on the next restart (no mid-session hot-swap).
   */
  private _moduleSkipReason: 'corrupt' | 'incompatible' | null = null;

  constructor(private readonly deps: ModuleLifecycleDeps) {}

  get proModule(): ProModuleLocation | null {
    return this._proModule;
  }

  get moduleSkipReason(): 'corrupt' | 'incompatible' | null {
    return this._moduleSkipReason;
  }

  setKernel(kernel: Kernel): void {
    this.kernel = kernel;
  }

  /**
   * Resolve where the Pro module loads from, or null when there is none:
   *  1. A provisioned + entitled module → its decrypted install dir
   *     (`~/.editmamei/modules/pro/<version>/`: pro-handlers.mjs + bin/).
   *  2. Dev (EDITION='dev') with no installed module → the in-tree compiled
   *     module + the dev Pro binary (buildGoCoreDev → dist/modules/pro/bin),
   *     so the dynamic-load path is exercised without provisioning.
   *  3. Otherwise (CE, or a Pro build with no module yet) → null.
   */
  resolveProModule(): ProModuleLocation | null {
    if (isProEntitled()) {
      // Boot-time re-verification: re-hash + re-check the Ed25519 signature of the
      // retained artifact against the pinned key and regenerate the decrypted tree
      // before we import it, so a local code-swap between install and boot can't
      // load unverified Pro code. null → Pro stays dark (fail-closed).
      const verified = loadVerifiedModule(PRO_SKU);
      if (verified) {
        // Carry the pointer's abi (HOST_MIN_ABI gate) and version (forward-compat
        // degrade in loadModules). loadVerifiedModule already read + integrity-
        // checked the pointer, so both are present here.
        const installed = readInstalledModule(PRO_SKU);
        this._proModule = {
          importer: () => import(pathToFileURL(verified.handlersPath).href),
          binDir: verified.binDir,
          abi: installed?.abi ?? null,
          version: installed?.version ?? null,
        };
        return this._proModule;
      }
      // Entitled but no verified module. If a pointer FILE exists on disk (in a
      // non-dev build, where the downloaded module is the real source), the
      // install is present-but-CORRUPT — bad decrypt / failed signature / a
      // malformed or legacy (pre-`abi`) pointer that `readInstalledModule`
      // rejects. Flag it so the background self-heal force-re-downloads the SAME
      // version (the cure). Pure filesystem — no network (boot-ordering invariant).
      // In dev the in-tree module below is authoritative, so don't flag.
      if (EDITION !== 'dev' && existsSync(installedPath(PRO_SKU))) {
        this._moduleSkipReason = 'corrupt';
      }
    }
    if (EDITION === 'dev') {
      // The specifier goes through a const so tsc cannot resolve it statically:
      // a Community-only checkout has no `modules/pro` at all, and a literal
      // specifier fails that tree's `tsc` (TS2307) even though this branch
      // never resolves there.
      const inTreeProSpecifier = '../modules/pro/index.js';
      // Only offer the in-tree module when it is actually built. A dev build
      // that has no Pro module on disk — a Community-only checkout, or a tree
      // where `npm run build` has not produced one — has nothing to load, and
      // saying so here is the truth. Claiming a location we cannot import
      // makes `loadModules` fail and warn that the module "could not be
      // loaded", then invites the operator to activate a license, both of
      // which misdescribe a tree that simply does not ship Pro.
      // Probe BOTH extensions: compiled (`dist/kernel/` → `dist/modules/pro/
      // index.js`) and source, since the test runner executes this file as
      // TypeScript, where the sibling is `index.ts` and no `.js` exists yet.
      const inTreePresent = ['../modules/pro/index.js', '../modules/pro/index.ts'].some((rel) =>
        existsSync(new URL(rel, import.meta.url))
      );
      if (!inTreePresent) {
        this._proModule = null;
        return null;
      }
      this._proModule = {
        importer: () => import(inTreeProSpecifier),
        binDir: dirname(resolveProBinaryPath()),
        // Dev in-tree module: always built against this exact host, no pointer —
        // null skips both the ABI gate and the forward-compat degrade.
        abi: null,
        version: null,
      };
      return this._proModule;
    }
    this._proModule = null;
    return null;
  }

  /**
   * Load downloaded modules (the Pro module) via dynamic import — never a static
   * link, so the host bundle carries no Pro code (the CE build prunes it). Called
   * from start() before the transport is announced, so the AI never sees a
   * tools/list missing Pro tools the license entitles. Resolves to the decrypted
   * install dir when provisioned + entitled, else the in-tree dev module (see
   * resolveProModule). Filesystem + crypto only — NO network (the v0.20.0
   * boot-ordering invariant); a stale module is re-provisioned by the background
   * self-heal in start() AFTER the transport connects.
   *
   * Self-healing (v0.22.1): a downloaded module built against an OLDER host
   * contract (e.g. the pre-rename `photoshop_*` tool surface) must NEVER crash the
   * server — the whole process, CE included, used to die when `assertToolsClassified`
   * threw on an unclassifiable tool. Two nets, both degrade to Community + flag a
   * re-provision:
   *   1. ABI gate — skip a module whose `abi` is below `HOST_MIN_ABI` before importing.
   *   2. Rollback — wrap import + classification; on any throw, unregister exactly
   *      the tools this module added (restoring the clean CE surface) and skip it.
   *
   * Forward-compat per-tool degrade (added alongside the above): the OPPOSITE
   * direction — a downloaded module NEWER than this host (e.g. the delivery
   * manifest's `latest` auto-updated ahead of a host that hasn't restarted onto
   * the matching release yet) registers a tool this host's `tool-tiers.ts` /
   * `tool-groups.ts` don't know yet. Rolling back the WHOLE module here is the
   * wrong cure — only this host is stale, and a background re-provision can
   * never fix that (the manifest is already at `latest`; the fix ships in the
   * NEXT host release). So between the import and the whole-module assertion,
   * any tool the module just added that this host can't classify is unregistered
   * ONE AT A TIME, keeping the rest of the module loaded. Gated strictly to a
   * WELL-FORMED module version (matches `VERSION_RE`) that is strictly greater
   * than host `VERSION` — a backward or equal-version module, OR one whose
   * version doesn't even parse as semver, still falls through to the full
   * rollback above, which remains the right cure there (a genuinely
   * older/inconsistent build, where a NEWER module re-provisioned in the
   * background is the fix).
   *
   * Two accepted limitations, deliberately not engineered around:
   *   (a) Dropped tools are NOT dependency-isolated. If a surviving module tool
   *       invokes a dropped sibling via `HostApi.invokeTool`, that call fails at
   *       call time with the ordinary "no such tool" error — an honest failure,
   *       not a crash. Acceptable for adjacent-version drift, where a handful of
   *       new tools calling each other across the exact boundary that triggers
   *       this degrade is a corner of a corner.
   *   (b) A TOTAL degrade — every tool the module added is unknown — leaves the
   *       module "loaded" (skipReason stays null) but contributing nothing,
   *       visible only via the per-tool warns below. Accepted because adjacent
   *       host/module versions never ship an entirely new tool surface in one
   *       step; an all-unknown module is already a much larger version gap than
   *       this net is meant to paper over.
   *
   * @internal exposed for tests so they can register the Pro surface without
   * booting the stdio transport.
   */
  async loadModules(): Promise<void> {
    // No edition gate here: a downloaded module is gated by ENTITLEMENT, not the host's
    // build edition. `resolveProModule` only returns a location when the license is valid +
    // the module is installed (or in dev, where Pro always shows), so a free CE host with no
    // license resolves null and loads nothing — while an entitled CE host loads the downloaded
    // Pro module from its install dir. This is the "install free CE → buy → unlock" path.
    // A null proModule can still carry a 'corrupt' skip reason set in
    // resolveProModule (entitled + a pointer file present but unverifiable) — the
    // self-heal in start() acts on that. Nothing more to load here.
    if (!this._proModule) return;

    // Net 1 — ABI gate. A downloaded module below HOST_MIN_ABI was built against a
    // host contract this build no longer supports; skip it before importing and
    // self-heal. (null abi = the dev in-tree module — always current, never gated.)
    if (this._proModule.abi !== null && this._proModule.abi < HOST_MIN_ABI) {
      this.deps.logger.warn(
        `Pro module (abi ${this._proModule.abi}) is older than this host requires ` +
          `(min abi ${HOST_MIN_ABI}) — booting Community; will re-provision in the background.`
      );
      this._moduleSkipReason = 'incompatible';
      return;
    }

    // Net 2 — load + classify under rollback. Snapshot the FULL (already-classified)
    // CE registry — DEFINITIONS, not names: `register` overwrites on a name
    // collision, so a stale module that re-registers a CE tool name would leave its
    // handler live under that name after a name-only rollback. `restore` puts the
    // exact pre-load CE definitions back.
    const snapshot = this.deps.toolRegistry.snapshot();
    try {
      await this.kernel.loadDownloaded(this._proModule.importer);

      // Net 2b — forward-compat per-tool degrade. Only when the installed module
      // carries a WELL-FORMED version (matches VERSION_RE — same shape provision.ts
      // already requires of a manifest's `latest`) that is STRICTLY NEWER than this
      // host: a backward/equal-version module, or one whose version doesn't even
      // parse as semver, is a genuine incompatibility and still falls through to
      // the full rollback below via assertToolsClassified's throw.
      if (
        this._proModule.version !== null &&
        VERSION_RE.test(this._proModule.version) &&
        compareVersions(this._proModule.version, VERSION) > 0
      ) {
        // Names the module load just added — a name already in the pre-load
        // snapshot is an overwritten CE tool, already classified, and never
        // reaches this probe.
        const added = this.deps.toolRegistry
          .list()
          .map((tool) => tool.name)
          .filter((name) => !snapshot.has(name));
        for (const name of added) {
          try {
            this.deps.classifyTool(name);
          } catch {
            this.deps.toolRegistry.unregister(name);
            this.deps.logger.warn(
              `Module tool '${name}' is not recognized by this host — skipping it; the ` +
                `rest of the module is loaded. Update Editmamei to use it.`
            );
          }
        }
      }

      // Throws if the module registered a tool with no tier/group entry (the
      // pre-rename `photoshop_*` wedge, or anything the degrade above didn't
      // apply to) — caught below and rolled back.
      this.deps.assertToolsClassified();
    } catch (err) {
      // Count truthfully rather than a plain size diff: the forward degrade above
      // may already have unregistered some of the module's own added tools before
      // this throw, which would otherwise make `count() - snapshot.size` read low
      // (even negative). Count names now present that weren't in the pre-load
      // snapshot (survivors of the module's additions) plus names present in both
      // but whose definition changed identity (an overwritten CE tool).
      let changed = 0;
      for (const tool of this.deps.toolRegistry.list()) {
        const prior = snapshot.get(tool.name);
        if (!prior || this.deps.toolRegistry.get(tool.name) !== prior) changed++;
      }
      this.deps.toolRegistry.restore(snapshot);
      this.deps.logger.warn(
        `Pro module could not be loaded on this host — booting Community and rolling back ` +
          `${changed} module tool change(s); will re-provision in the background: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
      this._moduleSkipReason = 'incompatible';
    }
  }

  /**
   * Boot-time Pro-module outcome for the `module_status` telemetry event (Category A,
   * opt-out), or null when this install has no license record — a pure-CE user has no
   * module to report on, so stays silent. Read from telemetry `start()`, AFTER
   * `loadModules()` has settled `proModule` + `moduleSkipReason`, so it reflects what
   * actually happened this boot. Content-free: an enum outcome plus the installed
   * module's own version/abi.
   */
  computeModuleStatus(): ModuleStatusInfo | null {
    // Gate on a license RECORD, not entitlement: a lapsed subscriber (record present but
    // grace-expired) is exactly the case we want visible. A free CE user has no record.
    if (!readLicense()) return null;
    const installed = readInstalledModule(PRO_SKU);
    return {
      module: PRO_SKU,
      outcome: classifyModuleOutcome({
        proModuleLoaded: this._proModule !== null,
        skipReason: this._moduleSkipReason,
        entitled: isProEntitled(),
      }),
      module_version: installed?.version ?? null,
      abi: installed?.abi ?? null,
    };
  }

  /**
   * Background self-heal (v0.22.1). When `loadModules()`/`resolveProModule` skipped
   * the on-disk Pro module, re-fetch it from the delivery service with the cached
   * license key. MUST run only AFTER the transport connects — this is the first
   * network call of the boot, gated by the v0.20.0 no-network-before-connect
   * invariant. Fire-and-forget + fully swallowed: on any failure (offline, license
   * lapsed, delivery down, no cached key) the host simply stays Community. A freshly
   * installed module loads on the NEXT restart — no mid-session hot-swap.
   *
   * The `moduleSkipReason` selects the cure: `'corrupt'` force-re-downloads the SAME
   * version (bad bytes on disk); `'incompatible'` re-provisions WITHOUT force (only a
   * newer version can help — a forced identical re-download would be churn).
   *
   * `delivery` is injected by tests so the re-provision runs without real network;
   * production start() passes nothing (baked delivery config + pinned signing keys).
   */
  async reprovisionIfModuleSkipped(
    delivery: Pick<ProvisionOptions, 'config' | 'fetchImpl' | 'signingKeys' | 'sleep'> = {}
  ): Promise<void> {
    const reason = this._moduleSkipReason;
    if (reason === null) return;
    const license = readLicense();
    if (!license) {
      // No cached key → repair can't help either (it needs the same key). Point at
      // activate, not repair.
      this.deps.logger.warn(
        'A Pro module was skipped but no cached license was found — staying Community. ' +
          'Run `editmamei activate <key>` to restore Pro.'
      );
      return;
    }
    try {
      const prov = await provisionModules(license.key, {
        // 'corrupt' → the current install is unusable; force bypasses the up-to-date
        // skip so the SAME version re-downloads (never weakens verification).
        force: reason === 'corrupt',
        config: delivery.config,
        fetchImpl: delivery.fetchImpl,
        signingKeys: delivery.signingKeys,
        sleep: delivery.sleep,
      });
      if (prov.installed.length > 0) {
        for (const m of prov.installed) {
          this.deps.logger.info(`Pro module updated to v${m.version}, restart to load.`);
        }
        return;
      }
      if (prov.notConfigured) {
        this.deps.logger.warn('Module delivery is not configured — staying Community.');
        return;
      }
      for (const e of prov.errors) {
        this.deps.logger.warn(
          `Could not re-provision the ${e.sku} module (staying Community): ${e.message}`
        );
      }
      if (prov.errors.length === 0) {
        // Nothing installed, no error. Guidance MUST be honest per skip reason —
        // never point at a lever that hits the same wall.
        if (reason === 'incompatible') {
          // A newer version would have installed; there isn't one. `repair` re-runs
          // the identical provision and would skip too — do NOT recommend it.
          this.deps.logger.warn(
            'The published Pro module does not yet support this host version — staying ' +
              'Community. Update Editmamei when a compatible release ships; ' +
              '`editmamei report` files a diagnostic.'
          );
        } else {
          // 'corrupt': a forced same-version reinstall should have installed. Falling
          // here is unusual (manifest no longer lists it, etc.) — repair CAN retry.
          this.deps.logger.warn(
            'Re-provision installed nothing for the corrupt Pro module — staying ' +
              'Community. Try `editmamei repair`; `editmamei report` if it persists.'
          );
        }
      }
    } catch (err) {
      this.deps.logger.warn(
        `Background Pro-module re-provision failed (staying Community): ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Background "ensure the entitled Pro module is the latest" task — the fix for the
   * .mcpb auto-update gap. Once a Pro module is installed, NO automatic boot path
   * re-checked the manifest, so a newer published module was never pulled: the
   * `.mcpb` first-unlock path provisions only
   * when NO module is installed (env-activation.ts), and the self-heal above is
   * skip-gated. A stale-but-loadable module (e.g. an abi-1 module still inside the
   * host's `[HOST_MIN_ABI, KERNEL_ABI]` acceptance window after a SOFT abi bump) is
   * never skipped → never healed → stranded on the old version.
   *
   * This closes that gap by re-running `provisionModules` on the HEALTHY path too.
   * `provisionModules` already decides per-SKU: a version mismatch installs the newer
   * module, an up-to-date pointer is skipped (one manifest GET, no artifact fetch), a
   * downgrade is refused. So this single call covers, with no `force`:
   *   - installed + a newer version published → upgrade (the auto-update gap, Bug A);
   *   - installed + already current            → cheap no-op skip;
   *   - entitled + no module installed yet     → provision (a no-cap safety net that
   *     also dissolves the oversized-module boot-timeout loop, Bug B — a slow/large
   *     first install just finishes here off the critical path and loads next boot,
   *     and covers the npm path where boot never provisions a missing module).
   * The freshly installed module loads on the NEXT restart (the no-hot-swap contract).
   *
   * Deliberately NOT gated on the `update_check` setting: that toggle governs the
   * anonymous npm "is there a newer HOST?" notification, whereas keeping an entitled
   * user's PAID module at the correct version is a correctness/entitlement mechanism,
   * not a notification — and it rides the same license-keyed delivery channel the user
   * already uses (no new network surface). Gated instead on live entitlement +
   * mutually exclusive with the self-heal above (that owns `moduleSkipReason !== null`),
   * so exactly one of the two runs per boot — never a double fetch.
   *
   * Boot-ordering: like the self-heal, this is a post-connect, fire-and-forget,
   * fully-swallowed network call (the v0.20.0 no-network-before-connect invariant).
   * `delivery` is injected by tests so it runs without real network; production
   * start() passes nothing (baked delivery config + pinned signing keys).
   */
  async ensureEntitledModuleFresh(
    delivery: Pick<ProvisionOptions, 'config' | 'fetchImpl' | 'signingKeys' | 'sleep'> = {}
  ): Promise<void> {
    // A skipped module is the self-heal's job — stay mutually exclusive so the two
    // never both fetch the manifest in one boot.
    if (this._moduleSkipReason !== null) return;
    // Only entitled users have a module to keep fresh (a lapsed/free install no-ops).
    if (!isProEntitled()) return;
    // Never poll the delivery service under the test runner unless a fake fetch is
    // injected (mirrors shouldCheckForUpdate — the suite makes no real network calls).
    const underTest = process.env.VITEST !== undefined || process.env.NODE_ENV === 'test';
    if (underTest && !delivery.fetchImpl) return;
    const license = readLicense();
    if (!license) return; // entitled-without-a-cached-key shouldn't happen; provision needs one.
    try {
      const prov = await provisionModules(license.key, {
        // No force: a genuine version mismatch installs; an up-to-date pointer is a
        // no-op skip. force is only for the corrupt-install repair (the self-heal).
        config: delivery.config,
        fetchImpl: delivery.fetchImpl,
        signingKeys: delivery.signingKeys,
        sleep: delivery.sleep,
      });
      for (const m of prov.installed) {
        this.deps.logger.info(`Pro module updated to v${m.version} — restart to load.`);
      }
      // A freshness poll is best-effort: on error/notConfigured we simply stay on the
      // currently-installed module. Log at WARN for support, but recommend no lever
      // (nothing is broken — the existing module still works).
      for (const e of prov.errors) {
        this.deps.logger.warn(
          `Pro-module freshness check could not provision the ${e.sku} module ` +
            `(staying on the installed version): ${e.message}`
        );
      }
    } catch (err) {
      this.deps.logger.warn(
        `Background Pro-module freshness check failed (staying on the installed version): ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
