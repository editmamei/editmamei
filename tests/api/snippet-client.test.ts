import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  statSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  GoSnippetClient,
  coreBinaryName,
  resolveCoreBinaryPath,
  ensureExecutable,
} from '@editmamei/api/snippet-client.ts';
import { __setChildOpsForTests, __resetForTests } from '@editmamei/platform/run-child.ts';

// Pure unit coverage (no binary needed): name + path resolution.
describe('snippet-client path resolution', () => {
  it('builds the per-platform binary name', () => {
    expect(coreBinaryName('win32', 'x64')).toBe('editmamei-core-win-x64.exe');
    expect(coreBinaryName('darwin', 'arm64')).toBe('editmamei-core-darwin-arm64');
    expect(coreBinaryName('darwin', 'x64')).toBe('editmamei-core-darwin-x64');
  });

  it('honors the EDITMAMEI_CORE_BIN override', () => {
    const prev = process.env.EDITMAMEI_CORE_BIN;
    process.env.EDITMAMEI_CORE_BIN = '/tmp/custom-core';
    try {
      expect(resolveCoreBinaryPath()).toBe('/tmp/custom-core');
    } finally {
      if (prev === undefined) delete process.env.EDITMAMEI_CORE_BIN;
      else process.env.EDITMAMEI_CORE_BIN = prev;
    }
  });

  // The npm-strips-+x finding (real Mac, 2026-06-12): a bundled binary ships
  // 0644 and must be chmod'd before it can spawn. ensureExecutable self-heals.
  it.skipIf(process.platform === 'win32')(
    'ensureExecutable adds the execute bit to a non-executable file',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'em-exec-'));
      const f = join(dir, 'fake-core');
      try {
        writeFileSync(f, '#!/bin/sh\n');
        chmodSync(f, 0o644);
        expect(statSync(f).mode & 0o100).toBe(0); // owner-exec bit unset
        ensureExecutable(f);
        expect(statSync(f).mode & 0o100).not.toBe(0); // now set
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it('ensureExecutable is a no-op on a missing path (best-effort, no throw)', () => {
    expect(() => ensureExecutable(join(tmpdir(), 'definitely-not-here-xyz'))).not.toThrow();
  });
});

// Integration: drive the REAL built Go binary end-to-end (spawn → stdin params
// → stdout JSX). Phase 0 scaffolding — points at the locally-built dev binary
// under go-core/bin/. Skips cleanly when it isn't built, so the default
// `npm test` stays Go-free; build it via `go run ./cmd/buildtemplates` then
// `go build -ldflags "-s -w" -o bin/core.exe .` inside go-core/.
const here = dirname(fileURLToPath(import.meta.url));
const devBinary = join(here, '..', '..', 'go-core', 'bin', 'core.exe');
const integration = existsSync(devBinary) ? describe : describe.skip;

integration('GoSnippetClient ⇄ editmamei-core (live binary)', () => {
  it('builds applyGaussianBlur JSX over the spawn protocol', async () => {
    const client = new GoSnippetClient({ binaryPath: devBinary });
    const jsx = await client.build('applyGaussianBlur', { radius: 2, applyToActiveLayer: false });
    // Behavioral fingerprints of the snippet — the helper body, the auto-
    // duplicate fragment, the interpolated radius, the result payload.
    expect(jsx).toContain('function getMinimalContextInfo()');
    expect(jsx).toContain('var __opTargetIsCopy = true;');
    expect(jsx).toContain('layer.applyGaussianBlur(2);');
    expect(jsx).toContain("filter: 'Gaussian Blur'");
  });

  it('rejects with stderr context on an unknown snippet', async () => {
    const client = new GoSnippetClient({ binaryPath: devBinary });
    await expect(client.build('noSuchSnippet', {})).rejects.toThrow(/unknown snippet/);
  });
});

// Edition topology: `npm run build` emits TWO host binaries — a
// CE-only host at dist/bin/ (community snippets, NO Pro IP) and a Pro-only binary
// at dist/modules/pro/bin/ (Pro snippets only). The kernel's composite client
// routes Pro names to the Pro binary and community names to the host binary.
// These pin the divergence end-to-end through the same binaries the live dev MCP
// spawns. Skip cleanly when the binaries aren't built.
const hostBinary = join(here, '..', '..', 'dist', 'bin', coreBinaryName());
const proBinary = join(here, '..', '..', 'dist', 'modules', 'pro', 'bin', coreBinaryName());

