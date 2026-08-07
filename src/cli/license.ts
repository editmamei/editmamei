/**
 * `editmamei license` — re-check the license online (best-effort) and show it
 * plus whether Pro is currently unlocked (and why not, if locked). Falls back
 * to the cached verdict when offline / unconfigured.
 */

import { readLicense } from '../license/store.js';
import { evaluateEntitlement, refresh, type LicenseOps } from '../license/entitlement.js';
import { PolarLicenseError } from '../license/polar-client.js';

export interface LicenseStatusOptions extends LicenseOps {
  stdout?: (s: string) => void;
}

export async function runLicenseStatus(opts: LicenseStatusOptions = {}): Promise<void> {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  let rec = readLicense(opts);
  if (!rec) {
    out('No license activated on this device.\n');
    out('  Activate Pro with: editmamei activate <license-key>\n');
    return;
  }

  // Best-effort online re-check — refreshes the cached verdict so a
  // revocation / lapse propagates. Degrade to the cached record on failure.
  let offline = false;
  try {
    const updated = await refresh(opts);
    if (updated) rec = updated;
  } catch (e) {
    if (e instanceof PolarLicenseError) offline = true;
    else throw e;
  }

  const ent = evaluateEntitlement(rec, opts.now ? opts.now() : Date.now());
  out('Editmamei license\n');
  out(`  License:    ${rec.display_key}\n`);
  out(`  Status:     ${rec.status}\n`);
  out(`  Expires:    ${rec.expires_at ?? 'never (perpetual)'}\n`);
  out(`  Last check: ${rec.last_validated_at}\n`);
  out(`  Pro:        ${ent.entitled ? 'unlocked' : `locked (${ent.reason})`}\n`);
  if (offline) out('  (offline — showing last cached check)\n');
}
