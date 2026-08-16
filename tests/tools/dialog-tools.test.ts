import { describe, it, expect, vi } from 'vitest';
import { createDialogTools } from '../../src/tools/dialog-tools.js';
import type { ToolResult } from '../../src/core/tool-registry.js';
import type { DialogProbe, DialogReport } from '../../src/platform/dialog-probe.js';
import { describeReport } from '../../src/platform/dialog-probe.js';
import type { PhotoshopConnection } from '../../src/platform/connection.js';
import type { SnippetClient } from '../../src/api/snippet-client.js';

const connection = {} as PhotoshopConnection;
const snippet = {} as SnippetClient;

function build(probe: Partial<DialogProbe>, pids: number[] = [1234]) {
  const full: DialogProbe = {
    probe: probe.probe ?? vi.fn().mockResolvedValue({ status: 'clear' }),
    click: probe.click ?? vi.fn().mockResolvedValue({ status: 'cleared' }),
  };
  const [def] = createDialogTools(connection, snippet, {
    probe: full,
    pids: async () => pids,
  });
  return { def, full };
}

function parse(result: ToolResult): DialogReport & { summary: string } {
  const first = result.content[0];
  return JSON.parse('text' in first ? first.text : '{}');
}

const blockingDialog: DialogReport = {
  status: 'dialog',
  token: 'd1:1234:ABC:deadbeef',
  title: 'Adobe Photoshop',
  text: 'The command “Feather” is not currently available.',
  stakes: 'decision',
  buttons: [
    { index: 0, id: 10, caption: 'Continue', default: true },
    { index: 1, id: 11, caption: 'Stop', default: false },
  ],
};

describe('ps_dialog', () => {
  it('registers at a name and shape the surface guards expect', () => {
    const { def } = build({});
    expect(def.tool.name).toBe('ps_dialog');
    // It presses real buttons in the user's Photoshop — that must be declared.
    expect(def.tool.annotations?.readOnlyHint).toBe(false);
    expect(def.tool.annotations?.destructiveHint).toBe(true);
  });

  it('inspect reports the blocking dialog with its buttons', async () => {
    const probe = vi.fn().mockResolvedValue(blockingDialog);
    const { def } = build({ probe });
    const out = parse(await def.handler({ action: 'inspect' }));

    expect(probe).toHaveBeenCalledWith([1234]);
    expect(out.status).toBe('dialog');
    expect(out.buttons?.map((b) => b.caption)).toEqual(['Continue', 'Stop']);
    expect(out.summary).toContain('Feather');
  });

  it('defaults to inspect when no action is given', async () => {
    const probe = vi.fn().mockResolvedValue({ status: 'clear' });
    const { def } = build({ probe });
    await def.handler({});
    expect(probe).toHaveBeenCalledOnce();
  });

  it('reports unknown — never clear — when Photoshop is not running', async () => {
    const probe = vi.fn();
    const { def } = build({ probe }, []);
    const out = parse(await def.handler({ action: 'inspect' }));

    expect(out.status).toBe('unknown');
    expect(out.status).not.toBe('clear');
    // Nothing should be spawned when there is no PID to probe.
    expect(probe).not.toHaveBeenCalled();
  });

  it('refuses to click without the token from an inspect call', async () => {
    const click = vi.fn();
    const { def } = build({ click });
    await expect(def.handler({ action: 'click', button_id: 11 })).rejects.toThrow(/token/i);
    expect(click).not.toHaveBeenCalled();
  });

  it('refuses to click without a button id', async () => {
    const click = vi.fn();
    const { def } = build({ click });
    await expect(def.handler({ action: 'click', token: 'd1:x' })).rejects.toThrow(/button_id/);
    expect(click).not.toHaveBeenCalled();
  });

  it('passes the token and button id straight through to the probe', async () => {
    const click = vi.fn().mockResolvedValue({ status: 'cleared' });
    const { def } = build({ click });
    const out = parse(
      await def.handler({ action: 'click', token: 'd1:1234:ABC:deadbeef', button_id: 11 })
    );

    expect(click).toHaveBeenCalledWith([1234], 'd1:1234:ABC:deadbeef', 11);
    expect(out.status).toBe('cleared');
  });

  it('surfaces a stale token as stale rather than clicking anyway', async () => {
    const click = vi.fn().mockResolvedValue({ status: 'stale', reason: 'token-mismatch' });
    const { def } = build({ click });
    const out = parse(await def.handler({ action: 'click', token: 'old', button_id: 1 }));
    expect(out.status).toBe('stale');
    expect(out.summary).toMatch(/no longer the one on screen/i);
  });
});

describe('describeReport', () => {
  // The whole point of the unknown status is that it must not read as "fine".
  it('never lets unknown be mistaken for clear', () => {
    const text = describeReport({ status: 'unknown', reason: 'probe-unavailable' });
    expect(text).toMatch(/NOT the same as "no dialog"/);
  });

  it('tells the caller to stop when a click opened another dialog', () => {
    const text = describeReport({ status: 'replaced', title: 'Save changes?' });
    expect(text).toMatch(/Stopping here/);
    expect(text).toContain('Save changes?');
  });

  it('describes a clear Photoshop plainly', () => {
    expect(describeReport({ status: 'clear' })).toMatch(/No dialog/);
  });
});
