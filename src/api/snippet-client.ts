/**
 * SnippetClient — the Node seam to the compiled `editmamei-core` Go binary.
 *
 * The snippet/orchestration IP lives in the Go binary (sealed at rest behind an
 * encrypted template blob). Handlers
 * call `build(name, params)` instead of the old in-process
 * `ExtendScriptSnippets.<name>(...)`; the client spawns the binary, writes the
 * params as JSON to its stdin, and returns the inner JSX body on stdout. The
 * existing wrapper in photoshop-api.ts still wraps that body before execution.
 *
 * Phase 0: per-call spawn (one short-lived process per snippet build), reusing
 * the battle-tested run-child timeout/kill helper. PS-operation latency dwarfs
 * the spawn cost, so a long-lived `serve` mode is deferred (see the migration
 * doc). The contract is identical either way, so swapping later is local.
 */
import { chmodSync, statSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChildWithTimeout } from '../platform/run-child.js';

// Paths already confirmed executable this process — avoids a stat+chmod on
// every per-call spawn.
const ensuredExecutable = new Set<string>();

/**
 * Ensure the core binary has its owner-execute bit set. `npm pack` only
 * preserves `+x` on declared `bin` entries, so our bundled `dist/bin/`
 * binaries ship `0644` and fail to spawn with EACCES / "Permission denied"
 * on macOS + Linux until chmod'd (confirmed on a real Mac, 2026-06-12).
 * Self-heal at first spawn so the binary runs regardless of how it was
 * installed. No-op on Windows (no execute bit) and best-effort on error —
 * a failed chmod just lets the spawn surface its own clear error.
 */
export function ensureExecutable(binaryPath: string): void {
  if (process.platform === 'win32') return;
  if (ensuredExecutable.has(binaryPath)) return;
  try {
    const mode = statSync(binaryPath).mode;
    if ((mode & 0o100) === 0) {
      chmodSync(binaryPath, 0o755);
    }
    ensuredExecutable.add(binaryPath);
  } catch {
    // Ignore — the subsequent spawn will report an actionable error if the
    // binary is genuinely missing/unrunnable.
  }
}

export interface SnippetClient {
  /**
   * Build a snippet's inner JSX body from its name + params. Rejects if the
   * core binary errors (non-zero exit) or the spawn times out.
   */
  build(name: string, params?: Record<string, unknown>): Promise<string>;
}

/**
 * Per-platform binary filename. Matches what the build pipeline emits into
 * `dist/bin/`. `win32`→`win`; arch is node's `x64`/`arm64`.
 */
export function coreBinaryName(os: string = platform(), cpu: string = arch()): string {
  const osPart = os === 'win32' ? 'win' : os; // 'win' | 'darwin'
  const ext = os === 'win32' ? '.exe' : '';
  return `editmamei-core-${osPart}-${cpu}${ext}`;
}

/**
 * Resolve the shipped binary path. `EDITMAMEI_CORE_BIN` overrides (used in dev
 * and tests to point at a locally-built binary). Otherwise resolves to
 * `<dist>/bin/<name>` relative to this compiled module (dist/api/ → dist/bin/).
 */
export function resolveCoreBinaryPath(): string {
  const override = process.env.EDITMAMEI_CORE_BIN;
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'bin', coreBinaryName());
}

/**
 * Resolve the Pro module's OWN go-core binary — the one the kernel's composite
 * snippet client spawns for Pro snippets (community snippets fall back to the
 * host binary above). `EDITMAMEI_PRO_CORE_BIN` overrides (tests / a custom
 * install). Otherwise resolves to `<dist>/modules/pro/bin/<name>`, the in-tree
 * dev Pro module's binary that `buildGoCoreDev` emits (dist/api/ → dist/modules/
 * pro/bin/). Slice 3d-4 points this at the decrypted install dir instead.
 */
export function resolveProBinaryPath(): string {
  const override = process.env.EDITMAMEI_PRO_CORE_BIN;
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'modules', 'pro', 'bin', coreBinaryName());
}

export interface GoSnippetClientOptions {
  /** Explicit binary path. Defaults to resolveCoreBinaryPath(). */
  binaryPath?: string;
  /** Per-build spawn timeout (ms). Default 10s — snippet building is pure CPU. */
  timeoutMs?: number;
  /**
   * Extra environment to hand the core binary, MERGED over process.env at spawn
   * time. Empty/omitted → the child inherits the parent env unchanged. A generic
   * seam (the per-module binary selection that used to ride here now flows
   * through `binaryPath` + the kernel's composite client).
   */
  env?: Record<string, string>;
}

/**
 * Routes each `build(name, …)` to one of two underlying SnippetClients by name —
 * the seam that lets a downloaded module's handlers build BOTH their own go-core
 * snippets and community snippets without the handlers knowing which binary
 * serves which. Snippet names in `ownSnippets` go to `own` (the module's own
 * go-core binary); everything else goes to `community` (the host/CE binary).
 *
 * Concretely: the Pro module's template
 * handlers build community snippets (renderHistoryStatePreview, getHistogram,
 * deselect, …) alongside the Pro selections — so the Pro module gets a composite
 * whose `own` is the Pro binary and whose `community` fallback is the CE binary.
 * The 14 `snippetClient.build(...)` call sites stay unchanged; routing lives
 * here, constructed by the kernel from the module manifest's snippet set.
 */