const hostIntegration = existsSync(hostBinary) ? describe : describe.skip;
hostIntegration('GoSnippetClient ⇄ dev CE host binary (community-only)', () => {
  it('refuses a Pro snippet — the CE host binary carries no Pro IP', async () => {
    // listActions is Pro (registry_pro.go, //go:build pro). selectSubject used to be
    // the probe here but is community tier — the host binary now BUILDS
    // it (see the community selectSubject test below).
    const client = new GoSnippetClient({ binaryPath: hostBinary });
    await expect(client.build('listActions', {})).rejects.toThrow(/unknown snippet/);
  });

  it('builds a community snippet (it is the community binary)', async () => {
    const client = new GoSnippetClient({ binaryPath: hostBinary });
    const jsx = await client.build('applyGaussianBlur', { radius: 2 });
    expect(jsx).toContain('layer.applyGaussianBlur(2);');
  });

  it('builds selectSubject JSX — the re-tiered Sensei snippet + its community helpers resolve', async () => {
    // selectSubject / selectSky are community tier: their emitters +
    // fragments moved to the community go-core binary, so the CE host binary now emits
    // them with the selection-type + selection-info helper slots filled.
    const client = new GoSnippetClient({ binaryPath: hostBinary });
    const jsx = await client.build('selectSubject', {
      sampleAllLayers: true,
      selectionType: 'replace',
    });
    expect(jsx).toContain("executeAction(stringIDToTypeID('autoCutout')");
    expect(jsx).toContain('function mapSelType(');
    expect(jsx).toContain('function getSelectionInfo(');
  });
});

const proBinIntegration = existsSync(proBinary) ? describe : describe.skip;
proBinIntegration('GoSnippetClient ⇄ dev Pro-only binary', () => {
  it('does NOT carry selectSubject — Sensei re-tiered to community (host binary emits it now)', async () => {
    // selectSubject's fragment left the pro-only blob (it's community
    // now). Even though `-tags pro` compiles the community dispatch, tpl[SelSubject] is
    // absent from the pro-only blob, so this binary can't emit the autoCutout body —
    // the composite client routes selectSubject to the host binary instead.
    const client = new GoSnippetClient({ binaryPath: proBinary });
    const jsx = await client.build('selectSubject', {
      sampleAllLayers: true,
      selectionType: 'replace',
    });
    expect(jsx).not.toContain("executeAction(stringIDToTypeID('autoCutout')");
  });

  it('builds listActions JSX — exercises the getContextInfo (Ctx) helper dep', async () => {
    const client = new GoSnippetClient({ binaryPath: proBinary });
    const jsx = await client.build('listActions', {});
    // The context helper the listActions emitter prepends must not be an empty slot.
    expect(jsx).toContain('function getContextInfo(');
  });

  it('refuses a bulk community snippet — the Pro binary carries no community surface', async () => {
    // applyGaussianBlur is community-tier; the Pro binary compiles the emitter
    // but its fragment is NOT in the pro-only blob, so it cannot emit a body.
    const client = new GoSnippetClient({ binaryPath: proBinary });
    const jsx = await client.build('applyGaussianBlur', { radius: 2 });
    // The interpolated radius can't appear without the fragment body.
    expect(jsx).not.toContain('layer.applyGaussianBlur(2);');
  });
});

// ============================================================================
// In-process build cache — drives the spawn seam from run-child.ts (the same
// seam tests/platform/run-child.test.ts uses) so every spawn is a stub, not a
// real child process. This lets us count spawns exactly and pin the cache's
// key/eviction/invalidation behavior without needing a real go-core binary.
// ============================================================================

/**
 * Stub ChildProcess mirroring tests/platform/run-child.test.ts's makeStubChild —
 * gives the test control over stdout content and exit code without forking a
 * real process.
 */
function makeStubChild(): {
  child: ChildProcess;
  emitStdout: (s: string) => void;
  emitExit: (code: number | null) => void;
  stdinEnd: ReturnType<typeof vi.fn>;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinEnd = vi.fn();
  const stdin = Object.assign(new EventEmitter(), { end: stdinEnd });
  const proc = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    stdin: typeof stdin;
    kill: (signal?: string) => boolean;
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = stdin;
  proc.kill = vi.fn(() => true);

  return {
    child: proc as unknown as ChildProcess,
    emitStdout: (s: string) => stdout.emit('data', Buffer.from(s, 'utf8')),
    emitExit: (code: number | null) => proc.emit('exit', code, null),
    stdinEnd,
  };
}

