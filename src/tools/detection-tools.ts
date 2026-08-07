/**
 * ps_detect — local computer-vision perception over the active document.
 *
 * Exports a bounded-size JPEG of the active doc, runs local ONNX detectors
 * (Ultraface faces + D-FINE-S COCO-80 objects) on it, and returns labeled boxes
 * in DOCUMENT-pixel space plus an annotated preview so the result is visually
 * verifiable. Read-only — it renders a throwaway duplicate, never touches the
 * working document.
 *
 * This is the "seeing" primitive: it gives the model semantic scene awareness
 * (what's in the frame) with real coordinates, a far stronger spatial basis than
 * estimating positions off a grid overlay. The image never leaves the machine.
 * Detection runs on the export (export-pixel space); coordinates are lifted to
 * document pixels via the doc/export scale before they're returned.
 */
import { encode } from 'jpeg-js';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { detectActiveDoc, type DetectActiveDocDeps } from '../detection/detect-active-doc.js';
import type { DecodedImage } from '../detection/runtime.js';
import { ANNOTATED_PREVIEW_JPEG_QUALITY } from '../utils/jpeg-quality.js';
import {
  OnnxDetectionClient,
  type DetectionClient,
  type DetectionResult,
} from '../detection/detection-client.js';
import { toolErrorResult } from '../utils/tool-helpers.js';
import {
  computePixelIdentity,
  docKeyFrom,
  samePixelIdentity,
  type PixelIdentity,
} from '../perception/pixel-identity.js';
import {
  ANNOTATION_RGB,
  annotationThickness,
  drawBoxOutline,
  type RGB,
} from '../perception/overlay.js';

const detectSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      enum: ['faces', 'objects', 'both'],
      default: 'both',
      description:
        "What to detect: 'faces' (forward-facing faces), 'objects' (COCO-80 classes: person, dog, car, chair, …), or 'both'.",
    },
    max_dimension: {
      type: 'number',
      default: 1024,
      minimum: 256,
      maximum: 4096,
      description:
        'Long-edge pixels of the JPEG the detectors run on. Smaller is faster; the models downscale internally so 1024 is plenty. Returned coordinates are always in full document pixels regardless.',
    },
    face_threshold: {
      type: 'number',
      default: 0.7,
      minimum: 0,
      maximum: 1,
      description: 'Minimum face confidence (0–1).',
    },
    object_threshold: {
      type: 'number',
      default: 0.4,
      minimum: 0,
      maximum: 1,
      description: 'Minimum object confidence (0–1).',
    },
    max_objects: {
      type: 'number',
      default: 50,
      minimum: 1,
      maximum: 300,
      description: 'Cap on returned objects, highest-confidence first.',
    },
    annotate: {
      type: 'boolean',
      default: true,
      description:
        'Return an annotated preview with the detected boxes drawn (faces cyan, objects magenta) so you can visually confirm the detections.',
    },
  },
};

/** Draw axis-aligned boxes onto a COPY of the decoded export's pixels (verification
 *  overlay) — never mutate the caller's DecodedImage in place. Exported (not just
 *  internal) so a unit test can pin the clone invariant directly: two calls on the
 *  same DecodedImage must produce byte-identical output and leave `img.data`
 *  untouched (see tests/tools/detection-tools.test.ts, 3-gap-1). */
export function drawBoxes(
  img: DecodedImage,
  boxes: Array<{ bbox: [number, number, number, number]; rgb: RGB }>
): Buffer {
  const { width: w, height: h } = img;
  const data = Uint8Array.from(img.data);
  const out = { data, width: w, height: h };
  const thickness = annotationThickness(out);
  for (const { bbox, rgb } of boxes) {
    drawBoxOutline(out, bbox, rgb, thickness);
  }
  return encode({ data, width: w, height: h }, ANNOTATED_PREVIEW_JPEG_QUALITY).data;
}

/** One-line "person×2, dog, chair" style tally of detected object labels. */
function summarizeObjects(objects: DetectionResult['objects']): string {
  if (!objects || objects.length === 0) return '';
  const counts = new Map<string, number>();
  for (const o of objects) counts.set(o.label, (counts.get(o.label) ?? 0) + 1);
  return [...counts.entries()].map(([l, n]) => (n > 1 ? `${l}×${n}` : l)).join(', ');
}

