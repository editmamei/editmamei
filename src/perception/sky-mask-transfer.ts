/**
 * Transfer a computed sky mask (from sky-ground-flood.ts) into Photoshop as the
 * active selection. The mask is computed at a downscaled working resolution; here we
 * render it to a grayscale BMP (lossless — every 0/255 value survives pixel-exact),
 * open it in PS, upscale to document dimensions, and load it as a selection via a
 * temporary alpha channel — the same PS-side, history-safe route
 * ps_select_subject_instance uses for its Sensei mask (paste into an explicitly-
 * targeted alpha channel so the original's pixels/layers are never touched).
 *
 * The grayscale → selection load is intentionally NOT thresholded: the BICUBIC
 * upscale (working resolution → full document resolution, below) is what produces
 * the soft, anti-aliased feathered sky boundary — a controlled source now that the
 * mask itself is lossless. (Until 2026-07-30 this was a q92 JPEG; the lossy
 * ringing it introduced near hard mask edges was an UNCONTROLLED second source of
 * "feathering" riding along with the upscale — removing it is a small correctness
 * improvement on top of the perf win of not JPEG-encoding a 2-value image.)
 *
 * The BICUBIC upscale is conditional on the mask doc first being converted OUT of
 * Indexed Color — see `buildLoadScript`'s comment at the `changeMode` call. An
 * 8bpp-indexed BMP (what `encodeMaskBmp` writes) opens in Photoshop as Indexed
 * Color, a mode where `resizeImage`'s `ResampleMethod` argument is IGNORED and
 * silently degrades to nearest-neighbor — without the mode fix, the "soft,
 * anti-aliased" boundary this comment promises would actually hard-edge.
 */

import * as fs from 'node:fs/promises';
import type { PhotoshopConnection } from '../platform/connection.js';
import { runScript } from '../utils/run-script.js';
import { TempDir, userOwnedTempRoot } from '../utils/temp.js';
import { getContextInfo } from '../api/extendscript/_helpers.js';
import { jsLit, jsNum } from '../utils/jsx.js';

const BMP_FILE_HEADER_SIZE = 14;
const BMP_INFO_HEADER_SIZE = 40;
const BMP_PALETTE_ENTRIES = 256;
const BMP_PALETTE_SIZE = BMP_PALETTE_ENTRIES * 4; // BGRA per entry
const BMP_PIXEL_OFFSET = BMP_FILE_HEADER_SIZE + BMP_INFO_HEADER_SIZE + BMP_PALETTE_SIZE;

/**
 * Encode a 0/1 mask as an uncompressed 8-bit grayscale BMP (255 = sky). Hand-rolled
 * — a lossless encoder isn't otherwise in the dependency tree and the format is
 * small: BITMAPFILEHEADER + BITMAPINFOHEADER + a 256-entry grayscale palette, then
 * bottom-up pixel rows padded to a 4-byte boundary (the BMP spec's row alignment
 * rule). Every mask value round-trips pixel-exact — no JPEG ringing near edges.
 */
