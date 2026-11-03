import { describe, it, expect } from 'vitest';
import { EditmameiServer } from '@editmamei/core/server.ts';
import { withholdImages } from '@editmamei/core/preview-privacy.ts';
import { runGimpTool, withWarning } from '@editmamei/tools/gimp-shared.ts';
import type { GimpBackend } from '@editmamei/backends/gimp/backend.ts';
import { useSessionLogSandbox } from '../fixtures/session-log-sandbox.ts';

useSessionLogSandbox();

interface Prop {
  description?: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

interface RegisteredTool {
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, Prop> };
}

function tools(): RegisteredTool[] {
  const s = new EditmameiServer() as unknown as { toolRegistry: { list(): RegisteredTool[] } };
  return s.toolRegistry.list();
}

function textOf(tool: RegisteredTool): string {
  const props = Object.values(tool.inputSchema.properties ?? {});
  return [tool.description ?? '', ...props.map((p) => p.description ?? '')].join('\n');
}

describe('tool text', () => {
  it('asks nothing of the model that it should hide from the user', () => {
    for (const tool of tools()) {
      expect(textOf(tool), tool.name).not.toMatch(
        /(do not|don't|never) (tell|mention|reveal|show)\b.*\buser\b/i
      );
    }
  });

  it('does not advertise the paid edition', () => {
    for (const tool of tools()) {
      expect(textOf(tool), tool.name).not.toMatch(/\bPro (adds|feature|landmark|face-mesh)\b/);
      expect(textOf(tool), tool.name).not.toMatch(/\bare a Pro\b/);
    }
  });

  it('states the Exposure gamma direction Photoshop uses', () => {
    const tool = tools().find((t) => t.name === 'ps_add_adjustment_layer');
    expect(tool?.inputSchema.properties?.exp_gamma?.description).toContain(
      'Values >1 brighten midtones; <1 darken them.'
    );
  });

  it('allows the tint hue its own default', () => {
    const hue = tools().find((t) => t.name === 'ps_add_adjustment_layer')?.inputSchema.properties
      ?.bw_tint_hue;
    expect(hue?.default as number).toBeLessThanOrEqual(hue?.maximum as number);
    expect(hue?.default as number).toBeGreaterThanOrEqual(hue?.minimum as number);
  });

  it('does not say an annotated image stays on the machine', () => {
    for (const name of ['ps_detect', 'ps_read_scene']) {
      const text = textOf(tools().find((t) => t.name === name) as RegisteredTool);
      expect(text).not.toMatch(/never (sent|leaves)/);
      expect(text).toContain('annotate:true returns a JPEG to your AI client');
    }
  });
});

describe('guidance reaches a client that shows only structuredContent', () => {
  it('withWarning copies the warning tail, and adds nothing without one', () => {
    expect(withWarning({ a: 1 }, 'Done. WARNING: blur is missing.')).toEqual({
      a: 1,
      warning: 'WARNING: blur is missing.',
    });
    expect(withWarning({ a: 1 }, 'Done.')).toEqual({ a: 1 });
  });

  it('runGimpTool carries a warning from its success text', async () => {
    const gimp = { call: async () => ({ width: 4 }) } as unknown as GimpBackend;
    const result = await runGimpTool({
      gimp,
      op: 'x',
      rawArgs: {},
      schema: { type: 'object' },
      errorPrefix: 'Error',
      successText: () => 'Resized. WARNING: vignette was left behind.',
    });
    expect(result.structuredContent).toEqual({
      width: 4,
      warning: 'WARNING: vignette was left behind.',
    });
  });

  it('withholdImages says so in the structured result', () => {
    const result = withholdImages({
      content: [{ type: 'image', data: 'x', mimeType: 'image/jpeg' }],
      structuredContent: { width: 4 },
    });
    expect(result.structuredContent?.images_withheld).toContain('An image was withheld');
  });
});
