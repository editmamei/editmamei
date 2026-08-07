import { describe, it, expect, beforeEach } from 'vitest';
import { createImagePlacementTools } from '@editmamei/tools/image-placement-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

describe('createImagePlacementTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;
  beforeEach(() => {
    conn = makeConnection();
    snippetClient = makeSnippetClient();
  });

  it('returns 1 well-formed tool', () => {
    const tools = createImagePlacementTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_place_image']);
  });

  it('place_image escapes Windows paths', async () => {
    const tools = createImagePlacementTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_place_image', {
      file_path: 'C:\\images\\shot.png',
      x: 100,
      y: 50,
    });
    const script = conn.lastScript();
    expect(script).toContain('C:\\\\images\\\\shot.png');
    expect(script).toContain('100');
    expect(script).toContain('50');
  });

  it('place_image omits Wdth/Hght scale keys when width_percent/height_percent not supplied', async () => {
    const tools = createImagePlacementTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_place_image', {
      file_path: 'C:\\images\\shot.png',
    });
    const script = conn.lastScript();
    // Default: PS treats the absence as 100% native size, matching the
    // 2026-06-03 audit capture's behaviour.
    expect(script).not.toContain("cTID('Wdth'), cTID('#Prc')");
    expect(script).not.toContain("cTID('Hght'), cTID('#Prc')");
  });

  it('place_image emits Wdth/Hght #Prc unitDouble when scale params supplied (Bundle 6)', async () => {
    const tools = createImagePlacementTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_place_image', {
      file_path: 'C:\\images\\shot.png',
      width_percent: 75,
      height_percent: 150,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('placeImage');
    expect(build.params.widthPercent).toBe(75);
    expect(build.params.heightPercent).toBe(150);
  });
});
