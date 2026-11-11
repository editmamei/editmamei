/**
 * ps_relight — Photoshop 28's Relight, behind an Adobe Firefly credits approval.
 *
 * These pin the slider-to-descriptor mapping, Adobe's color presets, the approval gate, edit in
 * place and the free preview's wiring. They can't catch a descriptor Photoshop rejects; the live
 * check is a real render (verified 2026-11-11, Photoshop 28.0.0 / Windows). The preview loop
 * itself is pinned in relight-preview.test.ts and go-core/window_test.go.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ADOBE_RELIGHT_PRESETS,
  approvalMessage,
  createRelightTools,
  kelvinToRgb,
  toDescriptorLight,
  type RelightDeps,
} from '@editmamei/tools/relight-tools.ts';
import { runWithCallApproval, type CallApprovalChannel } from '@editmamei/core/call-approval.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

const LIGHT = {
  left_right: 25,
  low_high: 60,
  close_far: 40,
  intensity: 47,
  diffusion: 42,
  color_kelvin: 5500,
};

function answering(action: 'accept' | 'decline' | 'cancel', approve = true): CallApprovalChannel {
  return {
    supportsForm: true,
    elicit: async () => ({ action, content: action === 'accept' ? { approve } : undefined }),
  };
}

describe('createRelightTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection({
      result: {
        relit: true,
        strategy_used: 'executeAction:lightshop',
        layer_name: 'Relight Layer 1',
        source_layer: 'Layer 0',
        source_hidden: true,
        source_found: true,
        light_count: 1,
        original_lighting: 0.8,
      },
    });
    snippetClient = makeSnippetClient();
  });

  /** Paid renders only: the probe before the question renders nothing. */
  const renders = () => snippetClient.allBuilds().filter((b) => b.params.mode === 'render');

  /** Call ps_relight as its own tools/call (or as `boundTo`, to model a nested call). */
  const call = async (
    args: Record<string, unknown>,
    channel?: CallApprovalChannel,
    boundTo = 'ps_relight',
    deps: RelightDeps = {}
  ) => {
    const tools = createRelightTools(conn.asConnection(), snippetClient, deps);
    if (!channel) return callTool(tools, 'ps_relight', args);
    const { result } = await runWithCallApproval(channel, boundTo, () =>
      callTool(tools, 'ps_relight', args)
    );
    return result;
  };

  it('exposes one well-formed, open-world tool named ps_relight', () => {
    const tools = createRelightTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_relight']);
    expect(tools[0].tool.annotations?.openWorldHint).toBe(true);
    expect(tools[0].tool.description).toMatch(/30 Adobe Firefly generative credits/);
  });

  it('maps the panel sliders to the descriptor read back from Photoshop', () => {
    // The panel showed X -0.44 at Left/Right 28, Y -0.17 at Close/Far 41, z 1.25 at Low/High 61,
    // 0.2988 at Intensity 47 and radius 0.294 at Diffusion 42.
    const d = toDescriptorLight({
      left_right: 28,
      close_far: 41.5,
      low_high: 60.5,
      intensity: 47,
      diffusion: 42,
      color_kelvin: 5500,
    });
    expect(d.x).toBeCloseTo(-0.44, 2);
    expect(d.y).toBeCloseTo(-0.17, 2);
    expect(d.z).toBeCloseTo(1.25, 2);
    expect(d.intensity).toBeCloseTo(0.2988, 3);
    expect(d.radius).toBeCloseTo(0.294, 3);
  });

  it('takes a hex color over the Kelvin value', () => {
    const d = toDescriptorLight({ ...LIGHT, color: '#ff8000' });
    expect([d.r, d.g, d.b]).toEqual([1, 0.502, 0]);
  });

  it("gives exactly Adobe's preset values at the preset temperatures", () => {
    // These are what the panel sends; with them its Color menu names the preset.
    expect(kelvinToRgb(2000)).toEqual([0.94, 0.66, 0.21]);
    expect(kelvinToRgb(3200)).toEqual([0.96, 0.78, 0.47]);
    expect(kelvinToRgb(5500)).toEqual([0.96, 0.94, 0.91]);
    for (const [k, rgb] of ADOBE_RELIGHT_PRESETS) expect(kelvinToRgb(k)).toEqual([...rgb]);
  });

  it('runs warm to cool through the presets, and keeps cooling past daylight', () => {
    const ks = [2000, 2400, 2800, 3200, 4000, 4800, 5500];
    for (let i = 1; i < ks.length; i++) {
      const [, g0, b0] = kelvinToRgb(ks[i - 1]);
      const [, g1, b1] = kelvinToRgb(ks[i]);
      expect(g1).toBeGreaterThanOrEqual(g0);
      expect(b1).toBeGreaterThan(b0);
    }
    // Between presets: straight-line RGB.
    expect(kelvinToRgb(2600)).toEqual([0.95, 0.72, 0.34]);
    // Warmer than the warmest preset stays at it.
    expect(kelvinToRgb(1000)).toEqual(kelvinToRgb(2000));
    // 7500K is a cool light, not daylight: blue now leads red.
    const [r, , b] = kelvinToRgb(7500);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeLessThanOrEqual(1);
  });

  it('renders after the person approves, with the converted lights and layer', async () => {
    const result = await call(
      { lights: [LIGHT], original_lighting: 60, layer: 'Model' },
      answering('accept')
    );
    expect(result.isError).toBeFalsy();
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('relight');
    expect(build.params.mode).toBe('render');
    expect(build.params.newLayer).toBe(false);
    expect(build.params.ambient).toBe(0.6);
    expect(build.params.layerName).toBe('Model');
    expect(build.params.lights).toEqual([toDescriptorLight(LIGHT)]);
    expect(result.structuredContent?.adobe_credits_used).toBe(30);
  });

  it('asks with a message that names Adobe Firefly credits, not Editmamei credits', async () => {
    let asked = '';
    let checkbox = '';
    await call(
      { lights: [LIGHT] },
      {
        supportsForm: true,
        elicit: async (params) => {
          asked = params.message;
          checkbox = params.requestedSchema.properties.approve.title;
          return { action: 'decline' };
        },
      }
    );
    expect(asked).toMatch(/30 Adobe Firefly generative credits/);
    expect(asked).toMatch(/not Editmamei credits/);
    expect(checkbox).toMatch(/Adobe Firefly credits/);
  });

  it.each([
    ['decline', true],
    ['cancel', true],
    ['accept', false],
  ] as const)('does not render on %s (box ticked: %s)', async (action, approve) => {
    const result = await call({ lights: [LIGHT] }, answering(action, approve));
    expect(renders()).toHaveLength(0);
    expect(result.structuredContent?.relit).toBe(false);
    expect(result.structuredContent?.adobe_credits_used).toBe(0);
  });

  it('does not render when the prompt fails', async () => {
    const result = await call(
      { lights: [LIGHT] },
      {
        supportsForm: true,
        elicit: async () => {
          throw new Error('client error');
        },
      }
    );
    expect(result.structuredContent?.reason).toBe('prompt_failed');
    expect(renders()).toHaveLength(0);
  });

  it('does not render a late yes after the client cancelled the call', async () => {
    const cancel = new AbortController();
    const result = await call(
      { lights: [LIGHT] },
      {
        supportsForm: true,
        signal: cancel.signal,
        elicit: async () => {
          cancel.abort();
          return { action: 'accept', content: { approve: true } };
        },
      }
    );
    expect(result.structuredContent?.reason).toBe('declined');
    expect(renders()).toHaveLength(0);
  });

  it('refuses inside another tool, without asking and even with confirm_adobe_credits', async () => {
    let asked = false;
    const channel: CallApprovalChannel = {
      supportsForm: false,
      elicit: async () => {
        asked = true;
        return { action: 'accept', content: { approve: true } };
      },
    };
    const result = await call(
      { lights: [LIGHT], confirm_adobe_credits: true },
      channel,
      'ps_sequence'
    );
    expect(result.structuredContent?.reason).toBe('nested');
    expect(asked).toBe(false);
    expect(renders()).toHaveLength(0);
  });

  it('without a prompt, waits for confirm_adobe_credits from a chat yes', async () => {
    const asked = await call({ lights: [LIGHT] }, { supportsForm: false });
    expect(asked.structuredContent?.reason).toBe('needs_confirmation');
    expect(renders()).toHaveLength(0);

    const confirmed = await call(
      { lights: [LIGHT], confirm_adobe_credits: true },
      { supportsForm: false }
    );
    expect(confirmed.isError).toBeFalsy();
    expect(snippetClient.lastBuild().name).toBe('relight');
  });

  it('ignores confirm_adobe_credits when the app can show the prompt', async () => {
    const result = await call(
      { lights: [LIGHT], confirm_adobe_credits: true },
      answering('decline')
    );
    expect(result.structuredContent?.reason).toBe('declined');
    expect(renders()).toHaveLength(0);
  });

  describe('on 2026-07-28', () => {
    const modern = (inputResponses?: Record<string, unknown>) =>
      runWithCallApproval(
        { supportsForm: true, multiRoundTrip: true, inputResponses },
        'ps_relight',
        () =>
          callTool(createRelightTools(conn.asConnection(), snippetClient), 'ps_relight', {
            lights: [LIGHT],
          })
      );

    it('sends the question back, then renders on the retry with a yes', async () => {
      const first = await modern();
      expect(first.inputRequired).toBeDefined();
      expect(renders()).toHaveLength(0);

      const retry = await modern({
        adobe_credits: { action: 'accept', content: { approve: true } },
      });
      expect(retry.inputRequired).toBeUndefined();
      expect(snippetClient.lastBuild().params.mode).toBe('render');
    });

    it('renders nothing on a retry that carries a no', async () => {
      const retry = await modern({ adobe_credits: { action: 'decline' } });
      expect(retry.inputRequired).toBeUndefined();
      expect(retry.result.structuredContent?.reason).toBe('declined');
      expect(renders()).toHaveLength(0);
    });
  });

  it('reads the target before asking, and asks about an edit without making it sound cheaper', async () => {
    conn = makeConnection({
      resultFor: (script) =>
        script.includes('"mode":"probe"')
          ? { probe: true, target_layer: 'Relight Layer 1', is_relight_layer: true, edit: true }
          : {
              relit: true,
              edited: true,
              layer_name: 'Relight Layer 1',
              source_layer: 'Relight Layer 1',
            },
    });
    let asked = '';
    const result = await call(
      { lights: [LIGHT] },
      {
        supportsForm: true,
        elicit: async (params) => {
          asked = params.message;
          return { action: 'accept', content: { approve: true } };
        },
      }
    );
    expect(snippetClient.allBuilds()[0].params.mode).toBe('probe');
    expect(asked).toMatch(/Re-render the layer "Relight Layer 1"/);
    expect(asked).toMatch(/30 Adobe Firefly generative credits/);
    expect(asked).toMatch(/costs the same/);
    expect(asked).not.toMatch(/cheaper|free|less/i);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as { text: string }).text).toMatch(/in place/);
    expect(result.structuredContent?.adobe_credits_used).toBe(30);
  });

  it('the edit and new-layer wordings both state the full price', () => {
    for (const edit of [false, true]) {
      expect(approvalMessage(1, 'Model', edit)).toMatch(
        /This uses 30 Adobe Firefly generative credits/
      );
    }
    expect(approvalMessage(1, 'Model', false)).toMatch(/new Relight layer/);
  });

  it('renders only what was approved: the probe answer rides along to the render', async () => {
    conn = makeConnection({
      resultFor: (script) =>
        script.includes('"mode":"probe"')
          ? { probe: true, target_layer: 'Background', target_id: 7, edit: false }
          : { relit: true, layer_name: 'Relight Layer 1', source_layer: 'Background' },
    });
    await call({ lights: [LIGHT] }, answering('accept'));
    expect(snippetClient.lastBuild().params).toMatchObject({
      mode: 'render',
      expect: 'new',
      expectLayerId: 7,
    });
  });

  it('refuses a preview from inside another tool (it sends Photoshop keys)', async () => {
    let previewRan = false;
    const result = await call(
      { lights: [LIGHT], preview: true },
      { supportsForm: true },
      'ps_sequence',
      {
        preview: () => {
          previewRan = true;
          throw new Error('should not run');
        },
      }
    );
    expect(result.structuredContent?.reason).toBe('nested');
    expect(previewRan).toBe(false);
  });

  it('passes new_layer through so a Relight layer can be stacked instead of edited', async () => {
    await call({ lights: [LIGHT], new_layer: true }, answering('accept'));
    expect(snippetClient.lastBuild().params.newLayer).toBe(true);
  });

  it('refuses before asking when the probe fails (no document, old Photoshop, no layer)', async () => {
    conn = makeConnection({
      resultFor: () => {
        throw new Error('No document is open in Photoshop');
      },
    });
    let asked = false;
    const result = await call(
      { lights: [LIGHT] },
      {
        supportsForm: true,
        elicit: async () => {
          asked = true;
          return { action: 'accept', content: { approve: true } };
        },
      }
    );
    expect(result.isError).toBe(true);
    expect(asked).toBe(false);
    expect(renders()).toHaveLength(0);
  });

  it('preview needs no approval and goes to the preview runner with the same lights', async () => {
    let asked = false;
    const seen: Record<string, unknown>[] = [];
    const deps: RelightDeps = {
      preview: (base) => {
        seen.push(base);
        return {
          platform: 'win32',
          script: async (mode) =>
            mode === 'preview_open'
              ? { panel_closed: true, rendered: false, edit: false }
              : {
                  prepared: true,
                  hidden_ids: [],
                  context: { document: { width: 30, height: 40 } },
                },
          window: async (action) =>
            action === 'capture'
              ? { crop: { x: 1, y: 2, w: 30, h: 40 }, signature: 'ab' }
              : {
                  settled: true,
                  png_base64: 'iVBORw0KGgo=',
                  width: 30,
                  height: 40,
                  closed: 'discarded',
                },
        };
      },
    };
    const result = await call(
      { lights: [LIGHT], preview: true, original_lighting: 70 },
      {
        supportsForm: true,
        elicit: async () => {
          asked = true;
          return { action: 'decline' };
        },
      },
      'ps_relight',
      deps
    );
    expect(asked).toBe(false);
    expect(snippetClient.allBuilds()).toHaveLength(0);
    expect(seen[0]).toMatchObject({ ambient: 0.7, lights: [toDescriptorLight(LIGHT)] });
    expect(result.structuredContent).toMatchObject({
      preview: true,
      rendered: false,
      adobe_credits_used: 0,
    });
    expect(result.content.some((c) => c.type === 'image')).toBe(true);
  });

  it('refuses a bad request before asking anyone', async () => {
    let asked = false;
    const channel: CallApprovalChannel = {
      supportsForm: true,
      elicit: async () => {
        asked = true;
        return { action: 'accept', content: { approve: true } };
      },
    };
    const four = await call({ lights: [LIGHT, LIGHT, LIGHT, LIGHT] }, channel);
    expect(four.isError).toBe(true);
    const outOfRange = await call({ lights: [{ ...LIGHT, intensity: 150 }] }, channel);
    expect(outOfRange.isError).toBe(true);
    expect(asked).toBe(false);
  });
});
