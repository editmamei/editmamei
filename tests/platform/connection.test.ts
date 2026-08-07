import { describe, it, expect, vi, afterEach } from 'vitest';
import * as connectionModule from '@editmamei/platform/connection.ts';
import { PhotoshopConnection, RUNNING_LATCH_TTL_MS } from '@editmamei/platform/connection.ts';
import type { HostPlatform } from '@editmamei/platform/host-platform.ts';
import type { PhotoshopInfo, PlatformAdapter } from '@editmamei/platform/ports.ts';

/**
 * These exercise the connection's own behaviour — the running-check latch,
 * single-flight detection, and the debug guard — with the host injected rather
 * than resolved, so no real runner or detector is constructed and the suite
 * runs identically on any platform.
 */
const INFO: PhotoshopInfo = {
  version: '2024',
  path: 'C:/Program Files/Adobe/Adobe Photoshop 2024/Photoshop.exe',
};

/**
 * Result queues are indexed by call count and clamp to the last entry once
 * exhausted, so a single-element queue behaves like "always return this".
 */
class MockAdapter implements PlatformAdapter {
  isRunningCalls = 0;
  launchCalls = 0;
  runCalls = 0;
  installsReceived: PhotoshopInfo[] = [];

  constructor(
    private runningResults: boolean[] = [true],
    private runResults: Array<() => unknown> = [() => 'ok']
  ) {}

  private static next<T>(queue: T[], count: number): T {
    return queue[Math.min(count, queue.length - 1)];
  }

  useInstall(install: PhotoshopInfo): void {
    this.installsReceived.push(install);
  }

  async isRunning(): Promise<boolean> {
    const result = MockAdapter.next(this.runningResults, this.isRunningCalls);
    this.isRunningCalls++;
    return result;
  }

  async launch(): Promise<void> {
    this.launchCalls++;
  }

  async run(): Promise<unknown> {
    const fn = MockAdapter.next(this.runResults, this.runCalls);
    this.runCalls++;
    return fn();
  }
}

class MockDetector {
  calls = 0;

  constructor(private impl: () => Promise<PhotoshopInfo | null> = async () => INFO) {}

  use(impl: () => Promise<PhotoshopInfo | null>): void {
    this.impl = impl;
  }

  detect(): Promise<PhotoshopInfo> {
    this.calls++;
    // The port promises an install; a null is the "not found" case these tests
    // drive deliberately, so the cast is confined to this double.
    return this.impl() as Promise<PhotoshopInfo>;
  }
}

function makeConnection(
  adapter: MockAdapter,
  now: () => number,
  detector: MockDetector = new MockDetector()
): PhotoshopConnection {
  const host: HostPlatform = { os: 'win32', adapter, detector };
  return new PhotoshopConnection({ now, host });
}

describe('PhotoshopConnection — running-check freshness latch', () => {
  it('two calls within the TTL probe exactly once', async () => {
    const adapter = new MockAdapter([true], [() => 'ok']);
    const conn = makeConnection(adapter, () => 1_000_000);

    await conn.executeScript('a');
    await conn.executeScript('b');

    expect(adapter.isRunningCalls).toBe(1);
    expect(adapter.runCalls).toBe(2);
  });

  it('probes again after a failed script', async () => {
    const adapter = new MockAdapter(
      [true],
      [
        () => {
          throw new Error('boom');
        },
        () => 'ok',
      ]
    );
    const conn = makeConnection(adapter, () => 1_000_000);

    await expect(conn.executeScript('a')).rejects.toThrow('boom');
    await conn.executeScript('b');

    expect(adapter.isRunningCalls).toBe(2);
  });

  it('probes again once the TTL has elapsed', async () => {
    let currentTime = 1_000_000;
    const adapter = new MockAdapter([true], [() => 'ok']);
    const conn = makeConnection(adapter, () => currentTime);

    await conn.executeScript('a');
    expect(adapter.isRunningCalls).toBe(1);

    currentTime += RUNNING_LATCH_TTL_MS; // exactly at the boundary
    await conn.executeScript('b');

    expect(adapter.isRunningCalls).toBe(2);
  });

  it('launches on a negative probe and does not latch it', async () => {
    // Photoshop reported not-running, so a launch fires; the script right after
    // a cold launch fails because Photoshop is still starting. That sequence
    // shows the negative probe was never latched, independently of the rule
    // that a successful script refreshes the latch.
    const adapter = new MockAdapter(
      [false, true],
      [
        () => {
          throw new Error('still starting up');
        },
        () => 'ok',
      ]
    );
    const conn = makeConnection(adapter, () => 1_000_000);

    await expect(conn.executeScript('a')).rejects.toThrow('still starting up');
    expect(adapter.launchCalls).toBe(1);
    expect(adapter.isRunningCalls).toBe(1);

    await conn.executeScript('b');
    expect(adapter.isRunningCalls).toBe(2);
  });
});

