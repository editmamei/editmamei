/**
 * Shared "export the active doc, detect, map to document pixels" step.
 *
 * Both the perception tool (ps_detect) and the detection-driven
 * orchestrations (ps_portrait_touchup, ps_edit_object) need the same
 * front half: render a bounded JPEG of the active document, run the local
 * detectors on it (EXPORT-pixel space), then lift the boxes to DOCUMENT pixels.
 * Centralizing it keeps the coordinate-frame discipline in one place.
 */
import { readFile } from 'node:fs/promises';
import type { PhotoshopConnection } from '../platform/connection.js';
import { getContextInfo } from '../api/extendscript/_helpers.js';
import { jsLit, jsNum } from '../utils/jsx.js';
import { runScript } from '../utils/run-script.js';
import { TempDir, userOwnedTempRoot } from '../utils/temp.js';
import { decodeJpegBuffer, type DecodedImage } from './runtime.js';
import {
  mapDetectionToDoc,
  type DetectionClient,
  type DetectionResult,
} from './detection-client.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('detect-active-doc');

export interface DetectActiveDocOptions {
  faces?: boolean;
  objects?: boolean;
  maxDimension?: number;
  faceThreshold?: number;
  objectThreshold?: number;
  maxObjects?: number;
  /**
   * Called right after export+decode — with the decoded pixels, the export
   * context (getContextInfo() snapshot), and the doc dimensions — and BEFORE
   * `client.detect()`, while the export's temp file is still on disk. Return
   * `false` to skip the `client.detect()` ONNX call entirely; return `true`
   * (or omit this option) to detect normally.
   *
   * Exists so a warm-cache caller (scene-model.ts's pixel-identity cache) can
   * make its hit/miss decision AT the freshness probe itself — the export+
   * decode round trip can't be skipped without losing the freshness signal,
   * but the expensive ONNX inference underneath can be, once the caller knows
   * the decoded pixels match a previous build. Splitting this into a second
   * detectActiveDoc call would lose the temp file (cleaned up in `finally`
   * before returning), so the decision has to happen inside this one call.
   */
  shouldDetect?: (info: {
    decoded: DecodedImage | undefined;
    context: Record<string, unknown> | undefined;
    docWidth: number;
    docHeight: number;
  }) => boolean;
}

/** Injectable I/O seam (default: real fs read + the real jpeg-js decode). Lets a
 *  test prove the decode-once invariant without a real PS export
 *  on disk — the unit harness has no live Photoshop to write `tempPath`. */
export interface DetectActiveDocDeps {
  readFile?: (path: string) => Promise<Buffer>;
  decode?: (bytes: Buffer) => DecodedImage;
}

export interface DetectActiveDocResult {
  docWidth: number;
  docHeight: number;
  /** Boxes already lifted to DOCUMENT pixels (what orchestrations act on). */
  result: DetectionResult;
  /** Boxes in EXPORT-image pixels (matches exportBytes — for annotated previews). */
  raw: DetectionResult;
  /** getContextInfo() snapshot from the export script. */
  context: Record<string, unknown> | undefined;
  /** The bounded export JPEG bytes (for annotated previews). */
  exportBytes: Buffer;
  /**
   * The export decoded ONCE here and threaded to the detector plus every
   * downstream consumer that needs pixels (annotated previews, row-brightness,
   * SAM/grounding pixel readers) instead of each re-reading + re-decoding the
   * same file (up to 4-5 redundant decodes per perception call).
   * Undefined when the export bytes were unreadable or undecodable — callers
   * guard on this exactly as they used to guard on an empty `exportBytes`.
   */
  decoded: DecodedImage | undefined;
}

/**
 * Export a bounded JPEG of the active document (duplicate → resize → save),
 * detect on it, and return the boxes in document-pixel space. Manages its own
 * temp dir (cleaned before returning). Throws if there is no active document or
 * the export/detection fails.
 */
