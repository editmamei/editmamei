import { describe, it, expect } from 'vitest';
import { Kernel } from '@editmamei/kernel/kernel.ts';
import {
  KERNEL_ABI,
  HOST_MIN_ABI,
  type EditmameiModule,
  type HostApi,
} from '@editmamei/kernel/host-api.ts';
import {
  ToolRegistry,
  type ToolDefinition,
  type ToolResult,
} from '@editmamei/core/tool-registry.ts';
import { Logger } from '@editmamei/utils/logger.ts';
import type { ModuleSnippetResolver } from '@editmamei/kernel/kernel.ts';
import { makeConnection } from '../fixtures/fake-connection.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import { makeFakeDetection } from '../fixtures/fake-detection.ts';

function makeKernel(
  registry = new ToolRegistry(),
  opts: { snippet?: FakeSnippetClient; resolveModuleSnippet?: ModuleSnippetResolver } = {}
) {
  const snippet = opts.snippet ?? makeSnippetClient();
  const kernel = new Kernel({
    registry,
    connection: makeConnection().asConnection(),
    snippet,
    resolveModuleSnippet: opts.resolveModuleSnippet,
    detection: makeFakeDetection(),
    sessionId: 'test-session',
    logger: new Logger('test-kernel'),
  });
  return { kernel, registry, snippet };
}

function textTool(
  name: string,
  handler: (args: Record<string, unknown>) => Promise<ToolResult>
): ToolDefinition {
  return {
    tool: { name, description: 'test tool', inputSchema: { type: 'object', properties: {} } },
    handler,
  };
}

const okResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });

describe('ABI acceptance window', () => {
  it('HOST_MIN_ABI never exceeds KERNEL_ABI (a coherent [min, current] window)', () => {
    expect(HOST_MIN_ABI).toBeLessThanOrEqual(KERNEL_ABI);
    expect(HOST_MIN_ABI).toBeGreaterThanOrEqual(1);
  });
});

describe('Kernel.loadBuiltins', () => {
  it("registers a module's tools through the HostApi", () => {
    const { kernel, registry } = makeKernel();
    const mod: EditmameiModule = {
      manifest: { id: 'm1', name: 'Module One', abi: KERNEL_ABI },
      register(host) {
        host.registerTools([textTool('photoshop_t1', async () => okResult('ok'))]);
      },
    };
    kernel.loadBuiltins([mod]);
    expect(registry.count()).toBe(1);
    expect(registry.list().map((t) => t.name)).toEqual(['photoshop_t1']);
  });

  it('skips a module that needs a newer ABI than the kernel implements', () => {
    const { kernel, registry } = makeKernel();
    const future: EditmameiModule = {
      manifest: { id: 'future', name: 'From The Future', abi: KERNEL_ABI + 1 },
      register(host) {
        host.registerTools([textTool('photoshop_future', async () => okResult('nope'))]);
      },
    };
    kernel.loadBuiltins([future]);
    expect(registry.count()).toBe(0);
  });

  it('hands the module a HostApi carrying its session id', () => {
    const { kernel } = makeKernel();
    let seen: HostApi | undefined;
    kernel.loadBuiltins([
      {
        manifest: { id: 'm', name: 'M', abi: KERNEL_ABI },
        register(host) {
          seen = host;
        },
      },
    ]);
    expect(seen?.abi).toBe(KERNEL_ABI);
    expect(seen?.session.id).toBe('test-session');
    expect(typeof seen?.invokeTool).toBe('function');
    expect(typeof seen?.executeScript).toBe('function');
  });
});