export function encodeMaskBmp(mask: Uint8Array, w: number, h: number): Buffer {
  // Dimension validation: Photoshop cannot open a 0 (or negative/non-integer)
  // dimension BMP, so a degenerate w/h must throw rather than silently emit a
  // header-only file that would fail confusingly later at `app.open`.
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error(`encodeMaskBmp: w/h must be positive integers (got w=${w}, h=${h})`);
  }
  // A mask shorter than w*h would otherwise read past its end as `undefined`,
  // which the `mask[srcRow * w + x] ? 255 : 0` pixel loop below silently treats
  // as falsy — encoding the missing tail as solid BLACK instead of failing loud.
  if (mask.length < w * h) {
    throw new Error(
      `encodeMaskBmp: mask.length (${mask.length}) is smaller than w*h (${w * h}) — refusing to silently encode the missing tail as black`
    );
  }
  const rowSize = (w + 3) & ~3; // rows padded to a multiple of 4 bytes
  const pixelArraySize = rowSize * h;
  const fileSize = BMP_PIXEL_OFFSET + pixelArraySize;

  const buf = Buffer.alloc(fileSize);
  let o = 0;

  // BITMAPFILEHEADER (14 bytes)
  buf.write('BM', o, 'ascii');
  o += 2;
  buf.writeUInt32LE(fileSize, o);
  o += 4;
  buf.writeUInt32LE(0, o); // reserved1 + reserved2
  o += 4;
  buf.writeUInt32LE(BMP_PIXEL_OFFSET, o);
  o += 4;

  // BITMAPINFOHEADER (40 bytes)
  buf.writeUInt32LE(BMP_INFO_HEADER_SIZE, o);
  o += 4;
  buf.writeInt32LE(w, o); // biWidth
  o += 4;
  buf.writeInt32LE(h, o); // biHeight — POSITIVE = bottom-up
  o += 4;
  buf.writeUInt16LE(1, o); // biPlanes
  o += 2;
  buf.writeUInt16LE(8, o); // biBitCount (8bpp indexed)
  o += 2;
  buf.writeUInt32LE(0, o); // biCompression = BI_RGB (uncompressed)
  o += 4;
  buf.writeUInt32LE(pixelArraySize, o); // biSizeImage
  o += 4;
  buf.writeInt32LE(0, o); // biXPelsPerMeter
  o += 4;
  buf.writeInt32LE(0, o); // biYPelsPerMeter
  o += 4;
  buf.writeUInt32LE(BMP_PALETTE_ENTRIES, o); // biClrUsed
  o += 4;
  buf.writeUInt32LE(0, o); // biClrImportant (0 = all)
  o += 4;

  // 256-entry grayscale palette (BGRA, alpha byte unused/reserved).
  for (let i = 0; i < BMP_PALETTE_ENTRIES; i++) {
    buf[o++] = i; // blue
    buf[o++] = i; // green
    buf[o++] = i; // red
    buf[o++] = 0; // reserved
  }

  // Pixel data — BOTTOM-UP: the file's first row is the image's LAST row.
  // Buffer.alloc already zero-fills, so the padding bytes need no write.
  for (let y = 0; y < h; y++) {
    const srcRow = h - 1 - y;
    const rowStart = BMP_PIXEL_OFFSET + y * rowSize;
    for (let x = 0; x < w; x++) {
      buf[rowStart + x] = mask[srcRow * w + x] ? 255 : 0;
    }
  }

  return buf;
}

/**
 * ExtendScript: open the mask image, upscale to the document, paste it into a fresh
 * full-canvas alpha channel, load that channel as the selection, and re-target the RGB
 * composite (leaving an alpha channel active makes a later Make — e.g. a layer mask —
 * fail "command not currently available").
 *
 * `selType` is the ExtendScript SelectionType member (REPLACE/EXTEND/DIMINISH/INTERSECT).
 * For a COMBINE (not REPLACE) the prior selection is saved to its own channel FIRST —
 * because the mask-paste setup (selectAll → paste-into → deselect) necessarily clears
 * the current selection — then re-combined: add = mask∪prior, subtract = prior−mask,
 * intersect = prior∩mask. Selection-existence is probed via `executeActionGet` (never
 * `doc.selection.bounds`, which throws uncatchable error 1302 when nothing is selected).
 */