describe('PhotoshopConnection — handing the install to the adapter', () => {
  it('passes the detected install to the adapter before any script runs', async () => {
    // macOS cannot address Photoshop without the application name carried on
    // the install, so this wiring is what makes the platform work at all.
    const adapter = new MockAdapter([true], [() => 'ok']);
    const conn = makeConnection(adapter, () => 1_000_000);

    await conn.executeScript('a');

    expect(adapter.installsReceived).toEqual([INFO]);
  });

  it('hands it over once, not per call', async () => {
    const adapter = new MockAdapter([true], [() => 'ok']);
    const conn = makeConnection(adapter, () => 1_000_000);

    await conn.executeScript('a');
    await conn.executeScript('b');

    expect(adapter.installsReceived).toHaveLength(1);
  });
});

describe('PhotoshopConnection — a rejecting useInstall must not poison the connection', () => {
  it('does not cache the install when the adapter refuses it', async () => {
    // The adapter validates what it is handed and can reject — macOS refuses an
    // application name it cannot compose into AppleScript. Caching the install
    // before the hook ran would leave the connection permanently
    // half-configured: detection never repeats, so every later call fails with
    // the downstream symptom instead of this cause.
    class RefusingAdapter extends MockAdapter {
      override useInstall(): void {
        throw new Error('application name cannot be composed into AppleScript');
      }
    }

    const adapter = new RefusingAdapter([true], [() => 'ok']);
    const detector = new MockDetector();
    const conn = makeConnection(adapter, () => 1_000_000, detector);

    await expect(conn.executeScript('a')).rejects.toThrow(/cannot be composed/);
    expect(conn.getPhotoshopInfo()).toBeNull();

    // And the failure is retryable rather than latched.
    await expect(conn.executeScript('b')).rejects.toThrow(/cannot be composed/);
    expect(detector.calls).toBe(2);
  });
});

describe('truncateForLog', () => {
  it('passes strings at or under the limit through unchanged', () => {
    expect(connectionModule.truncateForLog('short', 200)).toBe('short');
  });

  it('truncates and appends a remaining-chars marker past the limit', () => {
    const s = 'a'.repeat(500);
    const truncated = connectionModule.truncateForLog(s, 200);
    expect(truncated.startsWith('a'.repeat(200))).toBe(true);
    expect(truncated).toContain('+300 chars');
  });
});

/**
 * The debug line's argument is a template string built around
 * `truncateForLog(script, 200)`. Arguments are evaluated before the call, so
 * the logger's own level check cannot prevent that work — `executeScript`
 * guards the whole block with `isDebugEnabled()` instead.
 *
 * Spying on the exported `truncateForLog` does not intercept the same-module
 * call, since internal references compile to the local binding rather than
 * through the exports object. So this asserts through the observable seam:
 * whether the line reaches stderr at all.
 */
describe('PhotoshopConnection — debug guard on the eagerly built log line', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    delete process.env.LOG_LEVEL;
    stderrSpy?.mockRestore();
  });

  it('does not emit the line at the default level', async () => {
    delete process.env.LOG_LEVEL;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const conn = makeConnection(new MockAdapter([true], [() => 'ok']), () => 1_000_000);

    await conn.executeScript('a'.repeat(500));

    const emitted = stderrSpy.mock.calls.some((call: unknown[]) =>
      String(call[0]).includes('Executing script')
    );
    expect(emitted).toBe(false);
  });

  it('emits the truncated line when debug logging is enabled', async () => {
    process.env.LOG_LEVEL = 'DEBUG';
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const conn = makeConnection(new MockAdapter([true], [() => 'ok']), () => 1_000_000);

    await conn.executeScript('a'.repeat(500));

    const line = stderrSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .find((text: string) => text.includes('Executing script'));
    expect(line).toBeDefined();
    // Proof the eagerly built truncation actually ran.
    expect(line).toContain('+300 chars');
  });
});

describe('PhotoshopConnection — single-flight detection', () => {
  /**
   * Boot starts a Photoshop probe without awaiting it, so a tool call can
   * arrive while that probe is still detecting. Both callers used to see no
   * install, start competing detections, and the loser could resolve nothing —
   * leaving the connection convinced no Photoshop had been found when one had.
   */
  it('shares one detection across concurrent callers instead of racing', async () => {
    const detector = new MockDetector();
    let release: (v: PhotoshopInfo) => void = () => {};
    const pending = new Promise<PhotoshopInfo>((res) => {
      release = res;
    });
    detector.use(() => pending);

    const conn = makeConnection(new MockAdapter([true], [() => 'ok']), () => 1_000_000, detector);

    // Two callers arrive while detection is still in flight.
    const a = conn.getVersion();
    const b = conn.executeScript("'pong';");
    release(INFO);
    await Promise.all([a, b]);

    expect(detector.calls).toBe(1);
    expect(conn.getPhotoshopInfo()).toEqual(INFO);
  });

  it('does not cache a failed detection — the next call retries', async () => {
    const detector = new MockDetector();
    let attempt = 0;
    detector.use(() => {
      attempt++;
      return Promise.resolve(attempt === 1 ? null : INFO);
    });

    const conn = makeConnection(new MockAdapter([true], [() => 'ok']), () => 1_000_000, detector);

    // The first attempt finds nothing: surfaced as an actionable error rather
    // than a permanently poisoned connection.
    await expect(conn.executeScript("'pong';")).rejects.toThrow(/could not be detected/i);
    // The second succeeds, proving the miss was never latched.
    await conn.executeScript("'pong';");

    expect(detector.calls).toBe(2);
  });
});
