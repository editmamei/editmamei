/**
 * `editmamei repair` — re-provision the Pro module for this device.
 *
 * A thin, synchronous wrapper over the same `provisionModules` re-fetch that
 * `editmamei activate` runs, using the license key already cached in
 * `~/.editmamei/license.json`. It exists so a user whose installed Pro module is
 * WEDGED — built against an older host (e.g. the pre-rename tool surface), which
 * the host now skips + degrades to Community — can restore Pro without deleting
 * `~/.editmamei` (which would also nuke their saved templates and license). The
 * host self-heals in the background on boot too; this is the explicit, immediate
 * lever with visible stdout for support.
 */

import { readLicense, type LicenseStoreOptions } from '../license/store.js';
import { provisionModules, type ProvisionOptions } from '../delivery/provision.js';

export interface RepairOptions extends LicenseStoreOptions {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Injected clock (tests). */
  now?: () => number;
  /** Override the delivery config/fetch (tests / localhost wrangler dev). */
  delivery?: Pick<ProvisionOptions, 'config' | 'fetchImpl' | 'signingKeys' | 'sleep'>;
}

export async function runRepair(opts: RepairOptions = {}): Promise<void> {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const err = opts.stderr ?? ((s) => process.stderr.write(s));

  const license = readLicense({ dir: opts.dir });
  if (!license) {
    err('No Pro license found on this device. Run `editmamei activate <license-key>` first.\n');
    throw new Error('no license');
  }

  out('Repairing the Pro module (re-provisioning from the delivery service)…\n');
  // `force: true` — repair is an explicit, user-initiated lever: re-download even
  // when the pointer already names the latest version (the corrupt-current-install
  // case, which a normal provision would skip as up-to-date). Verification is
  // unchanged; the downgrade guard still holds.
  const prov = await provisionModules(license.key, {
    force: true,
    dir: opts.dir,
    now: opts.now,
    config: opts.delivery?.config,
    fetchImpl: opts.delivery?.fetchImpl,
    signingKeys: opts.delivery?.signingKeys,
    sleep: opts.delivery?.sleep,
  });

  if (prov.notConfigured) {
    out('  Module delivery is not configured in this build — nothing to repair.\n');
    return;
  }

  for (const m of prov.installed) out(`  Installed ${m.sku} module v${m.version}.\n`);
  // With force, the only remaining skip is the downgrade guard — surface its reason.
  for (const s of prov.skipped) out(`  Skipped ${s.sku} v${s.version}: ${s.reason}.\n`);
  for (const e of prov.errors) {
    err(`  Error: could not provision the ${e.sku} module: ${e.message}\n`);
  }

  // A support script needs a real signal: provisioning errors → non-zero exit.
  // The router maps a thrown subcommand to exit 1 (like the no-license path above).
  if (prov.errors.length > 0) {
    throw new Error('module re-provisioning failed');
  }

  out('\nRestart your MCP client (Claude Desktop / Claude Code) to load Pro tools.\n');
}
