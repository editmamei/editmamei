import { describe, it, expect } from 'vitest';
import { hasImageContent, withholdImages } from '@editmamei/core/preview-privacy.ts';
import type { ToolResult } from '@editmamei/core/tool-registry.ts';

const image = { type: 'image' as const, data: 'SECRETPIXELS', mimeType: 'image/jpeg' };
const text = { type: 'text' as const, text: 'Preview rendered.' };

/** The shape ps_sequence returns: one text block on top, the last step's full result (image
 * included) nested in structuredContent (`final` in summary mode, `steps[n].result` in full). */
function sequenceShaped(): ToolResult {
  const lastStep = { content: [image, text] };
  return {
    content: [{ type: 'text' as const, text: 'Ran 2 of 2 steps.' }],
    structuredContent: {
      steps: [
        { index: 0, tool: 'ps_add_adjustment_layer', ok: true, result: { content: [text] } },
        { index: 1, tool: 'ps_get_preview', ok: true, result: lastStep },
      ],
      final: lastStep,
    },
  };
}

describe('preview privacy helpers', () => {
  it('hasImageContent finds an image at the top level or nested anywhere in the result', () => {
    expect(hasImageContent({ content: [text, image] })).toBe(true);
    expect(hasImageContent(sequenceShaped())).toBe(true);
    expect(hasImageContent({ content: [text] })).toBe(false);
    expect(hasImageContent({ content: [] })).toBe(false);
    expect(hasImageContent({} as ToolResult)).toBe(false);
  });

  it('withholdImages drops every top-level image, keeps text and structuredContent, and says so', () => {
    const out = withholdImages({ content: [image, text, image], structuredContent: { bytes: 4 } });
    expect(out.content.some((c) => c.type === 'image')).toBe(false);
    expect(out.content[0]).toEqual(text);
    const note = out.content[out.content.length - 1] as { type: string; text: string };
    expect(note.text).toMatch(/^2 images were withheld because the user's privacy/);
    expect(out.structuredContent).toEqual({ bytes: 4 });
    expect(JSON.stringify(out)).not.toContain('SECRETPIXELS');
  });

  it('withholdImages strips images nested in structuredContent (the ps_sequence shape)', () => {
    const out = withholdImages(sequenceShaped());
    expect(JSON.stringify(out)).not.toContain('SECRETPIXELS');
    const sc = out.structuredContent as {
      final: { content: unknown[] };
      steps: Array<{ result: { content: unknown[] } }>;
    };
    expect(sc.final.content).toEqual([text]);
    expect(sc.steps[1]!.result.content).toEqual([text]);
    expect((out.content.at(-1) as { text: string }).text).toMatch(/^2 images were withheld/);
  });

  it('withholdImages strips an embedded resource whose blob is an image', () => {
    const resource = {
      type: 'resource' as const,
      resource: { uri: 'file:///x.jpg', mimeType: 'image/jpeg', blob: 'SECRETPIXELS' },
    };
    const out = withholdImages({ content: [resource, text] } as unknown as ToolResult);
    expect(JSON.stringify(out)).not.toContain('SECRETPIXELS');
    expect((out.content.at(-1) as { text: string }).text).toMatch(/^An image was withheld/);
  });

  it('a plain object with type "image" but no image bytes is kept', () => {
    const layer = { type: 'image', name: 'Background' };
    const result: ToolResult = { content: [text], structuredContent: { layers: [layer] } };
    expect(hasImageContent(result)).toBe(false);
    expect(withholdImages(result)).toBe(result);
  });

  it('the note never tells the model how to turn the setting back on', () => {
    const note = (withholdImages({ content: [image] }).content.at(-1) as { text: string }).text;
    expect(note).not.toMatch(/config set|true/);
  });

  it('withholdImages keeps isError and returns an image-free result unchanged', () => {
    const noImage: ToolResult = { content: [text] };
    expect(withholdImages(noImage)).toBe(noImage);
    expect(withholdImages({ content: [image], isError: true }).isError).toBe(true);
  });
});