/**
 * One-slot warm cache for ps_detect, keyed by decoded-pixel identity AND the
 * detector options. One slot matches ps_read_scene's cache (see scene-model.ts):
 * the consumer is one MCP session working one document, so alternating documents
 * thrashes but always stays correct — never stale.
 */
interface DetectCacheEntry {
  identity: PixelIdentity;
  /** Serialized detector options — different thresholds must not share boxes. */
  optionsKey: string;
  /** Boxes in DOCUMENT pixels. */
  result: DetectionResult;
  /** Boxes in EXPORT pixels (what the annotated preview draws). */
  raw: DetectionResult;
}

let detectCache: DetectCacheEntry | null = null;

/** Test-only: clear the ps_detect warm cache between cases. */
export function __clearDetectCache(): void {
  detectCache = null;
}

async function detect(
  connection: PhotoshopConnection,
  client: DetectionClient,
  rawArgs: Record<string, unknown>,
  detectDeps?: DetectActiveDocDeps
): Promise<ToolResult> {
  try {
    const args = validateArgs(detectSchema, rawArgs);
    const target = (args.target as string) ?? 'both';
    const annotate = (args.annotate as boolean) ?? true;
    const wantFaces = target === 'faces' || target === 'both';
    const wantObjects = target === 'objects' || target === 'both';

    // Export a bounded JPEG, detect, and lift boxes to document pixels.
    //
    // WARM CACHE: ps_detect had none, so two identical back-to-back calls each
    // re-ran full ONNX inference (measured live 2026-07-30 on a 51MP document:
    // 3,125ms then 3,440ms — the repeat was SLOWER). ps_read_scene has had a
    // pixel-identity cache since 2026-07-30; this is the same probe, shared from
    // perception/pixel-identity.ts rather than reimplemented.
    //
    // The export+decode round trip still runs — it IS the freshness signal and
    // can't be skipped without losing it — so `shouldDetect` makes the hit/miss
    // call at the probe itself and skips only the inference underneath. The
    // detector options are part of the key: a threshold or target change must
    // re-run rather than serve boxes filtered for different settings.
    const detectKey = JSON.stringify({
      faces: wantFaces,
      objects: wantObjects,
      maxDimension: args.max_dimension ?? null,
      faceThreshold: args.face_threshold ?? null,
      objectThreshold: args.object_threshold ?? null,
      maxObjects: args.max_objects ?? null,
    });
    // Both are per-call LOCALS captured by the shouldDetect closure below, never
    // module state. A module-global `pendingIdentity` leaked across calls: if
    // inference threw after the probe set it, or `shouldDetect` was skipped on a
    // later call (detect-active-doc degrades to detecting when the probe throws,
    // and `decoded` can be undefined), the next call would store ITS boxes under
    // the PREVIOUS document's identity — and a later call on that first document
    // would be served the wrong detections. Two concurrent ps_detect calls hit
    // the same hazard.
    let hit: DetectCacheEntry | null = null;
    let pendingIdentity: PixelIdentity | null = null;
    const det = await detectActiveDoc(
      connection,
      client,
      {
        faces: wantFaces,
        objects: wantObjects,
        maxDimension: args.max_dimension as number | undefined,
        faceThreshold: args.face_threshold as number | undefined,
        objectThreshold: args.object_threshold as number | undefined,
        maxObjects: args.max_objects as number | undefined,
        shouldDetect: ({ decoded, context, docWidth, docHeight }) => {
          if (!decoded) return true; // no pixels to key on — always detect
          const identity = computePixelIdentity(decoded, docKeyFrom(context, docWidth, docHeight));
          if (
            detectCache &&
            detectCache.optionsKey === detectKey &&
            samePixelIdentity(detectCache.identity, identity)
          ) {
            hit = detectCache;
            return false; // pixel-identical under the same options — skip ONNX
          }
          pendingIdentity = identity;
          return true;
        },
      },
      detectDeps
    );

    // On a hit, detectActiveDoc returns empty detections (it never ran) — serve
    // the cached boxes instead. On a miss, store what we just computed.
    const mapped = hit ? (hit as DetectCacheEntry).result : det.result;
    const rawDetections = hit ? (hit as DetectCacheEntry).raw : det.raw;
    if (!hit && pendingIdentity) {
      detectCache = {
        identity: pendingIdentity,
        optionsKey: detectKey,
        result: det.result,
        raw: det.raw,
      };
    }

    // Annotate the export with the EXPORT-pixel boxes (det.raw matches the
    // export image). Non-fatal — the structured detection still returns if
    // drawing fails.
    const content: ToolResult['content'] = [];
    if (annotate && det.decoded) {
      try {
        const boxes: Array<{
          bbox: [number, number, number, number];
          rgb: RGB;
        }> = [
          // rawDetections, not det.raw — on a cache HIT det.raw is empty
          // (inference never ran) and the preview would draw no boxes at all.
          ...(rawDetections.faces ?? []).map((f) => ({ bbox: f.bbox, rgb: ANNOTATION_RGB.face })),
          ...(rawDetections.objects ?? []).map((o) => ({
            bbox: o.bbox,
            rgb: ANNOTATION_RGB.object,
          })),
        ];
        const annotated = drawBoxes(det.decoded, boxes);
        content.push({
          type: 'image' as const,
          data: annotated.toString('base64'),
          mimeType: 'image/jpeg',
        });
      } catch {
        // Non-fatal: fall through to the structured result without the preview.
      }
    }

    const faceCount = mapped.faces?.length ?? 0;
    const objCount = mapped.objects?.length ?? 0;
    const parts: string[] = [];
    if (wantFaces) parts.push(`${faceCount} face${faceCount === 1 ? '' : 's'}`);
    if (wantObjects) {
      const tally = summarizeObjects(mapped.objects);
      parts.push(`${objCount} object${objCount === 1 ? '' : 's'}${tally ? ` (${tally})` : ''}`);
    }
    content.push({
      type: 'text' as const,
      text:
        `Detected ${parts.join(', ')} in the active document (${det.docWidth}×${det.docHeight}). ` +
        `All bounding boxes are [x1, y1, x2, y2] in document pixels.`,
    });

    return {
      content,
      structuredContent: {
        image: mapped.image,
        backends: mapped.backends,
        ...(mapped.faces ? { faces: mapped.faces } : {}),
        ...(mapped.objects ? { objects: mapped.objects } : {}),
        context: det.context,
      },
    };
  } catch (error) {
    return toolErrorResult('Error during detection', error);
  }
}

