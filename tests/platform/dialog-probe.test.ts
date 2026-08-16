import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GoDialogProbe,
  resolvePhotoshopPids,
  __setProbeOpsForTests,
  __resetProbeOpsForTests,
} from '../../src/platform/dialog-probe.js';

afterEach(() => __resetProbeOpsForTests());

function stubRun(result: Partial<{ stdout: string; stderr: string; exitCode: number }>) {
  const run = vi.fn().mockResolvedValue({
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode ?? 0,
    signal: null,
  });
  __setProbeOpsForTests({ run, resolveBinary: () => 'editmamei-core' });
  return run;
}

describe('GoDialogProbe', () => {
  it('parses a dialog report from the binary', async () => {
    stubRun({
      stdout: JSON.stringify({
        status: 'dialog',
        token: 'd1:1:A:b',
        title: 'Adobe Photoshop',
        stakes: 'decision',
        buttons: [{ index: 0, id: 10, caption: 'Continue', default: true }],
      }),
    });
    const report = await new GoDialogProbe().probe([1234]);
    expect(report.status).toBe('dialog');
    expect(report.buttons?.[0].caption).toBe('Continue');
  });

  it('passes the pid list comma-separated, because several Photoshops can run', async () => {
    const run = stubRun({ stdout: '{"status":"clear"}' });
    await new GoDialogProbe().probe([111, 222]);
    expect(run.mock.calls[0][1]).toEqual(['dialog', '--action', 'probe', '--pid', '111,222']);
  });

  it('sends token and button id on a click', async () => {
    const run = stubRun({ stdout: '{"status":"cleared"}' });
    await new GoDialogProbe().click([1], 'tok', 11);
    expect(run.mock.calls[0][1]).toEqual([
      'dialog',
      '--action',
      'click',
      '--pid',
      '1',
      '--token',
      'tok',
      '--button-id',
      '11',
    ]);
  });

  // The probe is a diagnostic. It must never be able to make things worse, so
  // every failure mode below has to degrade to `unknown` rather than throw.
  describe('degrades to unknown, never throws and never claims clear', () => {
    it('on a spawn failure', async () => {
      const run = vi.fn().mockRejectedValue(new Error('ENOENT'));
      __setProbeOpsForTests({ run, resolveBinary: () => 'missing' });
      const report = await new GoDialogProbe().probe([1]);
      expect(report.status).toBe('unknown');
      expect(report.reason).toBe('probe-unavailable');
    });

    it('on a non-zero exit', async () => {
      stubRun({ stdout: '', exitCode: 2 });
      const report = await new GoDialogProbe().probe([1]);
      expect(report.status).toBe('unknown');
      expect(report.reason).toBe('probe-exit-2');
    });

    it('on unparseable output', async () => {
      stubRun({ stdout: 'not json at all' });
      const report = await new GoDialogProbe().probe([1]);
      expect(report.status).toBe('unknown');
    });

    it('on empty output', async () => {
      stubRun({ stdout: '   ' });
      const report = await new GoDialogProbe().probe([1]);
      expect(report.status).toBe('unknown');
    });

    it('on JSON that is not a report', async () => {
      stubRun({ stdout: '[1,2,3]' });
      const report = await new GoDialogProbe().probe([1]);
      expect(report.status).toBe('unknown');
    });

    it('when there are no pids at all', async () => {
      const run = stubRun({ stdout: '{"status":"clear"}' });
      const report = await new GoDialogProbe().probe([]);
      expect(report.status).toBe('unknown');
      expect(run).not.toHaveBeenCalled();
    });
  });
});

describe('resolvePhotoshopPids', () => {
  it('parses every Photoshop pid out of tasklist CSV', async () => {
    // Two instances is a real configuration, and the probe checks them all.
    stubRun({
      stdout:
        '"Photoshop.exe","31108","Console","1","2,897,000 K"\n"Photoshop.exe","52100","Console","1","1,000 K"\n',
    });
    const pids = await resolvePhotoshopPids();
    if (process.platform === 'win32') {
      expect(pids).toEqual([31108, 52100]);
    }
  });

  it('returns nothing rather than throwing when the lookup fails', async () => {
    const run = vi.fn().mockRejectedValue(new Error('no tasklist'));
    __setProbeOpsForTests({ run });
    await expect(resolvePhotoshopPids()).resolves.toEqual([]);
  });
});
