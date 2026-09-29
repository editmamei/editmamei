import { describe, it, expect } from 'vitest';
import { hasImageContent, withholdImages } from '@editmamei/core/preview-privacy.ts';
import type { ToolResult } from '@editmamei/core/tool-registry.ts';

const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/jpeg' };
const text = { type: 'text' as const, text: 'Preview rendered.' };

describe('preview privacy helpers', () => {
  it('hasImageContent is true only when an image block is present', () => {
    expect(hasImageContent({ content: [text, image] })).toBe(true);
    expect(hasImageContent({ content: [text] })).toBe(false);
    expect(hasImageContent({ content: [] })).toBe(false);
    expect(hasImageContent({} as ToolResult)).toBe(false);
  });

  it('withholdImages drops every image, keeps text and structuredContent, and says how many', () => {
    const result: ToolResult = {
      content: [image, text, image],
      structuredContent: { bytes: 4 },
    };
    const out = withholdImages(result);
    expect(out.content.some((c) => c.type === 'image')).toBe(false);
    expect(out.content[0]).toEqual(text);
    const note = out.content[out.content.length - 1] as { type: string; text: string };
    expect(note.type).toBe('text');
    expect(note.text).toMatch(/send_previews_to_llm is false, so 2 image\(s\) were not sent/);
    expect(out.structuredContent).toEqual({ bytes: 4 });
    // No image data survives anywhere in the serialized result.
    expect(JSON.stringify(out)).not.toContain('AAAA');
  });

  it('withholdImages keeps isError and returns an image-free result unchanged', () => {
    const noImage: ToolResult = { content: [text] };
    expect(withholdImages(noImage)).toBe(noImage);
    const errored = withholdImages({ content: [image], isError: true });
    expect(errored.isError).toBe(true);
  });
});
