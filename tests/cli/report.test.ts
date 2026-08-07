import { describe, it, expect, vi } from 'vitest';
import { runReport } from '@editmamei/cli/report.ts';
import type { DiagnosticBundle } from '@editmamei/diagnostics/collect.ts';

/** The CLI shares the collector seam with the tool; here we only assert wiring + output. */
describe('runReport (editmamei report)', () => {
  it('collects with the note, writes a bundle, and prints the path + where to file it', async () => {
    const out: string[] = [];
    const collect = vi.fn(async () => ({}) as unknown as DiagnosticBundle);
    const write = vi.fn(async () => ({ path: '/dl/editmamei-diagnostics-x.json', bytes: 10 }));

    await runReport({ note: 'broke on launch', stdout: (s) => out.push(s), collect, write });

    const text = out.join('');
    expect(collect).toHaveBeenCalledWith({ note: 'broke on launch' });
    expect(write).toHaveBeenCalledOnce();
    expect(text).toContain('/dl/editmamei-diagnostics-x.json');
    expect(text).toMatch(/github\.com/);
    expect(text).toMatch(/no tool arguments/i);
  });

  it('works with no note', async () => {
    const out: string[] = [];
    const collect = vi.fn(async () => ({}) as unknown as DiagnosticBundle);
    const write = vi.fn(async () => ({ path: '/dl/x.json', bytes: 1 }));
    await runReport({ stdout: (s) => out.push(s), collect, write });
    expect(collect).toHaveBeenCalledWith({ note: undefined });
  });
});
