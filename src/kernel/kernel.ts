/**
 * The kernel — the stable host core. It owns the tool registry and hands each
 * module a HostApi to register through, brokers cross-module `invokeTool` calls,
 * and loads modules. It contains NO tools itself.
 *
 * Slice 1 (kernel extraction): built-in (in-memory) modules load synchronously
 * via `loadBuiltins`. Downloaded modules (decrypt + dynamic-import) get an async
 * load path in a later slice; their `register(host)` is still synchronous — only
 * fetching/decrypting the module object is async.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { PhotoshopConnection } from '../platform/connection.js';
import { CompositeSnippetClient, type SnippetClient } from '../api/snippet-client.js';
import { ToolRegistry, type ToolResult } from './../core/tool-registry.js';
import { Logger } from '../utils/logger.js';
import { runScript } from '../utils/run-script.js';
import {
  KERNEL_ABI,
  type HostApi,
  type HostDetection,
  type EditmameiModule,
  type ModuleManifest,
} from './host-api.js';

/**
 * Resolves a module's OWN go-core snippet client — the binary that emits the
 * snippets the module declares in `manifest.goCoreSnippets`. Returns null for a
 * module that has no separate binary (a built-in whose snippets are the host
 * binary's). Injected by the host so the kernel stays decoupled from where a
 * module's binary lives (dist/bin for built-ins, the install dir for a
 * downloaded module).
 */
export type ModuleSnippetResolver = (manifest: ModuleManifest) => SnippetClient | null;

export interface KernelDeps {
  registry: ToolRegistry;
  connection: PhotoshopConnection;
  /** The host/community snippet client (the CE go-core binary) — the fallback every module routes non-own snippets to. */
  snippet: SnippetClient;
  /** Optional: resolves a module's own-binary snippet client. Omitted → every module uses the community client. */
  resolveModuleSnippet?: ModuleSnippetResolver;
  /** The host's local-vision runtime (ONNX), handed to modules as `HostApi.detection`. */
  detection: HostDetection;
  sessionId: string;
  logger: Logger;
}

export class Kernel {
  private readonly registry: ToolRegistry;
  private readonly connection: PhotoshopConnection;
  private readonly snippet: SnippetClient;
  private readonly resolveModuleSnippet?: ModuleSnippetResolver;
  private readonly detection: HostDetection;
  private readonly sessionId: string;
  private readonly logger: Logger;

  /**
   * Depth guard for the `invokeTool` broker — prevents a cross-module cycle from
   * looping forever. Scoped per async call chain via `AsyncLocalStorage` (not a
   * shared instance counter): concurrently-dispatched, independent `invokeTool`
   * calls each start their own chain at depth 0, so in-flight concurrency
   * BREADTH never trips the guard — only genuine A→B→A recursion WITHIN one
   * chain accumulates depth. See backlog H4 / review finding ML-1.
   */
  private readonly invokeDepth = new AsyncLocalStorage<number>();
  private static readonly MAX_INVOKE_DEPTH = 8;

  constructor(deps: KernelDeps) {
    this.registry = deps.registry;
    this.connection = deps.connection;
    this.snippet = deps.snippet;
    this.resolveModuleSnippet = deps.resolveModuleSnippet;
    this.detection = deps.detection;
    this.sessionId = deps.sessionId;
    this.logger = deps.logger;
  }

  /**
   * The snippet client a module registers through. A module that declares its
   * own go-core snippets (`manifest.goCoreSnippets`) AND has a resolvable own
   * binary gets a composite: its declared names build on its own binary, every
   * other name (community snippets its handlers also build) falls back to the
   * host/community binary. Otherwise the module uses the community client
   * directly.
   */
  private snippetFor(manifest: ModuleManifest): SnippetClient {
    const own = this.resolveModuleSnippet?.(manifest) ?? null;
    const names = manifest.goCoreSnippets;
    if (own && names && names.length > 0) {
      return new CompositeSnippetClient(own, this.snippet, names);
    }
    return this.snippet;
  }