describe('Kernel per-module snippet binding', () => {
  it('gives a module with no own snippets the host/community client', () => {
    const community = makeSnippetClient();
    const { kernel } = makeKernel(new ToolRegistry(), { snippet: community });
    let seen: HostApi | undefined;
    kernel.loadBuiltins([
      {
        manifest: { id: 'ce', name: 'CE', abi: KERNEL_ABI },
        register(host) {
          seen = host;
        },
      },
    ]);
    expect(seen?.snippet).toBe(community);
  });

  it('gives a module that declares own snippets a composite routing to its own binary', async () => {
    const community = makeSnippetClient();
    const proOwn = makeSnippetClient();
    // The resolver returns the module's own binary client when it declares snippets.
    const { kernel } = makeKernel(new ToolRegistry(), {
      snippet: community,
      resolveModuleSnippet: (m) => (m.goCoreSnippets?.length ? proOwn : null),
    });
    let seen: HostApi | undefined;
    kernel.loadBuiltins([
      {
        manifest: {
          id: 'pro',
          name: 'Pro',
          abi: KERNEL_ABI,
          goCoreSnippets: ['selectSubject', 'selectSky'],
        },
        register(host) {
          seen = host;
        },
      },
    ]);

    // Own snippet → own binary; community snippet the Pro handlers also build → host binary.
    await seen!.snippet.build('selectSubject', { sampleAllLayers: true });
    await seen!.snippet.build('renderHistoryStatePreview', { historyIndex: 0 });

    expect(proOwn.allBuilds().map((b) => b.name)).toEqual(['selectSubject']);
    expect(community.allBuilds().map((b) => b.name)).toEqual(['renderHistoryStatePreview']);
  });

  it('falls back to the community client when the resolver returns null for a declaring module', () => {
    const community = makeSnippetClient();
    const { kernel } = makeKernel(new ToolRegistry(), {
      snippet: community,
      resolveModuleSnippet: () => null, // no own binary available (e.g. module not yet installed)
    });
    let seen: HostApi | undefined;
    kernel.loadBuiltins([
      {
        manifest: {
          id: 'pro',
          name: 'Pro',
          abi: KERNEL_ABI,
          goCoreSnippets: ['selectSubject'],
        },
        register(host) {
          seen = host;
        },
      },
    ]);
    // Declares snippets, but no own client resolved → no composite, plain community client.
    expect(seen?.snippet).toBe(community);
  });

  it('falls back to the community client when no resolver is injected', async () => {
    const community = makeSnippetClient();
    const { kernel } = makeKernel(new ToolRegistry(), { snippet: community });
    let seen: HostApi | undefined;
    kernel.loadBuiltins([
      {
        manifest: {
          id: 'pro',
          name: 'Pro',
          abi: KERNEL_ABI,
          goCoreSnippets: ['selectSubject'],
        },
        register(host) {
          seen = host;
        },
      },
    ]);
    // No resolver → even a declaring module gets the community client (no own binary to route to).
    expect(seen?.snippet).toBe(community);
  });
});

describe('Kernel.loadDownloaded', () => {
  const proTool = (name: string): EditmameiModule => ({
    manifest: { id: 'dl', name: 'Downloaded', abi: KERNEL_ABI },
    register(host) {
      host.registerTools([textTool(name, async () => okResult('ok'))]);
    },
  });

  it('imports a module via the injected importer and registers its tools (default export)', async () => {
    const { kernel, registry } = makeKernel();
    await kernel.loadDownloaded(async () => ({ default: proTool('photoshop_dl1') }));
    expect(registry.list().map((t) => t.name)).toEqual(['photoshop_dl1']);
  });

  it('accepts a proModule named export as a fallback', async () => {
    const { kernel, registry } = makeKernel();
    await kernel.loadDownloaded(async () => ({ proModule: proTool('photoshop_dl2') }));
    expect(registry.list().map((t) => t.name)).toEqual(['photoshop_dl2']);
  });

  it('awaits an async register()', async () => {
    const { kernel, registry } = makeKernel();
    const asyncMod: EditmameiModule = {
      manifest: { id: 'async', name: 'Async', abi: KERNEL_ABI },
      async register(host) {
        await Promise.resolve();
        host.registerTools([textTool('photoshop_async', async () => okResult('ok'))]);
      },
    };
    await kernel.loadDownloaded(async () => ({ default: asyncMod }));
    expect(registry.list().map((t) => t.name)).toEqual(['photoshop_async']);
  });

  it('throws when the import has no EditmameiModule export', async () => {
    const { kernel } = makeKernel();
    await expect(kernel.loadDownloaded(async () => ({ nope: 1 }))).rejects.toThrow(
      /not an EditmameiModule/
    );
  });

  it('skips a downloaded module that needs a newer ABI than the kernel implements', async () => {
    const { kernel, registry } = makeKernel();
    const future: EditmameiModule = {
      manifest: { id: 'future-dl', name: 'Future', abi: KERNEL_ABI + 1 },
      register(host) {
        host.registerTools([textTool('photoshop_future_dl', async () => okResult('no'))]);
      },
    };
    // Skipping stays SILENT (no throw, nothing registered), but the caller has
    // to be able to tell this apart from a successful load — otherwise a module
    // that registered nothing gets reported as loaded.
    expect(await kernel.loadDownloaded(async () => ({ default: future }))).toBe('abi-too-new');
    expect(registry.count()).toBe(0);
  });

  it('reports a successful downloaded load as loaded', async () => {
    const { kernel } = makeKernel();
    expect(await kernel.loadDownloaded(async () => ({ default: proTool('photoshop_dl_ok') }))).toBe(
      'loaded'
    );
  });

  it('propagates an importer failure (caller decides whether to degrade)', async () => {
    const { kernel } = makeKernel();
    await expect(
      kernel.loadDownloaded(async () => {
        throw new Error('decrypt failed');
      })
    ).rejects.toThrow(/decrypt failed/);
  });
});