describe('GoSnippetClient — in-process build cache', () => {
  let binDir: string;
  let binaryPath: string;
  let spawnCalls: Array<{ command: string; args: readonly string[] }>;
  let stubs: ReturnType<typeof makeStubChild>[];

  function installSpawnStub(): void {
    spawnCalls = [];
    stubs = [];
    __setChildOpsForTests({
      spawn: ((command: string, args: readonly string[]) => {
        spawnCalls.push({ command, args });
        const stub = makeStubChild();
        stubs.push(stub);
        return stub.child;
      }) as never,
    });
  }

  /**
   * Drive one build() call through to a resolved/rejected result, assuming it
   * causes a fresh spawn (cache miss). Because `runChildWithTimeout` spawns
   * synchronously inside its Promise executor — before the caller's `await`
   * suspends — `stubs` already has the new stub by the time `client.build(...)`
   * returns its (still-pending) promise, so we can immediately drive it to
   * completion.
   */
  async function buildViaSpawn(
    client: GoSnippetClient,
    name: string,
    params: Record<string, unknown>,
    opts: { stdout?: string; exitCode?: number } = {}
  ): Promise<string> {
    const { stdout = `jsx:${name}`, exitCode = 0 } = opts;
    const countBefore = stubs.length;
    const promise = client.build(name, params);
    expect(stubs.length).toBe(countBefore + 1); // sanity: this call really spawned
    const stub = stubs[stubs.length - 1];
    stub.emitStdout(stdout);
    stub.emitExit(exitCode);
    return promise;
  }

  afterEach(() => {
    __resetForTests();
    // binDir is only set inside makeClient() — guard against a test that threw
    // before ever calling it (setup failure), which would otherwise pass
    // `undefined` to rmSync and throw a second, more confusing error on top of
    // the original failure.
    if (binDir) rmSync(binDir, { recursive: true, force: true });
  });

  function makeClient(): GoSnippetClient {
    binDir = mkdtempSync(join(tmpdir(), 'em-snippet-cache-'));
    binaryPath = join(binDir, 'fake-core');
    writeFileSync(binaryPath, 'stub-binary-contents');
    installSpawnStub();
    return new GoSnippetClient({ binaryPath });
  }

  // (a) Same name + params → exactly one spawn, identical output both times.
  it('serves an identical build from cache — exactly one spawn, identical output', async () => {
    const client = makeClient();

    const first = await buildViaSpawn(client, 'deselect', {}, { stdout: 'jsx-deselect' });
    const second = await client.build('deselect', {}); // cache hit — no new stub needed

    expect(first).toBe('jsx-deselect');
    expect(second).toBe('jsx-deselect');
    expect(spawnCalls).toHaveLength(1);
  });

  // (b) Different params on the same snippet name → separate cache entries.
  it('spawns again when params differ, even for the same snippet name', async () => {
    const client = makeClient();

    const rgb = await buildViaSpawn(
      client,
      'getHistogram',
      { channel: 'rgb' },
      { stdout: 'jsx-rgb' }
    );
    const red = await buildViaSpawn(
      client,
      'getHistogram',
      { channel: 'red' },
      { stdout: 'jsx-red' }
    );

    expect(rgb).toBe('jsx-rgb');
    expect(red).toBe('jsx-red');
    expect(spawnCalls).toHaveLength(2);
  });

  // (c) A binary mtime change (npm run build replacing the binary mid-process
  // in dev) must drop the WHOLE cache, so a stale snippet can never be served.
  it('drops the whole cache when the binary mtime changes (dev rebuild mid-process)', async () => {
    const client = makeClient();

    const v1 = await buildViaSpawn(client, 'pingState', {}, { stdout: 'jsx-v1' });
    expect(v1).toBe('jsx-v1');
    expect(spawnCalls).toHaveLength(1);

    // Cache hit before any rebuild — confirms the cache was actually populated.
    const cached = await client.build('pingState', {});
    expect(cached).toBe('jsx-v1');
    expect(spawnCalls).toHaveLength(1);

    // Simulate `npm run build` replacing the binary: bump its mtime forward.
    // utimesSync (rather than relying on real clock ticks between writes)
    // guarantees a detectable change regardless of filesystem timestamp
    // resolution.
    const bumped = new Date(Date.now() + 60_000);
    utimesSync(binaryPath, bumped, bumped);

    const v2 = await buildViaSpawn(client, 'pingState', {}, { stdout: 'jsx-v2' });
    expect(v2).toBe('jsx-v2'); // NOT the stale v1 value
    expect(spawnCalls).toHaveLength(2);
  });

  // (d) A failed build (non-zero exit) must not be cached — the next
  // identical call re-spawns rather than replaying the failure or a stale hit.
  it('does not cache a failed build — the next identical call re-spawns', async () => {
    const client = makeClient();

    await expect(
      buildViaSpawn(client, 'applyGaussianBlur', { radius: 2 }, { stdout: '', exitCode: 1 })
    ).rejects.toThrow(/failed \(exit 1\)/);
    expect(spawnCalls).toHaveLength(1);

    const result = await buildViaSpawn(
      client,
      'applyGaussianBlur',
      { radius: 2 },
      { stdout: 'jsx-blur', exitCode: 0 }
    );
    expect(result).toBe('jsx-blur');
    expect(spawnCalls).toHaveLength(2);
  });

  // (e) LRU eviction at the 256-entry bound: the 257th distinct key evicts the
  // OLDEST entry (insertion order, since nothing was re-touched to alter it).
  it('evicts the oldest entry once the cache exceeds 256 entries (LRU)', async () => {
    const client = makeClient();

    for (let i = 0; i < 256; i++) {
      await buildViaSpawn(client, 'probe', { i }, { stdout: `jsx-${i}` });
    }
    expect(spawnCalls).toHaveLength(256);

    // The 257th distinct key pushes the cache over the bound — the oldest
    // entry (i: 0) must be evicted to make room.
    await buildViaSpawn(client, 'probe', { i: 256 }, { stdout: 'jsx-256' });
    expect(spawnCalls).toHaveLength(257);

    // i: 1 was NOT the oldest at eviction time — still cached, no new spawn.
    // Checked BEFORE touching i: 0 again: re-inserting an evicted key is
    // itself an insert-beyond-cap, so it would evict whatever is oldest at
    // THAT point (i: 1, having just been bumped out of first place by the
    // eviction above) — asserting this first avoids disturbing that order.
    const stillCached1 = await client.build('probe', { i: 1 });
    expect(stillCached1).toBe('jsx-1');
    expect(spawnCalls).toHaveLength(257);

    // i: 0 was evicted -> re-requesting it must re-spawn, not hit stale cache.
    const rebuilt0 = await buildViaSpawn(client, 'probe', { i: 0 }, { stdout: 'jsx-0-again' });
    expect(rebuilt0).toBe('jsx-0-again');
    expect(spawnCalls).toHaveLength(258);
  });

  // (f) True LRU recency, not FIFO-by-insertion-order: a cache HIT on the
  // oldest entry must bump it to most-recently-used, so it survives an
  // eviction that a pure insertion-order (FIFO) cache would still apply to it.
  it('a cache hit on the oldest entry marks it MRU — evicts the NEXT-oldest instead (true LRU, not FIFO)', async () => {
    const client = makeClient();

    for (let i = 0; i < 256; i++) {
      await buildViaSpawn(client, 'probe', { i }, { stdout: `jsx-${i}` });
    }
    expect(spawnCalls).toHaveLength(256);

    // HIT the oldest entry (i: 0) — no new spawn, but it's now MRU.
    const hit0 = await client.build('probe', { i: 0 });
    expect(hit0).toBe('jsx-0');
    expect(spawnCalls).toHaveLength(256);

    // The 257th distinct key pushes the cache over the bound. A FIFO cache
    // would evict i: 0 (oldest by insertion); a true LRU cache evicts i: 1
    // instead (the oldest by RECENCY, since i: 0 was just touched above).
    await buildViaSpawn(client, 'probe', { i: 256 }, { stdout: 'jsx-256' });
    expect(spawnCalls).toHaveLength(257);

    // i: 0 survives — this is the assertion that would fail under plain FIFO.
    const stillCached0 = await client.build('probe', { i: 0 });
    expect(stillCached0).toBe('jsx-0');
    expect(spawnCalls).toHaveLength(257);

    // i: 1 was never re-touched — it is the true oldest now and must have
    // been evicted in i: 0's place.
    const rebuilt1 = await buildViaSpawn(client, 'probe', { i: 1 }, { stdout: 'jsx-1-again' });
    expect(rebuilt1).toBe('jsx-1-again');
    expect(spawnCalls).toHaveLength(258);
  });

  // Bonus: the cache layer must never throw on its own — a stat failure
  // (binary missing) bypasses the cache entirely for that call instead.
  it('bypasses the cache (never throws) when statSync fails — re-spawns every call', async () => {
    binDir = mkdtempSync(join(tmpdir(), 'em-snippet-cache-'));
    binaryPath = join(binDir, 'does-not-exist');
    installSpawnStub();
    const client = new GoSnippetClient({ binaryPath });

    const first = await buildViaSpawn(client, 'deselect', {}, { stdout: 'jsx-a' });
    const second = await buildViaSpawn(client, 'deselect', {}, { stdout: 'jsx-b' });

    expect(first).toBe('jsx-a');
    expect(second).toBe('jsx-b'); // not served from a cache that never got populated
    expect(spawnCalls).toHaveLength(2);
  });
});
