/**
 * ONNX runtime plumbing for the local-vision detectors.
 *
 * One process-wide onnxruntime-web (WASM) backend, configured once and shared by
 * every detector. Models load lazily and are cached by absolute path, so the
 * first detection of a kind pays the session-create cost and the rest are warm.
 *
 * Why onnxruntime-web (WASM) and not the native addon: a single cross-platform
 * artifact (one `.wasm` covers win + mac-x64 + mac-arm64) keeps the CE bundle
 * and the one-click `.mcpb` simple — no per-platform native binaries to stage
 * and sign. Inference is single-threaded here (numThreads = 1) so the MCP server
 * process never spawns worker threads; detection isn't in a hot loop, so the
 * cost is a non-issue (faces ~tens of ms, objects sub-second).
 *
 * Everything runs HEADLESS in Node. This is what excluded MediaPipe's *JS Tasks
 * runtime* (@mediapipe/tasks-vision needs a DOM and never initializes a session
 * off-screen). It does NOT exclude MediaPipe's *models*: the Pro face-mesh
 * detector runs Google's MediaPipe FaceMesh MODEL converted to ONNX on THIS same
 * backend (src/detection/landmark-detector.ts) — the model, not the DOM-bound
 * runtime. So "MediaPipe excluded" means the JS runtime, never the weights.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decode } from 'jpeg-js';
import { existsSync, readFileSync } from 'node:fs';
import * as staticOrt from 'onnxruntime-web';
import type { HostDetection } from '../kernel/host-api.js';

/**
 * The ACTIVE `onnxruntime-web` instance. In the CE host this is the bundled
 * package. A downloaded module — a relocated esbuild bundle with no
 * `node_modules` — swaps in the HOST's instance via `useHostRuntime()`, so its
 * detectors build input tensors with the SAME ort that runs the session (a
 * cross-instance `new ort.Tensor` would mismatch), and it never calls
 * `require.resolve('onnxruntime-web')`.
 */
export let ort: typeof staticOrt = staticOrt;

// Injection state — set once by a downloaded module's register() via
// useHostRuntime(). Null in the host process, which resolves ort + weights itself.
let injectedLoadModel: HostDetection['loadModel'] | null = null;
let injectedModelDirs: readonly string[] | null = null;

/**
 * Borrow the CE host's ONNX runtime (called ONCE, by a downloaded module's
 * register()). After this: `loadModel` delegates to the host, `ort` is the host's
 * instance, and `resolveModelPath` searches the module's own Pro-weight dir first,
 * then the host's CE-weight dir. Fixes the delivered-module failure where the
 * relocated bundle can neither `require.resolve('onnxruntime-web')` nor find its
 * weights (which `buildProModule` never staged).
 */
export function useHostRuntime(host: HostDetection, proModelsDir: string): void {
  injectedLoadModel = host.loadModel;
  ort = host.ort;
  injectedModelDirs = [proModelsDir, host.ceModelsDir];
}

/**
 * The `HostApi.detection` capability, built from THIS (host) runtime. The host
 * hands it to downloaded modules so they reuse the already-configured backend
 * instead of resolving one from their relocated bundle.
 */
export function hostDetectionRuntime(): HostDetection {
  return { loadModel: hostLoadModel, ort: staticOrt, ceModelsDir: hostModelsDir() };
}

let configured = false;

/**
 * Configure the WASM backend once (HOST only). Points ort-web at its own bundled
 * `.wasm` files in `node_modules`, forces single-threaded execution, and silences
 * the graph-optimizer warnings the models emit at load. A downloaded module never
 * reaches here — it delegates through `useHostRuntime()`.
 */
function configureOrt(): void {
  if (configured) return;
  const require = createRequire(import.meta.url);
  // The resolved entry sits in onnxruntime-web/dist/, alongside the .wasm files.
  // ort-web's loader fetches the wasm by URL — on Windows a raw drive path
  // ('e:\…') is rejected as an unsupported ESM scheme, so hand it a file:// URL
  // (trailing slash so the wasm filename appends cleanly).
  const ortDist = dirname(require.resolve('onnxruntime-web'));
  staticOrt.env.wasm.wasmPaths = pathToFileURL(join(ortDist, '/')).href;
  staticOrt.env.wasm.numThreads = 1;
  staticOrt.env.logLevel = 'error';
  configured = true;
}

