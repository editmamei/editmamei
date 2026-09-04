import { describe, it, expect } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createSequenceTools, HISTORY_UNSAFE_TOOLS } from '@editmamei/tools/sequence-tools.ts';
import { tierOf, TOOL_TIERS } from '@editmamei/core/tool-tiers.ts';
import { groupOf } from '@editmamei/core/tool-groups.ts';
import {
  getToolTimeoutMs,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  SEQUENCE_OVERALL_TIMEOUT_MS,
} from '@editmamei/utils/operation-timeouts.ts';
import { assertToolShape, callTool, textOf } from '../fixtures/tool-helpers.ts';
import type { ToolResult } from '@editmamei/core/tool-registry.ts';

// ps_sequence never talks to Photoshop itself — every step is dispatched
// through an injected invokeTool and validated through an injected hasTool,
// exactly the seams the real CE module wires to host.invokeTool / host.hasTool
// (src/modules/ce/index.ts). These tests drive both directly, never a real
// registry or connection.

type FakeInvoke = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
type HasTool = (name: string) => boolean;

/** Accepts any tool name — the injected registry-lookup stand-in for tests that don't care about it. */
const allow: HasTool = () => true;

const ok = (text = 'ok'): ToolResult => ({ content: [{ type: 'text' as const, text }] });
const fail = (text = 'boom'): ToolResult => ({
  content: [{ type: 'text' as const, text }],
  isError: true,
});

/** A ps_inspect(what='history') result shaped the way performRollback reads it. */
function historyResult(
  index: number,
  opts: { stateName?: string; total?: number; documentName?: string | null } = {}
): ToolResult {
  const { stateName = `state-${index}`, total = index + 1, documentName = 'doc.psd' } = opts;
  return {
    content: [{ type: 'text' as const, text: 'history' }],
    structuredContent: {
      currentIndex: index,
      currentState: stateName,
      totalStates: total,
      context:
        documentName === null
          ? { hasDocument: false }
          : { hasDocument: true, document: { name: documentName } },
    },
  };
}