function buildLoadScript(maskPath: string, docW: number, docH: number, selType: string): string {
  return `
    ${getContextInfo}
    function __restoreComposite(d) {
      try {
        app.activeDocument = d;
        var ref = new ActionReference();
        ref.putEnumerated(app.charIDToTypeID('Chnl'), app.charIDToTypeID('Chnl'), app.charIDToTypeID('RGB '));
        var desc = new ActionDescriptor();
        desc.putReference(app.charIDToTypeID('null'), ref);
        app.executeAction(app.charIDToTypeID('slct'), desc, DialogModes.NO);
      } catch (eRC) {}
    }
    function __selExists(d) {
      try {
        var r = new ActionReference();
        r.putProperty(app.charIDToTypeID('Prpr'), app.stringIDToTypeID('selection'));
        r.putEnumerated(app.charIDToTypeID('Dcmn'), app.charIDToTypeID('Ordn'), app.charIDToTypeID('Trgt'));
        return app.executeActionGet(r).hasKey(app.stringIDToTypeID('selection'));
      } catch (eSe) { return false; }
    }
    if (app.documents.length === 0) { throw new Error('No document is open in Photoshop'); }
    var orig = app.activeDocument;
    var combine = '${selType}';

    // Save the prior selection (combine ops only) BEFORE the mask setup deselects it.
    var priorCh = null;
    if (combine !== 'REPLACE' && __selExists(orig)) {
      priorCh = orig.channels.add();
      orig.selection.store(priorCh);
    }

    // Bring the upscaled mask onto the clipboard, then paste it INTO a fresh full-canvas
    // alpha channel on the original (selectAll + paste-into keeps it aligned to canvas).
    var maskDoc = app.open(new File(${jsLit(maskPath)}));
    // TRAP: encodeMaskBmp writes an 8bpp PALETTIZED bitmap (a 256-entry grayscale
    // palette over indexed pixel data — see sky-mask-transfer.ts's encodeMaskBmp),
    // so Photoshop opens this file in INDEXED COLOR mode, not Grayscale. In Indexed
    // Color, resizeImage's ResampleMethod argument is silently IGNORED — there is no
    // palette-space bicubic — so the upscale below would degrade to nearest-neighbor
    // and hard-edge the sky/SAM selection despite asking for BICUBIC. Indexed →
    // Grayscale is a legal direct conversion (no intermediate RGB round trip needed)
    // and must happen BEFORE resizeImage for the requested resample method to apply.
    maskDoc.changeMode(ChangeMode.GRAYSCALE);
    maskDoc.resizeImage(
      UnitValue(${jsNum(docW, 1)}, 'px'),
      UnitValue(${jsNum(docH, 1)}, 'px'),
      null,
      ResampleMethod.BICUBIC
    );
    maskDoc.selection.selectAll();
    maskDoc.selection.copy();
    maskDoc.close(SaveOptions.DONOTSAVECHANGES);

    app.activeDocument = orig;
    var maskCh = orig.channels.add();
    orig.activeChannels = [maskCh];
    orig.selection.selectAll();
    orig.paste(true);
    orig.selection.deselect();

    // Load the mask (REPLACE), then re-combine with the saved prior selection.
    orig.selection.load(maskCh, SelectionType.REPLACE);
    if (priorCh) {
      if (combine === 'EXTEND') {
        orig.selection.load(priorCh, SelectionType.EXTEND);      // mask ∪ prior
      } else if (combine === 'DIMINISH') {
        orig.selection.load(priorCh, SelectionType.REPLACE);     // = prior
        orig.selection.load(maskCh, SelectionType.DIMINISH);     // prior − mask
      } else if (combine === 'INTERSECT') {
        orig.selection.load(priorCh, SelectionType.REPLACE);     // = prior
        orig.selection.load(maskCh, SelectionType.INTERSECT);    // prior ∩ mask
      }
      try { priorCh.remove(); } catch (eP) {}
    }
    try { maskCh.remove(); } catch (eRm) {}
    __restoreComposite(orig);
    return { ok: true };
  `;
}

/**
 * Render a 0/1 mask (at its working resolution) and load it as the active selection
 * on the active document — upscaled to the full document via a temp alpha channel,
 * history-safe (the same route ps_select_subject_instance uses for its Sensei mask).
 * Tool-agnostic: any mask producer (the sky flood, MobileSAM object cutout, …) uses
 * it. Leaves the selection active; best-effort temp cleanup. `docW`/`docH` are the
 * FULL document dimensions the mask upscales to.
 */
export type MaskSelectionType = 'replace' | 'add' | 'subtract' | 'intersect';

/** MaskSelectionType → the ExtendScript `SelectionType` enum member. Fixed strings
 *  (never user text) so interpolating the name into the script is injection-safe. */
const SELECTION_TYPE_ENUM: Record<MaskSelectionType, string> = {
  replace: 'REPLACE',
  add: 'EXTEND',
  subtract: 'DIMINISH',
  intersect: 'INTERSECT',
};

export async function loadMaskAsSelection(
  connection: PhotoshopConnection,
  mask: Uint8Array,
  maskW: number,
  maskH: number,
  docW: number,
  docH: number,
  selectionType: MaskSelectionType = 'replace'
): Promise<void> {
  const bmp = encodeMaskBmp(mask, maskW, maskH);
  const dir =
    process.platform === 'darwin'
      ? await TempDir.createWithRoot(userOwnedTempRoot(), 'editmamei-mask-')
      : await TempDir.create('editmamei-mask-');
  try {
    const maskPath = dir.path('mask.bmp');
    await fs.writeFile(maskPath, bmp);
    await runScript(
      connection,
      buildLoadScript(maskPath, docW, docH, SELECTION_TYPE_ENUM[selectionType])
    );
  } finally {
    await dir.cleanup();
  }
}

/** Back-compat alias — the sky recipe (select-recipes.ts) predates the rename. */
export const loadSkyMaskAsSelection = loadMaskAsSelection;