export class CompositeSnippetClient implements SnippetClient {
  private readonly ownSnippets: ReadonlySet<string>;

  constructor(
    private readonly own: SnippetClient,
    private readonly community: SnippetClient,
    ownSnippets: Iterable<string>
  ) {
    this.ownSnippets = new Set(ownSnippets);
  }

  build(name: string, params: Record<string, unknown> = {}): Promise<string> {
    const target = this.ownSnippets.has(name) ? this.own : this.community;
    return target.build(name, params);
  }
}

// Bound on the per-client in-process memo below. Snippets are KB-scale
// strings, so the worst case (every slot full) is a few hundred KB.
const SNIPPET_CACHE_MAX_ENTRIES = 256;

export class GoSnippetClient implements SnippetClient {
  private readonly binaryPath: string;
  private readonly timeoutMs: number;
  private readonly extraEnv: Record<string, string>;

  // In-process memo of build() results. `build` output is a pure function of
  // (binary bytes, name, params) — the go-core golden tests pin exactly this
  // determinism (no timestamps/randomness in emitters) — so identical calls
  // can be served from memory instead of a ~109ms spawn. Orchestration paths
  // (perception precompute) fire 9-15 builds per tool call, many with
  // byte-identical params (deselect {}, getHistogram, pingState), so this is
  // pure win with no behavior change. Keyed by name + params JSON (Map
  // insertion order gives us the LRU idiom for free: delete+re-set on hit,
  // evict-oldest on overflow).
  private readonly cache = new Map<string, string>();
  // mtime of `binaryPath` the cache above was populated against. `npm run
  // build` replaces the binary mid-process in dev, so every build() call
  // re-stats the binary and drops the whole cache the moment mtime moves —
  // a stale snippet built from the old binary must be impossible.
  private cachedBinaryMtimeMs: number | null = null;

  constructor(opts: GoSnippetClientOptions = {}) {
    this.binaryPath = opts.binaryPath ?? resolveCoreBinaryPath();
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    // Defensive copy — `opts.env` is caller-owned. Without this, a caller
    // mutating its own object AFTER construction (e.g. reusing one options
    // object across several client instances) silently changes what THIS
    // client spawns with, while the cache above stays keyed only on
    // (name, params) — a build served from cache would then look identical to
    // one that would spawn with different env, desyncing the two.
    this.extraEnv = { ...(opts.env ?? {}) };
  }

  /**
   * Drop the cache if the binary's mtime has moved since it was populated.
   * Returns whether the cache is usable for this call — false on a stat
   * error (binary missing/unreadable), which bypasses the cache entirely
   * for that call rather than throwing from the cache layer; the subsequent
   * spawn will surface its own actionable error if the binary is genuinely
   * gone.
   */
  private refreshCacheValidity(): boolean {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.binaryPath).mtimeMs;
    } catch {
      return false;
    }
    if (mtimeMs !== this.cachedBinaryMtimeMs) {
      this.cache.clear();
      this.cachedBinaryMtimeMs = mtimeMs;
    }
    return true;
  }

  async build(name: string, params: Record<string, unknown> = {}): Promise<string> {
    ensureExecutable(this.binaryPath);
    // Params serialization is already what's piped to the binary as stdin,
    // so it doubles as the cache key with no extra normalization needed.
    const paramsJson = JSON.stringify(params);
    const cacheUsable = this.refreshCacheValidity();
    // `this.extraEnv` is deliberately NOT part of this key — build() is a pure
    // function of (binary bytes, name, params) today because go-core reads no
    // env vars; extraEnv only ever reaches the spawned child process, never
    // the build logic. If an emitter is ever added that DOES branch on an env
    // var, the key must grow to include the relevant extraEnv entries too, or
    // two instances with different env pointed at the same binary could serve
    // each other's cached output.
    const cacheKey = name + '\u0000' + paramsJson;

    if (cacheUsable) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        this.cache.delete(cacheKey); // re-insert to mark most-recently-used
        this.cache.set(cacheKey, cached);
        return cached;
      }
    }

    // Only build an explicit env when we have extras to add — otherwise let the
    // child inherit the parent env unchanged (run-child treats undefined as inherit).
    const env =
      Object.keys(this.extraEnv).length > 0 ? { ...process.env, ...this.extraEnv } : undefined;
    const result = await runChildWithTimeout(this.binaryPath, ['build', name], {
      timeout: this.timeoutMs,
      input: paramsJson,
      diagLabel: `editmamei-core build ${name}`,
      env,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `editmamei-core build "${name}" failed (exit ${result.exitCode}): ` +
          `${result.stderr.trim() || '(no stderr)'}`
      );
    }

    // Only successful builds are cached — a failure propagates uncached so
    // the next call always gets a fresh attempt.
    if (cacheUsable) {
      this.cache.set(cacheKey, result.stdout);
      if (this.cache.size > SNIPPET_CACHE_MAX_ENTRIES) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey !== undefined) this.cache.delete(oldestKey);
      }
    }

    return result.stdout;
  }
}