export async function detectActiveDoc(
  connection: PhotoshopConnection,
  client: DetectionClient,
  opts: DetectActiveDocOptions,
  deps: DetectActiveDocDeps = {}
): Promise<DetectActiveDocResult> {
  const readFileFn = deps.readFile ?? readFile;
  const decodeFn = deps.decode ?? decodeJpegBuffer;
  const maxDimension = opts.maxDimension ?? 1024;
  const dir =
    process.platform === 'darwin'
      ? await TempDir.createWithRoot(userOwnedTempRoot(), 'editmamei-detect-')
      : await TempDir.create('editmamei-detect-');
  try {
    const tempPath = dir.path('detect.jpg');
    const script = `
      ${getContextInfo}
      if (app.documents.length === 0) { throw new Error('No document is open in Photoshop'); }
      for (var __pi = app.documents.length - 1; __pi >= 0; __pi--) {
        try {
          var __pd = app.documents[__pi];
          if (String(__pd.name).indexOf('__mcp_detect__') !== -1) {
            try { __pd.close(SaveOptions.DONOTSAVECHANGES); } catch (e0) {}
          }
        } catch (e1) {}
      }
      var orig = app.activeDocument;
      var origW = orig.width.as('px');
      var origH = orig.height.as('px');
      var dup = orig.duplicate(orig.name + ' __mcp_detect__');
      try {
        var w = dup.width.as('px');
        var h = dup.height.as('px');
        var longEdge = (w > h) ? w : h;
        if (longEdge > ${jsNum(maxDimension, 1024)}) {
          var scale = ${jsNum(maxDimension, 1024)} / longEdge;
          dup.resizeImage(
            UnitValue(Math.round(w * scale), 'px'),
            UnitValue(Math.round(h * scale), 'px'),
            null,
            ResampleMethod.BICUBIC
          );
        }
        var outFile = new File(${jsLit(tempPath)});
        var opts = new JPEGSaveOptions();
        opts.quality = 8;
        opts.embedColorProfile = true;
        opts.formatOptions = FormatOptions.STANDARDBASELINE;
        dup.saveAs(outFile, opts, true, Extension.LOWERCASE);
        if (!outFile.exists) {
          try { dup.close(SaveOptions.DONOTSAVECHANGES); } catch (eD) {}
          try { app.activeDocument = orig; } catch (eA) {}
          throw new Error('JPEG saveAs reported success but no file at ' + outFile.fsName);
        }
        dup.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = orig;
        return { ok: true, doc_width: origW, doc_height: origH, context: getContextInfo() };
      } catch (e) {
        try { dup.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
        try { app.activeDocument = orig; } catch (e3) {}
        throw e;
      }
    `;
    const exp = (await runScript(connection, script)) as {
      doc_width?: number;
      doc_height?: number;
      context?: Record<string, unknown>;
    };
    const docWidth = exp.doc_width ?? 0;
    const docHeight = exp.doc_height ?? 0;

    // Read + decode the export ONCE — never let a read/decode failure sink the
    // detection result (and keeps the helper unit-testable without a real export
    // on disk). The single read below replaces what used to be a SEPARATE
    // post-detect readFile PLUS a decode inside each detector — client.detect()
    // gets the already-decoded image instead of re-reading/re-decoding tempPath.
    let exportBytes: Buffer = Buffer.alloc(0);
    let decoded: DecodedImage | undefined;
    try {
      exportBytes = await readFileFn(tempPath);
    } catch {
      // leave empty; callers guard drawing
    }
    if (exportBytes.length > 0) {
      try {
        decoded = decodeFn(exportBytes);
      } catch {
        // leave undefined; a bad/truncated export must not sink the detection
      }
    }

    // shouldDetect is caller-supplied (scene-model.ts's pixel-identity cache
    // probe) and runs pure JS over the just-decoded pixels — a throw there (e.g.
    // a hash computation surprise) must degrade to detecting normally, matching
    // the read/decode failure posture just above, rather than sinking the whole
    // detection call.
    let doDetect = true;
    if (opts.shouldDetect) {
      try {
        doDetect = opts.shouldDetect({ decoded, context: exp.context, docWidth, docHeight });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug(`shouldDetect threw (${msg}) — degrading to detect normally`);
        doDetect = true;
      }
    }
    const raw: DetectionResult = doDetect
      ? await client.detect(
          tempPath,
          {
            faces: opts.faces,
            objects: opts.objects,
            faceThreshold: opts.faceThreshold,
            objectThreshold: opts.objectThreshold,
            maxObjects: opts.maxObjects,
          },
          decoded
        )
      : {
          image: decoded
            ? { width: decoded.width, height: decoded.height }
            : { width: 0, height: 0 },
          backends: {},
        };
    const result = mapDetectionToDoc(raw, docWidth, docHeight);
    return { docWidth, docHeight, result, raw, context: exp.context, exportBytes, decoded };
  } finally {
    await dir.cleanup();
  }
}
