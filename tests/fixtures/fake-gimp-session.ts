import type { GimpBackend } from '@editmamei/backends/gimp/backend.ts';
import type { GimpInstall } from '@editmamei/backends/gimp/detect.ts';

export interface RecordedGimpCall {
  op: string;
  args: Record<string, unknown>;
}

export interface FakeGimpBackendOptions {
  /** Defaults to a plausible resolved install; pass `null` to simulate "registered with none". */
  install?: GimpInstall | null;
  /** Static result for every call, unless `resultFor` is given. */
  result?: unknown;
  /** Per-call result, keyed by op. Wins over `result` when it returns non-undefined. */
  resultFor?: (op: string, args: Record<string, unknown>) => unknown;
  /** Per-call error, keyed by op — thrown instead of returning a result. */
  throwFor?: (op: string, args: Record<string, unknown>) => unknown;
  gimpVersion?: string;
  /** Defaults to 'ready' (a warm session). Set to 'idle' / 'dead' to test gimp_ping's cold/restarted labeling. */
  state?: string;
  /** Defaults to undefined (no start attempt has ever begun). Set alongside `state: 'starting'` to test gimp_ping's origin-aware labeling. */
  startOrigin?: 'cold' | 'restarted';
}

const DEFAULT_INSTALL: GimpInstall = {
  source: 'conventional',
  path: 'C:/Program Files/GIMP 3/bin/gimp-console-3.2.exe',
  launch: { command: 'C:/Program Files/GIMP 3/bin/gimp-console-3.2.exe', args: [] },
};

/**
 * Drop-in stand-in for `GimpBackend` used in tests — the exact analogue of
 * `FakePhotoshopConnection` (see `tests/fixtures/fake-connection.ts`). Records
 * every `call(op, args)` so tests can assert what the tool would have sent to
 * the bridge, without spawning a real headless GIMP.
 */
export class FakeGimpBackend {
  public calls: RecordedGimpCall[] = [];

  private readonly installInfo: GimpInstall | null;
  private readonly staticResult: unknown;
  private readonly resultForFn?: (op: string, args: Record<string, unknown>) => unknown;
  private readonly throwForFn?: (op: string, args: Record<string, unknown>) => unknown;
  private readonly version?: string;
  private readonly sessionState: string;
  private readonly origin?: 'cold' | 'restarted';

  constructor(opts: FakeGimpBackendOptions = {}) {
    this.installInfo = opts.install === undefined ? DEFAULT_INSTALL : opts.install;
    this.staticResult = opts.result ?? {};
    this.resultForFn = opts.resultFor;
    this.throwForFn = opts.throwFor;
    this.version = opts.gimpVersion;
    this.sessionState = opts.state ?? 'ready';
    this.origin = opts.startOrigin;
  }

  get installed(): boolean {
    return this.installInfo !== null;
  }

  get install(): GimpInstall | null {
    return this.installInfo;
  }

  get gimpVersion(): string | undefined {
    return this.version;
  }

  get state(): string {
    return this.sessionState;
  }

  get startOrigin(): 'cold' | 'restarted' | undefined {
    return this.origin;
  }

  async call<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ op, args });
    if (this.throwForFn) {
      const err = this.throwForFn(op, args);
      if (err !== undefined) throw err;
    }
    if (this.resultForFn) {
      const r = this.resultForFn(op, args);
      if (r !== undefined) return r as T;
    }
    return this.staticResult as T;
  }

  async prepare(): Promise<void> {
    /* no-op: the fake has no detection to retry */
  }

  latestPreviewPath(): string {
    return '/fake/gimp/latest-preview.jpg';
  }

  copyToLatestPreview(_src: string): void {
    /* no-op */
  }

  tempPath(name: string): string {
    return `/fake/gimp/${name}`;
  }

  async shutdown(): Promise<void> {
    /* no-op */
  }

  /** Test helper — the most recent call. */
  lastCall(): RecordedGimpCall {
    if (this.calls.length === 0) {
      throw new Error('FakeGimpBackend: no call has been made yet.');
    }
    return this.calls[this.calls.length - 1];
  }

  /** Test helper — every op name called, in order. */
  allOps(): string[] {
    return this.calls.map((c) => c.op);
  }

  /** Cast helper so tests don't repeat the `as unknown as` dance. */
  asBackend(): GimpBackend {
    return this as unknown as GimpBackend;
  }
}

export function makeGimpBackend(opts?: FakeGimpBackendOptions): FakeGimpBackend {
  return new FakeGimpBackend(opts);
}
