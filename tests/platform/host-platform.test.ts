import { describe, it, expect, vi, afterEach } from 'vitest';
import { platform } from 'os';
import { resolveHostPlatform } from '@editmamei/platform/host-platform.ts';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, platform: vi.fn(actual.platform) };
});

/**
 * The decision this module owns used to be written out in three places. These
 * cover the branch itself; what each branch *builds* is covered by the runner
 * and detector suites.
 */
describe('resolveHostPlatform', () => {
  const realPlatform = process.platform;

  afterEach(() => {
    // Restore an explicit real value rather than resetting: a bare reset drops
    // the implementation entirely, so any later test in this file that forgot
    // to set one would see platform() return undefined.
    vi.mocked(platform).mockReturnValue(realPlatform);
  });

  it('supplies a runner and a detector on Windows', () => {
    vi.mocked(platform).mockReturnValue('win32');
    const host = resolveHostPlatform();

    expect(host.os).toBe('win32');
    expect(typeof host.adapter.run).toBe('function');
    expect(typeof host.adapter.isRunning).toBe('function');
    expect(typeof host.adapter.launch).toBe('function');
    expect(typeof host.detector.detect).toBe('function');
  });

  it('supplies a runner and a detector on macOS', () => {
    vi.mocked(platform).mockReturnValue('darwin');
    const host = resolveHostPlatform();

    expect(host.os).toBe('darwin');
    expect(typeof host.adapter.run).toBe('function');
    expect(typeof host.detector.detect).toBe('function');
  });

  it('exposes useInstall only where the platform needs it', () => {
    // macOS must be told which application to address; Windows reaches
    // Photoshop through a fixed COM identifier and has nothing to take.
    vi.mocked(platform).mockReturnValue('darwin');
    expect(typeof resolveHostPlatform().adapter.useInstall).toBe('function');

    vi.mocked(platform).mockReturnValue('win32');
    expect(resolveHostPlatform().adapter.useInstall).toBeUndefined();
  });

  it('resolves an inert host where Photoshop does not exist, refusing per call', async () => {
    // Resolution succeeds on any OS — that is what lets the server boot,
    // complete the MCP handshake, and list tools inside a Linux sandbox (the
    // exact shape of a directory scanner's run). The refusal moves to the
    // calls that genuinely try to drive Photoshop, and it names the OS.
    vi.mocked(platform).mockReturnValue('linux');
    const host = resolveHostPlatform();

    expect(host.os).toBe('linux');
    await expect(host.adapter.run('$.__mcp__ = 1;')).rejects.toThrow(/Windows and macOS/);
    await expect(host.adapter.isRunning()).rejects.toThrow(/"linux"/);
    await expect(host.adapter.launch('/nowhere')).rejects.toThrow(/no Linux build/);
    await expect(host.detector.detect()).rejects.toThrow(/nothing here to drive/);
  });
});
