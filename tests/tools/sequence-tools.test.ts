import { describe, it, expect } from 'vitest';
import { createSequenceTools } from '@editmamei/tools/sequence-tools.ts';
import { tierOf } from '@editmamei/core/tool-tiers.ts';
import { groupOf } from '@editmamei/core/tool-groups.ts';
import { assertToolShape, callTool, textOf } from '../fixtures/tool-helpers.ts';
import type { ToolResult } from '@editmamei/core/tool-registry.ts';

// ps_sequence never talks to Photoshop itself — every step is dispatched
// through an injected invokeTool, exactly the seam the real CE module wires
// to host.invokeTool (src/modules/ce/index.ts). These tests drive that seam
// directly with a fake, never a real registry or connection.

type FakeInvoke = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

const ok = (text = 'ok'): ToolResult => ({ content: [{ type: 'text' as const, text }] });
const fail = (text = 'boom'): ToolResult => ({
  content: [{ type: 'text' as const, text }],
  isError: true,
});

describe('createSequenceTools', () => {
  it('returns one well-formed tool', () => {
    const tools = createSequenceTools(async () => ok());
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_sequence']);
  });

  it('is registered at dev tier and appears in the automation group', () => {
    expect(tierOf('ps_sequence')).toBe('dev');
    expect(groupOf('ps_sequence')).toBe('automation');
  });

  // ---------- ordering ----------

  it('runs steps in order, each receiving exactly its own args', async () => {
    const invoked: Array<{ name: string; args: unknown }> = [];
    const invokeTool: FakeInvoke = async (name, args) => {
      invoked.push({ name, args });
      return ok();
    };
    const tools = createSequenceTools(invokeTool);
    await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'ps_ping', args: {} },
        { tool: 'ps_undo', args: { steps: 2 } },
        { tool: 'ps_redo', args: { steps: 3 } },
      ],
    });
    expect(invoked).toEqual([
      { name: 'ps_ping', args: {} },
      { name: 'ps_undo', args: { steps: 2 } },
      { name: 'ps_redo', args: { steps: 3 } },
    ]);
  });

  // ---------- validation, before any step runs ----------

  it('validation refuses an unknown tool and runs nothing', async () => {
    const invoked: string[] = [];
    const invokeTool: FakeInvoke = async (name) => {
      invoked.push(name);
      return ok();
    };
    const tools = createSequenceTools(invokeTool);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'ps_this_tool_does_not_exist', args: {} }],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not a tool registered in this edition/);
    expect(invoked).toEqual([]);
  });

  it('validation refuses ps_sequence nesting itself and runs nothing', async () => {
    const invoked: string[] = [];
    const invokeTool: FakeInvoke = async (name) => {
      invoked.push(name);
      return ok();
    };
    const tools = createSequenceTools(invokeTool);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'ps_sequence', args: { steps: [{ tool: 'ps_ping', args: {} }] } }],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/cannot nest ps_sequence/);
    expect(invoked).toEqual([]);
  });

  it('validation refuses an out-of-range step count and runs nothing', async () => {
    const invoked: string[] = [];
    const invokeTool: FakeInvoke = async (name) => {
      invoked.push(name);
      return ok();
    };
    const tools = createSequenceTools(invokeTool);
    const tooMany = Array.from({ length: 26 }, () => ({ tool: 'ps_ping', args: {} }));
    const res = await callTool(tools, 'ps_sequence', { steps: tooMany });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/must contain 1 to 25 items/);
    expect(invoked).toEqual([]);
  });

  // ---------- on_error policies ----------

  it('on_error=stop halts at the first failing step', async () => {
    const invoked: string[] = [];
    const invokeTool: FakeInvoke = async (name) => {
      invoked.push(name);
      return name === 'ps_get_histogram' ? fail() : ok();
    };
    const tools = createSequenceTools(invokeTool);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'ps_ping', args: {} },
        { tool: 'ps_get_histogram', args: {} },
        { tool: 'ps_undo', args: {} },
      ],
      on_error: 'stop',
    });
    expect(invoked).toEqual(['ps_ping', 'ps_get_histogram']);
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { failed_step: unknown; ran_steps: number };
    expect(sc.failed_step).toEqual({ index: 1, tool: 'ps_get_histogram' });
    expect(sc.ran_steps).toBe(2);
  });

  it('on_error=continue records the failure and runs every remaining step', async () => {
    const invoked: string[] = [];
    const invokeTool: FakeInvoke = async (name) => {
      invoked.push(name);
      return name === 'ps_get_histogram' ? fail() : ok();
    };
    const tools = createSequenceTools(invokeTool);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'ps_ping', args: {} },
        { tool: 'ps_get_histogram', args: {} },
        { tool: 'ps_undo', args: {} },
      ],
      on_error: 'continue',
    });
    expect(invoked).toEqual(['ps_ping', 'ps_get_histogram', 'ps_undo']);
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { failed_step: unknown; ran_steps: number };
    expect(sc.failed_step).toEqual({ index: 1, tool: 'ps_get_histogram' });
    expect(sc.ran_steps).toBe(3);
  });

  it('on_error=continue reports the FIRST failure when several steps fail', async () => {
    const invokeTool: FakeInvoke = async (name) => (name === 'ps_ping' ? ok() : fail());
    const tools = createSequenceTools(invokeTool);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'ps_get_histogram', args: {} }, // fails first
        { tool: 'ps_ping', args: {} },
        { tool: 'ps_undo', args: {} }, // fails too, but should not overwrite failed_step
      ],
      on_error: 'continue',
    });
    const sc = res.structuredContent as {
      failed_step: unknown;
      steps: Array<{ index: number; ok: boolean }>;
    };
    expect(sc.failed_step).toEqual({ index: 0, tool: 'ps_get_histogram' });
    expect(sc.steps.map((s) => s.ok)).toEqual([false, true, false]);
  });

  it('on_error=rollback restores the history cursor (ps_inspect + ps_undo) after a failing step', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let historyReads = 0;
    const invokeTool: FakeInvoke = async (name, args) => {
      calls.push({ name, args });
      if (name === 'ps_inspect' && args.what === 'history') {
        historyReads++;
        // Before step 1: index 5. After the failed step ran: index 8 — 3
        // in-document edits happened, so rollback should undo exactly 3.
        return {
          ...ok('history'),
          structuredContent: { currentIndex: historyReads === 1 ? 5 : 8 },
        };
      }
      if (name === 'ps_get_histogram') return fail();
      return ok();
    };
    const tools = createSequenceTools(invokeTool);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'ps_ping', args: {} },
        { tool: 'ps_get_histogram', args: {} },
        { tool: 'ps_undo', args: {} }, // never reached — rollback stops the loop
      ],
      on_error: 'rollback',
    });
    expect(calls.map((c) => c.name)).toEqual([
      'ps_inspect', // capture, before step 1
      'ps_ping',
      'ps_get_histogram', // fails
      'ps_inspect', // re-read to compute the rollback distance
      'ps_undo', // the actual restore
    ]);
    expect(calls.at(-1)).toEqual({ name: 'ps_undo', args: { steps: 3 } });
    const sc = res.structuredContent as { rolled_back: boolean; failed_step: unknown };
    expect(sc.rolled_back).toBe(true);
    expect(sc.failed_step).toEqual({ index: 1, tool: 'ps_get_histogram' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/rolled back|restored/);
  });

  it('on_error=rollback refuses at validation when a step sits outside history scope', async () => {
    const invoked: string[] = [];
    const invokeTool: FakeInvoke = async (name) => {
      invoked.push(name);
      return ok();
    };
    const tools = createSequenceTools(invokeTool);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'ps_ping', args: {} },
        { tool: 'ps_close_document', args: {} },
      ],
      on_error: 'rollback',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/can't be honored/);
    // Not even the history capture ran — refused at validation, before step 1.
    expect(invoked).toEqual([]);
  });

  // ---------- return modes + image stripping ----------

  it("return=summary carries a per-step summary line plus the last step's full result", async () => {
    const invokeTool: FakeInvoke = async (name) => ({
      content: [{ type: 'text' as const, text: `${name} line1\nline2` }],
      structuredContent: { tool: name },
    });
    const tools = createSequenceTools(invokeTool);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'ps_ping', args: {} },
        { tool: 'ps_undo', args: {} },
      ],
      return: 'summary',
    });
    const sc = res.structuredContent as { steps: unknown; final: ToolResult };
    expect(sc.steps).toEqual([
      {
        index: 0,
        tool: 'ps_ping',
        ok: true,
        duration_ms: expect.any(Number),
        text: 'ps_ping line1',
      },
      {
        index: 1,
        tool: 'ps_undo',
        ok: true,
        duration_ms: expect.any(Number),
        text: 'ps_undo line1',
      },
    ]);
    expect(sc.final).toEqual({
      content: [{ type: 'text', text: 'ps_undo line1\nline2' }],
      structuredContent: { tool: 'ps_undo' },
    });
  });

  it("return=full carries every step's full result", async () => {
    const invokeTool: FakeInvoke = async (name) => ok(`${name} ok`);
    const tools = createSequenceTools(invokeTool);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'ps_ping', args: {} },
        { tool: 'ps_undo', args: {} },
      ],
      return: 'full',
    });
    const sc = res.structuredContent as { steps: Array<{ result: ToolResult }>; final?: unknown };
    expect(sc.steps).toEqual([
      {
        index: 0,
        tool: 'ps_ping',
        ok: true,
        duration_ms: expect.any(Number),
        result: ok('ps_ping ok'),
      },
      {
        index: 1,
        tool: 'ps_undo',
        ok: true,
        duration_ms: expect.any(Number),
        result: ok('ps_undo ok'),
      },
    ]);
    expect(sc.final).toBeUndefined();
  });

  it('strips inline image content from every step except the last, in both return modes', async () => {
    const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/jpeg' };
    const invokeTool: FakeInvoke = async (name) => ({
      content: [{ type: 'text' as const, text: `${name} ok` }, image],
    });
    const tools = createSequenceTools(invokeTool);
    const steps = [
      { tool: 'ps_ping', args: {} },
      { tool: 'ps_undo', args: {} },
    ];

    const summaryRes = await callTool(tools, 'ps_sequence', { steps, return: 'summary' });
    const summarySc = summaryRes.structuredContent as { final: ToolResult };
    expect(summarySc.final.content).toContainEqual(image);

    const fullRes = await callTool(tools, 'ps_sequence', { steps, return: 'full' });
    const fullSc = fullRes.structuredContent as { steps: Array<{ result: ToolResult }> };
    expect(fullSc.steps[0].result.content).toEqual([{ type: 'text', text: 'ps_ping ok' }]);
    expect(fullSc.steps[1].result.content).toContainEqual(image);
  });

  // ---------- overall time budget ----------

  it('the overall time budget fires with a fake clock, stopping before the step that would have run', async () => {
    const invoked: string[] = [];
    const invokeTool: FakeInvoke = async (name) => {
      invoked.push(name);
      return ok();
    };
    // Advances 200s per call. Two checks in: 2*200s = 400s > the 300s cap.
    let t = 0;
    const now = () => {
      const v = t;
      t += 200_000;
      return v;
    };
    const tools = createSequenceTools(invokeTool, { now });
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'ps_ping', args: {} },
        { tool: 'ps_undo', args: {} },
        { tool: 'ps_redo', args: {} },
      ],
    });
    // Only the first step actually ran; the cap fired before the second.
    expect(invoked).toEqual(['ps_ping']);
    const sc = res.structuredContent as { cap_exceeded: boolean; failed_step: unknown };
    expect(sc.cap_exceeded).toBe(true);
    expect(sc.failed_step).toEqual({ index: 1, tool: 'ps_undo' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/exceeded its overall time budget/);
  });
});