const sessions = new Map<string, Promise<staticOrt.InferenceSession>>();

/** The host's own model loader: configure the bundled ort once, then session-cache. */
function hostLoadModel(absPath: string): Promise<staticOrt.InferenceSession> {
  configureOrt();
  let p = sessions.get(absPath);
  if (!p) {
    p = staticOrt.InferenceSession.create(absPath, { logSeverityLevel: 3 });
    sessions.set(absPath, p);
  }
  return p;
}

/**
 * Load (and cache) an ONNX model session by absolute path. Delegates to the host
 * runtime when a downloaded module has injected one (`useHostRuntime`), else uses
 * the host's own loader. `logSeverityLevel: 3` (Error) suppresses the verbose
 * per-initializer graph warnings on stderr.
 */
export function loadModel(absPath: string): Promise<staticOrt.InferenceSession> {
  return injectedLoadModel ? injectedLoadModel(absPath) : hostLoadModel(absPath);
}

/** The host's model dir (`dist/models`), or the `EDITMAMEI_MODELS_DIR` dev override. */
function hostModelsDir(): string {
  const override = process.env.EDITMAMEI_MODELS_DIR;
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'models');
}

/**
 * Resolve a model file to an absolute path. HOST: `dist/models/<file>` (or the
 * `EDITMAMEI_MODELS_DIR` override). DOWNLOADED MODULE (post-`useHostRuntime`):
 * search the module's own Pro-weight dir, then the host's CE-weight dir — Pro
 * weights (`pro/*`) ship in the module bundle, CE weights (Ultraface, D-FINE) live
 * in the host; in dev in-tree both sit in the host dir (the second entry). Falls
 * back to the last dir so a genuine miss surfaces a clear ENOENT on that path.
 */
export function resolveModelPath(filename: string): string {
  if (injectedModelDirs) {
    for (const dir of injectedModelDirs) {
      const candidate = join(dir, filename);
      if (existsSync(candidate)) return candidate;
    }
    return join(injectedModelDirs[injectedModelDirs.length - 1], filename);
  }
  return join(hostModelsDir(), filename);
}

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes/pixel, row-major. */
  data: Uint8Array;
}

// `useTArray: true` makes jpeg-js return a Uint8Array-backed result; type the
// holder by the fields we consume rather than ReturnType<typeof decode> (whose
// default overload is the Buffer-backed variant and wouldn't match).
function decodeJpegBytes(bytes: Uint8Array | Buffer): DecodedImage {
  const img = decode(bytes, { useTArray: true, formatAsRGBA: true });
  return { width: img.width, height: img.height, data: img.data };
}

/**
 * Decode already-in-memory JPEG bytes to an RGBA pixel buffer. Split out from
 * {@link decodeJpeg} (perf-audit H4) so a caller that already holds the export
 * bytes in memory (`detectActiveDoc`) can decode ONCE and thread the result
 * through the detectors + every downstream consumer, instead of each one
 * re-reading and re-decoding the same file off disk.
 */
export function decodeJpegBuffer(bytes: Uint8Array | Buffer): DecodedImage {
  try {
    return decodeJpegBytes(bytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to decode JPEG buffer: ${msg}`);
  }
}

/** Decode a JPEG file to an RGBA pixel buffer (detection always runs on an export). */
export function decodeJpeg(path: string): DecodedImage {
  // jpeg-js throws raw on a truncated / non-JPEG / unreadable file; wrap it in a
  // descriptive Error so the ONNX detection path surfaces the bad input + path
  // instead of an opaque decoder throw bubbling through.
  try {
    return decodeJpegBytes(readFileSync(path));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to decode JPEG at ${path}: ${msg}`);
  }
}
