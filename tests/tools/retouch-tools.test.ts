/**
 * Selection retouch. 2026-06-20 Phase 1 consolidation:
 * apply_content_aware_fill / apply_patch / apply_content_aware_move collapsed
 * into one ps_retouch with a `method` discriminator. The per-method
 * handlers (validation, defaults, param forwarding) are unchanged; these tests
 * pin the (name, params) forwarded to the SnippetClient, reached via method:'…'.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRetouchTools } from '@editmamei/tools/retouch-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import { FakeDetectionClient, CANNED } from '../fixtures/fake-detection-client.ts';

describe('createRetouchTools', () => {
  let conn: FakePhotoshopConnection;
  let sc: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection();
    sc = makeSnippetClient();
  });

  it('exposes one consolidated retouch tool, well-formed', () => {
    const tools = createRetouchTools(conn.asConnection(), sc);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_retouch']);
  });

  it('the method field enumerates the three techniques', () => {
    const tools = createRetouchTools(conn.asConnection(), sc);
    const schema = tools[0].tool.inputSchema as unknown as {
      properties: { method: { enum: string[] }; apply_to_active_layer?: unknown };
      required: string[];
    };
    expect(schema.properties.method.enum).toEqual([
      'content_aware_fill',
      'patch',
      'content_aware_move',
    ]);
    expect(schema.required).toContain('method');
  });

  it('exposes apply_to_active_layer (auto-duplicate-first escape hatch)', () => {
    const tools = createRetouchTools(conn.asConnection(), sc);
    const schema = tools[0].tool.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties && 'apply_to_active_layer' in schema.properties).toBe(true);
  });

  it('is marked destructive in annotations', () => {
    const tools = createRetouchTools(conn.asConnection(), sc);
    expect(tools[0].tool.annotations?.destructiveHint).toBe(true);
  });

  it('an unknown method returns an error without dispatching', async () => {
    const tools = createRetouchTools(conn.asConnection(), sc);
    const result = await callTool(tools, 'ps_retouch', { method: 'bogus' });
    expect(result.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });

  // ---------- Content-Aware Fill ----------

  describe('method=content_aware_fill', () => {
    it('builds applyContentAwareFill with opacity + blend-mode defaults', async () => {
      const tools = createRetouchTools(conn.asConnection(), sc);
      await callTool(tools, 'ps_retouch', { method: 'content_aware_fill' });
      const b = sc.lastBuild();
      expect(b.name).toBe('applyContentAwareFill');
      expect(b.params.opacity).toBe(100);
      expect(b.params.blendMode).toBe('normal');
      expect(b.params.colorAdaptation).toBe(true);
    });

    it('forwards the four content-aware booleans', async () => {
      const tools = createRetouchTools(conn.asConnection(), sc);
      await callTool(tools, 'ps_retouch', {
        method: 'content_aware_fill',
        color_adaptation: false,
        rotate: true,
        scale: true,
        mirror: true,
      });
      const b = sc.lastBuild();
      expect(b.params.colorAdaptation).toBe(false);
      expect(b.params.rotate).toBe(true);
      expect(b.params.scale).toBe(true);
      expect(b.params.mirror).toBe(true);
    });

    it('forwards blend_mode (charID mapping is golden-verified in go-core)', async () => {
      const tools = createRetouchTools(conn.asConnection(), sc);
      await callTool(tools, 'ps_retouch', {
        method: 'content_aware_fill',
        blend_mode: 'multiply',
      });
      expect(sc.lastBuild().params.blendMode).toBe('multiply');
    });
  });

  // ---------- Patch ----------

  describe('method=patch', () => {
    it('rejects calls missing the required offset args', async () => {
      const tools = createRetouchTools(conn.asConnection(), sc);
      const result = await callTool(tools, 'ps_retouch', { method: 'patch' });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/offset_x|offset_y|required/i);
    });

    it('builds applyPatch with offsets + adaptation defaults', async () => {
      const tools = createRetouchTools(conn.asConnection(), sc);
      await callTool(tools, 'ps_retouch', { method: 'patch', offset_x: 90, offset_y: -6 });
      const b = sc.lastBuild();
      expect(b.name).toBe('applyPatch');
      expect(b.params.offsetX).toBe(90);
      expect(b.params.offsetY).toBe(-6);
      expect(b.params.patchStructure).toBe(5);
      expect(b.params.patchColor).toBe(5);
      expect(b.params.healSmoothFactor).toBe(5);
      expect(b.params.useSource).toBe(true);
    });

    it('forwards sample_all_layers, transparent, use_source overrides', async () => {
      const tools = createRetouchTools(conn.asConnection(), sc);
      await callTool(tools, 'ps_retouch', {
        method: 'patch',
        offset_x: 50,
        offset_y: 0,
        sample_all_layers: true,
        transparent: true,
        use_source: false,
      });
      const b = sc.lastBuild();
      expect(b.params.sampleAllLayers).toBe(true);
      expect(b.params.transparent).toBe(true);
      expect(b.params.useSource).toBe(false);
    });

    it('enforces patch_structure and patch_color range bounds', async () => {
      const tools = createRetouchTools(conn.asConnection(), sc);
      const tooHigh = await callTool(tools, 'ps_retouch', {
        method: 'patch',
        offset_x: 0,
        offset_y: 0,
        patch_structure: 99,
      });
      expect(tooHigh.isError).toBe(true);
      const tooLow = await callTool(tools, 'ps_retouch', {
        method: 'patch',
        offset_x: 0,
        offset_y: 0,
        patch_color: -3,
      });
      expect(tooLow.isError).toBe(true);
    });
  });

  // ---------- Content-Aware Move ----------

  describe('method=content_aware_move', () => {
    it('builds applyContentAwareMove with offsets', async () => {
      const tools = createRetouchTools(conn.asConnection(), sc);
      await callTool(tools, 'ps_retouch', {
        method: 'content_aware_move',
        offset_x: 219,
        offset_y: -384,
      });
      const b = sc.lastBuild();
      expect(b.name).toBe('applyContentAwareMove');
      expect(b.params.offsetX).toBe(219);
      expect(b.params.offsetY).toBe(-384);
    });

    it('defaults patch_structure to 4 (CAM default differs from Patch 5)', async () => {
      const tools = createRetouchTools(conn.asConnection(), sc);
      await callTool(tools, 'ps_retouch', {
        method: 'content_aware_move',
        offset_x: 0,
        offset_y: 0,
      });
      expect(sc.lastBuild().params.patchStructure).toBe(4);
    });

    it('defaults reshuffle to true (CAM default differs from Patch false)', async () => {
      const tools = createRetouchTools(conn.asConnection(), sc);
      await callTool(tools, 'ps_retouch', {
        method: 'content_aware_move',
        offset_x: 0,
        offset_y: 0,
      });
      expect(sc.lastBuild().params.reshuffle).toBe(true);
    });

    it('forwards sample_all_layers + transparent overrides', async () => {
      const tools = createRetouchTools(conn.asConnection(), sc);
      await callTool(tools, 'ps_retouch', {
        method: 'content_aware_move',
        offset_x: 10,
        offset_y: 0,
        sample_all_layers: true,
        transparent: true,
      });
      const b = sc.lastBuild();
      expect(b.params.sampleAllLayers).toBe(true);
      expect(b.params.transparent).toBe(true);
    });
  });

  // ---------- Grounded placement (B4) ----------
  // NAME the destination/source instead of guessing a raw offset. The placement
  // resolves to a gated POINT; the selection center is read via getSelectionState;
  // the offset that lands the center on that point is computed for the snippet.
  describe('grounded offset (destination_placement / source_placement)', () => {
    // A connection that routes the three scripts the grounded path runs: the
    // detect export (doc 1000×800), getSelectionState (selection centre 200,200),
    // and the retouch snippet itself.
    const groundedConn = () =>
      makeConnection({
        resultFor: (script: string) => {
          if (script.includes('__mcp_detect__'))
            return { ok: true, doc_width: 1000, doc_height: 800, context: { hasDocument: true } };
          if (script.includes('getSelectionState'))
            return {
              has_selection: true,
              bounds: { left: 100, top: 100, right: 300, bottom: 300 }, // centre (200,200)
            };
          return { target_was_copy: true, target_layer_name: 'X', original_layer_name: 'Y' };
        },
      });
    // grid 'center' on 1000×800 → centroid (500,400); selection centre (200,200)
    // → offset (300,200).
    const CENTER_PLACEMENT = {
      anchors: [{ id: 'g', kind: 'grid', at: 'center' }],
      relation: { type: 'centroid', anchor: 'g' },
    };

    it('content_aware_move: destination_placement resolves the offset (centre → gated point)', async () => {
      const conn2 = groundedConn();
      const sc2 = makeSnippetClient();
      const tools = createRetouchTools(conn2.asConnection(), sc2, new FakeDetectionClient(CANNED));
      const res = await callTool(tools, 'ps_retouch', {
        method: 'content_aware_move',
        destination_placement: CENTER_PLACEMENT,
      });
      expect(res.isError).toBeFalsy();
      const b = sc2.allBuilds().find((x) => x.name === 'applyContentAwareMove')!;
      expect(b.params.offsetX).toBe(300);
      expect(b.params.offsetY).toBe(200);
      const dp = (
        res.structuredContent as {
          destination_placement?: { gate: { pass: boolean }; point: { x: number; y: number } };
        }
      ).destination_placement;
      expect(dp?.gate.pass).toBe(true);
      expect(dp?.point).toEqual({ x: 500, y: 400 });
    });

    it('content_aware_move: destination_placement WINS over an explicit offset', async () => {
      const conn2 = groundedConn();
      const sc2 = makeSnippetClient();
      const tools = createRetouchTools(conn2.asConnection(), sc2, new FakeDetectionClient(CANNED));
      await callTool(tools, 'ps_retouch', {
        method: 'content_aware_move',
        offset_x: -999,
        offset_y: -999,
        destination_placement: CENTER_PLACEMENT,
      });
      const b = sc2.allBuilds().find((x) => x.name === 'applyContentAwareMove')!;
      expect(b.params.offsetX).toBe(300); // resolved, not the -999 the caller passed
      expect(b.params.offsetY).toBe(200);
    });

    it('patch: source_placement resolves the offset and echoes source_placement', async () => {
      const conn2 = groundedConn();
      const sc2 = makeSnippetClient();
      const tools = createRetouchTools(conn2.asConnection(), sc2, new FakeDetectionClient(CANNED));
      const res = await callTool(tools, 'ps_retouch', {
        method: 'patch',
        source_placement: CENTER_PLACEMENT,
      });
      expect(res.isError).toBeFalsy();
      const b = sc2.allBuilds().find((x) => x.name === 'applyPatch')!;
      expect(b.params.offsetX).toBe(300);
      expect(b.params.offsetY).toBe(200);
      const sp = (res.structuredContent as { source_placement?: { gate: { pass: boolean } } })
        .source_placement;
      expect(sp?.gate.pass).toBe(true);
    });

    it('errors (fail-closed) when a placement has no anchors — nothing dispatched', async () => {
      const conn2 = groundedConn();
      const sc2 = makeSnippetClient();
      const tools = createRetouchTools(conn2.asConnection(), sc2, new FakeDetectionClient(CANNED));
      const res = await callTool(tools, 'ps_retouch', {
        method: 'content_aware_move',
        destination_placement: { relation: { type: 'centroid', anchor: 'g' } },
      });
      expect(res.isError).toBe(true);
      expect(sc2.allBuilds().some((x) => x.name === 'applyContentAwareMove')).toBe(false);
    });

    it('patch is also fail-closed — no selection with a source_placement dispatches nothing', async () => {
      // Covers the patch branch's throw symmetrically with content_aware_move.
      const conn2 = makeConnection({
        resultFor: (script: string) => {
          if (script.includes('__mcp_detect__'))
            return { ok: true, doc_width: 1000, doc_height: 800, context: { hasDocument: true } };
          if (script.includes('getSelectionState')) return { has_selection: false };
          return { target_was_copy: true, target_layer_name: 'X' };
        },
      });
      const sc2 = makeSnippetClient();
      const tools = createRetouchTools(conn2.asConnection(), sc2, new FakeDetectionClient(CANNED));
      const res = await callTool(tools, 'ps_retouch', {
        method: 'patch',
        source_placement: CENTER_PLACEMENT,
      });
      expect(res.isError).toBe(true);
      expect(sc2.allBuilds().some((x) => x.name === 'applyPatch')).toBe(false);
    });

    it('errors when a placement is given but no selection is active', async () => {
      const conn2 = makeConnection({
        resultFor: (script: string) => {
          if (script.includes('__mcp_detect__'))
            return { ok: true, doc_width: 1000, doc_height: 800, context: { hasDocument: true } };
          if (script.includes('getSelectionState')) return { has_selection: false };
          return { target_was_copy: true, target_layer_name: 'X' };
        },
      });
      const sc2 = makeSnippetClient();
      const tools = createRetouchTools(conn2.asConnection(), sc2, new FakeDetectionClient(CANNED));
      const res = await callTool(tools, 'ps_retouch', {
        method: 'content_aware_move',
        destination_placement: CENTER_PLACEMENT,
      });
      expect(res.isError).toBe(true);
      expect(sc2.allBuilds().some((x) => x.name === 'applyContentAwareMove')).toBe(false);
    });
  });
});