  /** The stable HostApi handed to a module's register(). */
  private hostApiFor(manifest: ModuleManifest): HostApi {
    return {
      abi: KERNEL_ABI,
      registerTools: (defs) => this.registry.registerAll(defs),
      invokeTool: (name, args) => this.invokeTool(name, args),
      connection: this.connection,
      executeScript: (innerBody, timeoutMs) => runScript(this.connection, innerBody, timeoutMs),
      snippet: this.snippetFor(manifest),
      detection: this.detection,
      session: { id: this.sessionId },
      logger: new Logger(`module:${manifest.id}`),
    };
  }

  /**
   * Cross-module orchestration broker (§7): dispatch to a loaded tool's handler
   * and return its structured result. Reuses the registry's execute path (same
   * dispatch the MCP request uses) so the call runs on the shared PS connection
   * and stays serialized. Depth-capped against cross-module cycles. The
   * registry throws when the target isn't loaded — callers catch to degrade
   * gracefully.
   */
  async invokeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const depth = this.invokeDepth.getStore() ?? 0;
    if (depth >= Kernel.MAX_INVOKE_DEPTH) {
      throw new Error(
        `invokeTool recursion limit (${Kernel.MAX_INVOKE_DEPTH}) exceeded invoking '${name}'`
      );
    }
    return this.invokeDepth.run(depth + 1, () => this.registry.execute(name, args));
  }

  /**
   * Guard a module against an ABI this kernel can't satisfy. Logs and returns
   * true ("skip it") rather than crashing the host — "update the host first".
   */
  private abiTooNew(manifest: ModuleManifest): boolean {
    if (manifest.abi > KERNEL_ABI) {
      this.logger.warn(
        `Skipping module '${manifest.id}' — it needs kernel ABI ${manifest.abi} but this host implements ${KERNEL_ABI}. Update the host.`
      );
      return true;
    }
    return false;
  }

  /**
   * Load in-memory (built-in) modules. Each module's `register(host)` wires its
   * tools into the registry via `host.registerTools`. A module whose required
   * ABI exceeds this kernel's is skipped with a clear log rather than crashing
   * the host ("update the host first").
   */
  loadBuiltins(modules: EditmameiModule[]): void {
    for (const m of modules) {
      if (this.abiTooNew(m.manifest)) continue;
      const before = this.registry.count();
      m.register(this.hostApiFor(m.manifest));
      this.logger.info(
        `Loaded module '${m.manifest.id}' (${m.manifest.name}) — ${this.registry.count() - before} tools.`
      );
    }
  }

  /**
   * Load a downloaded module (Pro, add-ons): resolve the `EditmameiModule` from
   * an injected importer, then register it through the same HostApi seam as a
   * built-in. The host supplies the importer so the kernel stays decoupled from
   * where the module's bytes live — a relative `import()` of the in-tree module
   * (dev), or an absolute `import()` of the decrypted install dir (the eventual
   * provisioned path). The bundle's `default` export IS the module. `register`
   * may be async (decrypt/setup), so this awaits it.
   */
  async loadDownloaded(importer: () => Promise<unknown>): Promise<void> {
    const imported = (await importer()) as {
      default?: EditmameiModule;
      proModule?: EditmameiModule;
    };
    const mod = imported.default ?? imported.proModule;
    if (!mod || typeof mod.register !== 'function' || !mod.manifest) {
      throw new Error(
        'downloaded module export is not an EditmameiModule (expected a default export with a manifest + register())'
      );
    }
    if (this.abiTooNew(mod.manifest)) return;
    const before = this.registry.count();
    await mod.register(this.hostApiFor(mod.manifest));
    this.logger.info(
      `Loaded downloaded module '${mod.manifest.id}' (${mod.manifest.name}) — ${this.registry.count() - before} tools.`
    );
  }
}
