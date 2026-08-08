/**
 * Multi-file module bundle pack/unpack.
 *
 * A downloaded module is no longer a single fragment blob — it's a bundle of
 * several files: the esbuilt handler code (`pro-handlers.mjs`), one go-core
 * binary per platform (`bin/editmamei-core-<os>-<arch>`), and a `manifest.json`.
 * They travel as ONE artifact: the files are
 * zipped into a container, then the container bytes are AES-256-GCM encrypted
 * with the per-license content key (the same `IV||ct||tag` primitive go-core +
 * the delivery worker use). Install = decrypt → unzip → write the files out.
 *
 * The zip is a transport container, not a security boundary — the encryption is.
 * A non-payer can't decrypt the artifact at all; only after decryption is there
 * a zip to open. Integrity is the GCM auth tag (decrypt fails on tamper) plus the
 * manifest sha256 the caller checks on the whole artifact before trusting it.
 */

import AdmZip from 'adm-zip';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { encryptModule, decryptModule } from './crypto.js';

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

// Decompression-bomb / OOM guards on an unpacked bundle (audit L5). A real Pro
// bundle is the handler file + 3 go-core binaries + a manifest — a handful of
// entries, a few MB each. These caps are generous headroom, not tight fits.
const MAX_BUNDLE_ENTRIES = 64;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** One file inside a module bundle. `name` is a forward-slashed relative path. */
export interface BundleFile {
  name: string;
  data: Uint8Array;
  /** POSIX mode; the go-core binaries want 0o755. Defaults to 0o644. */
  mode?: number;
}

/** Zip a set of files into a single container buffer (deterministic entry order). */
export function zipBundle(files: BundleFile[]): Buffer {
  const zip = new AdmZip();
  // Sort by name so the container is byte-stable for a given input set.
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    zip.addFile(f.name, Buffer.from(f.data));
  }
  return zip.toBuffer();
}

/**
 * Read every entry out of a zip container buffer, bounded against a
 * decompression bomb: at most MAX_BUNDLE_ENTRIES files, each ≤ MAX_ENTRY_BYTES
 * uncompressed, ≤ MAX_TOTAL_BYTES in aggregate. The declared (header) size is
 * checked BEFORE decompressing each entry; the realized total is checked after.
 */
export function unzipBundle(container: Uint8Array): BundleFile[] {
  const zip = new AdmZip(Buffer.from(container));
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (entries.length > MAX_BUNDLE_ENTRIES) {
    throw new BundleError(
      `bundle has too many entries (${entries.length} > ${MAX_BUNDLE_ENTRIES})`
    );
  }
  const out: BundleFile[] = [];
  let total = 0;
  for (const e of entries) {
    // Reject traversal/absolute entry names at the boundary where names first
    // enter trusted code, so a name can never escape even a caller
    // that writes the returned files itself without going through installBundle's
    // safeResolve. adm-zip pre-sanitizes most `../` on read; this fail-closes the
    // rest (absolute / drive-letter / surviving `..`).
    if (isUnsafeEntryName(e.entryName)) {
      throw new BundleError(`bundle entry '${e.entryName}' escapes the install directory`);
    }
    const declared = e.header?.size ?? 0;
    if (declared > MAX_ENTRY_BYTES) {
      throw new BundleError(`bundle entry '${e.entryName}' is too large (${declared} bytes)`);
    }
    const data = e.getData();
    total += data.length;
    if (data.length > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) {
      throw new BundleError(`bundle uncompressed size exceeds the ${MAX_TOTAL_BYTES}-byte cap`);
    }
    out.push({ name: e.entryName, data });
  }
  return out;
}

/**
 * Pack a set of files into an encrypted artifact: zip → AES-256-GCM encrypt with
 * the base64 content key. The inverse of `unpackBundle`. Used by build:pro-module
 * and tests to produce artifacts with the same primitive the delivery worker uses.
 */
export function packBundle(files: BundleFile[], keyB64: string): Uint8Array {
  return encryptModule(zipBundle(files), keyB64);
}

/** Decrypt + unzip an artifact back into its files. Throws on a bad key / tampered bytes. */
export function unpackBundle(blob: Uint8Array, keyB64: string): BundleFile[] {
  return unzipBundle(decryptModule(blob, keyB64));
}

/**
 * Decrypt + unzip an artifact and write every file under `destDir`, creating
 * subdirectories as needed. Go-core binaries (basename contains `editmamei-core`)
 * are written executable; everything else 0o644. Returns the relative paths
 * written. The caller verifies the artifact's sha256 before calling this.
 *
 * Write safety: we materialize each entry's CONTENT with `writeFileSync` (never
 * adm-zip's `extractTo`, which would honor `../` + symlink entries), and every
 * destination path goes through `safeResolve`. A symlink entry is therefore
 * written as a regular file containing the link target bytes — never created as
 * a symlink and never followed — so no entry can write outside `destDir`.
 */
export function installBundle(blob: Uint8Array, keyB64: string, destDir: string): string[] {
  const files = unpackBundle(blob, keyB64);
  const root = resolve(destDir);
  const written: string[] = [];
  for (const f of files) {
    const out = safeResolve(root, f.name);
    // Owner-only dirs (0o700): the install tree holds decrypted Pro code +
    // binaries the host imports/spawns — keep other local accounts out (audit L5).
    mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
    const mode = f.mode ?? (isCoreBinary(f.name) ? 0o755 : 0o644);
    writeFileSync(out, f.data, { mode });
    written.push(f.name);
  }
  return written;
}

/**
 * Resolve a bundle entry name under `root`, throwing if it escapes the install
 * directory (Zip-Slip guard: absolute paths or `../` traversal). adm-zip already
 * sanitizes most traversal on read; this is the fail-closed backstop and the
 * directly-testable home of the safety rule. Exported for unit tests.
 */
export function safeResolve(root: string, name: string): string {
  const base = resolve(root);
  const out = resolve(base, name);
  const rel = relative(base, out);
  if (isAbsolute(name) || rel === '..' || rel.startsWith('..' + sep)) {
    throw new BundleError(`bundle entry '${name}' escapes the install directory`);
  }
  return out;
}

/**
 * Pure name-only traversal check used at the unzip boundary: an
 * absolute path (POSIX `/`, Windows drive `C:\`, or UNC) or any `..` segment is
 * unsafe. `installBundle`'s `safeResolve` is the resolve-against-root backstop;
 * this is the cheaper, container-agnostic first gate. Exported for unit tests.
 */
export function isUnsafeEntryName(name: string): boolean {
  if (isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name) || /^[\\/]{2}/.test(name)) return true;
  return name.split(/[\\/]/).some((seg) => seg === '..');
}

/** A go-core binary entry — written executable so it can spawn without a chmod step. */
function isCoreBinary(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  return base.startsWith('editmamei-core-');
}