export function createDetectionTools(
  connection: PhotoshopConnection,
  _snippetClient: SnippetClient,
  client: DetectionClient = new OnnxDetectionClient(),
  /** Test-only seam: passed straight through to detectActiveDoc's injected
   *  readFile/decode (see DetectActiveDocDeps), so a unit test can prove the
   *  pixel-identity warm cache without a real PS export on disk. Mirrors
   *  scene-tools' identical seam. Never set in production. */
  detectDeps?: DetectActiveDocDeps
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_detect',
        description:
          'Locate faces and/or COCO-80 objects (person, dog, car, chair, sofa, …) in the active document using LOCAL on-device computer vision — the image is never sent anywhere. Returns labeled bounding boxes in DOCUMENT-pixel space plus an annotated preview for visual confirmation. Use this to gain semantic scene awareness ("there are 2 people and a dog") and real coordinates before any spatially-targeted edit — far more reliable than estimating positions from a preview. `target` selects faces / objects / both. Read-only: renders a throwaway duplicate, never modifies the working document. Boxes are [x1, y1, x2, y2]. Validate surprising results against the annotated image before acting on them.',
        inputSchema: detectSchema,
        outputSchema: {
          type: 'object',
          properties: {
            image: {
              type: 'object',
              properties: { width: { type: 'number' }, height: { type: 'number' } },
            },
            backends: { type: 'object' },
            faces: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  bbox: { type: 'array', items: { type: 'number' } },
                  confidence: { type: 'number' },
                },
              },
            },
            objects: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  class_id: { type: 'number' },
                  bbox: { type: 'array', items: { type: 'number' } },
                  confidence: { type: 'number' },
                },
              },
            },
            context: { type: 'object' },
          },
        },
        annotations: {
          title: 'Detect Faces & Objects',
          readOnlyHint: true,
          idempotentHint: true,
        },
      },
      handler: async (args) => detect(connection, client, args, detectDeps),
    },
  ];
}