describe('Kernel.invokeTool (broker)', () => {
  it('dispatches to a loaded tool and returns its structured result', async () => {
    const { kernel } = makeKernel();
    kernel.loadBuiltins([
      {
        manifest: { id: 'm', name: 'M', abi: KERNEL_ABI },
        register(host) {
          host.registerTools([textTool('photoshop_echo', async () => okResult('echoed'))]);
        },
      },
    ]);
    const res = await kernel.invokeTool('photoshop_echo', {});
    expect((res.content?.[0] as { text: string }).text).toBe('echoed');
  });

  it('throws when the target tool is not loaded (caller degrades gracefully)', async () => {
    const { kernel } = makeKernel();
    await expect(kernel.invokeTool('photoshop_missing', {})).rejects.toThrow(
      /No tool is registered/
    );
  });

  it('caps recursion so a cross-module cycle cannot loop forever', async () => {
    const { kernel } = makeKernel();
    let host: HostApi;
    kernel.loadBuiltins([
      {
        manifest: { id: 'rec', name: 'Recursor', abi: KERNEL_ABI },
        register(h) {
          host = h;
          h.registerTools([
            textTool('photoshop_loop', async () => host.invokeTool('photoshop_loop', {})),
          ]);
        },
      },
    ]);
    await expect(kernel.invokeTool('photoshop_loop', {})).rejects.toThrow(/recursion limit/);
  });

  // Backlog H4 / review finding ML-1: the depth guard used to be a single shared
  // instance counter, so it measured in-flight concurrency BREADTH rather than
  // one call chain's recursion DEPTH. Fixed via a per-async-chain AsyncLocalStorage.
  // These two tests pin both halves of that fix.

  it('genuine nested invokeTool recursion still trips the cap at the same depth', async () => {
    const { kernel } = makeKernel();
    let host: HostApi;
    let calls = 0;
    kernel.loadBuiltins([
      {
        manifest: { id: 'rec2', name: 'Recursor2', abi: KERNEL_ABI },
        register(h) {
          host = h;
          h.registerTools([
            textTool('photoshop_loop2', async () => {
              calls++;
              return host.invokeTool('photoshop_loop2', {});
            }),
          ]);
        },
      },
    ]);
    await expect(kernel.invokeTool('photoshop_loop2', {})).rejects.toThrow(/recursion limit \(8\)/);
    // MAX_INVOKE_DEPTH is 8 — depths 0..7 dispatch successfully (8 handler runs),
    // the 9th nested call (depth 8) is rejected before its handler ever runs.
    // A single call chain still accumulates depth exactly as before the fix.
    expect(calls).toBe(8);
  });

  it('many concurrent independent invokeTool calls all succeed (breadth is not depth)', async () => {
    const { kernel } = makeKernel();
    const CONCURRENCY = 20; // comfortably more than MAX_INVOKE_DEPTH (8)
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    kernel.loadBuiltins([
      {
        manifest: { id: 'par', name: 'Parallel', abi: KERNEL_ABI },
        register(h) {
          h.registerTools([
            textTool('photoshop_parallel', async () => {
              inFlight++;
              maxInFlight = Math.max(maxInFlight, inFlight);
              await gate; // hold every call open at once so they genuinely overlap
              inFlight--;
              return okResult('done');
            }),
          ]);
        },
      },
    ]);

    // Fire them all as independent top-level calls — none nests inside another's
    // invokeTool, so under the old shared counter this would have piled every
    // in-flight call onto ONE field and spuriously rejected past depth 8.
    const calls = Array.from({ length: CONCURRENCY }, () =>
      kernel.invokeTool('photoshop_parallel', {})
    );
    // Let every call reach the gate before releasing them together.
    await new Promise((r) => setTimeout(r, 0));
    release();
    const results = await Promise.all(calls);

    expect(maxInFlight).toBeGreaterThan(8); // > MAX_INVOKE_DEPTH — proves genuine overlap, not serialization
    expect(results).toHaveLength(CONCURRENCY);
    for (const res of results) {
      expect((res.content?.[0] as { text: string }).text).toBe('done');
    }
  });
});
