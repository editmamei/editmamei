/**
 * Activate Pro from the `EDITMAMEI_LICENSE_KEY` environment variable at boot.
 *
 * This is the `.mcpb` (Claude Desktop) activation path. That install has no
 * terminal, so the `editmamei activate` CLI isn't reachable — instead the
 * bundle's manifest declares a `license_key` user_config field that Claude
 * Desktop renders as a settings input and injects here as an env var (see
 * scripts/build-mcpb.ts). The npm / Claude-Code path uses the CLI; both
 * converge on the same license core AND the same module provisioning.
 *
 * Called once from index.ts BEFORE the server is constructed, so both the Pro
 * tool gate (reads the license cache) and `resolveProModule` (reads the
 * installed-module pointer) see fresh state. Two best-effort phases, neither
 * throws into boot:
 *   1. Activate — register + validate the key with Polar, cache the verdict.
 *   2. Provision — when entitled and the Pro module isn't installed yet, fetch +
 *      verify + decrypt + install it. The CLI does this inside `editmamei
 *      activate`; without it here a Desktop buyer's key validates but the module
 *      never downloads, so Pro tools never appear and no restart fixes it.
 * Any failure logs and returns — Pro stays gated and the server boots Community.
 *
 * Staleness-driven RE-validation deliberately does NOT live here: the
 * matching-cached-key early path below skips Polar entirely (seat safety),
 * and index.ts calls `refreshIfStale()` (license/entitlement.ts) right
 * after this function on every boot — env key or not — so both install
 * channels share one refresh chokepoint instead of duplicating the policy.
 */

import { Logger } from '../utils/logger.js';
import { readLicense } from './store.js';
import { activate, isProEntitled, type LicenseOps } from './entitlement.js';
import { provisionModules, type ProvisionOptions } from '../delivery/provision.js';
import { readInstalledModule, PRO_SKU } from '../delivery/store.js';

const logger = new Logger('License');

/** Default boot-time cap on Pro provisioning (ms) — see EnvActivateDelivery.bootTimeoutMs. */
const PROVISION_BOOT_TIMEOUT_MS = 20_000;

/**
 * Delivery-side options forwarded to `provisionModules`. Production passes
 * nothing (the baked delivery default + pinned signing keys apply); tests inject
 * a fake fetch / config / ephemeral signing key so the loop runs without network.
 */
export type EnvActivateDelivery = Pick<
  ProvisionOptions,
  'config' | 'fetchImpl' | 'sleep' | 'signingKeys'
> & {
  /**
   * Max ms to wait on provisioning before boot continues as Community. Node's
   * global fetch has no default timeout, so a stalled delivery server must not
   * hang the whole MCP server start. Default 20s; tests set it small. On expiry
   * the in-flight download is abandoned — provisionModules is idempotent and the
   * install is an atomic swap, so the next boot retries cleanly.
   */
  bootTimeoutMs?: number;
};

export async function maybeActivateFromEnv(
  env: Record<string, string | undefined> = process.env,
  ops: LicenseOps = {},
  delivery: EnvActivateDelivery = {}
): Promise<void> {
  const key = (env.EDITMAMEI_LICENSE_KEY ?? '').trim();
  if (!key) return;

  // Phase 1 — activate, but only when the cache doesn't already hold this key.
  // Polar activations stack (they don't dedupe by device), so re-activating an
  // already-cached key would consume a second seat. A cached key still falls
  // through to provisioning below (the unlock may have validated on an earlier
  // boot that never managed to download the module).
  const cached = readLicense(ops);
  if (!cached || cached.key !== key) {
    try {
      await activate(key, ops);
      logger.info('Activated Pro from EDITMAMEI_LICENSE_KEY.');
    } catch (err) {
      logger.warn(
        `Could not activate from EDITMAMEI_LICENSE_KEY (continuing as Community): ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
      return; // no valid license → nothing to provision
    }
  }

  // Phase 2 — provision the Pro module. The `.mcpb` path can't reach the CLI's
  // `editmamei activate` (which provisions), so without this a Desktop buyer's
  // key validates but the module never downloads → Pro tools never appear. Gated
  // on entitled-AND-not-installed so steady-state boots make zero network calls;
  // only the first post-purchase boot fetches. Non-fatal (provisionModules
  // collects its own errors, and a thrown failure is caught here): a failure
  // leaves a valid license + the community surface. This path only closes the
  // FIRST-UNLOCK gap (Pro tools appear the same boot as first activation on a
  // normal link). Module *updates* to an already-installed module are handled
  // post-connect by EditmameiServer.ensureEntitledModuleFresh() — the background
  // net that also rescues a slow/oversized first install this bounded race abandons.
  try {
    if (isProEntitled(ops) && !readInstalledModule(PRO_SKU, ops)) {
      const provisioning = provisionModules(key, {
        dir: ops.dir,
        now: ops.now,
        config: delivery.config,
        fetchImpl: delivery.fetchImpl,
        sleep: delivery.sleep,
        signingKeys: delivery.signingKeys,
      });
      // A stalled delivery server must not hang the MCP server start — bound the
      // wait and continue as Community on expiry (next boot retries; the install
      // is atomic so an abandoned download leaves no half-install). The original
      // promise may settle later in the background; swallow its outcome so a late
      // rejection isn't unhandled.
      provisioning.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(
          () => resolve(null),
          delivery.bootTimeoutMs ?? PROVISION_BOOT_TIMEOUT_MS
        );
        timer.unref?.();
      });
      const prov = await Promise.race([provisioning, deadline]);
      if (timer) clearTimeout(timer);
      if (!prov) {
        logger.warn(
          'Pro module provisioning did not finish in time — continuing as Community; the next start retries.'
        );
      } else {
        for (const m of prov.installed) logger.info(`Installed ${m.sku} module v${m.version}.`);
        for (const e of prov.errors) {
          logger.warn(`Could not provision the ${e.sku} module (Pro stays dark): ${e.message}`);
        }
      }
    }
  } catch (err) {
    logger.warn(
      `Pro module provisioning failed (continuing without Pro): ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
}
