import { describe, it, expect, beforeEach } from 'vitest';
import { createFilterTools } from '@editmamei/tools/filter-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import { FakeDetectionClient, CANNED, EXPORT_RESULT } from '../fixtures/fake-detection-client.ts';

// 2026-06-20 — Phase 1 tool-surface consolidation. The thirteen
// photoshop_apply_<filter> tools collapsed into ONE ps_apply_filter with
// a `type` discriminator. The
// per-type schemas + handlers are unchanged; the consolidated handler strips
// `type` and delegates, so these tests still pin the TS→snippet param-forwarding
// contract — now reached via type:'<filter>'.

describe('createFilterTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection();
    snippetClient = makeSnippetClient();
  });

  it('exposes one consolidated apply_filter tool, well-formed', () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_apply_filter']);
  });

  it('the type field enumerates all eighteen filters', () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    const schema = tools[0].tool.inputSchema as unknown as {
      properties: { type: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.type.enum).toEqual([
      'gaussian_blur',
      'motion_blur',
      'lens_blur',
      'radial_blur',
      'sharpen',
      'smart_sharpen',
      'noise',
      'reduce_noise',
      'high_pass',
      'pixelate',
      'distort',
      'stylize',
      'render',
      'other',
      'denoise',
      'blur',
      'displace',
      'oil_paint',
    ]);
    expect(schema.required).toContain('type');
  });

  it('an unknown filter type returns an error without dispatching a snippet', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_apply_filter', { type: 'bogus' });
    expect(result.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });

  // 2026-06-20 — apply_displace (capture). Map path travels in
  // the descriptor (putPath DspF), so it forwards as a param.
  it('type=displace forwards map path + scale + enum params', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'displace',
      map_path: 'C:/maps/disp.psd',
      horizontal_scale: 10,
      vertical_scale: 10,
      displacement_map: 'stretch_to_fit',
      undefined_areas: 'repeat_edge',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyDisplace');
    expect(build.params.mapPath).toBe('C:/maps/disp.psd');
    expect(build.params.horizontalScale).toBe(10);
    expect(build.params.displacementMap).toBe('stretch_to_fit');
    expect(build.params.undefinedAreas).toBe('repeat_edge');
  });

  it('type=gaussian_blur passes the radius param', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', { type: 'gaussian_blur', radius: 12 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyGaussianBlur');
    expect(build.params.radius).toBe(12);
  });

  it('type=sharpen passes amount, radius, and threshold params', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'sharpen',
      amount: 100,
      radius: 1.5,
      threshold: 4,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyUnsharpMask');
    expect(build.params.amount).toBe(100);
    expect(build.params.radius).toBe(1.5);
    expect(build.params.threshold).toBe(4);
  });

  it('type=motion_blur passes angle and radius params', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', { type: 'motion_blur', angle: 45, radius: 20 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyMotionBlur');
    expect(build.params.angle).toBe(45);
    expect(build.params.radius).toBe(20);
  });

  it('type=noise passes amount param', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', { type: 'noise', amount: 10 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyAddNoise');
    expect(build.params.amount).toBe(10);
  });

  // 2026-06-20 — radial_blur. Maps spin/zoom + quality + normalized center to RdlB.
  it('type=radial_blur passes amount, method, quality, and center params', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'radial_blur',
      amount: 23,
      method: 'zoom',
      quality: 'best',
      center_x: 0.5,
      center_y: 0.5,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyRadialBlur');
    expect(build.params.amount).toBe(23);
    expect(build.params.method).toBe('zoom');
    expect(build.params.quality).toBe('best');
    expect(build.params.centerX).toBe(0.5);
    expect(build.params.centerY).toBe(0.5);
  });

  // Grounded center (2026-07-05): NAME the blur center instead of guessing a
  // normalized 0-1 pair. The resolved doc-pixel point ÷ doc dims → the center.
  it('type=radial_blur center_placement resolves the normalized center (wins over center_x/y)', async () => {
    const conn2 = makeConnection({
      resultFor: (s: string) =>
        s.includes('__mcp_detect__')
          ? EXPORT_RESULT
          : { target_was_copy: true, target_layer_name: 'Radial Blur (Background)' },
    });
    const sc2 = makeSnippetClient();
    const tools = createFilterTools(conn2.asConnection(), sc2, new FakeDetectionClient(CANNED));
    const res = await callTool(tools, 'ps_apply_filter', {
      type: 'radial_blur',
      amount: 20,
      center_x: 0.9, // should be overridden by the placement
      center_y: 0.9,
      center_placement: {
        anchors: [{ id: 'd', kind: 'object', label: 'dog', pick: 'leftmost' }],
        relation: { type: 'centroid', anchor: 'd' },
      },
    });
    expect(res.isError).toBeFalsy();
    const build = sc2.allBuilds().find((b) => b.name === 'applyRadialBlur')!;
    // dog leftmost centroid (200,200) on the 1000² doc → normalized 0.2 (not 0.9)
    expect(build.params.centerX).toBe(0.2);
    expect(build.params.centerY).toBe(0.2);
    const cp = (
      res.structuredContent as {
        center_placement?: { gate: { pass: boolean }; point: { x: number; y: number } };
      }
    ).center_placement;
    expect(cp?.gate.pass).toBe(true);
    expect(cp?.point).toEqual({ x: 200, y: 200 });
  });

  it('type=radial_blur is fail-closed when center_placement resolves a non-point', async () => {
    const conn2 = makeConnection({
      resultFor: (s: string) =>
        s.includes('__mcp_detect__') ? EXPORT_RESULT : { target_was_copy: true },
    });
    const sc2 = makeSnippetClient();
    const tools = createFilterTools(conn2.asConnection(), sc2, new FakeDetectionClient(CANNED));
    const res = await callTool(tools, 'ps_apply_filter', {
      type: 'radial_blur',
      center_placement: {
        anchors: [
          { id: 'd0', kind: 'object', label: 'dog', pick: 'leftmost' },
          { id: 'd1', kind: 'object', label: 'dog', pick: 'rightmost' },
        ],
        relation: { type: 'gap', anchors: ['d0', 'd1'] }, // → a region, not a point
      },
    });
    expect(res.isError).toBe(true); // region ≠ point → LocateError, nothing applied
    expect(sc2.allBuilds().some((b) => b.name === 'applyRadialBlur')).toBe(false);
  });

  // 2026-06-20 — pixelate (two modes ClrH / Msc).
  it('type=pixelate color_halftone passes radius + channel angles', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'pixelate',
      mode: 'color_halftone',
      max_radius: 9,
      angle_1: 108,
      angle_2: 162,
      angle_3: 90,
      angle_4: 45,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyPixelate');
    expect(build.params.mode).toBe('color_halftone');
    expect(build.params.maxRadius).toBe(9);
    expect(build.params.angle1).toBe(108);
    expect(build.params.angle4).toBe(45);
  });

  it('type=pixelate mosaic passes cell_size', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'pixelate',
      mode: 'mosaic',
      cell_size: 12,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyPixelate');
    expect(build.params.mode).toBe('mosaic');
    expect(build.params.cellSize).toBe(12);
  });

  // 2026-06-29 — pixelate family extension (capture).
  it('type=pixelate crystallize passes cell_size', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'pixelate',
      mode: 'crystallize',
      cell_size: 25,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyPixelate');
    expect(build.params.mode).toBe('crystallize');
    expect(build.params.cellSize).toBe(25);
  });

  it('type=pixelate pointillize passes cell_size', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'pixelate',
      mode: 'pointillize',
      cell_size: 7,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyPixelate');
    expect(build.params.mode).toBe('pointillize');
    expect(build.params.cellSize).toBe(7);
  });

  it('type=pixelate facet dispatches with no extra params', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', { type: 'pixelate', mode: 'facet' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyPixelate');
    expect(build.params.mode).toBe('facet');
    expect(build.params.cellSize).toBeUndefined();
    expect(build.params.maxRadius).toBeUndefined();
  });

  it('type=pixelate fragment dispatches with no extra params', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', { type: 'pixelate', mode: 'fragment' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyPixelate');
    expect(build.params.mode).toBe('fragment');
    expect(build.params.cellSize).toBeUndefined();
  });

  // 2026-06-20 — distort (four modes).
  it('type=distort twirl passes the angle', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', { type: 'distort', mode: 'twirl', angle: 232 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyDistort');
    expect(build.params.mode).toBe('twirl');
    expect(build.params.angle).toBe(232);
  });

  it('type=distort wave maps its rich param set to camelCase', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'distort',
      mode: 'wave',
      wave_type: 'sine',
      generators: 5,
      wavelength_min: 10,
      wavelength_max: 120,
      amplitude_min: 5,
      amplitude_max: 35,
      undefined_areas: 'repeat_edge',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyDistort');
    expect(build.params.mode).toBe('wave');
    expect(build.params.waveType).toBe('sine');
    expect(build.params.wavelengthMax).toBe(120);
    expect(build.params.undefinedAreas).toBe('repeat_edge');
  });

  // 2026-06-29 — distort family extension (capture).
  it('type=distort pinch passes the amount', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', { type: 'distort', mode: 'pinch', amount: 60 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyDistort');
    expect(build.params.mode).toBe('pinch');
    expect(build.params.amount).toBe(60);
  });

  it('type=distort spherize passes the amount', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', { type: 'distort', mode: 'spherize', amount: -40 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyDistort');
    expect(build.params.mode).toBe('spherize');
    expect(build.params.amount).toBe(-40);
  });

  it('type=distort zigzag passes amount + ridges', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'distort',
      mode: 'zigzag',
      amount: 25,
      ridges: 8,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyDistort');
    expect(build.params.mode).toBe('zigzag');
    expect(build.params.amount).toBe(25);
    expect(build.params.ridges).toBe(8);
  });

  // 2026-06-29 — stylize family (new tool).
  it('type=stylize emboss passes angle/height/amount', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'stylize',
      mode: 'emboss',
      angle: 120,
      height: 5,
      amount: 150,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyStylize');
    expect(build.params.mode).toBe('emboss');
    expect(build.params.angle).toBe(120);
    expect(build.params.height).toBe(5);
    expect(build.params.amount).toBe(150);
  });

  it('type=stylize wind maps wind_method/wind_direction to method/direction', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'stylize',
      mode: 'wind',
      wind_method: 'blast',
      wind_direction: 'right',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyStylize');
    expect(build.params.mode).toBe('wind');
    expect(build.params.method).toBe('blast');
    expect(build.params.direction).toBe('right');
  });

  it('type=stylize trace_contour passes level + edge', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'stylize',
      mode: 'trace_contour',
      level: 200,
      edge: 'upper',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyStylize');
    expect(build.params.level).toBe(200);
    expect(build.params.edge).toBe('upper');
  });

  it('type=stylize tiles passes number + offset', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'stylize',
      mode: 'tiles',
      number: 12,
      offset: 8,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyStylize');
    expect(build.params.number).toBe(12);
    expect(build.params.offset).toBe(8);
  });

  it('type=stylize find_edges dispatches parameterless', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', { type: 'stylize', mode: 'find_edges' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyStylize');
    expect(build.params.mode).toBe('find_edges');
  });

  // 2026-06-29 — render family (new tool).
  it('type=render clouds dispatches parameterless', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', { type: 'render', mode: 'clouds' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyRender');
    expect(build.params.mode).toBe('clouds');
  });

  it('type=render fibers maps fiber_strength to strength + passes variance/seed', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'render',
      mode: 'fibers',
      variance: 20,
      fiber_strength: 6,
      seed: 999,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyRender');
    expect(build.params.variance).toBe(20);
    expect(build.params.strength).toBe(6);
    expect(build.params.seed).toBe(999);
  });

  // 2026-06-29 — other/denoise/blur families (new tools).
  it('type=other maximum passes radius + preserve', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'other',
      mode: 'maximum',
      radius: 5,
      preserve: 'squareness',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyOther');
    expect(build.params.mode).toBe('maximum');
    expect(build.params.radius).toBe(5);
    expect(build.params.preserve).toBe('squareness');
  });

  it('type=other offset passes horizontal + vertical', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'other',
      mode: 'offset',
      horizontal: 40,
      vertical: -20,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyOther');
    expect(build.params.horizontal).toBe(40);
    expect(build.params.vertical).toBe(-20);
  });

  it('type=denoise dust_and_scratches passes radius + threshold', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'denoise',
      mode: 'dust_and_scratches',
      radius: 4,
      threshold: 15,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyDenoise');
    expect(build.params.radius).toBe(4);
    expect(build.params.threshold).toBe(15);
  });

  it('type=denoise despeckle dispatches parameterless', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', { type: 'denoise', mode: 'despeckle' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyDenoise');
    expect(build.params.mode).toBe('despeckle');
  });

  it('type=blur surface_blur passes radius + threshold', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'blur',
      mode: 'surface_blur',
      radius: 18,
      threshold: 25,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyBlurAdv');
    expect(build.params.radius).toBe(18);
    expect(build.params.threshold).toBe(25);
  });

  it('type=blur average dispatches parameterless', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', { type: 'blur', mode: 'average' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyBlurAdv');
    expect(build.params.mode).toBe('average');
  });

  // 2026-06-20 — oil_paint (7 sliders).
  it('type=oil_paint maps its sliders to camelCase params', async () => {
    const tools = createFilterTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_filter', {
      type: 'oil_paint',
      stylization: 4,
      cleanliness: 2.3,
      brush_scale: 0.8,
      bristle_detail: 10,
      light_direction: -60,
      shine: 1.3,
      lighting_on: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyOilPaint');
    expect(build.params.stylization).toBe(4);
    expect(build.params.brushScale).toBe(0.8);
    expect(build.params.bristleDetail).toBe(10);
    expect(build.params.lightDirection).toBe(-60);
    expect(build.params.lightingOn).toBe(true);
  });

  // ===========================================================================
  // Auto-duplicate-first pattern.
  //
  // Every destructive filter runs on a COPY of the active layer by default
  // (so the original is preserved). Pass apply_to_active_layer:true to bake
  // into the original. These pin the param-forwarding contract through the
  // consolidated dispatcher.
  // ===========================================================================
  describe('auto-duplicate-first', () => {
    const filterCases = [
      { type: 'gaussian_blur', args: { radius: 5 }, snippetName: 'applyGaussianBlur' },
      {
        type: 'sharpen',
        args: { amount: 80, radius: 1, threshold: 2 },
        snippetName: 'applyUnsharpMask',
      },
      { type: 'noise', args: { amount: 5 }, snippetName: 'applyAddNoise' },
      { type: 'motion_blur', args: { angle: 30, radius: 8 }, snippetName: 'applyMotionBlur' },
      {
        type: 'lens_blur',
        args: { radius: 20, iris_shape: 'hexagon' },
        snippetName: 'applyLensBlur',
      },
      {
        type: 'smart_sharpen',
        args: { amount: 100, radius: 1.5 },
        snippetName: 'applySmartSharpen',
      },
      { type: 'reduce_noise', args: { strength: 6 }, snippetName: 'applyReduceNoise' },
      { type: 'high_pass', args: { radius: 10 }, snippetName: 'applyHighPass' },
    ] as const;

    for (const { type, args, snippetName } of filterCases) {
      it(`type=${type} defaults to duplicate-first (applyToActiveLayer=false)`, async () => {
        const tools = createFilterTools(conn.asConnection(), snippetClient);
        await callTool(tools, 'ps_apply_filter', { type, ...args });
        const build = snippetClient.lastBuild();
        expect(build.name).toBe(snippetName);
        expect(build.params.applyToActiveLayer).toBe(false);
      });

      it(`type=${type} with apply_to_active_layer=true passes applyToActiveLayer=true`, async () => {
        const tools = createFilterTools(conn.asConnection(), snippetClient);
        await callTool(tools, 'ps_apply_filter', {
          type,
          ...args,
          apply_to_active_layer: true,
        });
        const build = snippetClient.lastBuild();
        expect(build.name).toBe(snippetName);
        expect(build.params.applyToActiveLayer).toBe(true);
      });
    }

    it('apply_to_active_layer is documented on the consolidated input schema', () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      const schema = tools[0].tool.inputSchema as unknown as {
        properties: { apply_to_active_layer?: { default?: boolean; description?: string } };
      };
      const prop = schema.properties.apply_to_active_layer;
      expect(prop).toBeDefined();
      expect(prop!.default).toBe(false);
      // Pins the shared applyToActiveLayerProp contract wording at the
      // REGISTERED-schema level (QA 2026-07-30 #7): a reword of the helper
      // silently rewrites LLM-facing copy across 15+ tools — this fails first.
      expect(prop!.description).toContain(
        'If false (default), the filter is applied to a duplicate of the active layer'
      );
      expect(prop!.description).toContain('"<OpName> (<Original Name>)"');
      expect(prop!.description).toContain(
        'If true, the filter bakes directly into the active layer'
      );
    });
  });

  // ===========================================================================
  // lens_blur key params forwarding.
  // ===========================================================================
  describe('lens_blur', () => {
    it('passes radius and iris_shape to the snippet', async () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_filter', {
        type: 'lens_blur',
        radius: 25,
        iris_shape: 'octagon',
        iris_blade_curvature: 35,
        iris_rotation: 45,
        specular_brightness: 80,
        specular_threshold: 220,
        noise_amount: 10,
        noise_distribution: 'gaussian',
        noise_monochromatic: false,
        depth_source: 'transparency',
        focal_distance: 128,
        invert_depth: true,
      });
      const build = snippetClient.lastBuild();
      expect(build.name).toBe('applyLensBlur');
      expect(build.params.radius).toBe(25);
      expect(build.params.irisShape).toBe('octagon');
      expect(build.params.focalDistance).toBe(128);
    });

    it('defaults sensible values when params omitted', async () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_filter', { type: 'lens_blur' });
      const build = snippetClient.lastBuild();
      expect(build.name).toBe('applyLensBlur');
      expect(conn.executions.length).toBe(1);
    });
  });

  describe('smart_sharpen', () => {
    it('passes amount, radius, and shadow/highlight params to the snippet', async () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_filter', {
        type: 'smart_sharpen',
        amount: 250,
        radius: 2.5,
        noise_reduction: 30,
        remove_mode: 'gaussianBlur',
        shadow_fade: 20,
        shadow_tonal_width: 40,
        shadow_radius: 25,
        highlight_fade: 10,
        highlight_tonal_width: 60,
        highlight_radius: 35,
      });
      const build = snippetClient.lastBuild();
      expect(build.name).toBe('applySmartSharpen');
      expect(build.params.amount).toBe(250);
      expect(build.params.radius).toBe(2.5);
      expect(build.params.noiseReduction).toBe(30);
    });

    it('motionBlur remove_mode passes motion_angle to the snippet', async () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_filter', {
        type: 'smart_sharpen',
        amount: 100,
        radius: 1.5,
        remove_mode: 'motionBlur',
        motion_angle: 45,
      });
      const build = snippetClient.lastBuild();
      expect(build.name).toBe('applySmartSharpen');
      expect(build.params.removeMode).toBe('motionBlur');
      expect(build.params.motionAngle).toBe(45);
    });

    it('non-motion remove_mode does not pass motionAngle', async () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_filter', {
        type: 'smart_sharpen',
        amount: 100,
        radius: 1.5,
        remove_mode: 'lensBlur',
      });
      const build = snippetClient.lastBuild();
      expect(build.name).toBe('applySmartSharpen');
      expect(build.params.removeMode).toBe('lensBlur');
    });
  });

  // ===========================================================================
  // 2026-06-02 — reduce_noise param forwarding.
  // ===========================================================================
  describe('reduce_noise', () => {
    it('passes strength and preserve_details to the snippet', async () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_filter', {
        type: 'reduce_noise',
        strength: 8,
        preserve_details: 65,
      });
      const build = snippetClient.lastBuild();
      expect(build.name).toBe('applyReduceNoise');
      expect(build.params.strength).toBe(8);
      expect(build.params.preserveDetails).toBe(65);
    });

    it('passes color_noise and sharpen_details to the snippet', async () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_filter', {
        type: 'reduce_noise',
        color_noise: 60,
        sharpen_details: 35,
      });
      const build = snippetClient.lastBuild();
      expect(build.name).toBe('applyReduceNoise');
      expect(build.params.colorNoise).toBe(60);
      expect(build.params.sharpenDetails).toBe(35);
    });

    it('passes remove_jpeg_artifact flag to the snippet', async () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_filter', {
        type: 'reduce_noise',
        remove_jpeg_artifact: true,
      });
      const build = snippetClient.lastBuild();
      expect(build.name).toBe('applyReduceNoise');
      expect(build.params.removeJpegArtifact).toBe(true);
    });

    it('passes per_channel=true and per-channel values to the snippet', async () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_filter', {
        type: 'reduce_noise',
        strength: 5,
        per_channel: true,
        red_strength: 3,
        red_preserve_details: 70,
        green_strength: 4,
        green_preserve_details: 60,
        blue_strength: 8,
        blue_preserve_details: 30,
      });
      const build = snippetClient.lastBuild();
      expect(build.name).toBe('applyReduceNoise');
      expect(build.params.perChannel).toBe(true);
      expect(build.params.redStrength).toBe(3);
      expect(build.params.greenStrength).toBe(4);
      expect(build.params.blueStrength).toBe(8);
    });

    it('default-args case dispatches with strength param', async () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_filter', { type: 'reduce_noise', strength: 5 });
      const build = snippetClient.lastBuild();
      expect(build.name).toBe('applyReduceNoise');
      expect(build.params.strength).toBe(5);
    });
  });

  describe('high_pass', () => {
    it('passes radius to the snippet', async () => {
      const tools = createFilterTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_filter', { type: 'high_pass', radius: 3.5 });
      const build = snippetClient.lastBuild();
      expect(build.name).toBe('applyHighPass');
      expect(build.params.radius).toBe(3.5);
    });
  });

  // ===========================================================================
  // as_smart_filter forwarding. Every filter type declares the opt-in
  // (asSmartFilterProp, shared across all 18 schemas) and must forward it — or
  // its absence — to the snippet unmodified. Table-driven over the tool's OWN
  // schema enum (not a hand-copied list) so a new filter type auto-joins this
  // coverage instead of silently going unchecked.
  // ===========================================================================
  describe('as_smart_filter forwarding', () => {
    // Minimal valid params per type — just enough to satisfy that type's
    // required fields (per the per-type schemas above), nothing more.
    const requiredParamsByType: Record<string, Record<string, unknown>> = {
      gaussian_blur: { radius: 10 },
      motion_blur: { angle: 10, radius: 10 },
      lens_blur: {},
      radial_blur: {},
      sharpen: { amount: 50, radius: 2 },
      smart_sharpen: {},
      noise: { amount: 10 },
      reduce_noise: {},
      high_pass: { radius: 10 },
      pixelate: { mode: 'mosaic' },
      distort: { mode: 'twirl' },
      stylize: { mode: 'emboss' },
      render: { mode: 'clouds' },
      other: { mode: 'offset' },
      denoise: { mode: 'despeckle' },
      blur: { mode: 'average' },
      displace: { map_path: 'C:/maps/disp.psd' },
      oil_paint: {},
    };

    const schemaTools = createFilterTools(makeConnection().asConnection(), makeSnippetClient());
    const filterTypeSchema = schemaTools[0].tool.inputSchema as unknown as {
      properties: { type: { enum: string[] } };
    };
    const types = filterTypeSchema.properties.type.enum;

    it('the params table above covers every type the tool accepts (so a new type fails loudly, not silently)', () => {
      expect(Object.keys(requiredParamsByType).sort()).toEqual([...types].sort());
    });

    for (const type of types) {
      it(`type=${type} forwards as_smart_filter:true`, async () => {
        const tools = createFilterTools(conn.asConnection(), snippetClient);
        await callTool(tools, 'ps_apply_filter', {
          type,
          ...requiredParamsByType[type],
          as_smart_filter: true,
        });
        expect(snippetClient.lastBuild().params.asSmartFilter).toBe(true);
      });

      it(`type=${type} omitting as_smart_filter forwards false/absent`, async () => {
        const tools = createFilterTools(conn.asConnection(), snippetClient);
        await callTool(tools, 'ps_apply_filter', {
          type,
          ...requiredParamsByType[type],
        });
        const asSmartFilter = snippetClient.lastBuild().params.asSmartFilter;
        expect(asSmartFilter === false || asSmartFilter === undefined).toBe(true);
      });
    }
  });
});
