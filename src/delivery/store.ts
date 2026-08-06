/**
 * Installed-module store under `~/.editmamei/modules/<sku>/`. A downloaded module
 * is delivered as an encrypted bundle (zip-of-files: pro-handlers.mjs + per-
 * platform go-core binaries + manifest.json — see bundle.ts). On install the
 * bundle is decrypted + unpacked into `<sku>/<version>/`, and an `installed.json`
 * pointer records the active version, its content key, ABI, and integrity hash.
 * The kernel boots the module by importing `<version>/pro-handlers.mjs` and the
 * composite snippet client spawns `<version>/bin/<core>`.
 *
 * Reuses `settingsDir()` so modules sit beside license.json / settings.json and
 * honour the same test directory override. Atomic tmp+rename writes for the
 * pointer; the pointer flip IS the swap. After a successful install the prior
 * version directories are pruned (`pruneOldModuleVersions`) — a wedged/superseded
 * `<sku>/<old>/` tree left on disk is dead weight, and the retained encrypted
 * artifact under the CURRENT version dir is the boot-time trust source, so old
 * dirs are not needed for rollback.
 *
 * Every module-TREE write (a fresh install, a force-repair, and the boot-time
 * regen in `loadVerifiedModule`) stages into a private per-process `.tmp-*` dir
 * first and swaps it into place with `renameSync`, never writing straight into a
 * dir a sibling process or a reader might be observing — see the staging comments
 * on `installModule` and `loadVerifiedModule` (DL-3 / ML-2, 2026-07-27 review).
 */

import { join, dirname } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync,
  lstatSync,
} from 'node:fs';
import { settingsDir } from '../core/settings.js';
import type { LicenseStoreOptions } from '../license/store.js';
import { installBundle } from './bundle.js';
import { sha256Hex } from './crypto.js';
import {
  verifyModuleSignature,
  verifyModuleSignatureV2,
  digestsRootSha256Hex,
  isModuleFileDigestArray,
  MODULE_SIGNING_PUBLIC_KEYS,
  type ModuleFileDigest,
} from './signing.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('Modules');
const INSTALLED_FILENAME = 'installed.json';

/**
 * Prefix for a private, per-process staging dir (`<sku>/.tmp-<version>-<pid>/`) an
 * install extracts into before renaming atomically into `<sku>/<version>/`. Prune
 * leaves recent ones (a concurrent sibling mid-install) and reaps stale ones.
 */
const TMP_PREFIX = '.tmp-';
/** A staging dir older than this is a crashed-mid-install leftover — safe to reap. */
const TMP_STALE_MS = 5 * 60 * 1000;

/** The single paid SKU today (licensing.md: one Pro tier). */
export const PRO_SKU = 'pro';

/** The handler-bundle entry inside an installed module dir (matches build:pro-module). */
export const PRO_HANDLERS_ENTRY = 'pro-handlers.mjs';

/** The manifest filename inside an installed module dir (presence = a complete install). */
const MODULE_MANIFEST = 'manifest.json';

/**
 * The retained encrypted artifact inside an installed version dir. Kept so the
 * boot path can re-verify (sha256 + Ed25519) and regenerate the decrypted tree
 * from a trusted source on every load (audit H1).
 */
const MODULE_ARTIFACT = 'artifact.enc';

