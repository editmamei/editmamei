/**
 * Pixel identity — the shared warm-cache freshness probe.
 *
 * FRESHNESS IDENTITY = the decoded PIXELS, not the exported file bytes (PS may
 * embed varying metadata — timestamps, ICC profile ordering — into the export,
 * which would kill byte-identity silently; pixel identity is deterministic).
 * Mirrors OnnxSamSegmenter's embedding-memo pattern (src/detection/sam-segmenter.ts
 * `computeImageKey`) — same FNV-1a-over-sampled-slabs shape. `docKey` (document
 * name + dims, read for free off the export context) keeps two different
 * documents that happen to render byte-identical composites from ever colliding.
 *
 * Extracted from scene-model.ts (2026-08-01) so ps_detect can reuse the exact
 * same probe instead of growing a second, subtly-different one. Detection and
 * the scene model export the same bounded JPEG and answer the same question —
 * "are these the pixels I already ran ONNX on?" — so they must agree on what
 * "same pixels" means, or one of them serves a stale answer the other wouldn't.
 */

import type { DecodedImage } from '../detection/runtime.js';

const HASH_SAMPLE_BYTES = 4096;
const HASH_STRIDE_SAMPLES = 1024;

function fnv1a(data: Uint8Array, start: number, end: number, seed: number): number {
  let h = seed;
  for (let i = start; i < end; i++) {
    h = Math.imul(h ^ data[i], 0x01000193) >>> 0;
  }
  return h;
}

export interface PixelIdentity {
  /** null when the export context didn't carry a usable document.name (a
   *  degraded getContextInfo() path) — see docKeyFrom's doc comment. */
  docKey: string | null;
  width: number;
  height: number;
  byteLength: number;
  hash: number;
}

/**
 * Document identity from the export context — free (no extra PS round trip):
 * the export script already reads doc.name and returns doc width/height.
 * Returns null (not a shared 'unknown' sentinel) when document.name is
 * missing/non-string — two DIFFERENT documents hitting this degraded path must
 * never collide into a false cache hit just because they share a placeholder
 * name; samePixelIdentity below treats a null docKey on either side as
 * always-miss (no verifiable identity).
 */
export function docKeyFrom(
  context: Record<string, unknown> | undefined,
  docWidth: number,
  docHeight: number
): string | null {
  const doc = (context as { document?: { name?: unknown; hasSelection?: unknown } } | undefined)
    ?.document;
  const name = typeof doc?.name === 'string' ? doc.name : null;
  if (name === null) return null;
  // hasSelection is part of the identity because doc.histogram is natively
  // selection-scoped (see template-tools-pro's gatherMeasurements): a leftover
  // selection changes tonal zones without changing a single pixel, so a
  // selection-state flip must MISS rather than serve selection-scoped facets
  // to a selection-free read (or vice versa).
  const sel = doc?.hasSelection === true ? 'S' : 'N';
  return `${name}:${docWidth}x${docHeight}:${sel}`;
}

export function computePixelIdentity(decoded: DecodedImage, docKey: string | null): PixelIdentity {
  const { width, height, data } = decoded;
  const n = data.length;
  let h = fnv1a(data, 0, Math.min(HASH_SAMPLE_BYTES, n), 0x811c9dc5);
  h = fnv1a(data, Math.max(0, n - HASH_SAMPLE_BYTES), n, h);
  const stride = Math.max(1, Math.floor(n / HASH_STRIDE_SAMPLES));
  for (let i = 0; i < n; i += stride) {
    h = Math.imul(h ^ data[i], 0x01000193) >>> 0;
  }
  return { docKey, width, height, byteLength: n, hash: h };
}

export function samePixelIdentity(a: PixelIdentity, b: PixelIdentity): boolean {
  // A null docKey means no verifiable document identity (degraded context) —
  // fail-safe to always-miss rather than let two unrelated degraded docs match
  // on docKey === docKey === null.
  if (a.docKey === null || b.docKey === null) return false;
  return (
    a.docKey === b.docKey &&
    a.width === b.width &&
    a.height === b.height &&
    a.byteLength === b.byteLength &&
    a.hash === b.hash
  );
}

/** Opaque, human-debuggable string form of a PixelIdentity — becomes
 *  `provenance.cache_key` and is what region-precompute.ts's menu-reuse gate
 *  compares against. */
export function identityKeyString(identity: PixelIdentity): string {
  return `${identity.docKey}:${identity.width}x${identity.height}:${identity.byteLength}:${identity.hash.toString(16)}`;
}
