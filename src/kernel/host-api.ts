/**
 * The stable Host ABI — the single interface the kernel hands every module's
 * `register(host)`.
 *
 * This surface is intentionally minimal and changes ONLY for a genuinely new
 * capability *type* (a kernel release). Patch-level module changes never touch
 * it. Modules receive everything they need here — connection/execution, their
 * own snippet engine, cross-module orchestration, and registration — so they
 * never reach into host internals directly.
 */

import type * as ort from 'onnxruntime-web';
import type { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import type { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { Logger } from '../utils/logger.js';

/**
 * Kernel ABI version. Bumped only when the HostApi gains a new capability type.
 * A module declares the minimum ABI it needs in its manifest; the loader refuses
 * a module whose `abi` exceeds this ("update the host first").
 *
 * ABI 2 (v0.22.x): added `HostApi.detection` — modules borrow the CE host's
 * already-configured ONNX runtime + CE-model dir instead of resolving their own
 * from the relocated bundle (which can't `require.resolve('onnxruntime-web')` and
 * ships no weights).
 */
export const KERNEL_ABI = 2;

/**
 * The OLDEST module ABI this host will run. A downloaded module whose
 * `InstalledModule.abi` is BELOW this is refused at load (server.ts
 * `loadModules`) — it was built against a host contract this build no longer
 * supports (e.g. a pre-rename tool surface) — and the host boots the Community
 * surface instead of crashing on it. Together with `KERNEL_ABI` this defines the
 * acceptance window `[HOST_MIN_ABI, KERNEL_ABI]`.
 *
 * Kept at 1 for the v0.22.1 self-heal patch: the module currently served from R2
 * is `abi = 1`, so raising this would wrongly reject the *good* module. Today's
 * pre-rename wedge is caught instead by the classification try/catch in
 * `loadModules` (a same-abi breaking change the ABI gate can't see).
 *
 * STANDING RULE — the reason this gate exists: on ANY breaking tool-surface
 * change (rename/removal that makes an older module's tool names unclassifiable),
 * bump `KERNEL_ABI`, rebuild + republish the Pro module (so R2 serves the new
 * abi), and raise `HOST_MIN_ABI` to that new value in the host that drops support
 * for the old surface. Then the gate cleanly skips old modules and the background
 * self-heal re-provisions the new one — no thrown assertion. Skipping the bump is
 * exactly the bug this patch had to paper over.
 */
export const HOST_MIN_ABI = 1;

/**
 * The CE host's local-vision runtime, handed to downloaded modules so their
 * ONNX detectors reuse the host's already-configured `onnxruntime-web` (the host
 * has it in `node_modules`; a relocated module bundle does not). The module's own
 * Pro-only weights ship in its bundle; the shared CE weights (Ultraface, D-FINE)
 * live in `ceModelsDir`.
 */
export interface HostDetection {
  /** Create (and host-cache) an inference session for an absolute model path. */
  loadModel(absPath: string): Promise<ort.InferenceSession>;
  /** The host's `onnxruntime-web` namespace — modules build tensors with THIS
   *  instance so a module-side `new ort.Tensor` matches the host-run session. */
  readonly ort: typeof ort;
  /** Absolute dir of the CE detection weights in the host install (`dist/models`). */
  readonly ceModelsDir: string;
}

export interface HostApi {
  /** The ABI this kernel implements (≥ a module's manifest `abi`). */
  readonly abi: number;

  /** Register this module's tools into the kernel registry. */
  registerTools(defs: ToolDefinition[]): void;

  /**
   * Invoke another loaded tool by name and get its structured result — the
   * cross-module orchestration broker (§7). Entitlement-aware: an unknown /
   * not-loaded tool throws so the caller can degrade gracefully. Recursion is
   * depth-capped. Runs on the same PS connection/queue, so calls stay serialized.
   */
  invokeTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;

  /**
   * Whether `name` is registered right now — answers "would
   * invokeTool(name, …) dispatch?" without dispatching it. Backed directly by
   * the registry, so the answer always matches the live tool surface rather
   * than a fixed list computed some other way. Optional and additive: it does
   * not raise `KERNEL_ABI`, because a module that calls it defensively
   * (checking for the method before relying on it) works unchanged against an
   * older host that lacks it. A module that comes to depend on it
   * unconditionally should raise its manifest's required ABI when a future
   * kernel bump promises it outright.
   */
  hasTool?(name: string): boolean;

  /** The live Photoshop connection (Windows COM / macOS AppleScript). */
  readonly connection: PhotoshopConnection;

  /**
   * Run an inner ExtendScript body through the kernel's standard wrapper
   * (error envelope, units lock, dialog suppression) and return its result.
   * The host owns the wrapper contract; modules supply only the inner body.
   */
  executeScript(innerBody: string, timeoutMs?: number): Promise<unknown>;

  /** This module's snippet engine — spawns the module's own go-core binary. */
  readonly snippet: SnippetClient;

  /** Current session context. */
  readonly session: { readonly id: string };

  /** A logger scoped for the module. */
  readonly logger: Logger;

  /**
   * The CE host's local-vision runtime (ABI 2+). A downloaded module's ONNX
   * detectors borrow this instead of resolving `onnxruntime-web` + weights from
   * their own relocated bundle. Wire it once at `register()` via
   * `useHostRuntime(host.detection, …)` in `src/detection/runtime.ts`.
   */
  readonly detection: HostDetection;
}

/** A module's self-description. */
export interface ModuleManifest {
  /** Stable unique id, e.g. 'core', 'pro', 'local-cv'. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Minimum kernel ABI this module needs. */
  abi: number;
  /**
   * The snippet names this module's OWN go-core binary emits (the Pro selections
   * + action runner, for the Pro module). When set, the kernel hands the module
   * a composite SnippetClient that routes these names to the module's own binary
   * and every OTHER name (community snippets the handlers also build, e.g.
   * renderHistoryStatePreview) to the host/community binary. Omitted/empty for a
   * built-in module whose snippets ARE the host binary's.
   */
  goCoreSnippets?: readonly string[];
}

/**
 * A module: a manifest + a single registration entrypoint. `register` wires the
 * module's tools into the kernel via `host.registerTools(...)`. Built-in modules
 * (CE) ship in the package; downloaded modules (Pro, add-ons) are fetched +
 * decrypted and loaded through this same contract.
 */
export interface EditmameiModule {
  manifest: ModuleManifest;
  register(host: HostApi): void | Promise<void>;
}