/** What `installed.json` records for an installed module SKU. */
export interface InstalledModule {
  sku: string;
  version: string;
  /** Host↔module ABI version — the host refuses a module it can't run. */
  abi: number;
  /** Lowercase hex SHA-256 of the encrypted artifact bytes. */
  sha256: string;
  /** Content-key algorithm, e.g. 'AES-256-GCM'. */
  alg: string;
  /**
   * Base64 AES-256 content key. RETAINED (not wiped after install) because the
   * BOOT path re-decrypts the retained, signature-verified artifact to regenerate
   * the trusted tree on every load (loadVerifiedModule — audit H1/M1). It buys an
   * attacker nothing on its own: the decrypted code already sits beside it on disk,
   * and the key is useless without the pinned-Ed25519-verified artifact.
   */
  content_key: string;
  /**
   * Detached base64 Ed25519 signature over (sku, version, sha256) — persisted so
   * the boot path can re-verify the artifact against the pinned key, not just at
   * install time (audit H1). A pointer without it is treated as malformed.
   */
  sig: string;
  /**
   * v2 boot-fast-path fields (both optional — an install without them just keeps
   * taking the full decrypt+regen path on every boot, unchanged). `files` is the
   * per-file digest list of the extracted module tree; `sig_v2` is a detached
   * Ed25519 signature over (sku, version, sha256, digestsRoot(files)) — see
   * delivery/signing.ts. provisionModules verifies `sig_v2` BEFORE ever writing
   * these two fields (a failed verify stores neither, never a partially-trusted
   * pair); `loadVerifiedModule` re-verifies again from what's stored, plus
   * checks the on-disk tree actually matches, before trusting the fast path.
   * A pointer read back with either field malformed or half-present is
   * SANITIZED (both dropped, not fatal) by `readInstalledModule` — see there.
   */
  files?: ModuleFileDigest[];
  sig_v2?: string;
  installed_at: string;
}

export function modulesRoot(opts: LicenseStoreOptions = {}): string {
  return join(settingsDir(opts), 'modules');
}

export function installedPath(sku: string, opts: LicenseStoreOptions = {}): string {
  return join(modulesRoot(opts), sku, INSTALLED_FILENAME);
}

/** The unpacked-bundle directory for a SKU + version (`<sku>/<version>/`). */
export function installedModuleDir(
  sku: string,
  version: string,
  opts: LicenseStoreOptions = {}
): string {
  return join(modulesRoot(opts), sku, version);
}

/** Absolute path of an installed version's handler bundle entry. */
export function moduleHandlersPath(
  sku: string,
  version: string,
  opts: LicenseStoreOptions = {}
): string {
  return join(installedModuleDir(sku, version, opts), PRO_HANDLERS_ENTRY);
}

/** Absolute path of an installed version's go-core binary directory. */
export function moduleBinDir(sku: string, version: string, opts: LicenseStoreOptions = {}): string {
  return join(installedModuleDir(sku, version, opts), 'bin');
}

/** Absolute path of an installed version's retained encrypted artifact (audit H1). */
export function moduleArtifactPath(
  sku: string,
  version: string,
  opts: LicenseStoreOptions = {}
): string {
  return join(installedModuleDir(sku, version, opts), MODULE_ARTIFACT);
}

/**
 * True iff `v` has the REQUIRED (v1) `InstalledModule` shape — sku, version,
 * abi, sha256, alg, content_key, sig, installed_at. This is STRICT: any of
 * these missing/mistyped invalidates the whole pointer (readInstalledModule
 * returns null). The v2 fast-path fields (`files`/`sig_v2`) are optional and
 * are validated — and, if malformed, SANITIZED rather than rejected — by
 * `readInstalledModule` itself; see the comment there for why the two halves
 * get different treatment.
 */
function isInstalledModuleBase(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.sku === 'string' &&
    typeof r.version === 'string' &&
    typeof r.abi === 'number' &&
    typeof r.sha256 === 'string' &&
    typeof r.alg === 'string' &&
    typeof r.content_key === 'string' &&
    typeof r.sig === 'string' &&
    typeof r.installed_at === 'string'
  );
}

