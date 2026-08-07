import { describe, it, expect } from 'vitest';
import { createOverviewTools } from '@editmamei/tools/overview-tools.ts';
import { makeConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient } from '../fixtures/fake-snippet-client.ts';

describe('createOverviewTools (2026-06-02)', () => {
  it('returns exactly 1 well-formed tool', () => {
    const tools = createOverviewTools(makeConnection().asConnection(), makeSnippetClient());
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_overview']);
  });

  it('ps_overview is read-only / idempotent / does NOT call Photoshop', async () => {
    const conn = makeConnection();
    const tools = createOverviewTools(conn.asConnection(), makeSnippetClient());
    const overview = tools.find((t) => t.tool.name === 'ps_overview')!;

    // Annotations must signal the tool is safe.
    expect(overview.tool.annotations?.readOnlyHint).toBe(true);
    expect(overview.tool.annotations?.idempotentHint).toBe(true);

    await callTool(tools, 'ps_overview', {});

    // The defining property of this tool — it returns static markdown
    // WITHOUT going through Photoshop. If a future change accidentally
    // wires it through runScript, the fake connection will record a
    // script and this assertion fires.
    expect(conn.executions).toHaveLength(0);
  });

  it('text content contains every required section header for the workflow brief', async () => {
    const tools = createOverviewTools(makeConnection().asConnection(), makeSnippetClient());
    const result = await callTool(tools, 'ps_overview', {});
    const text = (result.content?.[0] as { text: string }).text;

    // The workflow contract sections. If a future content edit drops one,
    // this test surfaces the drift. Section headers were updated 2026-06-08
    // when the overview went tier-agnostic — the old "escape hatch policy"
    // became the generic "When typed tools aren't enough" since the policy
    // doesn't name a specific tool anymore.
    const required = [
      '## The workflow contract',
      '## Capabilities map',
      '## The verification primitives',
      "## When typed tools aren't enough",
      '## Known gaps',
    ];
    for (const section of required) {
      expect(text, `missing section: ${section}`).toContain(section);
    }
  });

  it('names the discovery primitives and the underused verification primitives', async () => {
    // Two load-bearing invariants for the tier-agnostic overview
    // (adopted 2026-06-08):
    // (1) The discovery chain (ping → this overview → tools/list) must
    //     be explicit so the LLM has a repeatable session-start
    //     orientation. The chain is what makes inventory discovery
    //     consistent across sessions.
    // (2) Verification primitives — the zero-call tools in the 2026-06-02
    //     usage analysis (compare_regions, get_histogram) — must still
    //     be named so the LLM finds them when planning a check step.
    const tools = createOverviewTools(makeConnection().asConnection(), makeSnippetClient());
    const result = await callTool(tools, 'ps_overview', {});
    const text = (result.content?.[0] as { text: string }).text;

    // Discovery chain.
    expect(text).toContain('ps_ping');
    expect(text).toContain('tools/list');

    // Verification primitives — the underused part of the surface.
    expect(text).toContain('ps_get_layer_bounds_diff');
    expect(text).toContain('ps_compare_regions');
    expect(text).toContain('ps_get_histogram');

    // The "When typed tools aren't enough" section must still name
    // the common false reaches as compositional examples. Cross-line
    // regexes use [\s\S]*? to tolerate the markdown line breaks.
    // Note: the escape-hatch tool itself is no longer named (it's
    // Pro-tier — leaks if mentioned in CE-facing overview).
    expect(text).toMatch(/ps_layer_mask[\s\S]*?does this automatically/i);
    expect(text).toMatch(/center_on_x[\s\S]*?center_on_y/);
  });

  it('structuredContent surfaces section headings + bytes for clients that want a TOC', async () => {
    const tools = createOverviewTools(makeConnection().asConnection(), makeSnippetClient());
    const result = await callTool(tools, 'ps_overview', {});
    const sc = result.structuredContent as { sections: string[]; bytes: number };

    expect(Array.isArray(sc.sections)).toBe(true);
    expect(sc.sections.length).toBeGreaterThanOrEqual(5);
    expect(sc.bytes).toBeGreaterThan(0);
    // Sanity: bytes matches the actual markdown length.
    const text = (result.content?.[0] as { text: string }).text;
    expect(sc.bytes).toBe(text.length);
  });

  it('brief stays under 10 KB (so the LLM does not have to skim)', async () => {
    // Soft ceiling — if the content grows past this, split into a
    // sub-tool or trim. The aspirational target in overview-tools.ts
    // is ~6 KB; today's body is ~8 KB (the AM-event verification status
    // section was added later). The 10 KB ceiling leaves
    // headroom for one more round of additions before the test starts
    // flagging drift. At the ceiling, the right move is to split the
    // verification-status section into a separate `photoshop_overview_filters`
    // sub-tool rather than letting the main brief sprawl.
    const tools = createOverviewTools(makeConnection().asConnection(), makeSnippetClient());
    const result = await callTool(tools, 'ps_overview', {});
    const text = (result.content?.[0] as { text: string }).text;
    expect(text.length).toBeLessThan(10 * 1024);
  });

  it('description nudges the LLM to call this FIRST on open-ended tasks', () => {
    const tools = createOverviewTools(makeConnection().asConnection(), makeSnippetClient());
    const overview = tools.find((t) => t.tool.name === 'ps_overview')!;
    const desc = overview.tool.description ?? '';
    // The READ THIS FIRST signal — the corpus + memory established
    // 2026-06-02 that the LLM was over-reaching for execute_script
    // because it lacked a meta-orientation pass. This phrasing is the
    // discovery cue.
    expect(desc).toMatch(/READ THIS FIRST/i);
    expect(desc).toMatch(/open-ended/i);
  });
});
