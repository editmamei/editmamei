import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createGimpVerifyTools, HISTOGRAM_BIN_COUNT } from '@editmamei/tools/gimp-verify-tools.ts';
import { gimpFactories } from '@editmamei/modules/gimp/index.ts';
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

    it('renders to its own per-call file, returns THOSE bytes, then publishes them to latest-preview.jpg', async () => {
      // The shared latest-preview.jpg is never handed to GIMP: two sessions for one user
      // writing it in place could each read back the other's pixels.
      const gimp = makeGimpBackendWithRealPaths({
        result: { width: 1024, height: 683, proxy: true },
      });
      writeFileSync(gimp.latestPreviewPath(), Buffer.from('another session wrote this'));
      const renderBytes = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0x03, 0xff, 0xd9]);
      const renderPaths: string[] = [];
      gimp.tempPath = (name: string) => {
        const p = join(scratchDir, name);
        renderPaths.push(p);
        writeFileSync(p, renderBytes); // what GIMP would render for THIS call
        return p;
      };
      const published: string[] = [];
      gimp.copyToLatestPreview = (src: string) => {
        published.push(src);
      };
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_get_preview', { image: 1 });
      expect(result.isError).toBeFalsy();
      expect(gimp.lastCall().op).toBe('preview');
      expect(gimp.lastCall().args.image).toBe(1);
      expect(renderPaths).toHaveLength(1);
      expect(gimp.lastCall().args.out_path).toBe(renderPaths[0]);
      expect(gimp.lastCall().args.out_path).not.toBe(gimp.latestPreviewPath());
      expect(published).toEqual([renderPaths[0]]);
      const image = result.content?.find((c) => c.type === 'image') as { data: string };
      expect(Buffer.from(image.data, 'base64')).toEqual(renderBytes);
      expect(existsSync(renderPaths[0]!)).toBe(false); // the per-call file is cleaned up
    });

    it('still returns the render when refreshing latest-preview.jpg fails (the publish is best effort)', async () => {
      const gimp = makeGimpBackendWithRealPaths({
        result: { width: 16, height: 16, proxy: true },
      });
      gimp.copyToLatestPreview = () => {
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      };
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_get_preview', { image: 1 });
      expect(result.isError).toBeFalsy();
      expect(result.content?.some((c) => c.type === 'image')).toBe(true);
      expect((result.content?.at(-1) as { text: string }).text).toContain(
        'could not be refreshed this time'
      );
      expect((result.structuredContent as { path: string | null }).path).toBeNull();
    });

    it('reports the preview file by name only, never a full path (it carries the username)', async () => {
      const gimp = makeGimpBackendWithRealPaths({
        result: { width: 1024, height: 683, proxy: true },
      });
      for (const previewsAllowed of [allow, deny]) {
        const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed });
        const result = await callTool(tools, 'gimp_get_preview', { image: 1 });
        const text = (result.content?.at(-1) as { text: string }).text;
        expect(text).not.toContain(scratchDir);
        expect(text).toContain(basename(gimp.latestPreviewPath()));
        expect(text).toContain('in the session folder');
        expect((result.structuredContent as { path: string }).path).toBe(
          basename(gimp.latestPreviewPath())
        );
      }
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

    it('dispatches histogram with channels + exact, and the text includes percentiles', async () => {
      const gimp = makeGimpBackend({
        result: {
          exact: true,
          width: 100,
          height: 100,
          pixels: 10000,
          channels: { luminance: { mean: 128, median: 130, p1: 5, p5: 20, p95: 240, p99: 253 } },
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
      const text = (result.content?.[0] as { text: string }).text;
      expect(text).toContain('p1=5 p5=20 p95=240 p99=253');
    });

    it('states the bin count the bridge actually returns, and declares it in the outputSchema', async () => {
      // lib.channel_stats returns one bin per 8-bit value; test_lib.py pins that length, and the
      // live verify-ops suite pins it against a real GIMP. This pins the model-facing contract.
      const bins = new Array<number>(256).fill(0);
      const gimp = makeGimpBackend({
        result: {
          exact: false,
          width: 16,
          height: 16,
          pixels: 256,
          channels: { luminance: { mean: 1, median: 1, p1: 0, p5: 0, p95: 2, p99: 2, bins } },
        },
      });
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: allow });
      const tool = tools.find((t) => t.tool.name === 'gimp_get_histogram')!;
      const stated = /(\d+)-bin histogram/.exec(tool.tool.description ?? '');
      expect(stated, 'description states the bin count').not.toBeNull();
      expect(Number(stated![1])).toBe(HISTOGRAM_BIN_COUNT);
      const result = await callTool(tools, 'gimp_get_histogram', { image: 1 });
      const returned = (result.structuredContent as { channels: { luminance: { bins: number[] } } })
        .channels.luminance.bins;
      expect(returned).toHaveLength(HISTOGRAM_BIN_COUNT);
      const channelSchema = (
        tool.tool.outputSchema as unknown as {
          properties: {
            channels: {
              additionalProperties: {
                properties: { bins: { minItems: number; maxItems: number } };
              };
            };
          };
        }
      ).properties.channels.additionalProperties.properties.bins;
      expect(channelSchema.minItems).toBe(HISTOGRAM_BIN_COUNT);
      expect(channelSchema.maxItems).toBe(HISTOGRAM_BIN_COUNT);
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

    it('does not return the before/after render paths the bridge echoes (deleted temp files with the username in them)', async () => {
      const gimp = makeGimpBackendWithRealPaths();
      gimp.call = (async (op: string, args: Record<string, unknown> = {}) => {
        gimp.calls.push({ op, args });
        return {
          before: { luminance: { mean: 100 } },
          after: { luminance: { mean: 120 } },
          delta: { luminance: { mean: 20 } },
          proxy: true,
          before_path: args.before_path,
          after_path: args.after_path,
        };
      }) as typeof gimp.call;
      const tools = createGimpVerifyTools(gimp.asBackend(), { previewsAllowed: allow });
      const result = await callTool(tools, 'gimp_compare', {
        image: 1,
        mode: 'before_after',
        include_previews: true,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).not.toHaveProperty('before_path');
      expect(result.structuredContent).not.toHaveProperty('after_path');
      expect(JSON.stringify(result.structuredContent)).not.toContain(scratchDir);
      expect(result.structuredContent).toMatchObject({ delta: { luminance: { mean: 20 } } });
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

/**
 * The production wiring, with nothing injected: the tools as `gimpModule` registers them read
 * `privacy.send_previews_to_llm` from the real settings.json. Every other test here injects the
 * allow/deny function, so without this one a broken default would go unnoticed.
 */
describe('privacy.send_previews_to_llm, read from settings.json (no injected previewsAllowed)', () => {
  it('withholds every image from gimp_get_preview and gimp_compare include_previews:true when false', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gimp-verify-home-'));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    try {
      mkdirSync(join(home, '.editmamei'), { recursive: true });
      writeFileSync(
        join(home, '.editmamei', 'settings.json'),
        JSON.stringify({
          privacy: { send_previews_to_llm: false },
          telemetry: { install_id: 'keep0000000000' },
        })
      );
      // os.homedir() reads HOME on POSIX and USERPROFILE on Windows at call time.
      process.env.HOME = home;
      process.env.USERPROFILE = home;

      const gimp = makeGimpBackendWithRealPaths({
        resultFor: (op) =>
          op === 'preview'
            ? { width: 16, height: 16, proxy: true }
            : {
                before: { luminance: { mean: 100 } },
                after: { luminance: { mean: 120 } },
                delta: { luminance: { mean: 20 } },
                proxy: true,
              },
      });
      const tools = gimpFactories.flatMap((f) => f(gimp.asBackend()));
      const preview = await callTool(tools, 'gimp_get_preview', { image: 1 });
      const compare = await callTool(tools, 'gimp_compare', {
        image: 1,
        mode: 'before_after',
        include_previews: true,
      });
      for (const result of [preview, compare]) {
        expect(result.isError).toBeFalsy();
        expect(result.content?.some((c) => c.type === 'image')).toBe(false);
        expect((result.content?.at(-1) as { text: string }).text).toMatch(
          /send_previews_to_llm is false/
        );
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});