/** Read the installed-module pointer for a SKU, or null when absent / malformed / incomplete. */
export function readInstalledModule(
  sku: string,
  opts: LicenseStoreOptions = {}
): InstalledModule | null {
  const path = installedPath(sku, opts);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isInstalledModuleBase(parsed)) {
      logger.warn(`installed.json for '${sku}' malformed — ignoring`);
      return null;
    }
    // v2 fast-path fields are OPTIONAL and, unlike every base field above, a
    // malformed `files`/`sig_v2` does NOT invalidate the whole pointer — it is
    // SANITIZED AWAY here instead: both fields are dropped and a one-line warn
    // is logged, so the record still loads and the host degrades to the v1
    // full-regen path (loadVerifiedModule sees neither field and falls straight
    // through, exactly like a pre-v2 install). Rejecting the whole pointer over
    // a corrupted v2 write would take Pro fully dark for something the v1 trust
    // chain (sha256 + sig, checked independently at boot) doesn't even need. A
    // half-present pair (one field written, the other missing/dropped by a
    // partial write) is malformed the same way as a bad shape — both go.
    const filesOk = parsed.files === undefined || isModuleFileDigestArray(parsed.files);
    const sigV2Ok = parsed.sig_v2 === undefined || typeof parsed.sig_v2 === 'string';
    const bothPresent = parsed.files !== undefined && parsed.sig_v2 !== undefined;
    const bothAbsent = parsed.files === undefined && parsed.sig_v2 === undefined;
    if (!filesOk || !sigV2Ok || !(bothPresent || bothAbsent)) {
      logger.warn(
        `installed.json for '${sku}' carried malformed v2 fast-boot fields — dropping ` +
          `them and falling back to the v1 path`
      );
      delete parsed.files;
      delete parsed.sig_v2;
    }
    const rec = parsed as unknown as InstalledModule;
    // A pointer whose unpacked bundle is missing/incomplete (manifest absent —
    // e.g. a partial install or a manual delete) is stale; treat as absent.
    const manifest = join(installedModuleDir(sku, rec.version, opts), MODULE_MANIFEST);
    if (!existsSync(manifest)) {
      logger.warn(`module '${sku}' v${rec.version} install incomplete — ignoring pointer`);
      return null;
    }
    return rec;
  } catch (err) {
    logger.warn(
      `installed.json for '${sku}' unreadable: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

function writeFileAtomic(path: string, data: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${INSTALLED_FILENAME}.${process.pid}.tmp`);
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Persist the installed-module pointer (atomic tmp+rename write) — the pointer
 * flip IS the swap. Internal to `installModule`; `provisionModules` attaches the
 * v2 fast-boot fields (`files`/`sig_v2`) by passing them straight into
 * `installModule`'s record, not by calling this separately, so it has no other
 * caller and stays unexported.
 */
function writeInstalledModule(rec: InstalledModule, opts: LicenseStoreOptions = {}): void {
  writeFileAtomic(installedPath(rec.sku, opts), JSON.stringify(rec, null, 2) + '\n');
}

/**
 * Install a fetched module: decrypt + unpack the encrypted bundle into the
 * version dir, then flip the installed.json pointer (the atomic swap). The
 * caller is expected to have verified the artifact's sha256 first; `installBundle`
 * does the GCM-authenticated decrypt (throwing on a bad key / tampered bytes)
 * before any write. Returns the pointer.
 */
export function installModule(
  rec: Omit<InstalledModule, 'installed_at'>,
  blob: Uint8Array,
  opts: LicenseStoreOptions & { now?: () => number; force?: boolean } = {}
): InstalledModule {
  const finalDir = installedModuleDir(rec.sku, rec.version, opts);
  const skuDir = dirname(finalDir);

  // Concurrency: Claude Desktop + Claude Code can boot together and both
  // re-provision the same version. Extract into a private per-process staging dir,
  // then rename it into place (a same-parent rename is atomic), so a reader never
  // sees a half-unpacked tree and two installers can't interleave writes into one
  // dir. installBundle GCM-decrypts before any write (a bad key/tampered bytes throw
  // before the staging dir has content); we still clean the staging dir on throw.
  const tmpDir = join(skuDir, `${TMP_PREFIX}${rec.version}-${process.pid}`);
  rmSync(tmpDir, { recursive: true, force: true }); // clear any crashed-run leftover
  try {
    installBundle(blob, rec.content_key, tmpDir);
    // Retain the encrypted, signature-bound artifact beside the unpacked tree so
    // every boot can re-verify it + regenerate the tree (audit H1). 0600 owner-only.
    writeFileSync(join(tmpDir, MODULE_ARTIFACT), Buffer.from(blob), { mode: 0o600 });
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }

  // A `force` install (a corrupt-install repair) replaces the existing bad tree — it
  // is only ever the SAME, signature-verified version. ML-2: rm-then-rename left a
  // window where the pointer still named `finalDir` while it was transiently ABSENT
  // — a recursive delete of a real tree (go-core binaries) is not instant, so a
  // concurrent reader (another process calling loadVerifiedModule/readInstalledModule)
  // could observe the version as missing mid-repair and degrade to Community for that
  // session. Swap the old tree aside with a fast atomic rename instead of deleting it
  // in place first, so `finalDir` is only unresolvable for the gap between two
  // back-to-back rename() calls, not for the duration of a recursive delete.
  // A non-force install of a new version leaves a sibling's win alone (unchanged).
  if (opts.force && existsSync(finalDir)) {
    const oldDir = join(skuDir, `${TMP_PREFIX}old-${rec.version}-${process.pid}`);
    rmSync(oldDir, { recursive: true, force: true }); // clear any crashed-run leftover
    renameSync(finalDir, oldDir);
    try {
      renameSync(tmpDir, finalDir);
      rmSync(oldDir, { recursive: true, force: true });
    } catch (err) {
      rmSync(tmpDir, { recursive: true, force: true });
      if (existsSync(finalDir)) {
        // A concurrent sibling's force-repair won the race and already replaced
        // finalDir with the same signature-verified bytes — adopt it.
        rmSync(oldDir, { recursive: true, force: true });
      } else {
        // Genuine failure and no sibling filled it back in — restore the previous
        // tree so the pointer (not yet rewritten) keeps resolving.
        renameSync(oldDir, finalDir);
        throw err;
      }
    }
  } else {
    try {
      renameSync(tmpDir, finalDir);
    } catch (err) {
      // finalDir already exists — a concurrent sibling won the race and materialized
      // the same signed bytes. Drop our staging dir and adopt theirs; only rethrow a
      // genuine failure (finalDir still absent).
      rmSync(tmpDir, { recursive: true, force: true });
      if (!existsSync(finalDir)) throw err;
    }
  }

  const now = opts.now ?? Date.now;
  const installed: InstalledModule = { ...rec, installed_at: new Date(now()).toISOString() };
  writeInstalledModule(installed, opts);
  // The pointer now names this version; reclaim every OTHER version dir under the
  // SKU. Best-effort: the install already succeeded, so a prune failure must never
  // surface as an install failure.
  pruneOldModuleVersions(rec.sku, rec.version, opts);
  return installed;
}

/**
 * Remove every `<sku>/<version>/` directory except `keepVersion` — called after an
 * install flips the pointer. Leaves the pointer file (`installed.json`) and any
 * non-version files in `<sku>/` untouched; only descends one level and only deletes
 * directories. In-flight `.tmp-*` staging dirs (a concurrent sibling's extraction)
 * are left alone unless stale (`TMP_STALE_MS`), then reaped. Best-effort and
 * self-contained: swallows and logs its own errors so it can never break the
 * caller's install.
 *
 * SAFETY: `sku` MUST be an already-validated SKU (a manifest sku is SKU_RE-checked
 * in provision.ts; internal callers pass the `PRO_SKU` constant) — this deletes
 * directories under `<sku>/` recursively, so an attacker-controlled `sku` would be a
 * path-injection primitive. Never pass an unvalidated value.
 */
export function pruneOldModuleVersions(
  sku: string,
  keepVersion: string,
  opts: LicenseStoreOptions & { now?: () => number } = {}
): void {
  const skuDir = join(modulesRoot(opts), sku);
  if (!existsSync(skuDir)) return;
  let entries: string[];
  try {
    entries = readdirSync(skuDir);
  } catch (err) {
    logger.warn(
      `could not list module dir for '${sku}' to prune: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  const now = (opts.now ?? Date.now)();
  for (const entry of entries) {
    if (entry === keepVersion || entry === INSTALLED_FILENAME) continue;
    const full = join(skuDir, entry);
    try {
      // lstat (not stat): a symlink is never a real version dir. Skipping it means a
      // planted symlink-to-elsewhere can't be followed into a recursive delete.
      const st = lstatSync(full);
      if (entry.startsWith(TMP_PREFIX)) {
        // A sibling's in-flight extraction — reap only if it's a crashed-mid-install
        // leftover (older than TMP_STALE_MS), never a fresh concurrent one.
        if (now - st.mtimeMs > TMP_STALE_MS) {
          rmSync(full, { recursive: true, force: true });
          logger.info(`Pruned stale staging dir '${sku}/${entry}'.`);
        }
        continue;
      }
      if (!st.isDirectory()) continue;
      rmSync(full, { recursive: true, force: true });
      logger.info(`Pruned stale module version '${sku}' v${entry}.`);
    } catch (err) {
      logger.warn(
        `could not prune stale module entry '${sku}/${entry}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/** Where a verified module loads from: the import target + the go-core bin dir. */
export interface VerifiedModuleLocation {
  version: string;
  dir: string;
  handlersPath: string;
  binDir: string;
  /**
   * True when this call regenerated the tree from the verified artifact (the
   * v1-only path, or a v2 fast-path anomaly falling back to it); false when the
   * v2 fast path verified the on-disk tree in place and returned it untouched.
   * Exposed so tests/callers can observe which path ran.
   */
  regenerated: boolean;
}

/**
 * The v2 boot fast path (2026-07-29): try to prove the LIVE `dir` already equals
 * the signed bytes, cheaply, so `loadVerifiedModule` can skip the decrypt+unzip+
 * atomic-swap regen entirely. Returns `{ ok: true }` only when EVERY check
 * passes; any anomaly returns `{ ok: false, reason }` and the caller falls
 * through to the (unchanged) full regen — never a partial trust.
 *
 * Checks, in order: (1) `sig_v2` verifies over (sku, version, artifactSha256,
 * digestsRoot) against the pinned keys, where digestsRoot is RE-DERIVED from the
 * stored `files` list (never trusted as given); (2) the live tree's file SET
 * equals exactly {every listed path} ∪ {the retained artifact copy,
 * MODULE_ARTIFACT} — an extra or missing entry is an anomaly; (3) every listed
 * file's bytes hash to its recorded digest. The retained artifact copy's own
 * hash is NOT re-checked here — the caller already read it (as `blob`) and
 * verified `sha256Hex(blob) === rec.sha256` moments earlier, from the exact same
 * file; re-hashing it again here would just re-read identical bytes.
 *
 * Concurrency (mirrors the DL-3 note on the regen path below): this function
 * only READS `dir`. Claude Desktop + Claude Code can boot together, so a
 * concurrent sibling's regen can be mid-rename-swap while this runs — a torn
 * read of a dir being swapped out from under us looks exactly like a genuine
 * anomaly (a missing file, an enumeration error) and is indistinguishable from
 * one here. That's fine: it just falls through to the full regen below, which
 * already knows how to handle the race (adopts the sibling's result on a rename
 * collision). No new race is introduced by reading concurrently with a rename.
 */
function verifyFastPath(
  sku: string,
  version: string,
  dir: string,
  artifactSha256Hex: string,
  files: readonly ModuleFileDigest[],
  sigV2: string,
  pubKeys: readonly string[]
): { ok: true } | { ok: false; reason: string } {
  const digestsRoot = digestsRootSha256Hex(files);
  if (!verifyModuleSignatureV2(sku, version, artifactSha256Hex, digestsRoot, sigV2, pubKeys)) {
    return { ok: false, reason: 'sig_v2 did not verify against the pinned key' };
  }

  const expected = new Set<string>(files.map((f) => f.path));
  expected.add(MODULE_ARTIFACT);

  let onDisk: string[];
  try {
    onDisk = listFilesRecursive(dir);
  } catch (err) {
    return {
      ok: false,
      reason: `tree enumeration failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const onDiskSet = new Set(onDisk);

  // SAFETY-CRITICAL ORDERING — do not reorder these three blocks. The
  // missing/extra SET check below MUST run to completion (and return on the
  // first anomaly) BEFORE the content loop ever calls `readFileSync` on a
  // listed path. `f.path` is never shape-constrained (no traversal/absolute-
  // path check anywhere) — `join(dir, f.path)` is not guaranteed to stay
  // inside `dir` — so if the content loop ever ran against an entry the set
  // check hadn't first proven exists ON DISK UNDER `dir` (via plain string
  // membership in `onDiskSet`, which `listFilesRecursive` populated by
  // enumerating FROM `dir` — a `../../evil.txt` or absolute-looking entry
  // simply cannot appear in it), `f.path` becomes an arbitrary-file-read
  // primitive: whatever `join(dir, f.path)` happens to resolve to gets read
  // and its hash compared, with the result surfacing only as an opaque
  // "content mismatch"/pass. `sig_v2` (checked above) is the primary gate
  // against an attacker supplying such an entry, but this ordering is the
  // load-bearing SECOND gate — it must hold even if that signature check is
  // ever weakened, bypassed by a future refactor, or reused in a context that
  // skips it, which is exactly the kind of defense-in-depth a single-gate
  // design can't provide. See tests/delivery/store.test.ts "adversarial path
  // battery" (T2) for the pinned cases (traversal, absolute path, a directory
  // occupying a listed path, a symlink) — each proves the set check rejects
  // BEFORE any read is attempted.
  //
  // Missing: every listed file (+ the artifact copy) must be present.
  for (const p of expected) {
    if (!onDiskSet.has(p)) return { ok: false, reason: `missing file '${p}'` };
  }
  // Extra: nothing on disk beyond the expected set (a planted file/symlink
  // included — listFilesRecursive counts every non-directory entry, never
  // silently drops one).
  for (const p of onDisk) {
    if (!expected.has(p)) return { ok: false, reason: `unexpected file '${p}'` };
  }
  // Content: every listed file's bytes must hash to the recorded digest.
  for (const f of files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(dir, f.path));
    } catch (err) {
      return {
        ok: false,
        reason: `could not read '${f.path}': ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (sha256Hex(bytes) !== f.sha256) {
      return { ok: false, reason: `content mismatch on '${f.path}'` };
    }
  }
  return { ok: true };
}

/**
 * Recursively list every non-directory entry under `dir`, as forward-slash
 * paths relative to `dir` — the same convention `canonicalDigestListString`
 * (signing.ts) and the offline packer use. A symlink (or any other non-file,
 * non-directory entry) still counts as a leaf name here — it must show up as
 * an "unexpected" (or, if it shadows a listed path, "content mismatch"/"missing
 * file" via read failure) anomaly in `verifyFastPath`, never be silently
 * skipped from the set check.
 */
function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (sub: string): void => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const relPath = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(relPath);
      } else {
        out.push(relPath);
      }
    }
  };
  walk('');
  return out;
}

/**
 * Boot-time integrity gate (audit H1). Provisioning verifies the artifact's
 * Ed25519 signature ONCE, at install. But the host re-imports the decrypted
 * `pro-handlers.mjs` and spawns the unpacked go-core binary on EVERY boot from a
 * dir that another local process / malware running as the user could overwrite
 * between install and boot — bypassing the entire signing scheme (a persistent
 * local-code-swap TOCTOU).
 *
 * So on each load we re-establish trust from a source an attacker can't forge:
 * re-hash the retained encrypted artifact, verify its detached signature against
 * the PINNED public key, then — a v2 fast path permitting (see `verifyFastPath`)
 * — either confirm the on-disk tree already IS those verified bytes, or
 * REGENERATE the decrypted tree from the artifact (the decrypt is
 * GCM-authenticated). The imported bytes therefore always derive from a
 * signature-verified source — never from whatever happens to be on disk. A
 * swapped `pro-handlers.mjs` is overwritten with the signed bytes before import
 * (full regen) or detected and rejected outright (fast path); a forged artifact
 * fails the hash/signature and is refused either way.
 *
 * v2 fast path (2026-07-29): when the installed pointer carries `files` +
 * `sig_v2` (persisted by provisionModules only after verifying `sig_v2` itself),
 * skip the ~1-3s decrypt+unzip+atomic-swap regen when `verifyFastPath` confirms
 * the live tree already equals the signed bytes. Absent those fields, or ANY
 * anomaly the fast path finds, falls straight through to the full regen below —
 * unchanged, still fail-closed, never a partial trust.
 *
 * Returns null (never throws) on any missing/mismatched/unverifiable material so
 * boot degrades cleanly to the Community surface — fail-closed, never load
 * unverified code. `pubKeys` is injectable for tests (mirrors provisionModules).
 */
export function loadVerifiedModule(
  sku: string,
  opts: LicenseStoreOptions = {},
  pubKeys: readonly string[] = MODULE_SIGNING_PUBLIC_KEYS
): VerifiedModuleLocation | null {
  const rec = readInstalledModule(sku, opts);
  if (!rec) return null;
  const version = rec.version;
  const dir = installedModuleDir(sku, version, opts);
  const skuDir = dirname(dir);
  try {
    const blob = readFileSync(moduleArtifactPath(sku, version, opts));
    const digest = sha256Hex(blob);
    if (digest !== rec.sha256) {
      logger.warn(
        `module '${sku}' v${version} artifact hash changed since install — refusing to load`
      );
      return null;
    }
    if (!verifyModuleSignature(sku, version, digest, rec.sig, pubKeys)) {
      logger.warn(
        `module '${sku}' v${version} signature did not verify at boot — refusing to load`
      );
      return null;
    }

    // v2 fast path: skip the regen below entirely when the on-disk tree can be
    // proven, cheaply, to already equal these verified bytes. No v2 fields on
    // the pointer → today's path, unchanged (falls straight through).
    if (rec.files && rec.sig_v2) {
      const fast = verifyFastPath(sku, version, dir, digest, rec.files, rec.sig_v2, pubKeys);
      if (fast.ok) {
        return {
          version,
          dir,
          handlersPath: moduleHandlersPath(sku, version, opts),
          binDir: moduleBinDir(sku, version, opts),
          regenerated: false,
        };
      }
      logger.warn(
        `module '${sku}' v${version} fast-path check failed (${fast.reason}) — ` +
          `regenerating from the verified artifact`
      );
    }

    // Regenerate the decrypted tree from the verified artifact so the imported
    // handlers + spawned binary are exactly the signed bytes, closing the
    // install→boot TOCTOU. GCM-authenticated; a tampered artifact throws here.
    //
    // DL-3: Claude Desktop + Claude Code share `~/.editmamei` and can boot together,
    // so two processes can regenerate the SAME live `dir` at once. Writing straight
    // into `dir` (what `installBundle` would do if pointed at it directly) lets one
    // process's in-progress unpack be imported mid-write by the other — a torn
    // partial module. Regenerate into a private per-process staging dir instead and
    // swap it into `dir` with the same rename-aside/rename-in dance `installModule`'s
    // force path uses, so `dir` is never observed half-written — only "the previous
    // complete tree" or "the new complete tree", with a same-parent-rename-sized gap
    // between the two.
    const regenDir = join(skuDir, `${TMP_PREFIX}regen-${version}-${process.pid}`);
    rmSync(regenDir, { recursive: true, force: true }); // clear any crashed-run leftover
    try {
      installBundle(blob, rec.content_key, regenDir);
      // Retain the signature-bound artifact beside the regenerated tree, exactly
      // as installModule does (~:217). installBundle writes only the unpacked
      // tree (handlers/bin/manifest); WITHOUT this line the swapped-in dir has no
      // artifact.enc, so the NEXT boot's readFileSync(moduleArtifactPath) throws
      // ENOENT -> corrupt -> Pro dark offline / re-download every other boot,
      // defeating the audit-H1 re-verify-on-every-load invariant this path exists
      // to uphold.
      writeFileSync(join(regenDir, MODULE_ARTIFACT), Buffer.from(blob), { mode: 0o600 });
    } catch (err) {
      rmSync(regenDir, { recursive: true, force: true });
      throw err;
    }
    const oldDir = join(skuDir, `${TMP_PREFIX}regen-old-${version}-${process.pid}`);
    rmSync(oldDir, { recursive: true, force: true }); // clear any crashed-run leftover
    renameSync(dir, oldDir);
    try {
      renameSync(regenDir, dir);
      rmSync(oldDir, { recursive: true, force: true });
    } catch (err) {
      rmSync(regenDir, { recursive: true, force: true });
      if (existsSync(dir)) {
        // A concurrent sibling's regen won the race and already swapped in an
        // identical tree (same verified artifact + content key) — adopt it.
        rmSync(oldDir, { recursive: true, force: true });
      } else {
        // Genuine failure and no sibling filled it back in — restore the previous
        // tree so `dir` never resolves to nothing.
        renameSync(oldDir, dir);
        throw err;
      }
    }
    return {
      version,
      dir,
      handlersPath: moduleHandlersPath(sku, version, opts),
      binDir: moduleBinDir(sku, version, opts),
      regenerated: true,
    };
  } catch (err) {
    logger.warn(
      `module '${sku}' v${version} failed boot verification: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}
