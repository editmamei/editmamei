import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGimpVerifyTools } from '@editmamei/tools/gimp-verify-tools.ts';
import { FakeGimpBackend, makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

const scratchDir = mkdtempSync(join(tmpdir(), 'gimp-verify-tools-test-'));
afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));

/** A fake backend whose latestPreviewPath()/tempPath() point at real files this test controls. */
function makeGimpBackendWithRealPaths(
  opts: Parameters<typeof makeGimpBackend>[0] = {}
): FakeGimpBackend {
  const gimp = makeGimpBackend(opts);
  const previewPath = join(scratchDir, `preview-${Math.random().toString(36).slice(2)}.jpg`);
  writeFileSync(previewPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // minimal JPEG SOI/EOI
  gimp.latestPreviewPath = () => previewPath;
  gimp.tempPath = (name: string) => {
    const p = join(scratchDir, name);
    writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return p;
  };
  return gimp;
}

const allow = () => true;
const deny = () => false;

describe('createGimpVerifyTools', () => {
  it('returns 3 well-formed tools with these names', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpVerifyTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name).sort()).toEqual([
      'gimp_compare',
      'gimp_get_histogram',
      'gimp_get_preview',
    ]);
    assertToolShape(tools);
  });

  describe('gimp_get_preview', () => {
    it('requires image', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_get_preview', {});
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it("dispatches preview with out_path set to the backend's own latestPreviewPath (never caller-supplied)", async () => {
      const gimp = makeGimpBackendWithRealPaths({
        result: { width: 1024, height: 683, proxy: true },
      });
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_get_preview', { image: 1 });
      expect(gimp.lastCall().op).toBe('preview');
      expect(gimp.lastCall().args.out_path).toBe(gimp.latestPreviewPath());
      expect(gimp.lastCall().args.image).toBe(1);
      expect(result.isError).toBeFalsy();
      // one image block + one text block when previews are allowed
      expect(result.content?.some((c) => c.type === 'image')).toBe(true);
    });

    it('returns no image content when privacy.send_previews_to_llm is false', async () => {
      const gimp = makeGimpBackendWithRealPaths({
        result: { width: 1024, height: 683, proxy: true },
      });
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: deny });
      const result = await callTool(tools, 'gimp_get_preview', { image: 1 });
      expect(result.isError).toBeFalsy();
      expect(result.content?.some((c) => c.type === 'image')).toBe(false);
      expect((result.content?.[0] as { text: string }).text).toMatch(
        /send_previews_to_llm is false/
      );
    });
  });

  describe('gimp_get_histogram', () => {
    it('requires image', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_get_histogram', {});
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('dispatches histogram with channels + exact', async () => {
      const gimp = makeGimpBackend({
        result: {
          exact: true,
          width: 100,
          height: 100,
          pixels: 10000,
          channels: { luminance: { mean: 128, median: 130 } },
        },
      });
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_get_histogram', {
        image: 1,
        channels: ['luminance'],
        exact: true,
      });
      expect(gimp.lastCall()).toEqual({
        op: 'histogram',
        args: { image: 1, channels: ['luminance'], exact: true },
      });
      expect(result.structuredContent).toMatchObject({ exact: true, pixels: 10000 });
    });
  });

  describe('gimp_compare', () => {
    it('requires mode (image given alone)', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_compare', { image: 1 });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('requires image (mode given alone)', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_compare', { mode: 'before_after' });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it("mode='regions' requires both region_a and region_b to be dispatched, bridge-side, but forwards whatever is given", async () => {
      const gimp = makeGimpBackend({
        result: {
          region_a: { luminance: { mean: 1 } },
          region_b: { luminance: { mean: 2 } },
          proxy: false,
        },
      });
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: allow });
      const regionA = { x: 0, y: 0, width: 10, height: 10 };
      const regionB = { x: 10, y: 10, width: 10, height: 10 };
      await callTool(tools, 'gimp_compare', {
        image: 1,
        mode: 'regions',
        region_a: regionA,
        region_b: regionB,
      });
      expect(gimp.lastCall()).toEqual({
        op: 'compare',
        args: {
          image: 1,
          mode: 'regions',
          channels: undefined,
          region_a: regionA,
          region_b: regionB,
        },
      });
    });

    it("mode='before_after' dispatches compare and reports deltas, with no image content when include_previews is false", async () => {
      const gimp = makeGimpBackend({
        result: {
          before: { luminance: { mean: 100 } },
          after: { luminance: { mean: 120 } },
          delta: { luminance: { mean: 20 } },
          proxy: true,
        },
      });
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_compare', { image: 1, mode: 'before_after' });
      expect(gimp.lastCall().op).toBe('compare');
      expect(gimp.lastCall().args.before_path).toBeUndefined();
      expect(result.content?.some((c) => c.type === 'image')).toBe(false);
      expect((result.content?.at(-1) as { text: string }).text).toContain('luminance');
    });

    it('include_previews returns paired before/after images when privacy allows it', async () => {
      const gimp = makeGimpBackendWithRealPaths({
        result: {
          before: { luminance: { mean: 100 } },
          after: { luminance: { mean: 120 } },
          delta: { luminance: { mean: 20 } },
          proxy: true,
        },
      });
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_compare', {
        image: 1,
        mode: 'before_after',
        include_previews: true,
      });
      expect(gimp.lastCall().args.before_path).toBeTruthy();
      expect(gimp.lastCall().args.after_path).toBeTruthy();
      expect(result.content?.filter((c) => c.type === 'image')).toHaveLength(2);
    });

    it('include_previews is withheld (not silently) when privacy.send_previews_to_llm is false — the result text says so', async () => {
      const gimp = makeGimpBackendWithRealPaths({
        result: {
          before: { luminance: { mean: 100 } },
          after: { luminance: { mean: 120 } },
          delta: { luminance: { mean: 20 } },
          proxy: true,
        },
      });
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: deny });
      const result = await callTool(tools, 'gimp_compare', {
        image: 1,
        mode: 'before_after',
        include_previews: true,
      });
      expect(gimp.lastCall().args.before_path).toBeUndefined();
      expect(result.content?.some((c) => c.type === 'image')).toBe(false);
      expect((result.content?.at(-1) as { text: string }).text).toMatch(
        /send_previews_to_llm is false/
      );
    });

    it('does not mention withheld previews when include_previews was never requested', async () => {
      const gimp = makeGimpBackendWithRealPaths({
        result: {
          before: { luminance: { mean: 100 } },
          after: { luminance: { mean: 120 } },
          delta: { luminance: { mean: 20 } },
          proxy: true,
        },
      });
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: deny });
      const result = await callTool(tools, 'gimp_compare', { image: 1, mode: 'before_after' });
      expect((result.content?.at(-1) as { text: string }).text).not.toMatch(/send_previews_to_llm/);
    });

    it("an unknown mode is refused before any dispatch (schema enum rejects it; the handler's own unknownDiscriminator fallback is unreachable while the enum stands)", async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_compare', { image: 1, mode: 'nonsense' });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });
  });
});