describe('createSequenceTools', () => {
  it('returns one well-formed tool', () => {
    const tools = createSequenceTools(async () => ok(), allow);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_sequence']);
  });

  it('is registered at community tier and appears in the automation group', () => {
    expect(tierOf('ps_sequence')).toBe('community');
    expect(groupOf('ps_sequence')).toBe('automation');
  });

  it('its dispatch budget is the whole-sequence budget, not the shared default', () => {
    // Every step nests inside this one call, so the dispatch deadline bounds
    // all of them together. If it were the shared default a long sequence
    // would starve its later steps and kill one mid-script, well before the
    // between-steps budget this tool documents ever applied.
    expect(getToolTimeoutMs('ps_sequence')).toBe(SEQUENCE_OVERALL_TIMEOUT_MS);
    expect(getToolTimeoutMs('ps_sequence')).toBeGreaterThan(DEFAULT_SCRIPT_TIMEOUT_MS);
  });

  it('every HISTORY_UNSAFE_TOOLS entry names a real, currently classified tool', () => {
    // A rename in tool-tiers.ts that isn't mirrored here would otherwise
    // silently drop a guard entry with no test ever noticing.
    for (const name of HISTORY_UNSAFE_TOOLS) {
      expect(Object.keys(TOOL_TIERS), `${name} is not in TOOL_TIERS`).toContain(name);
    }
  });

  it('no HISTORY_UNSAFE_TOOLS entry is Pro-tier', () => {
    // A pro-tier name here would compile into CE dist as a string literal —
    // in the description, the validation error, and the Set itself — and
    // trip the leak guard (tests/integration/build-output.test.ts), since
    // this file ships in every edition (dev-tier gating happens at
    // registration, not at compile time). Community-only is the ceiling this
    // list can safely name; anything else is caught after the fact by
    // performRollback's document_changed/history_evicted checks instead.
    for (const name of HISTORY_UNSAFE_TOOLS) {
      expect(TOOL_TIERS[name], `${name} must not be pro-tier`).not.toBe('pro');
    }
  });

  // ---------- ordering ----------

  it('runs steps in order, each receiving exactly its own args', async () => {
    const invoked: Array<{ name: string; args: unknown }> = [];
    const invokeTool: FakeInvoke = async (name, args) => {
      invoked.push({ name, args });
      return ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'tool_b', args: { steps: 2 } },
        { tool: 'tool_c', args: { steps: 3 } },
      ],
    });
    expect(invoked).toEqual([
      { name: 'tool_a', args: {} },
      { name: 'tool_b', args: { steps: 2 } },
      { name: 'tool_c', args: { steps: 3 } },
    ]);
  });

  // ---------- validation, before any step runs ----------

  it('validation refuses a tool the injected registry lookup rejects, and runs nothing', async () => {
    const invoked: string[] = [];
    const invokeTool: FakeInvoke = async (name) => {
      invoked.push(name);
      return ok();
    };
    const hasTool: HasTool = (name) => name !== 'tool_not_registered';
    const tools = createSequenceTools(invokeTool, hasTool);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'tool_not_registered', args: {} }],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not a tool registered right now/);
    expect(invoked).toEqual([]);
  });

  it('validation refuses ps_sequence nesting itself even when the lookup would allow it', async () => {
    const invoked: string[] = [];
    const invokeTool: FakeInvoke = async (name) => {
      invoked.push(name);
      return ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'ps_sequence', args: { steps: [{ tool: 'tool_a', args: {} }] } }],
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
    const tools = createSequenceTools(invokeTool, allow);
    const tooMany = Array.from({ length: 26 }, () => ({ tool: 'tool_a', args: {} }));
    const res = await callTool(tools, 'ps_sequence', { steps: tooMany });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/must contain 1 to 25 items/);
    expect(invoked).toEqual([]);
  });

  it('rejects an invalid on_error value', async () => {
    const tools = createSequenceTools(async () => ok(), allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'tool_a', args: {} }],
      on_error: 'retry',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/on_error/);
  });

  it('rejects an invalid return value', async () => {
    const tools = createSequenceTools(async () => ok(), allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'tool_a', args: {} }],
      return: 'verbose',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/return/);
  });

  it('defaults on_error to "stop" and return to "summary" when omitted', async () => {
    const tools = createSequenceTools(async () => ok(), allow);
    const res = await callTool(tools, 'ps_sequence', { steps: [{ tool: 'tool_a', args: {} }] });
    const sc = res.structuredContent as { on_error: string; return: string };
    expect(sc.on_error).toBe('stop');
    expect(sc.return).toBe('summary');
  });

  // ---------- on_error policies ----------

  it('on_error=stop halts at the first failing step', async () => {
    const invoked: string[] = [];
    const invokeTool: FakeInvoke = async (name) => {
      invoked.push(name);
      return name === 'tool_fail' ? fail() : ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'tool_fail', args: {} },
        { tool: 'tool_c', args: {} },
      ],
      on_error: 'stop',
    });
    expect(invoked).toEqual(['tool_a', 'tool_fail']);
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { failed_step: unknown; ran_steps: number };
    expect(sc.failed_step).toEqual({ index: 1, tool: 'tool_fail' });
    expect(sc.ran_steps).toBe(2);
  });

  it('a thrown (rejected) invokeTool call reaches the synthetic error path and stops (on_error=stop)', async () => {
    const invoked: string[] = [];
    const invokeTool: FakeInvoke = async (name) => {
      invoked.push(name);
      if (name === 'tool_throws') throw new Error('kernel depth exceeded');
      return ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'tool_throws', args: {} },
        { tool: 'tool_c', args: {} },
      ],
      on_error: 'stop',
    });
    expect(invoked).toEqual(['tool_a', 'tool_throws']);
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as {
      failed_step: unknown;
      steps: Array<{ ok: boolean; text: string }>;
    };
    expect(sc.failed_step).toEqual({ index: 1, tool: 'tool_throws' });
    expect(sc.steps[1].ok).toBe(false);
    expect(sc.steps[1].text).toMatch(/kernel depth exceeded/);
  });

  it('on_error=continue records the failure and runs every remaining step', async () => {
    const invoked: string[] = [];
    const invokeTool: FakeInvoke = async (name) => {
      invoked.push(name);
      return name === 'tool_fail' ? fail() : ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'tool_fail', args: {} },
        { tool: 'tool_c', args: {} },
      ],
      on_error: 'continue',
    });
    expect(invoked).toEqual(['tool_a', 'tool_fail', 'tool_c']);
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { failed_step: unknown; ran_steps: number };
    expect(sc.failed_step).toEqual({ index: 1, tool: 'tool_fail' });
    expect(sc.ran_steps).toBe(3);
  });

  it('on_error=continue reports the FIRST failure when several steps fail', async () => {
    const invokeTool: FakeInvoke = async (name) => (name === 'tool_ok' ? ok() : fail());
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_fail_1', args: {} }, // fails first
        { tool: 'tool_ok', args: {} },
        { tool: 'tool_fail_2', args: {} }, // fails too, but should not overwrite failed_step
      ],
      on_error: 'continue',
    });
    const sc = res.structuredContent as {
      failed_step: unknown;
      steps: Array<{ index: number; ok: boolean }>;
    };
    expect(sc.failed_step).toEqual({ index: 0, tool: 'tool_fail_1' });
    expect(sc.steps.map((s) => s.ok)).toEqual([false, true, false]);
  });

  // ---------- rollback: verified restore ----------

  it('on_error=rollback verifies the restore (re-reads index, state name, and document) before reporting success', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let historyReads = 0;
    const invokeTool: FakeInvoke = async (name, args) => {
      calls.push({ name, args });
      if (name === 'ps_inspect') {
        historyReads++;
        // 1: capture (index 5). 2: pre-undo re-read (index 8, 3 edits ran).
        // 3: post-undo verification re-read (back to 5 — matches).
        if (historyReads === 1) return historyResult(5, { stateName: 'S5', total: 10 });
        if (historyReads === 2) return historyResult(8, { stateName: 'S8', total: 13 });
        return historyResult(5, { stateName: 'S5', total: 13 });
      }
      if (name === 'ps_undo') return ok('Undo successful');
      if (name === 'tool_fail') return fail();
      return ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'tool_fail', args: {} },
        { tool: 'tool_c', args: {} }, // never reached — rollback stops the loop
      ],
      on_error: 'rollback',
    });
    expect(calls.map((c) => c.name)).toEqual([
      'ps_inspect', // capture, before step 1
      'tool_a',
      'tool_fail', // fails
      'ps_inspect', // re-read to compute the rollback distance
      'ps_undo', // the actual restore
      'ps_inspect', // re-read AGAIN to verify it actually landed
    ]);
    expect(calls[4]).toEqual({ name: 'ps_undo', args: { steps: 3 } });
    const sc = res.structuredContent as {
      rolled_back: boolean;
      rollback_reason?: string;
      failed_step: unknown;
    };
    expect(sc.rolled_back).toBe(true);
    expect(sc.rollback_reason).toBeUndefined();
    expect(sc.failed_step).toEqual({ index: 1, tool: 'tool_fail' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/verified restored/);
  });

  it('on_error=rollback with no in-document edits (delta<=0) still re-verifies before reporting success', async () => {
    const calls: string[] = [];
    const invokeTool: FakeInvoke = async (name) => {
      calls.push(name);
      if (name === 'ps_inspect') return historyResult(5, { stateName: 'S5' });
      if (name === 'tool_fail') return fail();
      return ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'tool_fail', args: {} }],
      on_error: 'rollback',
    });
    // capture, the failing step, the pre-undo check, the post-check — never ps_undo.
    expect(calls).toEqual(['ps_inspect', 'tool_fail', 'ps_inspect', 'ps_inspect']);
    const sc = res.structuredContent as { rolled_back: boolean };
    expect(sc.rolled_back).toBe(true);
    expect(textOf(res)).not.toMatch(/nothing to roll back/);
    expect(textOf(res)).toMatch(/verified already at its state/);
  });

  it('on_error=rollback refuses at validation when a step sits outside history scope', async () => {
    const invoked: string[] = [];
    const invokeTool: FakeInvoke = async (name) => {
      invoked.push(name);
      return ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'ps_close_document', args: {} },
      ],
      on_error: 'rollback',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/can't be honored/);
    // Not even the history capture ran — refused at validation, before step 1.
    expect(invoked).toEqual([]);
  });

  it('on_error=rollback fails validation for ps_undo and ps_redo too, since they move the cursor rollback depends on', async () => {
    const tools = createSequenceTools(async () => ok(), allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'ps_undo', args: {} }],
      on_error: 'rollback',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/can't be honored/);
  });

  it('the pre-sequence history capture failing (invokeTool throws) refuses before any step runs', async () => {
    const invoked: string[] = [];
    const invokeTool: FakeInvoke = async (name) => {
      invoked.push(name);
      if (name === 'ps_inspect') throw new Error('Photoshop is busy');
      return ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'tool_a', args: {} }],
      on_error: 'rollback',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/capturing history state/);
    expect(invoked).toEqual(['ps_inspect']);
  });

  it('the pre-sequence history capture returning unusable data refuses before any step runs', async () => {
    const invoked: string[] = [];
    const invokeTool: FakeInvoke = async (name) => {
      invoked.push(name);
      // Missing currentState/totalStates — extractHistorySnapshot must reject this.
      if (name === 'ps_inspect') {
        return {
          content: [{ type: 'text' as const, text: 'history' }],
          structuredContent: { currentIndex: 5 },
        };
      }
      return ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'tool_a', args: {} }],
      on_error: 'rollback',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/capturing history state/);
    expect(invoked).toEqual(['ps_inspect']);
  });

  // ---------- rollback reason tokens ----------

  it('rollback_reason=undo_failed when ps_undo itself returns isError', async () => {
    let historyReads = 0;
    const invokeTool: FakeInvoke = async (name) => {
      if (name === 'ps_inspect') {
        historyReads++;
        return historyReads === 1 ? historyResult(5) : historyResult(8);
      }
      if (name === 'ps_undo') return fail('Photoshop refused the undo');
      if (name === 'tool_fail') return fail();
      return ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'tool_fail', args: {} }],
      on_error: 'rollback',
    });
    const sc = res.structuredContent as { rolled_back: boolean; rollback_reason: string };
    expect(sc.rolled_back).toBe(false);
    expect(sc.rollback_reason).toBe('undo_failed');
  });

  it('rollback_reason=cursor_moved_backward when the index is earlier than the capture', async () => {
    let historyReads = 0;
    const invokeTool: FakeInvoke = async (name) => {
      if (name === 'ps_inspect') {
        historyReads++;
        // Captured at 5; by the time we check, it's already at 3 — a step
        // must have called undo/redo on its own.
        return historyReads === 1 ? historyResult(5) : historyResult(3);
      }
      if (name === 'tool_fail') return fail();
      return ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'tool_fail', args: {} }],
      on_error: 'rollback',
    });
    const sc = res.structuredContent as { rolled_back: boolean; rollback_reason: string };
    expect(sc.rolled_back).toBe(false);
    expect(sc.rollback_reason).toBe('cursor_moved_backward');
  });

  it('rollback_reason=document_changed when the active document differs from the capture', async () => {
    let historyReads = 0;
    const invokeTool: FakeInvoke = async (name) => {
      if (name === 'ps_inspect') {
        historyReads++;
        return historyReads === 1
          ? historyResult(5, { documentName: 'A.psd' })
          : historyResult(5, { documentName: 'B.psd' });
      }
      if (name === 'tool_fail') return fail();
      return ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'tool_fail', args: {} }],
      on_error: 'rollback',
    });
    const sc = res.structuredContent as { rolled_back: boolean; rollback_reason: string };
    expect(sc.rolled_back).toBe(false);
    expect(sc.rollback_reason).toBe('document_changed');
  });

  it('rollback_reason=history_evicted when the verification re-read does not match the capture', async () => {
    let historyReads = 0;
    const invokeTool: FakeInvoke = async (name) => {
      if (name === 'ps_inspect') {
        historyReads++;
        if (historyReads === 1) return historyResult(5, { stateName: 'S5', total: 10 });
        if (historyReads === 2) return historyResult(8, { stateName: 'S8', total: 13 });
        // Post-undo: ps_undo claimed success, but the buffer evicted state 5 —
        // the cursor landed somewhere that is neither the right index nor name.
        return historyResult(6, { stateName: 'S-evicted', total: 13 });
      }
      if (name === 'ps_undo') return ok('Undo successful'); // clamps/lies — see doc comment
      if (name === 'tool_fail') return fail();
      return ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'tool_fail', args: {} }],
      on_error: 'rollback',
    });
    const sc = res.structuredContent as { rolled_back: boolean; rollback_reason: string };
    expect(sc.rolled_back).toBe(false);
    expect(sc.rollback_reason).toBe('history_evicted');
    expect(textOf(res)).toMatch(/rollback did not complete/);
  });

  it("rollback_reason=undo_failed when performRollback's first read (before undoing) is unusable", async () => {
    let historyReads = 0;
    const invokeTool: FakeInvoke = async (name) => {
      if (name === 'ps_inspect') {
        historyReads++;
        if (historyReads === 1) return historyResult(5); // capture succeeds
        return { content: [{ type: 'text' as const, text: 'history' }] }; // performRollback's own read fails
      }
      if (name === 'tool_fail') return fail();
      return ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'tool_fail', args: {} }],
      on_error: 'rollback',
    });
    const sc = res.structuredContent as { rolled_back: boolean; rollback_reason: string };
    expect(sc.rolled_back).toBe(false);
    expect(sc.rollback_reason).toBe('undo_failed');
    expect(textOf(res)).toMatch(/rollback did not complete/);
  });

  it("rollback_reason=undo_failed when performRollback's second read (after undoing) is unusable", async () => {
    let historyReads = 0;
    const invokeTool: FakeInvoke = async (name) => {
      if (name === 'ps_inspect') {
        historyReads++;
        if (historyReads === 1) return historyResult(5); // capture
        if (historyReads === 2) return historyResult(8); // pre-undo read, delta=3
        // Post-undo verification read comes back unusable.
        return { content: [{ type: 'text' as const, text: 'history' }] };
      }
      if (name === 'ps_undo') return ok('Undo successful');
      if (name === 'tool_fail') return fail();
      return ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'tool_fail', args: {} }],
      on_error: 'rollback',
    });
    const sc = res.structuredContent as { rolled_back: boolean; rollback_reason: string };
    expect(sc.rolled_back).toBe(false);
    expect(sc.rollback_reason).toBe('undo_failed');
  });

  it('on_error=rollback also runs performRollback from the time-budget branch, and the message reports both the cap and the rollback', async () => {
    let historyReads = 0;
    const invokeTool: FakeInvoke = async (name) => {
      if (name === 'ps_inspect') {
        historyReads++;
        // 1: capture (index 5, 1 edit already happened from tool_a).
        // 2: pre-undo re-read after the cap fires (index 6).
        // 3: post-undo verification re-read (back to 5 — matches).
        if (historyReads === 1) return historyResult(5, { stateName: 'S5', total: 10 });
        if (historyReads === 2) return historyResult(6, { stateName: 'S6', total: 11 });
        return historyResult(5, { stateName: 'S5', total: 11 });
      }
      if (name === 'ps_undo') return ok('Undo successful');
      return ok();
    };
    let t = 0;
    const now = () => {
      const v = t;
      t += 200_000;
      return v;
    };
    const tools = createSequenceTools(invokeTool, allow, { now });
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'tool_b', args: {} }, // cap fires before this one runs
        { tool: 'tool_c', args: {} },
      ],
      on_error: 'rollback',
    });
    const sc = res.structuredContent as {
      cap_exceeded: boolean;
      rolled_back: boolean;
      failed_step: unknown;
    };
    expect(sc.cap_exceeded).toBe(true);
    expect(sc.rolled_back).toBe(true);
    expect(sc.failed_step).toEqual({ index: 1, tool: 'tool_b' });
    // buildMessage's capExceeded-and-rolledBack arm names both the cap AND the rollback.
    expect(textOf(res)).toMatch(/exceeded its overall time budget/);
    expect(textOf(res)).toMatch(/Document rolled back/);
  });

  // ---------- return modes + image stripping ----------

  it("return=summary carries a per-step summary line plus the last step's full result", async () => {
    const invokeTool: FakeInvoke = async (name) => ({
      content: [{ type: 'text' as const, text: `${name} line1\nline2` }],
      structuredContent: { tool: name },
    });
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'tool_b', args: {} },
      ],
      return: 'summary',
    });
    const sc = res.structuredContent as { steps: unknown; final: ToolResult };
    expect(sc.steps).toEqual([
      { index: 0, tool: 'tool_a', ok: true, duration_ms: expect.any(Number), text: 'tool_a line1' },
      { index: 1, tool: 'tool_b', ok: true, duration_ms: expect.any(Number), text: 'tool_b line1' },
    ]);
    expect(sc.final).toEqual({
      content: [{ type: 'text', text: 'tool_b line1\nline2' }],
      structuredContent: { tool: 'tool_b' },
    });
  });

  it("return=full carries every step's full result", async () => {
    const invokeTool: FakeInvoke = async (name) => ok(`${name} ok`);
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'tool_b', args: {} },
      ],
      return: 'full',
    });
    const sc = res.structuredContent as { steps: Array<{ result: ToolResult }>; final?: unknown };
    expect(sc.steps).toEqual([
      {
        index: 0,
        tool: 'tool_a',
        ok: true,
        duration_ms: expect.any(Number),
        result: ok('tool_a ok'),
      },
      {
        index: 1,
        tool: 'tool_b',
        ok: true,
        duration_ms: expect.any(Number),
        result: ok('tool_b ok'),
      },
    ]);
    expect(sc.final).toBeUndefined();
  });

  it('return=full strips inline image content from every step except the last', async () => {
    const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/jpeg' };
    const invokeTool: FakeInvoke = async (name) => ({
      content: [{ type: 'text' as const, text: `${name} ok` }, image],
    });
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'tool_b', args: {} },
      ],
      return: 'full',
    });
    const sc = res.structuredContent as { steps: Array<{ result: ToolResult }> };
    expect(sc.steps[0].result.content).toEqual([{ type: 'text', text: 'tool_a ok' }]);
    expect(sc.steps[1].result.content).toContainEqual(image);
  });

  it('return=summary never leaks image data through the per-step text line, and keeps it on the final result', async () => {
    const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/jpeg' };
    const invokeTool: FakeInvoke = async (name) => ({
      content: [{ type: 'text' as const, text: `${name} ok` }, image],
    });
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'tool_b', args: {} },
      ],
      return: 'summary',
    });
    const sc = res.structuredContent as {
      steps: Array<{ text: string }>;
      final: ToolResult;
    };
    // Every non-last step reduces to a plain text line — there is no field an
    // image could ride on, which is what makes summary mode safe by
    // construction rather than by an explicit strip.
    expect(sc.steps[0].text).toBe('tool_a ok');
    expect(JSON.stringify(sc.steps[0])).not.toContain('AAAA');
    expect(sc.final.content).toContainEqual(image);
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
    const tools = createSequenceTools(invokeTool, allow, { now });
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'tool_b', args: {} },
        { tool: 'tool_c', args: {} },
      ],
    });
    // Only the first step actually ran; the cap fired before the second.
    expect(invoked).toEqual(['tool_a']);
    const sc = res.structuredContent as {
      cap_exceeded: boolean;
      failed_step: unknown;
      ran_steps: number;
    };
    expect(sc.cap_exceeded).toBe(true);
    expect(sc.failed_step).toEqual({ index: 1, tool: 'tool_b' });
    // The never-run synthetic cap entry must not count as a step that ran.
    expect(sc.ran_steps).toBe(1);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/exceeded its overall time budget/);
  });

  it("a time-budget abort makes `final` the last REAL step's result, not the synthetic cap stub, and keeps its image", async () => {
    const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/jpeg' };
    const invokeTool: FakeInvoke = async (name) => ({
      content: [{ type: 'text' as const, text: `${name} ok` }, image],
    });
    let t = 0;
    const now = () => {
      const v = t;
      t += 200_000;
      return v;
    };
    const tools = createSequenceTools(invokeTool, allow, { now });
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'tool_b', args: {} },
      ],
      return: 'summary',
    });
    const sc = res.structuredContent as { cap_exceeded: boolean; final: ToolResult };
    expect(sc.cap_exceeded).toBe(true);
    // `final` is tool_a's result (the last one that actually ran) — not the
    // "budget exceeded" stub for the never-run tool_b — and still carries the
    // image, since it's the real last step, not the synthetic one.
    expect(sc.final.content).toEqual([{ type: 'text', text: 'tool_a ok' }, image]);
    // The cap notice still surfaces in the text and status fields.
    expect(textOf(res)).toMatch(/exceeded its overall time budget/);
  });
});

