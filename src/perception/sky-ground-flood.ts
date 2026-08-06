/**
 * Sky selection by GROUND SUBTRACTION (Scene Model — sky_ground_flood method).
 *
 * A structural, mostly-content-free sky mask, validated live across hard cases
 * (couple-in-frame, vehicle-on-grass, jagged ridgeline + storm clouds, sunset over
 * water). The pipeline, in order:
 *
 *   1. Ground cue per pixel (green / dark-not-blue / sustained-texture) → a coarse
 *      "this is terrain/foliage/shadow" score. (The one place colour/luma is used.)
 *   2. OPEN it → thin ground (a bare tree's branches, wires) dissolves to sky; solid
 *      ground (a grass patch, a head) survives.
 *   3. LANDMASS = the ground connected to the BOTTOM of the frame. A blob that scores
 *      like terrain but floats in the sky (a dark storm cloud) is NOT the landmass, so
 *      it falls back to sky. This is what makes the dark-cloud gaps disappear.
 *   4. SKY = flood from the top through everything that is NOT the landmass — 2D, so
 *      sky beside a tall occluder is handled, and the dark zenith / corners are in by
 *      construction (no brightness threshold on the sky itself).
 *   5. FILL the thin intrusions the sky has to bridge (ridge spurs, branches, cloud-edge
 *      notches) with an aggressive morphological close — but ONLY outside detected
 *      object boxes, so a real person / vehicle is never bridged over. "It's not a real
 *      object → fill it" — the object detector is the arbiter, not colour.
 *   6. Fill sky-ENCLOSED holes by enclosure (border-flood), then a speckle close.
 *
 * Pure + deterministic over an RGBA buffer + detection boxes — no Photoshop, no file
 * I/O — so it is fully unit-testable. The caller decodes the export JPEG, supplies the
 * detected object boxes (in the buffer's pixel space), and transfers the returned mask
 * into PS as a selection (see sky-mask-transfer.ts).
 */

/** Axis-aligned box [x1, y1, x2, y2]. */
export type Box = [number, number, number, number];

export interface SkyMaskResult {
  /** 1 = sky, 0 = not, row-major at {@link width}×{@link height}. */
  mask: Uint8Array;
  width: number;
  height: number;
}

export interface SkyMaskOptions {
  /** Internal working width the morphology radii are tuned for (default 520). */
  targetWidth?: number;
}

// ---- tunables (calibrated at the ~520px working width) ----
const GREEN_SCALE = 35; // green dominance → ground
const DARK_LUM = 60;
const DARK_SCALE = 45; // near-black solids (a vehicle, deep shadow) → ground
const DARK2 = 145;
const DARK2_RANGE = 90;
const BLUE_PROTECT = 22; // dark-AND-not-blue → ground (mountains); a blue sky is spared
const TEX_SCALE = 0.085;
const TEX_LUM_MAX = 178; // sustained texture in non-bright areas → ground (ridge/foliage)
const GROUND_BIN = 0.45; // ground binarization
const OPEN_R = 1; // dissolve ground thinner than this (tree branches)
const CLOSE_R = 1; // speckle cleanup
const SKY_CLOSE_R = 8; // bridge the sky across thin intrusions the detector doesn't claim

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

/**
 * Compute the sky mask from an RGBA buffer + detected object boxes (both in the same
 * pixel space). Internally box-downscales to ~`targetWidth` (where the morphology radii
 * are tuned) and returns the mask at that working resolution; the caller upscales it
 * when transferring to a full-resolution selection.
 */
export function computeSkyMask(
  rgba: Uint8Array | Buffer,
  srcW: number,
  srcH: number,
  boxes: Box[],
  opts: SkyMaskOptions = {}
): SkyMaskResult {
  const targetWidth = opts.targetWidth ?? 520;
  const F = Math.max(1, Math.round(srcW / targetWidth));
  const W = Math.max(1, Math.floor(srcW / F));
  const H = Math.max(1, Math.floor(srcH / F));
  const N = W * H;

  // ---- box-downscale to the working resolution ----
  const R = new Float64Array(N);
  const G = new Float64Array(N);
  const B = new Float64Array(N);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let dy = 0; dy < F; dy++)
        for (let dx = 0; dx < F; dx++) {
          const i = ((y * F + dy) * srcW + (x * F + dx)) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          n++;
        }
      const o = y * W + x;
      R[o] = r / n;
      G[o] = g / n;
      B[o] = b / n;
    }

  // ---- luminance, greenness, Sobel edge, texture density ----
  const lum = new Float64Array(N);
  const greenness = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    lum[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i];
    greenness[i] = clamp((G[i] - Math.max(R[i], B[i])) / GREEN_SCALE, 0, 1);
  }
  const edge = new Float64Array(N);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const gx =
        lum[(y - 1) * W + x + 1] +
        2 * lum[y * W + x + 1] +
        lum[(y + 1) * W + x + 1] -
        (lum[(y - 1) * W + x - 1] + 2 * lum[y * W + x - 1] + lum[(y + 1) * W + x - 1]);
      const gy =
        lum[(y + 1) * W + x - 1] +
        2 * lum[(y + 1) * W + x] +
        lum[(y + 1) * W + x + 1] -
        (lum[(y - 1) * W + x - 1] + 2 * lum[(y - 1) * W + x] + lum[(y - 1) * W + x + 1]);
      edge[y * W + x] = Math.min(1, Math.hypot(gx, gy) / 600);
    }
  const textureDensity = boxBlur(edge, W, H, 2);

  // ---- ground cue → binary not-sky ----
  const notSky = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const darkSolid = lum[i] < DARK_LUM ? clamp((DARK_LUM - lum[i]) / DARK_SCALE, 0, 1) : 0;
    const texturedNonSky = lum[i] < TEX_LUM_MAX ? clamp(textureDensity[i] / TEX_SCALE, 0, 1) : 0;
    const blueDom = B[i] - Math.max(R[i], G[i]);
    const darkNotBlue =
      clamp((DARK2 - lum[i]) / DARK2_RANGE, 0, 1) * (1 - clamp(blueDom / BLUE_PROTECT, 0, 1));
    const ground = Math.max(greenness[i], darkSolid, 0.85 * texturedNonSky, darkNotBlue);
    if (ground >= GROUND_BIN) notSky[i] = 1;
  }

  // ---- open (thin → sky) → bottom-connected landmass → flood sky from top ----
  const solidGroundRaw = open(notSky, W, H, OPEN_R);
  const landmass = floodFromBottom(solidGroundRaw, W, H);
  const skyFill = floodTop((i) => landmass[i] === 0, W, H);

  // ---- object-gated intrusion fill: the close may only ADD outside object boxes ----
  const objMask = rasterizeBoxes(boxes, W, H, F);
  const closed = close(skyFill, W, H, SKY_CLOSE_R);
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask[i] = skyFill[i] || (closed[i] && !objMask[i]) ? 1 : 0;

  // ---- fill sky-enclosed holes (cloud gaps) by enclosure, then speckle close ----
  fillEnclosedHoles(mask, W, H);
  const finalMask = close(mask, W, H, CLOSE_R);

  return { mask: finalMask, width: W, height: H };
}

