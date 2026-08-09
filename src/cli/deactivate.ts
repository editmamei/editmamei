/**
 * `editmamei deactivate` — free this device's seat with Polar and clear the
 * local license. Use before moving Pro to a different machine.
 */

import { deactivate, type LicenseOps } from '../license/entitlement.js';
import { PolarLicenseError } from '../license/polar-client.js';

export interface DeactivateOptions extends LicenseOps {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export async function runDeactivate(opts: DeactivateOptions = {}): Promise<void> {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const err = opts.stderr ?? ((s) => process.stderr.write(s));
  try {
    const had = await deactivate(opts);
    out(
      had
        ? 'Deactivated — this device no longer uses Pro and its seat is freed.\n'
        : 'No active license on this device.\n'
    );
  } catch (e) {
    if (e instanceof PolarLicenseError) {
      err(`Deactivate failed: ${e.message}\n`);
      throw new Error(e.code, { cause: e });
    }
    throw e;
  }
}
