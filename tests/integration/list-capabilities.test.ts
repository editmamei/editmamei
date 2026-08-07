import { describe, it, expect } from 'vitest';
import { EditmameiServer } from '@editmamei/core/server.ts';
import { groupOf } from '@editmamei/core/tool-groups.ts';
import { useSessionLogSandbox } from '../fixtures/session-log-sandbox.ts';

// Every `new EditmameiServer()` below builds its own SessionLog with no `dir`
// override, and several tests here dispatch real tool calls via
// toolRegistry.execute() (which fires the onCall → sessionLog.append() hook) —
// redirect it to a per-test temp dir so this file never writes real NDJSON into
// the user's ~/.editmamei/sessions/.
useSessionLogSandbox();

/**
 * ps_list_capabilities — the read-only live capability map (group purpose
 * + the tool names in each group, for this build/edition). Pure server-state, no
 * Photoshop. Exercised against a real EditmameiServer without a transport.
 */
interface Internals {
  toolRegistry: {
    list(): Array<{ name: string }>;
    execute(
      name: string,
      args: Record<string, unknown>
    ): Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }>;
  };
}

function makeServer(): Internals {
  return new EditmameiServer() as unknown as Internals;
}

describe('ps_list_capabilities', () => {
  it('is registered and returns a grouped, name-level map of the live surface', async () => {
    const s = makeServer();
    const res = await s.toolRegistry.execute('ps_list_capabilities', {});
    expect(res.isError).toBeFalsy();

    const sc = res.structuredContent as {
      tool_count: number;
      group_count: number;
      groups: Array<{ id: string; label: string; purpose: string; tools: string[] }>;
    };

    // Counts agree with the live registry.
    expect(sc.tool_count).toBe(s.toolRegistry.list().length);
    expect(sc.group_count).toBe(sc.groups.length);

    // Every group reported is non-empty and carries names + purpose.
    for (const g of sc.groups) {
      expect(g.tools.length).toBeGreaterThan(0);
      expect(g.purpose).toBeTruthy();
    }

    // The flattened names equal the registered set, each filed under its own group.
    const flat = sc.groups.flatMap((g) => g.tools).sort();
    const registered = s.toolRegistry
      .list()
      .map((t) => t.name)
      .sort();
    expect(flat).toEqual(registered);
    for (const g of sc.groups) {
      for (const name of g.tools) {
        expect(groupOf(name)).toBe(g.id);
      }
    }

    // It lists itself (it's a registered, grouped tool) and a known core tool.
    expect(flat).toContain('ps_list_capabilities');
    expect(flat).toContain('ps_ping');
  });

  it('declares read-only + idempotent and an empty input schema', () => {
    const s = makeServer() as unknown as {
      toolRegistry: { list(): Array<Record<string, unknown>> };
    };
    const def = s.toolRegistry.list().find((t) => t.name === 'ps_list_capabilities') as
      | {
          annotations?: Record<string, unknown>;
          inputSchema?: { properties?: Record<string, unknown> };
        }
      | undefined;
    expect(def).toBeDefined();
    expect(def!.annotations?.readOnlyHint).toBe(true);
    expect(def!.annotations?.idempotentHint).toBe(true);
    expect(Object.keys(def!.inputSchema?.properties ?? {})).toEqual([]);
  });
});
