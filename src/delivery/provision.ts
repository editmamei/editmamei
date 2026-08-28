/**
 * provisionModules — the activate-time fetch loop. After a license is activated
 * (or refreshed), pull every entitled module from the delivery service, verify
 * its integrity + decryptability, and install it locally so the boot path can
 * load it. Idempotent: a SKU already at the manifest's latest version is skipped.
 *
 * Non-fatal by contract: a license activates whether or not modules provision.
 * When the delivery endpoint isn't configured (Phase A / pre-deploy) this is a
 * clean no-op (`notConfigured`); transient/network/server failures are collected
 * as `errors` (Pro tools simply stay dark until a later retry) rather than
 * throwing — the user keeps a valid, activated license either way.
 */

import { DeliveryClient, DeliveryError, type DeliveryFetch } from './client.js';
import type { DeliveryConfig } from './config.js';
import { sha256Hex } from './crypto.js';
import {
  verifyModuleSignature,
  verifyModuleSignatureV2,
  digestsRootSha256Hex,
  isModuleFileDigestArray,
  type ModuleFileDigest,
} from './signing.js';
import { installModule, readInstalledModule } from './store.js';
import { KERNEL_ABI } from '../kernel/host-api.js';
import type { LicenseStoreOptions } from '../license/store.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('Modules');

/**
 * The manifest's `sku` and `version` become filesystem path components (the
 * install dir) and ultimately an `import()` target — so they are NEVER trusted
 * as paths. We constrain both to a plain sku / strict semver before any path or
 * fetch use. The Worker constrains its own routes the same way; the
 * client must not assume the manifest it consumed is honest. The Ed25519
 * signature below also covers (sku, version), but these checks fail-close even
 * an unsigned or malformed manifest before it can touch the filesystem.
 *
 * `VERSION_RE` is exported: `module-lifecycle.ts` validates an installed
 * module's version against the same shape before trusting it in a semver
 * comparison (the forward-compat degrade), rather than assuming
 * `compareVersions`'s "already validated" precondition holds for every caller.
 */
const SKU_RE = /^[a-z0-9-]{2,32}$/;
export const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Hard cap on a downloaded module artifact — defense-in-depth against a hostile
 * server streaming an OOM-sized body before integrity can be checked. The real
 * Pro bundle (handlers + 3 go-core binaries) is a few MB; 64 MB is generous.
 */
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

export interface ProvisionResult {
  installed: { sku: string; version: string }[];
  skipped: { sku: string; version: string; reason: string }[];
  errors: { sku: string; message: string }[];
  /** True when no delivery endpoint is configured (Phase A) — a clean no-op. */
  notConfigured: boolean;
}

export interface ProvisionOptions extends LicenseStoreOptions {
  /** Injected delivery fetch (tests). */
  fetchImpl?: DeliveryFetch;
  /** Override the resolved delivery config (tests / localhost wrangler dev). */
  config?: DeliveryConfig;
  /** Injected clock (tests). */
  now?: () => number;
  /** Injected retry backoff delay for the delivery client (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Override the pinned Ed25519 signing public keys (tests supply an ephemeral
   * key). Omitted → the production keys pinned in signing.ts.
   */
  signingKeys?: readonly string[];
  /**
   * Re-install even when the installed pointer is already at the manifest's
   * `latest` version. Bypasses ONLY the up-to-date version-equality skip — the cure
   * for a corrupt/unverifiable on-disk install (self-heal `'corrupt'`, and every
   * `editmamei repair`). It NEVER weakens verification (SKU/semver shape, sha256,
   * signature, GCM decrypt all still run) and does NOT override the downgrade guard
   * below: a lower `latest` is still refused. Omitted/false → normal idempotence.
   */
  force?: boolean;
}

