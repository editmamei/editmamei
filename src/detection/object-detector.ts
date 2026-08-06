/**
 * Object detection via D-FINE-S (COCO-80, Apache-2.0). Gives the model semantic
 * scene awareness Photoshop never exposes — "dog here, sofa there, two people" —
 * with real bounding boxes in document-pixel space (a far stronger spatial
 * primitive than reading coordinates off a grid overlay).
 *
 * Contract (RT-DETR family): input `pixel_values` [1,3,640,640] RGB rescaled
 * /255 (no mean/std), CHW; outputs `logits` [1,300,80] (apply sigmoid) and
 * `pred_boxes` [1,300,4] (cxcywh normalized). DETR is "NMS-free" in theory, but
 * redundant queries fire on prominent objects, so a light class-aware NMS runs.
 */
import { loadModel, resolveModelPath, decodeJpeg, ort, type DecodedImage } from './runtime.js';
import { greedyNms, resizeToCHW, type Box } from './geometry.js';

const MODEL_FILE = 'dfine-s-coco-quant.onnx';
const IN_SIZE = 640;
const NUM_QUERIES = 300;
const NUM_CLASSES = 80;
const DEFAULT_THRESHOLD = 0.4;
const IOU_THRESHOLD = 0.5;
const DEFAULT_MAX = 50;

/** COCO-80 class names, in the model's label order (D-FINE config id2label). */
export const COCO_LABELS = [
  'person',
  'bicycle',
  'car',
  'motorbike',
  'aeroplane',
  'bus',
  'train',
  'truck',
  'boat',
  'traffic light',
  'fire hydrant',
  'stop sign',
  'parking meter',
  'bench',
  'bird',
  'cat',
  'dog',
  'horse',
  'sheep',
  'cow',
  'elephant',
  'bear',
  'zebra',
  'giraffe',
  'backpack',
  'umbrella',
  'handbag',
  'tie',
  'suitcase',
  'frisbee',
  'skis',
  'snowboard',
  'sports ball',
  'kite',
  'baseball bat',
  'baseball glove',
  'skateboard',
  'surfboard',
  'tennis racket',
  'bottle',
  'wine glass',
  'cup',
  'fork',
  'knife',
  'spoon',
  'bowl',
  'banana',
  'apple',
  'sandwich',
  'orange',
  'broccoli',
  'carrot',
  'hot dog',
  'pizza',
  'donut',
  'cake',
  'chair',
  'sofa',
  'pottedplant',
  'bed',
  'diningtable',
  'toilet',
  'tvmonitor',
  'laptop',
  'mouse',
  'remote',
  'keyboard',
  'cell phone',
  'microwave',
  'oven',
  'toaster',
  'sink',
  'refrigerator',
  'book',
  'clock',
  'vase',
  'scissors',
  'teddy bear',
  'hair drier',
  'toothbrush',
] as const;

export interface RawObject {
  label: string;
  class_id: number;
  bbox: Box;
  confidence: number;
}

export interface ObjectDetection {
  width: number;
  height: number;
  objects: RawObject[];
}

export interface ObjectDetectOptions {
  threshold?: number;
  /** Cap the returned objects (highest-confidence first). */
  maxObjects?: number;
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/**
 * Detect COCO-80 objects in an exported JPEG. Coordinates are in the EXPORT
 * image's pixel space (carry `width`/`height` for scaling to document pixels).
 * `decoded` is the export already decoded once by the caller (detectActiveDoc) —
 * when supplied, this skips its own decode (perf-audit H4).
 */
export async function detectObjects(
  imagePath: string,
  opts: ObjectDetectOptions = {},
  decoded?: DecodedImage
): Promise<ObjectDetection> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxObjects = opts.maxObjects ?? DEFAULT_MAX;
  const img = decoded ?? decodeJpeg(imagePath);
  const session = await loadModel(resolveModelPath(MODEL_FILE));
  const input = resizeToCHW(img, IN_SIZE, IN_SIZE, (v) => v / 255);
  const feeds = { pixel_values: new ort.Tensor('float32', input, [1, 3, IN_SIZE, IN_SIZE]) };
  const out = await session.run(feeds);

  const logits = out.logits.data as Float32Array; // [300,80]
  const boxes = out.pred_boxes.data as Float32Array; // [300,4] cxcywh norm
  const cand: RawObject[] = [];
  for (let q = 0; q < NUM_QUERIES; q++) {
    let bestC = -1;
    let bestS = 0;
    for (let c = 0; c < NUM_CLASSES; c++) {
      const s = sigmoid(logits[q * NUM_CLASSES + c]);
      if (s > bestS) {
        bestS = s;
        bestC = c;
      }
    }
    if (bestS >= threshold) {
      const cx = boxes[q * 4];
      const cy = boxes[q * 4 + 1];
      const bw = boxes[q * 4 + 2];
      const bh = boxes[q * 4 + 3];
      cand.push({
        label: COCO_LABELS[bestC],
        class_id: bestC,
        confidence: bestS,
        bbox: [
          (cx - bw / 2) * img.width,
          (cy - bh / 2) * img.height,
          (cx + bw / 2) * img.width,
          (cy + bh / 2) * img.height,
        ],
      });
    }
  }
  cand.sort((a, b) => b.confidence - a.confidence);
  const kept = greedyNms(cand, IOU_THRESHOLD, (a, b) => a.label === b.label);
  return { width: img.width, height: img.height, objects: kept.slice(0, maxObjects) };
}
