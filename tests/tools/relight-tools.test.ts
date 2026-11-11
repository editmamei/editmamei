/**
 * ps_relight — Photoshop 28's Relight, behind an Adobe Firefly credits approval.
 *
 * These pin the slider-to-descriptor mapping and the approval gate. They can't catch a
 * descriptor Photoshop rejects; the live check is a real render (verified 2026-11-11,
 * Photoshop 28.0.0 / Windows). Tool ships at dev tier.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createRelightTools,
  kelvinToRgb,
  toDescriptorLight,
} from '@editmamei/tools/relight-tools.ts';
import { runWithCallApproval, type CallApprovalChannel } from '@editmamei/core/call-approval.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

const LIGHT = { left_right: 25, low_high: 60, close_far: 40, intensity: 47, diffusion: 42 };

function approveWith(action: 'accept' | 'decline' | 'cancel', approve = true): CallApprovalChannel {
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
        light_count: 1,
        original_lighting: 0.8,
      },
    });
    snippetClient = makeSnippetClient();
  });

  const call = (args: Record<string, unknown>, channel?: CallApprovalChannel) => {
    const tools = createRelightTools(conn.asConnection(), snippetClient);
    return channel
      ? runWithCallApproval(channel, () => callTool(tools, 'ps_relight', args)).then(
          (r) => r.result
        )
      : callTool(tools, 'ps_relight', args);
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
    const d = toDescriptorLight({ ...LIGHT, color_kelvin: 5500, color: '#ff8000' });
    expect([d.r, d.g, d.b]).toEqual([1, 0.502, 0]);
  });

  it('keeps Kelvin colors near Photoshop presets', () => {
    const [r, g, b] = kelvinToRgb(5500);
    expect(r).toBeCloseTo(0.96, 1);
    expect(g).toBeCloseTo(0.94, 1);
    expect(b).toBeCloseTo(0.91, 1);
    const warm = kelvinToRgb(2000);
    expect(warm[0]).toBeGreaterThan(warm[1]);
    expect(warm[1]).toBeGreaterThan(warm[2]);
  });

  it('renders after the person approves, and reports the credits used', async () => {
    const result = await call({ lights: [LIGHT], original_lighting: 60 }, approveWith('accept'));
    expect(result.isError).toBeFalsy();
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('relight');
    expect(build.params.ambient).toBe(0.6);
    expect((build.params.lights as unknown[]).length).toBe(1);
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
    const result = await call({ lights: [LIGHT] }, approveWith(action, approve));
    expect(snippetClient.allBuilds()).toHaveLength(0);
    expect(result.structuredContent?.relit).toBe(false);
    expect(result.structuredContent?.adobe_credits_used).toBe(0);
  });

  it('without a prompt, waits for confirm_adobe_credits from a chat yes', async () => {
    const asked = await call({ lights: [LIGHT] }, { supportsForm: false });
    expect(asked.structuredContent?.reason).toBe('needs_confirmation');
    expect(snippetClient.allBuilds()).toHaveLength(0);

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
      approveWith('decline')
    );
    expect(result.structuredContent?.reason).toBe('declined');
    expect(snippetClient.allBuilds()).toHaveLength(0);
  });

  it('on 2026-07-28, sends the question back and renders on the retry with a yes', async () => {
    const tools = createRelightTools(conn.asConnection(), snippetClient);
    const first = await runWithCallApproval({ supportsForm: true, multiRoundTrip: true }, () =>
      callTool(tools, 'ps_relight', { lights: [LIGHT] })
    );
    expect(first.inputRequired).toBeDefined();
    expect(snippetClient.allBuilds()).toHaveLength(0);

    const retry = await runWithCallApproval(
      {
        supportsForm: true,
        multiRoundTrip: true,
        inputResponses: { adobe_credits: { action: 'accept', content: { approve: true } } },
      },
      () => callTool(tools, 'ps_relight', { lights: [LIGHT] })
    );
    expect(retry.inputRequired).toBeUndefined();
    expect(snippetClient.lastBuild().name).toBe('relight');
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
