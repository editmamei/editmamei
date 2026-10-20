/**
 * ps_replace_sky — Photoshop's Sky Replacement (Adobe Sensei).
 *
 * These unit tests pin the TS→snippet (name, params) forwarding contract only.
 * They cannot catch a descriptor that Photoshop rejects, so they are necessary
 * and NOT sufficient.
 *
 * Live status (PS 27.2.0 / Windows): the generated snippet composited a sky
 * end-to-end on 2026-08-16 — the group and its four layers materialised and the
 * supplied image rendered. The load-bearing behaviour comes from the 08-15
 * descriptor replay: an arbitrary `sky_file` path drives the composite even when
 * the preset GUID identifies nothing installed. Caveat carried in vault.go — the
 * successful run predates removing the lighting-mode parameter, which only
 * hardcodes a field Photoshop ignores. Tool ships at dev tier.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { createSkyTools } from '@editmamei/tools/sky-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import { setPathPlatformForTests } from '@editmamei/utils/local-path.ts';

// Written with Windows paths: apply Windows path rules on every runner.
beforeAll(() => setPathPlatformForTests('win32'));
afterAll(() => setPathPlatformForTests(undefined));

const SKY = 'C:\\skies\\dramatic-sunset.jpg';

describe('createSkyTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection({
      result: {
        replaced: true,
        strategy_used: 'executeAction:skyReplacement',
        group_name: 'Sky Replacement Group',
        group_layers: ['Sky', 'Edge Lighting Group', 'Foreground Lighting', 'Foreground Color'],
        sky_file: SKY,
        sky_name: 'Custom Sky',
      },
    });
    snippetClient = makeSnippetClient();
  });

  it('exposes a single well-formed tool named ps_replace_sky', () => {
    const tools = createSkyTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_replace_sky']);
  });

  it('requires nothing: a built-in sky by name, a file, or the default', () => {
    const tools = createSkyTools(conn.asConnection(), snippetClient);
    const schema = tools[0].tool.inputSchema as unknown as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required ?? []).toEqual([]);
    expect(schema.properties.sky).toBeDefined();
    expect(schema.properties.sky_file).toBeDefined();
  });

  // Removal guard, 2026-08-16: Photoshop IGNORES the descriptor's lightingMode
  // field — 'Scrn' and 'Mltp' with everything else identical rendered
  // byte-identically. Exposing it would be a control that silently does
  // nothing, so it must stay off the surface.
  it('does not expose lighting_mode — Photoshop ignores it', () => {
    const tools = createSkyTools(conn.asConnection(), snippetClient);
    const schema = tools[0].tool.inputSchema as unknown as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties.lighting_mode).toBeUndefined();
  });

  it('never forwards a lightingMode param to the snippet', async () => {
    const tools = createSkyTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_replace_sky', { sky_file: SKY });
    expect(snippetClient.lastBuild().params.lightingMode).toBeUndefined();
  });

  it('forwards the sky path to the replaceSky snippet', async () => {
    const tools = createSkyTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_replace_sky', { sky_file: SKY });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('replaceSky');
    expect(build.params.skyPath).toBe(SKY);
  });

  it('refuses a sky file on a network share before building a script', async () => {
    const tools = createSkyTools(conn.asConnection(), snippetClient);
    const res = await callTool(tools, 'ps_replace_sky', {
      sky_file: String.raw`\\attacker.example\share\sky.jpg`,
    });
    expect(res.isError).toBe(true);
    expect(snippetClient.allBuilds()).toEqual([]);
  });

  it('forwards a 120s timeout to the executor', async () => {
    const tools = createSkyTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_replace_sky', { sky_file: SKY });
    expect(conn.lastTimeout()).toBe(120000);
  });

  it('applies the captured Photoshop defaults when only sky_file is given', async () => {
    const tools = createSkyTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_replace_sky', { sky_file: SKY });
    const { params } = snippetClient.lastBuild();
    expect(params.shiftEdge).toBe(0);
    expect(params.borderSmoothness).toBe(50);
    expect(params.brightness).toBe(0);
    expect(params.temperature).toBe(0);
    expect(params.harmonizationOpacity).toBe(35);
    expect(params.foregroundLightingOpacity).toBe(78);
    expect(params.edgeLightingOpacity).toBe(70);
    expect(params.skyName).toBe('Custom Sky');
  });

  it('forwards every tuning parameter when supplied', async () => {
    const tools = createSkyTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_replace_sky', {
      sky_file: SKY,
      sky_name: 'Storm Front',
      shift_edge: -12,
      border_smoothness: 80,
      brightness: 15,
      temperature: -20,
      harmonization_opacity: 60,
      foreground_lighting_opacity: 40,
      edge_lighting_opacity: 25,
    });
    const { params } = snippetClient.lastBuild();
    expect(params.skyName).toBe('Storm Front');
    expect(params.shiftEdge).toBe(-12);
    expect(params.borderSmoothness).toBe(80);
    expect(params.brightness).toBe(15);
    expect(params.temperature).toBe(-20);
    expect(params.harmonizationOpacity).toBe(60);
    expect(params.foregroundLightingOpacity).toBe(40);
    expect(params.edgeLightingOpacity).toBe(25);
  });

  // Idnt does not choose the sky (sky_file does), but both verified-working
  // live calls carried a non-empty GUID, so we send one rather than betting on
  // an untested empty value. The placeholder is all-zero on purpose: it names
  // no installed preset, so it never claims something we cannot back up.
  it('sends a non-empty placeholder GUID that names no real preset', async () => {
    const tools = createSkyTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_replace_sky', { sky_file: SKY });
    const { skyId } = snippetClient.lastBuild().params as { skyId: string };
    expect(skyId).not.toBe('');
    expect(skyId).toBe('00000000-0000-0000-0000-000000000000');
  });

  // ---------- rejection + failure paths ----------

  // ---------- built-in skies by name ----------
  // Claude used to need folder access to find a sky: the built-ins sit under GUID file names in
  // Photoshop's settings folder. The server now resolves a name itself.

  const PRESETS = [
    { name: 'Blue Sky 000 by Rick Mandia', file: 'C:\\ps\\Sky_Presets\\e1ec.jpg' },
    { name: 'Blue Sky 001 by Photoshop', file: 'C:\\ps\\Sky_Presets\\d36f.jpg' },
    { name: 'Spectacular 004 by Russell Brown', file: 'C:\\ps\\Sky_Presets\\5a68.jpg' },
  ];
  const withPresets = (list = PRESETS) =>
    createSkyTools(conn.asConnection(), snippetClient, { presets: () => list });

  it('resolves a built-in sky by name to its image and labels the operation with it', async () => {
    const res = await callTool(withPresets(), 'ps_replace_sky', { sky: 'Spectacular 4' });
    expect(res.isError).toBeFalsy();
    const { params } = snippetClient.lastBuild();
    expect(params.skyPath).toBe('C:\\ps\\Sky_Presets\\5a68.jpg');
    expect(params.skyName).toBe('Spectacular 004 by Russell Brown');
    expect(JSON.stringify(res.content)).toContain('Spectacular 004 by Russell Brown');
  });

  it("uses Photoshop's own blue sky when neither sky nor sky_file is given", async () => {
    const res = await callTool(withPresets(), 'ps_replace_sky', {});
    expect(res.isError).toBeFalsy();
    expect(snippetClient.lastBuild().params.skyPath).toBe('C:\\ps\\Sky_Presets\\d36f.jpg');
  });

  // In the 2026-10-20 recordings Claude found the skies by passing names it knew were wrong
  // ("Sunset Sky 999", "list"): each cost a failed call and an approval. "list" now just answers.
  it('lists the installed skies for sky "list" without building or running anything', async () => {
    const res = await callTool(withPresets(), 'ps_replace_sky', { sky: ' List ' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({
      replaced: false,
      skies: PRESETS.map((p) => p.name),
    });
    expect(JSON.stringify(res.content)).toContain('Spectacular 004 by Russell Brown');
    expect(snippetClient.allBuilds()).toEqual([]);
    expect(conn.allScripts()).toEqual([]);
  });

  it('says how to proceed when listing finds no presets', async () => {
    const res = await callTool(withPresets([]), 'ps_replace_sky', { sky: 'list' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ replaced: false, skies: [] });
    expect(JSON.stringify(res.content)).toContain('sky_file');
  });

  it('treats a blank sky name as no name', async () => {
    const res = await callTool(withPresets(), 'ps_replace_sky', { sky: '  ' });
    expect(res.isError).toBeFalsy();
    expect(snippetClient.lastBuild().params.skyPath).toBe('C:\\ps\\Sky_Presets\\d36f.jpg');
  });

  it('words the result by where the sky came from, not by its label', async () => {
    // A user-saved preset may be called "Custom Sky", the same label a sky_file gets.
    const tools = withPresets([{ name: 'Custom Sky', file: 'C:\\ps\\Sky_Presets\\abcd.jpg' }]);
    const preset = await callTool(tools, 'ps_replace_sky', { sky: 'Custom Sky' });
    expect(JSON.stringify(preset.content)).toContain('built-in sky \\"Custom Sky\\"');
    const file = await callTool(tools, 'ps_replace_sky', { sky_file: SKY });
    expect(JSON.stringify(file.content)).toContain('dramatic-sunset.jpg');
  });

  it('lets sky_file win over sky, and keeps its path checks', async () => {
    await callTool(withPresets(), 'ps_replace_sky', { sky: 'Spectacular 4', sky_file: SKY });
    expect(snippetClient.lastBuild().params.skyPath).toBe(SKY);
    expect(snippetClient.lastBuild().params.skyName).toBe('Custom Sky');
    const unc = await callTool(withPresets(), 'ps_replace_sky', {
      sky: 'Spectacular 4',
      sky_file: String.raw`\\attacker.example\share\sky.jpg`,
    });
    expect(unc.isError).toBe(true);
  });

  it('keeps an explicit sky_name over the built-in label', async () => {
    await callTool(withPresets(), 'ps_replace_sky', { sky: 'Blue Sky 0', sky_name: 'Morning' });
    expect(snippetClient.lastBuild().params.skyName).toBe('Morning');
  });

  it('lists the installed skies when a name matches none, without running anything', async () => {
    const res = await callTool(withPresets(), 'ps_replace_sky', { sky: 'Storm 9' });
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain('Storm 9');
    expect(text).toContain('Blue Sky 001 by Photoshop');
    expect(snippetClient.allBuilds()).toEqual([]);
  });

  it('points at sky_file when this machine has no sky presets', async () => {
    const res = await callTool(withPresets([]), 'ps_replace_sky', {});
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('sky_file');
    expect(snippetClient.allBuilds()).toEqual([]);
  });

  it('rejects out-of-range tuning values', async () => {
    const tools = createSkyTools(conn.asConnection(), snippetClient);
    expect(
      (await callTool(tools, 'ps_replace_sky', { sky_file: SKY, harmonization_opacity: 200 }))
        .isError
    ).toBe(true);
    expect(
      (await callTool(tools, 'ps_replace_sky', { sky_file: SKY, shift_edge: -500 })).isError
    ).toBe(true);
    expect(
      (await callTool(tools, 'ps_replace_sky', { sky_file: SKY, border_smoothness: -1 })).isError
    ).toBe(true);
  });

  it('surfaces connection failures as an error result', async () => {
    const errConn = makeConnection({ throwOnExecute: new Error('parameters not valid') });
    const tools = createSkyTools(errConn.asConnection(), makeSnippetClient());
    const result = await callTool(tools, 'ps_replace_sky', { sky_file: SKY });
    expect(result.isError).toBe(true);
  });

  // The fixture returns a full group payload; assert it actually reaches the
  // caller rather than letting a realistic-looking fixture imply coverage.
  it('passes the group payload through as structuredContent', async () => {
    const tools = createSkyTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_replace_sky', { sky_file: SKY });
    const sc = result.structuredContent as { group_name?: string; group_layers?: string[] };
    expect(sc?.group_name).toBe('Sky Replacement Group');
    expect(sc?.group_layers).toContain('Foreground Lighting');
  });
});