/**
 * A tool's outputSchema is not documentation-only: an MCP client validates
 * every structuredContent it gets back against it (Ajv, via
 * AjvJsonSchemaValidator — @modelcontextprotocol/sdk/client/index.js
 * callTool()). A schema that no real call output can satisfy — the `oneOf`
 * that caused HIGH 2 — fails every call at the CLIENT, not in this repo's own
 * tests, so this exercises the exact validator a real client uses against the
 * exact shapes runSequence produces.
 */
describe('ps_sequence outputSchema validates its own structuredContent (the same Ajv path an MCP client uses)', () => {
  const ajvValidator = new AjvJsonSchemaValidator();

  function assertValidAgainstOwnSchema(
    tools: ReturnType<typeof createSequenceTools>,
    structuredContent: unknown
  ): void {
    const schema = tools[0].tool.outputSchema as Record<string, unknown>;
    const check = ajvValidator.getValidator(schema);
    const result = check(structuredContent);
    expect(result.valid, result.errorMessage).toBe(true);
  }

  it('summary success validates', async () => {
    const invokeTool: FakeInvoke = async (name) => ok(`${name} ok`);
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'tool_b', args: {} },
      ],
      return: 'summary',
    });
    assertValidAgainstOwnSchema(tools, res.structuredContent);
  });

  it('full success validates', async () => {
    const invokeTool: FakeInvoke = async (name) => ok(`${name} ok`);
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'tool_b', args: {} },
      ],
      return: 'full',
    });
    assertValidAgainstOwnSchema(tools, res.structuredContent);
  });

  it('stop-on-error with a failed step validates', async () => {
    const invokeTool: FakeInvoke = async (name) => (name === 'tool_fail' ? fail() : ok());
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'tool_fail', args: {} },
      ],
      on_error: 'stop',
    });
    assertValidAgainstOwnSchema(tools, res.structuredContent);
  });

  it('a failed rollback with a rollback_reason validates', async () => {
    let historyReads = 0;
    const invokeTool: FakeInvoke = async (name) => {
      if (name === 'ps_inspect') {
        historyReads++;
        if (historyReads === 1) return historyResult(5, { stateName: 'S5', total: 10 });
        if (historyReads === 2) return historyResult(8, { stateName: 'S8', total: 13 });
        return historyResult(6, { stateName: 'S-evicted', total: 13 });
      }
      if (name === 'ps_undo') return ok('Undo successful');
      if (name === 'tool_fail') return fail();
      return ok();
    };
    const tools = createSequenceTools(invokeTool, allow);
    const res = await callTool(tools, 'ps_sequence', {
      steps: [{ tool: 'tool_fail', args: {} }],
      on_error: 'rollback',
    });
    const sc = res.structuredContent as { rolled_back: boolean; rollback_reason: string };
    expect(sc.rolled_back).toBe(false);
    expect(sc.rollback_reason).toBe('history_evicted');
    assertValidAgainstOwnSchema(tools, res.structuredContent);
  });

  it('a time-budget abort validates', async () => {
    const invokeTool: FakeInvoke = async () => ok();
    let t = 0;
    const now = () => {
      const v = t;
      t += 200_000;
      return v;
    };
    const tools = createSequenceTools(invokeTool, allow, { now });
    const res = await callTool(tools, 'ps_sequence', {
      steps: [
        { tool: 'tool_a', args: {} },
        { tool: 'tool_b', args: {} },
        { tool: 'tool_c', args: {} },
      ],
    });
    assertValidAgainstOwnSchema(tools, res.structuredContent);
  });
});