export async function provisionModules(
  key: string,
  opts: ProvisionOptions = {}
): Promise<ProvisionResult> {
  const result: ProvisionResult = {
    installed: [],
    skipped: [],
    errors: [],
    notConfigured: false,
  };

  let client: DeliveryClient;
  try {
    client = new DeliveryClient({
      config: opts.config,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
    });
  } catch (e) {
    if (e instanceof DeliveryError && e.code === 'not_configured') {
      result.notConfigured = true;
      return result;
    }
    // A misconfigured endpoint — e.g. a plaintext EDITMAMEI_DELIVERY_URL rejected
    // by assertSecureEndpoint — is non-fatal by contract: record it and
    // keep the activated license rather than throwing out of provisioning.
    result.errors.push({ sku: '*', message: errMsg(e) });
    return result;
  }

  let manifest;
  try {
    manifest = await client.fetchManifest(key);
  } catch (e) {
    result.errors.push({ sku: '*', message: errMsg(e) });
    return result;
  }

  for (const [sku, entry] of Object.entries(manifest.modules)) {
    try {
      // The server-supplied sku/version become path components + an import()
      // target — validate their shape before any path or fetch use.
      if (!SKU_RE.test(sku)) {
        result.errors.push({ sku, message: `manifest sku '${sku}' has an invalid format` });
        continue;
      }
      const latest = entry.latest;
      if (typeof latest !== 'string' || !VERSION_RE.test(latest)) {
        result.errors.push({
          sku,
          message: `manifest version '${latest}' for ${sku} is not valid semver`,
        });
        continue;
      }
      // `abi` is the host<->module contract version. It is unvalidated manifest
      // JSON (`fetchManifest` casts the parse; the `number` type is compile-time
      // only) that flows into the installed pointer and, past it, into
      // `installModule` -> `pruneOldModuleVersions`, which DELETES the currently
      // working install. So it is checked HERE, before any artifact fetch or
      // install, and a bad value costs the user nothing:
      //   - above KERNEL_ABI the module cannot load on this host at all (the
      //     kernel skips it): "update the host first", not "destroy what works";
      //   - a non-integer / <1 value writes a pointer that `readInstalledModule`
      //     rejects forever, wedging boot into a permanent force-re-provision.
      // 1 is the lowest ABI ever published; the load-time `HOST_MIN_ABI` gate
      // remains the authority on the low side of the acceptance window.
      const abi = entry.abi;
      if (!Number.isInteger(abi) || abi < 1 || abi > KERNEL_ABI) {
        result.errors.push({
          sku,
          message: `manifest abi '${String(abi)}' for ${sku} is not supported by this host (expected an integer in 1..${KERNEL_ABI})`,
        });
        continue;
      }
      const installed = readInstalledModule(sku, opts);
      // Up-to-date idempotence — skipped UNLESS `force` (a corrupt-install repair
      // re-downloads the same version). `force` bypasses ONLY this equality check.
      if (installed && installed.version === latest && !opts.force) {
        result.skipped.push({ sku, version: latest, reason: 'up-to-date' });
        continue;
      }
      // Downgrade guard: the Ed25519 signature binds
      // (sku, version, sha256), so an OLD signature can't be replayed onto a NEW
      // version — but a compromised/rolled-back manifest could still pin an older,
      // genuinely signed (and possibly vulnerable) release, and `pruneOldModuleVersions`
      // would then DELETE the newer install. Refuse to move BACKWARDS; only forward
      // upgrades install. `force` deliberately does NOT reach this check (it only
      // bypassed the equality skip above, where versions are EQUAL so this is a
      // no-op) — a legitimate publisher rollback ships as a HIGHER version, never a
      // client flag. Blocked path `continue`s before install AND before any prune.
      if (installed && compareVersions(latest, installed.version) < 0) {
        result.skipped.push({
          sku,
          version: latest,
          reason: `downgrade-blocked (installed v${installed.version} is newer than manifest latest v${latest})`,
        });
        continue;
      }
      const vEntry = entry.versions[latest];
      if (!vEntry) {
        result.errors.push({ sku, message: `manifest has no descriptor for ${sku} v${latest}` });
        continue;
      }
      if (typeof vEntry.size === 'number' && vEntry.size > MAX_ARTIFACT_BYTES) {
        result.errors.push({
          sku,
          message: `artifact for ${sku} v${latest} exceeds the ${MAX_ARTIFACT_BYTES}-byte cap (declared ${vEntry.size})`,
        });
        continue;
      }

      const blob = await client.fetchArtifact(key, sku, latest);
      if (blob.length > MAX_ARTIFACT_BYTES) {
        result.errors.push({
          sku,
          message: `artifact for ${sku} v${latest} exceeds the ${MAX_ARTIFACT_BYTES}-byte cap`,
        });
        continue;
      }
      const digest = sha256Hex(blob);
      if (digest !== vEntry.sha256) {
        result.errors.push({
          sku,
          message: `sha256 mismatch for ${sku} v${latest} (expected ${vEntry.sha256}, got ${digest})`,
        });
        continue;
      }

      // Authenticity gate: the artifact must carry a valid OFFLINE
      // signature over (sku, version, sha256) from a pinned key. sha256 + the GCM
      // tag only prove the bytes match what THIS server said and decrypt with
      // THIS server's key — not that WE authored them. Without this, a compromised
      // delivery Worker / R2 / TLS could ship arbitrary code the host imports +
      // spawns. Refuse to install anything we can't verify.
      const sig = vEntry.sig;
      if (!verifyModuleSignature(sku, latest, digest, sig, opts.signingKeys)) {
        result.errors.push({
          sku,
          message: `signature verification failed for ${sku} v${latest} — refusing to install unverified module code`,
        });
        continue;
      }

      // v2 fast-boot fields (optional — an older manifest omits both `files` and
      // `sig_v2`, which is exactly the unchanged v1-only path). When present,
      // verify `sig_v2` NOW, against the manifest's OWN claimed digest list —
      // before this install ever persists it. A pointer must never carry v2
      // material we ourselves couldn't verify: `loadVerifiedModule` re-checks
      // `sig_v2` again at boot, but it trusts installed.json to only ever
      // contain what provisioning already vetted. Failure here does NOT fail
      // the install — v1 (sha256 + `sig`, checked above) is the load-bearing
      // trust; v2 is a pure boot-time speed optimization on top of it, so
      // refusing to persist a bad v2 pair just means boot keeps doing the full
      // regen every time (visibly slow, never a silent downgrade of trust).
      let filesForRec: ModuleFileDigest[] | undefined;
      let sigV2ForRec: string | undefined;
      if (vEntry.files !== undefined || vEntry.sig_v2 !== undefined) {
        if (
          isModuleFileDigestArray(vEntry.files) &&
          typeof vEntry.sig_v2 === 'string' &&
          verifyModuleSignatureV2(
            sku,
            latest,
            digest,
            digestsRootSha256Hex(vEntry.files),
            vEntry.sig_v2,
            opts.signingKeys
          )
        ) {
          filesForRec = vEntry.files;
          sigV2ForRec = vEntry.sig_v2;
        } else {
          logger.warn(
            `${sku} v${latest} manifest carried v2 fast-boot fields that failed verification — ` +
              `installing via v1 trust only (boot will keep doing the full regen for this module)`
          );
        }
      }

      const contentKey = await client.fetchKey(key, sku);
      // installModule decrypts + unpacks the bundle (GCM-authenticated, so a
      // key/artifact mismatch throws here and is caught below rather than leaving
      // Pro half-installed). The verified signature is persisted with the pointer
      // so the BOOT path can re-verify it (see store.loadVerifiedModule).
      // `sig` is non-null here: verifyModuleSignature returns false for undefined.
      installModule(
        {
          sku,
          version: latest,
          abi,
          sha256: digest,
          alg: contentKey.alg,
          content_key: contentKey.key,
          sig: sig as string,
          ...(filesForRec && sigV2ForRec ? { files: filesForRec, sig_v2: sigV2ForRec } : {}),
        },
        blob,
        opts
      );
      result.installed.push({ sku, version: latest });
    } catch (e) {
      result.errors.push({ sku, message: errMsg(e) });
    }
  }

  return result;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Compare two strict-semver strings (the VERSION_RE shape: `major.minor.patch`
 * with an optional `-prerelease`). Returns <0 when a<b, 0 when equal, >0 when
 * a>b. A release outranks a prerelease of the same core; prerelease identifiers
 * are compared lexically — exact SemVer precedence isn't needed, only the
 * coarse "is this a downgrade?" decision the rollback guard (M3) makes. Both
 * inputs are already VERSION_RE-validated before this is called.
 *
 * Exported: `module-lifecycle.ts` reuses it for the forward-compat per-tool
 * degrade (installed module version vs. host `VERSION`) rather than
 * duplicating the comparison.
 */
export function compareVersions(a: string, b: string): number {
  const [aCore, aPre] = a.split('-', 2);
  const [bCore, bPre] = b.split('-', 2);
  const ap = aCore.split('.').map(Number);
  const bp = bCore.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (ap[i] !== bp[i]) return ap[i] - bp[i];
  }
  if (aPre === bPre) return 0;
  if (aPre === undefined) return 1; // release > prerelease of the same core
  if (bPre === undefined) return -1;
  return aPre < bPre ? -1 : 1;
}
