/**
 * `editmamei activate <license-key>` — register this device with Polar and
 * unlock Pro. Tokenless: no Polar secret ships in the client.
 */

import { activate, type LicenseOps } from '../license/entitlement.js';
import { PolarLicenseError } from '../license/polar-client.js';
import { provisionModules, type ProvisionOptions } from '../delivery/provision.js';

export interface ActivateOptions extends LicenseOps {
  key?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Override the delivery config/fetch (tests / localhost wrangler dev). */
  delivery?: Pick<ProvisionOptions, 'config' | 'fetchImpl'>;
}

export async function runActivate(opts: ActivateOptions = {}): Promise<void> {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const err = opts.stderr ?? ((s) => process.stderr.write(s));
  const key = (opts.key ?? '').trim();
  if (!key) {
    err('Usage: editmamei activate <license-key>\n');
    throw new Error('missing license key');
  }
  try {
    const rec = await activate(key, opts);
    out(`Activated — Pro is unlocked on this device.\n`);
    out(`  License: ${rec.display_key}\n`);
    out(`  Status:  ${rec.status}\n`);
    out(`  Expires: ${rec.expires_at ?? 'never (perpetual)'}\n`);

    // Fetch + install entitled Pro modules (Phase B). A clean no-op when the
    // delivery endpoint isn't configured (Phase A); never fails activation.
    const prov = await provisionModules(key, {
      dir: opts.dir,
      now: opts.now,
      config: opts.delivery?.config,
      fetchImpl: opts.delivery?.fetchImpl,
    });
    for (const m of prov.installed) out(`  Installed ${m.sku} module v${m.version}.\n`);
    for (const s of prov.skipped) out(`  ${s.sku} module already up to date (v${s.version}).\n`);
    for (const e of prov.errors) {
      err(`  Warning: could not provision the ${e.sku} module: ${e.message}\n`);
    }

    out(`\nRestart your MCP client (Claude Desktop / Claude Code) to load Pro tools.\n`);
  } catch (e) {
    if (e instanceof PolarLicenseError) {
      err(`Activation failed: ${e.message}\n`);
      throw new Error(e.code, { cause: e });
    }
    throw e;
  }
}
