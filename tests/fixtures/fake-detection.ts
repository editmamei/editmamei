import type { HostDetection } from '@editmamei/kernel/host-api.ts';

/**
 * A no-op `HostDetection` for kernel/module tests that don't run real ONNX
 * inference. `loadModel` throws if actually reached — no unit test should, since
 * detectors are exercised via injected fake `DetectionClient`s, not the runtime.
 * Pass `overrides` to pin specific behavior (e.g. a spy `loadModel`).
 */
export function makeFakeDetection(overrides: Partial<HostDetection> = {}): HostDetection {
  return {
    loadModel: async () => {
      throw new Error('fake detection: loadModel should not run in unit tests');
    },
    ort: {} as unknown as HostDetection['ort'],
    ceModelsDir: '/fake/ce-models',
    ...overrides,
  };
}