// ---------- helpers (all operate on row-major W×H buffers) ----------

function rasterizeBoxes(boxes: Box[], W: number, H: number, F: number): Uint8Array {
  const m = new Uint8Array(W * H);
  for (const b of boxes) {
    const x1 = Math.max(0, Math.floor(b[0] / F));
    const y1 = Math.max(0, Math.floor(b[1] / F));
    const x2 = Math.min(W, Math.ceil(b[2] / F));
    const y2 = Math.min(H, Math.ceil(b[3] / F));
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) m[y * W + x] = 1;
  }
  return m;
}

function floodTop(passable: (i: number) => boolean, W: number, H: number): Uint8Array {
  const vis = new Uint8Array(W * H);
  const st: number[] = [];
  for (let x = 0; x < W; x++)
    if (passable(x)) {
      vis[x] = 1;
      st.push(x);
    }
  pushNeighbors(st, vis, passable, W, H);
  return vis;
}

function floodFromBottom(mask: Uint8Array, W: number, H: number): Uint8Array {
  const vis = new Uint8Array(W * H);
  const st: number[] = [];
  for (let x = 0; x < W; x++) {
    const i = (H - 1) * W + x;
    if (mask[i]) {
      vis[i] = 1;
      st.push(i);
    }
  }
  pushNeighbors(st, vis, (i) => mask[i] === 1, W, H);
  return vis;
}

/** Shared 4-connected flood worker: drains `st`, marking `vis`, gated by `passable`. */
function pushNeighbors(
  st: number[],
  vis: Uint8Array,
  passable: (i: number) => boolean,
  W: number,
  H: number
): void {
  while (st.length) {
    const p = st.pop() as number;
    const x = p % W;
    const y = (p - x) / W;
    if (x + 1 < W && !vis[p + 1] && passable(p + 1)) {
      vis[p + 1] = 1;
      st.push(p + 1);
    }
    if (x - 1 >= 0 && !vis[p - 1] && passable(p - 1)) {
      vis[p - 1] = 1;
      st.push(p - 1);
    }
    if (y + 1 < H && !vis[p + W] && passable(p + W)) {
      vis[p + W] = 1;
      st.push(p + W);
    }
    if (y - 1 >= 0 && !vis[p - W] && passable(p - W)) {
      vis[p - W] = 1;
      st.push(p - W);
    }
  }
}

/**
 * Fill non-mask regions NOT reachable from the image border (enclosed holes) — sky
 * pockets fully ringed by sky. Exported for direct unit testing of the border-flood.
 */
export function fillEnclosedHoles(mask: Uint8Array, W: number, H: number): void {
  const reach = new Uint8Array(W * H);
  const st: number[] = [];
  const seed = (i: number): void => {
    if (!mask[i] && !reach[i]) {
      reach[i] = 1;
      st.push(i);
    }
  };
  for (let x = 0; x < W; x++) {
    seed(x);
    seed((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    seed(y * W);
    seed(y * W + W - 1);
  }
  pushNeighbors(st, reach, (i) => mask[i] === 0, W, H);
  for (let i = 0; i < W * H; i++) if (!mask[i] && !reach[i]) mask[i] = 1;
}

function dilate(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let dy = -r; dy <= r && !v; dy++)
        for (let dx = -r; dx <= r && !v; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          if (mask[yy * W + xx]) v = 1;
        }
      out[y * W + x] = v;
    }
  return out;
}

function erode(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let v = 1;
      for (let dy = -r; dy <= r && v; dy++)
        for (let dx = -r; dx <= r && v; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; // ignore border
          if (!mask[yy * W + xx]) v = 0;
        }
      out[y * W + x] = v;
    }
  return out;
}

function open(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  return dilate(erode(mask, W, H, r), W, H, r);
}

function close(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  return erode(dilate(mask, W, H, r), W, H, r);
}

function boxBlur(src: Float64Array, W: number, H: number, iters: number): Float64Array {
  let a = Float64Array.from(src);
  let b = new Float64Array(W * H);
  for (let it = 0; it < iters; it++) {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let s = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            s += a[yy * W + xx];
            n++;
          }
        b[y * W + x] = s / n;
      }
    const t = a;
    a = b;
    b = t;
  }
  return a;
}
