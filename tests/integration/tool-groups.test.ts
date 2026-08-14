import { describe, it, expect } from 'vitest';
import { EditmameiServer } from '@editmamei/core/server.ts';
import { TOOL_TIERS } from '@editmamei/core/tool-tiers.ts';
import {
  TOOL_GROUPS,
  GROUPS,
  groupOf,
  toolsInGroup,
  type ToolGroup,
} from '@editmamei/core/tool-groups.ts';
import { useSessionLogSandbox } from '../fixtures/session-log-sandbox.ts';

// Every `new EditmameiServer()` below builds its own SessionLog with no `dir`
// override — redirect it to a per-test temp dir so this file's constructions
// never write real NDJSON into the user's ~/.editmamei/sessions/.
useSessionLogSandbox();

/**
 * Pins the contract between the live tool surface and the capability-group
 * classification. Groups are the companion axis to tiers: every registered
 * tool must be grouped (the boot assertion enforces it), and the group map
 * must not carry orphan entries. The strongest invariant — and the cheapest
 * to check — is that TOOL_GROUPS and TOOL_TIERS cover EXACTLY the same set of
 * tool names, since every registered tool must appear in both.
 */
describe('TOOL_GROUPS classification table', () => {
  it('covers exactly the same tools as TOOL_TIERS', () => {
    const groupNames = Object.keys(TOOL_GROUPS).sort();
    const tierNames = Object.keys(TOOL_TIERS).sort();
    const missingGroup = tierNames.filter((n) => !(n in TOOL_GROUPS));
    const orphanGroup = groupNames.filter((n) => !(n in TOOL_TIERS));
    expect(missingGroup, `Tiered tools missing a group: ${missingGroup.join(', ')}`).toEqual([]);
    expect(orphanGroup, `Grouped names not in TOOL_TIERS: ${orphanGroup.join(', ')}`).toEqual([]);
  });

  it('groups every registered tool (CE built-in + Pro module)', async () => {
    const server = new EditmameiServer() as unknown as {
      toolRegistry: { list(): Array<{ name: string }> };
      loadModules(): Promise<void>;
    };
    await server.loadModules();
    const registered = server.toolRegistry.list().map((t) => t.name);
    const missing = registered.filter((name) => !(name in TOOL_GROUPS));
    expect(missing, `Registered tools missing a group: ${missing.join(', ')}`).toEqual([]);
  });

  it('assigns every tool a valid group id from the GROUPS catalog', () => {
    const catalog = new Set(Object.keys(GROUPS));
    for (const [name, group] of Object.entries(TOOL_GROUPS)) {
      expect(catalog, `${name} → unknown group "${group}"`).toContain(group);
    }
  });

  it('has no empty groups (every catalog entry is used by at least one tool)', () => {
    for (const id of Object.keys(GROUPS) as ToolGroup[]) {
      expect(toolsInGroup(id).length, `group "${id}" has no tools`).toBeGreaterThan(0);
    }
  });

  it('GROUPS catalog ids are self-consistent (key === info.id)', () => {
    for (const [id, info] of Object.entries(GROUPS)) {
      expect(info.id).toBe(id);
    }
  });

  it('groupOf throws for unknown tool names', () => {
    expect(() => groupOf('photoshop_definitely_not_a_real_tool')).toThrow(
      /no entry in src\/core\/tool-groups\.ts/
    );
  });

  it('groupOf returns the matching group for known tools', () => {
    expect(groupOf('ps_ping')).toBe('core');
    expect(groupOf('ps_get_histogram')).toBe('verify');
    expect(groupOf('ps_filter')).toBe('filter');
  });
});

/**
 * Pins the merge of the former standalone Smart-Filter tool into ps_filter
 * (2026-08-09): the retired name must be gone everywhere a tool could be
 * registered, not just renamed in one spot while a stale registration
 * lingers elsewhere. The retired name is intentionally the ONE literal
 * occurrence excepted from this repo's zero-remaining-references check for
 * that tool name (see the ps_filter consolidation brief) — a negative
 * assertion has no way to name what it's asserting the absence of without
 * spelling it out.
 */
describe('retired Smart-Filter tool merge into ps_filter', () => {
  it('registers ps_filter and never registers the retired standalone tool', async () => {
    const server = new EditmameiServer() as unknown as {
      toolRegistry: { list(): Array<{ name: string }> };
      loadModules(): Promise<void>;
    };
    await server.loadModules();
    const registered = server.toolRegistry.list().map((t) => t.name);
    const retiredToolName = 'ps_smart_filter'; // merged into ps_filter 2026-08-09
    expect(registered).toContain('ps_filter');
    expect(registered).not.toContain(retiredToolName);
  });
});
