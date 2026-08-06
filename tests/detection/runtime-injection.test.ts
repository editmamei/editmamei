import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadModel,
  resolveModelPath,
  useHostRuntime,
  hostDetectionRuntime,
  ort,
} from '@editmamei/detection/runtime.ts';
import { makeFakeDetection } from '../fixtures/fake-detection.ts';

// The delivered Pro module runs as a relocated esbuild bundle (no node_modules,
// no staged CE weights). `useHostRuntime` lets it borrow the CE host's ONNX
// runtime + CE-weight dir instead of resolving its own. These tests pin that seam.
//
// NOTE: `useHostRuntime` mutates module-global state, so the non-injected (host)
// assertions run FIRST, before any injection. Vitest isolates per file, so this
// file's runtime state doesn't leak to others.

describe('detection runtime — host path (before injection)', () => {
  it('resolveModelPath returns a host path ending in the requested weight', () => {
    expect(resolveModelPath('ultraface-rfb-320.onnx').replace(/\\/g, '/')).toMatch(
      /ultraface-rfb-320\.onnx$/
    );
  });

  it('hostDetectionRuntime() exposes loadModel + ort + a models-dir capability', () => {
    const cap = hostDetectionRuntime();
    expect(typeof cap.loadModel).toBe('function');
    expect(cap.ort).toBeDefined();
    expect(cap.ceModelsDir.replace(/\\/g, '/')).toMatch(/\/models$/);
  });
});

describe('detection runtime — injected (downloaded-module) path', () => {
  it('loadModel delegates to the injected host runtime', async () => {
    const seen: string[] = [];
    const fakeSession = { inputNames: [], outputNames: [] } as unknown as Awaited<
      ReturnType<typeof loadModel>
    >;
    useHostRuntime(
      makeFakeDetection({
        loadModel: async (p) => {
          seen.push(p);
          return fakeSession;
        },
      }),
      '/module/models'
    );
    const session = await loadModel('/abs/model.onnx');
    expect(seen).toEqual(['/abs/model.onnx']);
    expect(session).toBe(fakeSession);
  });

  it('resolveModelPath routes Pro weights to the module dir and CE weights to the host dir', () => {
    const proDir = mkdtempSync(join(tmpdir(), 'em-promodels-'));
    mkdirSync(join(proDir, 'pro'), { recursive: true });
    writeFileSync(join(proDir, 'pro', 'mobile_sam_encoder.onnx'), 'x');
    const ceDir = mkdtempSync(join(tmpdir(), 'em-cemodels-'));
    writeFileSync(join(ceDir, 'dfine-s-coco-quant.onnx'), 'x');

    useHostRuntime(makeFakeDetection({ ceModelsDir: ceDir }), proDir);

    // Pro-only weight staged in the module bundle → resolves there.
    expect(resolveModelPath('pro/mobile_sam_encoder.onnx')).toBe(
      join(proDir, 'pro', 'mobile_sam_encoder.onnx')
    );
    // Shared CE weight lives only in the host install → resolves there.
    expect(resolveModelPath('dfine-s-coco-quant.onnx')).toBe(
      join(ceDir, 'dfine-s-coco-quant.onnx')
    );
    // A Pro weight absent from the module dir falls back to the host dir (dev in-tree,
    // where copy-models stages both CE + Pro weights into dist/models).
    expect(resolveModelPath('pro/face_mesh_468.onnx')).toBe(
      join(ceDir, 'pro', 'face_mesh_468.onnx')
    );
  });

  it('swaps the exported ort binding to the host instance', () => {
    // The whole reason for the seam: a module-side `new ort.Tensor` must use the
    // SAME ort that runs the host session, or the tensor is rejected cross-instance.
    const hostOrt = { __marker: 'host-ort' } as unknown as typeof ort;
    useHostRuntime(makeFakeDetection({ ort: hostOrt }), '/module/models');
    expect(ort).toBe(hostOrt);
  });
});
