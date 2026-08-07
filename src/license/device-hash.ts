/**
 * Opaque, stable, salted per-machine identifier used as the Polar activation
 * `label` (so a customer can recognise their seats, and we enforce the
 * 2-device cap per machine). SHA-256 over stable machine facts + a fixed salt,
 * truncated. NOT reversible to the underlying identifiers and NOT a copyable
 * random UUID — per the R1.7.3 "opaque salted machine-hash" decision.
 */

import { createHash } from 'node:crypto';
import { hostname, platform, arch, userInfo } from 'node:os';

const SALT = 'editmamei.device.v1';

export interface DeviceHashInputs {
  platform: string;
  arch: string;
  hostname: string;
  username: string;
}

/** Gather stable machine facts. `username` degrades to '' on locked-down accounts. */
export function gatherDeviceInputs(): DeviceHashInputs {
  let username = '';
  try {
    username = userInfo().username;
  } catch {
    /* userInfo() can throw on some restricted accounts — degrade to '' */
  }
  return { platform: platform(), arch: arch(), hostname: hostname(), username };
}

/** Hash inputs into a 32-char opaque hex id. Pure — inputs injectable for tests. */
export function hashDeviceInputs(inputs: DeviceHashInputs): string {
  const material = [SALT, inputs.platform, inputs.arch, inputs.hostname, inputs.username].join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

export function computeDeviceHash(): string {
  return hashDeviceInputs(gatherDeviceInputs());
}
