/**
 * gimp_text and gimp_inspect what=fonts against real headless GIMP, driven through the actual tool
 * handlers and a real `GimpBackend`/`GimpSession`, the same posture `layers.live.test.ts` takes.
 *
 * Fonts are discovered through what='fonts' rather than hard-coded, so the file runs on any GIMP
 * install. Every refusal below is checked to leave the document's layer tree unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpBackend } from '@editmamei/backends/gimp/backend.ts';
import { createGimpCoreTools } from '@editmamei/tools/gimp-core-tools.ts';
import { createGimpDocumentTools } from '@editmamei/tools/gimp-document-tools.ts';
import { createGimpInspectTools } from '@editmamei/tools/gimp-inspect-tools.ts';
import { createGimpLayerTools } from '@editmamei/tools/gimp-layer-tools.ts';
import { createGimpComposeTools } from '@editmamei/tools/gimp-compose-tools.ts';
import { createGimpTextTools } from '@editmamei/tools/gimp-text-tools.ts';
import { createGimpEffectTools } from '@editmamei/tools/gimp-effect-tools.ts';
import type { ToolDefinition, ToolResult } from '@editmamei/core/tool-registry.ts';
import { callTool } from '../fixtures/tool-helpers.ts';
import {
  readPng,
  pixelAt,
  readyGimpRegistry,
  LIVE_READY_TIMEOUT_MS,
  TEST_OPS_PY,
} from './support.ts';

vi.setConfig({ testTimeout: 60_000 });

const REQUIRE_GIMP = process.env.EDITMAMEI_REQUIRE_GIMP === '1';

const install: GimpInstall | null = await detectGimp();

it('GIMP must actually be detected when EDITMAMEI_REQUIRE_GIMP=1 (text)', () => {
  if (!REQUIRE_GIMP) return;
  expect(install, 'EDITMAMEI_REQUIRE_GIMP=1 but detectGimp() found no install').not.toBeNull();
});

interface TextNode {
  layer_id: number;
  name: string;
  is_text_layer: boolean;
  text?: string;
  font?: string | null;
  font_size?: number;
  color?: { red: number; green: number; blue: number };
  alignment?: string | null;
  offsets: { x: number | null; y: number | null };
  children: TextNode[];
}

interface TextResult {
  layer_id: number;
  name: string;
  text: string;
  font: string | null;
  font_size: number;
  font_size_px: number;
  ppi: number | null;
  color: { red: number; green: number; blue: number };
  alignment: string | null;
  bounds: { x: number; y: number; width: number; height: number };
  box?: { width: number; height: number };
  fitted?: boolean;
  fit_probes?: number;
  fit_seconds?: number;
}

function structuredOf(result: ToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function errorText(result: ToolResult): string {
  return JSON.stringify(result.content);
}

describe.skipIf(!install)('gimp_text against real headless GIMP', () => {
  let workDir: string;
  let backend: GimpBackend;
  let tools: ToolDefinition[];
  let fontA: string;
  let fontB: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-text-'));
    backend = new GimpBackend(install, {
      // opsPyPath: TEST_OPS_PY -- adds test_set_text_markup, used below.
      sessionOptions: { rootDir: join(workDir, 'session-root'), opsPyPath: TEST_OPS_PY },
    });
    tools = [
      ...createGimpCoreTools(backend),
      ...createGimpDocumentTools(backend),
      ...createGimpInspectTools(backend),
      ...createGimpLayerTools(backend),
      ...createGimpComposeTools(backend),
      ...createGimpTextTools(backend),
      ...createGimpEffectTools(backend),
    ];
    await readyGimpRegistry((name, args) => callTool(tools, name, args));
    const fonts = await callTool(tools, 'gimp_inspect', { what: 'fonts' });
    // fontA is the tool's own default font; fontB any other installed font, preferring a serif.
    fontA = structuredOf(fonts).default as string;
    const serifs = await callTool(tools, 'gimp_inspect', { what: 'fonts', filter: 'serif' });
    const candidates = [
      ...(structuredOf(serifs).fonts as string[]),
      ...(structuredOf(fonts).fonts as string[]),
    ];
    fontB =
      candidates.find((n) => n !== fontA && !/sans/i.test(n)) ??
      candidates.find((n) => n !== fontA)!;
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await backend.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  async function newDoc(width = 600, height = 300): Promise<number> {
    const created = await callTool(tools, 'gimp_create_document', { width, height });
    expect(created.isError, errorText(created)).toBeFalsy();
    return structuredOf(created).image as number;
  }

  async function layerTree(image: number): Promise<TextNode[]> {
    const result = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
    expect(result.isError, errorText(result)).toBeFalsy();
    return structuredOf(result).layers as TextNode[];
  }

  async function textNode(image: number, layerId: number): Promise<TextNode> {
    const node = (await layerTree(image)).find((n) => n.layer_id === layerId);
    expect(node, `layer ${layerId} missing from the tree`).toBeDefined();
    return node!;
  }

  async function text(args: Record<string, unknown>): Promise<ToolResult> {
    return callTool(tools, 'gimp_text', args);
  }

  async function exportPng(image: number, tag: string): Promise<string> {
    const path = join(workDir, `${tag}-${image}-${Date.now()}.png`);
    const result = await callTool(tools, 'gimp_export', { image, file_path: path });
    expect(result.isError, errorText(result)).toBeFalsy();
    return path;
  }

  it('what=fonts lists installed names, sorted, with a total, and narrows by filter', async () => {
    const all = await callTool(tools, 'gimp_inspect', { what: 'fonts' });
    expect(all.isError, errorText(all)).toBeFalsy();
    const r = structuredOf(all) as { fonts: string[]; total: number; returned: number };
    expect(r.fonts.length).toBeGreaterThan(0);
    expect(r.total).toBeGreaterThanOrEqual(r.returned);
    expect(r.returned).toBe(r.fonts.length);
    expect(r.fonts.length).toBeLessThanOrEqual(200);
    const lower = r.fonts.map((n) => n.toLowerCase());
    expect(lower).toEqual([...lower].sort());

    const needle = fontA.slice(0, 4).toUpperCase();
    const narrowed = await callTool(tools, 'gimp_inspect', { what: 'fonts', filter: needle });
    const nr = structuredOf(narrowed) as { fonts: string[]; total: number };
    expect(nr.fonts.length).toBeGreaterThan(0);
    expect(nr.total).toBeLessThanOrEqual(r.total);
    for (const n of nr.fonts) expect(n.toLowerCase()).toContain(needle.toLowerCase());
    expect(nr.fonts).toContain(fontA);
  });

  it('create with font, size, colour and alignment reads back through describe', async () => {
    const image = await newDoc();
    const created = await text({
      image,
      op: 'create',
      text: 'Hello GIMP',
      x: 40,
      y: 30,
      font_size: 36,
      font_name: fontB,
      red: 200,
      green: 30,
      blue: 40,
      alignment: 'CENTER',
    });
    expect(created.isError, errorText(created)).toBeFalsy();
    const r = structuredOf(created) as unknown as TextResult;
    expect(r.name).toBeTruthy();
    expect(r.bounds).toMatchObject({ x: 40, y: 30 });
    expect(r.bounds.width).toBeGreaterThan(0);
    expect(r.bounds.height).toBeGreaterThan(0);

    const node = await textNode(image, r.layer_id);
    expect(node.is_text_layer).toBe(true);
    expect(node.text).toBe('Hello GIMP');
    expect(node.font).toBe(fontB);
    expect(node.font_size).toBeCloseTo(36, 1);
    expect(node.color).toEqual({ red: 200, green: 30, blue: 40 });
    expect(node.alignment).toBe('CENTER');
    expect(node.offsets).toEqual({ x: 40, y: 30 });
    // The new layer sits above the background.
    expect((await layerTree(image))[0]!.layer_id).toBe(r.layer_id);
  });

  it('create defaults to a sans at 24pt, black, left-aligned, at 100,100', async () => {
    const image = await newDoc();
    const created = await text({ image, op: 'create', text: 'Defaults' });
    expect(created.isError, errorText(created)).toBeFalsy();
    const r = structuredOf(created) as unknown as TextResult;
    expect(r.bounds).toMatchObject({ x: 100, y: 100 });
    expect(r.font).toBe(fontA);
    expect(r.font_size).toBeCloseTo(24, 1);
    expect(r.ppi).toBeGreaterThan(0);
    expect(r.font_size_px).toBeCloseTo((24 * r.ppi!) / 72, 0);
    expect(created.content[0]).toMatchObject({
      text: expect.stringContaining(`24 pt = ${r.font_size_px} px at ${r.ppi} ppi`),
    });
    expect(r.color).toEqual({ red: 0, green: 0, blue: 0 });
    expect(r.alignment).toBe('LEFT');
  });

  it('resolves a family name and a full name case-insensitively', async () => {
    const image = await newDoc();
    const created = await text({
      image,
      op: 'create',
      text: 'Case',
      font_name: fontB.toUpperCase(),
    });
    expect(created.isError, errorText(created)).toBeFalsy();
    expect((structuredOf(created) as unknown as TextResult).font).toBe(fontB);
  });

  it('each set_* op changes its own property and reads back through describe', async () => {
    const image = await newDoc();
    const created = await text({ image, op: 'create', text: 'Before', font_name: fontA });
    const id = (structuredOf(created) as unknown as TextResult).layer_id;

    const content = await text({
      image,
      op: 'set_content',
      layer_id: id,
      text: 'After\nTwo lines',
    });
    expect(content.isError, errorText(content)).toBeFalsy();
    expect((await textNode(image, id)).text).toBe('After\nTwo lines');

    const font = await text({
      image,
      op: 'set_font',
      layer_id: id,
      font_name: fontB,
      font_size: 40,
    });
    expect(font.isError, errorText(font)).toBeFalsy();
    const sized = structuredOf(font) as unknown as TextResult;
    expect(sized.font_size_px).toBeCloseTo((40 * sized.ppi!) / 72, 0);
    let node = await textNode(image, id);
    expect(node.font).toBe(fontB);
    expect(node.font_size).toBeCloseTo(40, 1);

    // set_font without a size keeps the current size.
    const fontOnly = await text({ image, op: 'set_font', layer_id: id, font_name: fontA });
    expect(fontOnly.isError, errorText(fontOnly)).toBeFalsy();
    node = await textNode(image, id);
    expect(node.font).toBe(fontA);
    expect(node.font_size).toBeCloseTo(40, 1);

    const color = await text({
      image,
      op: 'set_color',
      layer_id: id,
      red: 10,
      green: 120,
      blue: 250,
    });
    expect(color.isError, errorText(color)).toBeFalsy();
    expect((await textNode(image, id)).color).toEqual({ red: 10, green: 120, blue: 250 });

    for (const alignment of ['RIGHT', 'CENTER', 'FULLYJUSTIFIED', 'LEFT']) {
      const aligned = await text({ image, op: 'set_alignment', layer_id: id, alignment });
      expect(aligned.isError, errorText(aligned)).toBeFalsy();
      expect((await textNode(image, id)).alignment).toBe(alignment);
    }

    // Addressing by layer name works too.
    const byName = await text({
      image,
      op: 'set_content',
      layer: (await textNode(image, id)).name,
      text: 'By name',
    });
    expect(byName.isError, errorText(byName)).toBeFalsy();
    expect((await textNode(image, id)).text).toBe('By name');
  });

  it('exports non-background pixels where the text is, in the requested colour', async () => {
    const image = await newDoc(500, 260);
    const created = await text({
      image,
      op: 'create',
      text: 'HHHH',
      x: 60,
      y: 60,
      font_size: 40,
      font_name: fontA,
      red: 220,
      green: 20,
      blue: 20,
    });
    expect(created.isError, errorText(created)).toBeFalsy();
    const b = (structuredOf(created) as unknown as TextResult).bounds;
    const png = readPng(await exportPng(image, 'text-pixels'));
    expect(png.width).toBe(500);

    let inked = 0;
    let reddest = 0;
    for (let y = b.y; y < b.y + b.height && y < png.height; y++) {
      for (let x = b.x; x < b.x + b.width && x < png.width; x++) {
        const [r, g, bl] = pixelAt(png, x, y);
        if (r < 250 || g < 250 || bl < 250) inked++;
        if (Math.abs(r - 220) <= 3 && Math.abs(g - 20) <= 3 && Math.abs(bl - 20) <= 3) reddest++;
      }
    }
    expect(inked).toBeGreaterThan(50);
    expect(reddest).toBeGreaterThan(20);
    // Far from the text the background is still white.
    expect(pixelAt(png, 5, 5)).toEqual([255, 255, 255]);
    expect(pixelAt(png, png.width - 5, png.height - 5)).toEqual([255, 255, 255]);
  });

  it('refuses a set_* op on a non-text layer and leaves the document unchanged', async () => {
    const image = await newDoc();
    const before = await layerTree(image);
    const background = before[before.length - 1]!;
    expect(background.is_text_layer).toBe(false);
    for (const args of [
      { op: 'set_content', text: 'x' },
      { op: 'set_font', font_name: fontA },
      { op: 'set_color', red: 1, green: 2, blue: 3 },
      { op: 'set_alignment', alignment: 'LEFT' },
    ]) {
      const refused = await text({ image, layer_id: background.layer_id, ...args });
      expect(refused.isError, `${args.op} should be refused`).toBe(true);
      expect(errorText(refused)).toMatch(/not a text layer/);
    }
    expect(await layerTree(image)).toEqual(before);
  });

  it('refuses a missing font with the closest installed names, creating nothing', async () => {
    const image = await newDoc();
    const before = await layerTree(image);
    const refused = await text({
      image,
      op: 'create',
      text: 'x',
      font_name: `${fontA.slice(0, 4)}-no-such-font`,
    });
    expect(refused.isError).toBe(true);
    const message = errorText(refused);
    expect(message).toMatch(/no installed font matches/);
    expect(message).toMatch(/Closest installed names/);
    expect(message).toContain(fontA);
    expect(await layerTree(image)).toEqual(before);

    const created = await text({ image, op: 'create', text: 'kept', font_name: fontA });
    const id = (structuredOf(created) as unknown as TextResult).layer_id;
    const treeWithText = await layerTree(image);
    const setRefused = await text({
      image,
      op: 'set_font',
      layer_id: id,
      font_name: 'Nonexistent Face',
    });
    expect(setRefused.isError).toBe(true);
    expect(errorText(setRefused)).toMatch(/Closest installed names/);
    expect(await layerTree(image)).toEqual(treeWithText);
  });

  it('refuses an oversized font or text and leaves the document unchanged', async () => {
    const image = await newDoc();
    const before = await layerTree(image);

    const hugeFont = await text({
      image,
      op: 'create',
      text: 'W'.repeat(60),
      font_size: 1296,
      font_name: fontA,
    });
    expect(hugeFont.isError).toBe(true);
    // Refused by the pre-render estimate, before anything is drawn at full size.
    expect(errorText(hugeFont)).toMatch(/would render as about \d+x\d+ px, past the size limit/);
    expect(await layerTree(image)).toEqual(before);

    const tooLong = await text({ image, op: 'create', text: 'a'.repeat(2001) });
    expect(tooLong.isError).toBe(true);
    expect(errorText(tooLong)).toMatch(/at most 2000 characters/);
    expect(await layerTree(image)).toEqual(before);

    // An edit that would blow the layer past the cap is rolled back.
    const created = await text({
      image,
      op: 'create',
      text: 'W',
      font_size: 200,
      font_name: fontA,
    });
    expect(created.isError, errorText(created)).toBeFalsy();
    const id = (structuredOf(created) as unknown as TextResult).layer_id;
    const treeWithText = await layerTree(image);
    const hugeContent = await text({
      image,
      op: 'set_content',
      layer_id: id,
      text: 'W'.repeat(2000),
    });
    expect(hugeContent.isError).toBe(true);
    expect(errorText(hugeContent)).toMatch(/would render as about \d+x\d+ px, past the size limit/);
    expect(await layerTree(image)).toEqual(treeWithText);
  });

  it('refuses set_* on a markup layer and reports it without its text', async () => {
    const image = await newDoc();
    const created = await text({ image, op: 'create', text: 'plain', font_name: fontA });
    const id = (structuredOf(created) as unknown as TextResult).layer_id;
    await backend.call('test_set_text_markup', { image, layer_id: id, markup: '<b>bold</b> rest' });
    const node = await textNode(image, id);
    expect(node.is_text_layer).toBe(true);
    expect((node as unknown as { has_markup: boolean }).has_markup).toBe(true);
    expect(node.text).toBe('');
    const before = await layerTree(image);
    for (const args of [
      { op: 'set_content', text: 'x' },
      { op: 'set_font', font_name: fontA },
      { op: 'set_color', red: 1, green: 2, blue: 3 },
      { op: 'set_alignment', alignment: 'LEFT' },
    ]) {
      const refused = await text({ image, layer_id: id, ...args });
      expect(refused.isError, `${args.op} should be refused`).toBe(true);
      expect(errorText(refused)).toMatch(/markup/);
    }
    expect(await layerTree(image)).toEqual(before);
  });

  it('caps the text describe and results report, with the full length alongside', async () => {
    const image = await newDoc(2000, 1000);
    const long = 'ab '.repeat(600).slice(0, 1500);
    const created = await text({ image, op: 'create', text: long, font_size: 6, font_name: fontA });
    expect(created.isError, errorText(created)).toBeFalsy();
    const result = structuredOf(created) as unknown as TextResult & {
      text_length: number;
      text_truncated: boolean;
    };
    expect(result.text.length).toBe(200);
    expect(result.text_length).toBe(1500);
    expect(result.text_truncated).toBe(true);
    const node = (await textNode(image, result.layer_id)) as unknown as {
      text: string;
      text_length: number;
      text_truncated: boolean;
    };
    expect([node.text.length, node.text_length, node.text_truncated]).toEqual([200, 1500, true]);
  });

  it('refuses the alignments GIMP cannot do, and partial colours', async () => {
    const image = await newDoc();
    const created = await text({ image, op: 'create', text: 'x' });
    const id = (structuredOf(created) as unknown as TextResult).layer_id;
    const before = await layerTree(image);
    for (const alignment of ['LEFTJUSTIFIED', 'CENTERJUSTIFIED', 'RIGHTJUSTIFIED']) {
      const refused = await text({ image, op: 'set_alignment', layer_id: id, alignment });
      expect(refused.isError, alignment).toBe(true);
      expect(errorText(refused)).toMatch(/not supported by GIMP text layers/);
    }
    const partial = await text({ image, op: 'set_color', layer_id: id, red: 5 });
    expect(partial.isError).toBe(true);
    expect(await layerTree(image)).toEqual(before);
  });
  describe('box and fit (the test image is 300 ppi, so 10 pt is about 42 px)', () => {
    const LONG =
      'The quick brown fox jumps over the lazy dog and keeps running far away over the hills';

    async function inkBox(image: number, tag: string, w: number, h: number) {
      const png = readPng(await exportPng(image, tag));
      let left = 99999;
      let right = -1;
      let top = 99999;
      let bottom = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const [r, g, b] = pixelAt(png, x, y);
          if (r < 128 && g < 128 && b < 128) {
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      }
      return { left, right, top, bottom };
    }

    it('wraps a long sentence inside a 400 px box and grows to the wrapped height', async () => {
      const image = await newDoc(800, 600);
      const single = await text({ image, op: 'create', text: 'Ag', font_size: 30, x: 0, y: 0 });
      const oneLine = (structuredOf(single) as unknown as TextResult).bounds.height;
      const created = await text({
        image,
        op: 'create',
        text: LONG,
        font_size: 30,
        x: 10,
        y: 10,
        box: { width: 400 },
      });
      expect(created.isError, errorText(created)).toBeFalsy();
      const r = structuredOf(created) as unknown as TextResult;
      expect(r.bounds.width).toBe(400);
      expect(r.bounds.height).toBeGreaterThanOrEqual(oneLine * 2);
      expect(r.box).toEqual({ width: 400, height: r.bounds.height });
      expect(r.bounds).toMatchObject({ x: 10, y: 10 });
      // The grown height is a whole number of lines.
      const lines = Math.round(r.bounds.height / oneLine);
      expect(Math.abs(r.bounds.height - lines * oneLine)).toBeLessThanOrEqual(lines);
    });

    it('keeps explicit newlines', async () => {
      const image = await newDoc(800, 600);
      const one = await text({
        image,
        op: 'create',
        text: 'ab',
        font_size: 30,
        box: { width: 700 },
      });
      const three = await text({
        image,
        op: 'create',
        text: 'ab\n\nab',
        font_size: 30,
        box: { width: 700 },
      });
      const h1 = (structuredOf(one) as unknown as TextResult).bounds.height;
      const h3 = (structuredOf(three) as unknown as TextResult).bounds.height;
      expect(h3).toBeGreaterThan(h1 * 2.5);
    });

    it('fit shrinks a long caption into 600x150 and keeps a short one at the requested size', async () => {
      const image = await newDoc(800, 400);
      const long = await text({
        image,
        op: 'create',
        text: LONG + ' ' + LONG,
        font_size: 60,
        x: 0,
        y: 0,
        box: { width: 600, height: 150 },
        fit: true,
      });
      expect(long.isError, errorText(long)).toBeFalsy();
      const lr = structuredOf(long) as unknown as TextResult;
      expect(lr.fitted).toBe(true);
      expect(lr.bounds).toMatchObject({ width: 600, height: 150 });
      expect(lr.font_size_px).toBeLessThan(60);
      expect(lr.font_size_px).toBeGreaterThan(10);
      expect(lr.fit_probes!).toBeLessThanOrEqual(12);
      console.log(`fit: ${lr.font_size_px}px in ${lr.fit_probes} probes, ${lr.fit_seconds}s`);

      // The fitted text is not clipped: its ink ends above the box bottom and fills most of it.
      const ink = await inkBox(image, 'fit-ink', 800, 400);
      expect(ink.bottom).toBeGreaterThan(75);
      expect(ink.bottom).toBeLessThan(150);
      expect(ink.right).toBeLessThan(600);

      const short = await text({
        image,
        op: 'create',
        text: 'Short',
        font_size: 10,
        x: 0,
        y: 200,
        box: { width: 600, height: 150 },
        fit: true,
      });
      const sr = structuredOf(short) as unknown as TextResult;
      expect(sr.fitted).toBe(true);
      expect(sr.font_size).toBeCloseTo(10, 1);
      expect(sr.fit_probes).toBe(1);
    });

    it('an impossible fit reports fitted false and leaves the text at min_size', async () => {
      const image = await newDoc(800, 400);
      const created = await text({
        image,
        op: 'create',
        text: LONG + ' ' + LONG + ' ' + LONG,
        font_size: 60,
        box: { width: 100, height: 20 },
        fit: true,
        min_size: 12,
      });
      expect(created.isError, errorText(created)).toBeFalsy();
      const r = structuredOf(created) as unknown as TextResult;
      expect(r.fitted).toBe(false);
      expect(r.font_size_px).toBeCloseTo(12, 0);
      expect(r.bounds).toMatchObject({ width: 100, height: 20 });
      expect(JSON.stringify(created.content)).toMatch(/Does NOT fit/);
    });

    it('set_box re-wraps an existing layer; content edits keep the box; fit works on it', async () => {
      const image = await newDoc(800, 600);
      const created = await text({ image, op: 'create', text: LONG, font_size: 30, x: 0, y: 0 });
      const c = structuredOf(created) as unknown as TextResult;
      const boxed = await text({ image, op: 'set_box', layer_id: c.layer_id, box: { width: 300 } });
      expect(boxed.isError, errorText(boxed)).toBeFalsy();
      const b = structuredOf(boxed) as unknown as TextResult;
      expect(b.bounds.width).toBe(300);
      expect(b.bounds.height).toBeGreaterThan(c.bounds.height * 2);

      const edited = await text({
        image,
        op: 'set_content',
        layer_id: c.layer_id,
        text: 'a shorter caption',
      });
      expect(edited.isError, errorText(edited)).toBeFalsy();
      expect((structuredOf(edited) as unknown as TextResult).bounds).toMatchObject({
        width: 300,
        height: b.bounds.height,
      });

      const centered = await text({
        image,
        op: 'set_alignment',
        layer_id: c.layer_id,
        alignment: 'CENTER',
      });
      expect(centered.isError, errorText(centered)).toBeFalsy();
      expect((structuredOf(centered) as unknown as TextResult).bounds.width).toBe(300);
      expect((await textNode(image, c.layer_id)).alignment).toBe('CENTER');

      const fitted = await text({
        image,
        op: 'set_box',
        layer_id: c.layer_id,
        box: { width: 300, height: 40 },
        fit: true,
        font_size: 60,
      });
      expect(fitted.isError, errorText(fitted)).toBeFalsy();
      const f = structuredOf(fitted) as unknown as TextResult;
      expect(f.fitted).toBe(true);
      expect(f.bounds).toMatchObject({ width: 300, height: 40 });
    });

    // Right, centered and filled lines end at the box's right edge; fit must not read that as
    // overflow. Alignment does not change line breaks, so every alignment fits at one size.
    it('fit sizes right, centered and filled text the same as left, and keeps the alignment', async () => {
      const sizes: Record<string, number> = {};
      for (const alignment of ['LEFT', 'RIGHT', 'CENTER', 'FULLYJUSTIFIED']) {
        const image = await newDoc(800, 400);
        const created = await text({
          image,
          op: 'create',
          text: LONG + ' ' + LONG,
          font_size: 60,
          x: 0,
          y: 0,
          box: { width: 600, height: 150 },
          fit: true,
          alignment,
        });
        expect(created.isError, errorText(created)).toBeFalsy();
        const r = structuredOf(created) as unknown as TextResult;
        expect(r.fitted, alignment).toBe(true);
        sizes[alignment] = r.font_size_px;
        expect((await textNode(image, r.layer_id)).alignment).toBe(alignment);
      }
      for (const alignment of ['RIGHT', 'CENTER', 'FULLYJUSTIFIED']) {
        expect(sizes[alignment], alignment).toBeCloseTo(sizes.LEFT!, 0);
      }
    });

    // The boxed tag outlives a switch back to dynamic text. An edit that trusts it skips the
    // pre-render size estimate, so it must put the layer back in its box first.
    it('a layer tagged as boxed but not in box mode stays bounded through a content edit', async () => {
      const image = await newDoc(800, 400);
      const created = await text({ image, op: 'create', text: 'short', font_size: 30, x: 0, y: 0 });
      const c = structuredOf(created) as unknown as TextResult;
      await backend.call('test_tag_text_box', { image, layer_id: c.layer_id });
      const edited = await text({
        image,
        op: 'set_content',
        layer_id: c.layer_id,
        text: (LONG + ' ').repeat(20),
      });
      expect(edited.isError, errorText(edited)).toBeFalsy();
      expect((structuredOf(edited) as unknown as TextResult).bounds).toMatchObject({
        width: c.bounds.width,
        height: c.bounds.height,
      });
    });

    it('centered text in a box is centered about the box middle', async () => {
      const image = await newDoc(500, 200);
      const created = await text({
        image,
        op: 'create',
        text: 'hi',
        font_size: 30,
        x: 0,
        y: 0,
        box: { width: 400, height: 100 },
        alignment: 'CENTER',
      });
      expect(created.isError, errorText(created)).toBeFalsy();
      const ink = await inkBox(image, 'center-ink', 500, 200);
      expect(ink.right).toBeGreaterThan(ink.left);
      expect(Math.abs((ink.left + ink.right) / 2 - 200)).toBeLessThan(12);
    });

    it('an outline effect still attaches to a boxed text layer', async () => {
      const image = await newDoc(500, 300);
      const created = await text({
        image,
        op: 'create',
        text: 'Outlined caption',
        font_size: 40,
        box: { width: 300, height: 120 },
      });
      const id = (structuredOf(created) as unknown as TextResult).layer_id;
      const effect = await callTool(tools, 'gimp_add_effect', {
        image,
        layer_id: id,
        type: 'outline',
        width: 3,
        color: '#ff0000',
      });
      expect(effect.isError, errorText(effect)).toBeFalsy();
      expect((await textNode(image, id)).is_text_layer).toBe(true);
    });

    const CAPTION_1500 = 'word '.repeat(300);
    // 60 short lines: harmless at a small size, past the probe cap at a large one.
    const LINES_60 = Array(60).fill('word').join(String.fromCharCode(10));

    it('set_content with a 1500-char caption succeeds on a boxed 300 px layer and keeps the box', async () => {
      const image = await newDoc(800, 600);
      const created = await text({
        image,
        op: 'create',
        text: 'short',
        font_size: 30,
        box: { width: 300, height: 400 },
      });
      const id = (structuredOf(created) as unknown as TextResult).layer_id;
      const edited = await text({ image, op: 'set_content', layer_id: id, text: CAPTION_1500 });
      expect(edited.isError, errorText(edited)).toBeFalsy();
      expect((structuredOf(edited) as unknown as TextResult).bounds).toMatchObject({
        width: 300,
        height: 400,
      });
      const font = await text({ image, op: 'set_font', layer_id: id, font_name: fontB });
      expect(font.isError, errorText(font)).toBeFalsy();
      expect((structuredOf(font) as unknown as TextResult).bounds).toMatchObject({
        width: 300,
        height: 400,
      });
    });

    it('a layer boxed by set_box is boxed for later edits too', async () => {
      const image = await newDoc(800, 600);
      const created = await text({ image, op: 'create', text: 'short', font_size: 30 });
      const id = (structuredOf(created) as unknown as TextResult).layer_id;
      const boxed = await text({
        image,
        op: 'set_box',
        layer_id: id,
        box: { width: 300, height: 200 },
      });
      expect(boxed.isError, errorText(boxed)).toBeFalsy();
      const edited = await text({ image, op: 'set_content', layer_id: id, text: CAPTION_1500 });
      expect(edited.isError, errorText(edited)).toBeFalsy();
      expect((structuredOf(edited) as unknown as TextResult).bounds).toMatchObject({
        width: 300,
        height: 200,
      });
    });

    it('a boxed layer is still treated as boxed after save and reopen', async () => {
      const image = await newDoc(800, 600);
      await text({
        image,
        op: 'create',
        text: 'short',
        font_size: 30,
        box: { width: 300, height: 200 },
      });
      const xcf = join(workDir, 'boxed-text.xcf');
      const saved = await callTool(tools, 'gimp_save_xcf', { image, file_path: xcf });
      expect(saved.isError, errorText(saved)).toBeFalsy();
      const opened = await callTool(tools, 'gimp_open_document', { file_path: xcf });
      expect(opened.isError, errorText(opened)).toBeFalsy();
      const reopened = structuredOf(opened).image as number;
      const node = (await layerTree(reopened)).find((n) => n.is_text_layer);
      expect(node).toBeDefined();
      const edited = await text({
        image: reopened,
        op: 'set_content',
        layer_id: node!.layer_id,
        text: CAPTION_1500,
      });
      expect(edited.isError, errorText(edited)).toBeFalsy();
      expect((structuredOf(edited) as unknown as TextResult).bounds).toMatchObject({
        width: 300,
        height: 200,
      });
    });

    it('a set_box that fails leaves a previously dynamic layer dynamic and unchanged', async () => {
      const image = await newDoc(800, 600);
      const created = await text({
        image,
        op: 'create',
        text: LINES_60,
        font_size: 12,
        x: 20,
        y: 30,
      });
      const before = structuredOf(created) as unknown as TextResult;
      // One character per line at this size runs past the scan cap: refused mid-way.
      const failed = await text({
        image,
        op: 'set_box',
        layer_id: before.layer_id,
        box: { width: 400 },
        font_size: 200,
      });
      expect(failed.isError).toBe(true);
      const after = await textNode(image, before.layer_id);
      expect(after.text).toBe(before.text);
      expect(after.font_size).toBeCloseTo(before.font_size, 1);
      expect(after.offsets).toEqual({ x: 20, y: 30 });
      // Still dynamic: a longer text grows the layer instead of being clipped to a box.
      const grown = await text({
        image,
        op: 'set_content',
        layer_id: before.layer_id,
        text: LINES_60 + '\nand a second, much wider line to widen the layer a lot',
      });
      expect(grown.isError, errorText(grown)).toBeFalsy();
      const g = structuredOf(grown) as unknown as TextResult;
      expect(g.bounds.width).toBeGreaterThan(0);
      expect(g.bounds.height).toBeGreaterThan(before.bounds.height);
    });

    it('a set_box that fails leaves a previously boxed layer in its old box', async () => {
      const image = await newDoc(800, 600);
      const created = await text({
        image,
        op: 'create',
        text: LINES_60,
        font_size: 12,
        box: { width: 400, height: 250 },
      });
      const before = structuredOf(created) as unknown as TextResult;
      const failed = await text({
        image,
        op: 'set_box',
        layer_id: before.layer_id,
        box: { width: 400 },
        font_size: 200,
      });
      expect(failed.isError).toBe(true);
      const after = await textNode(image, before.layer_id);
      expect(after.font_size).toBeCloseTo(before.font_size, 1);
      const edited = await text({
        image,
        op: 'set_content',
        layer_id: before.layer_id,
        text: CAPTION_1500,
      });
      expect(edited.isError, errorText(edited)).toBeFalsy();
      expect((structuredOf(edited) as unknown as TextResult).bounds).toMatchObject({
        width: 400,
        height: 250,
      });
    });

    it('set_box with a huge font_size on a dynamic layer is refused, not rendered unwrapped', async () => {
      const image = await newDoc(800, 600);
      const created = await text({
        image,
        op: 'create',
        text: LINES_60,
        font_size: 8,
        x: 5,
        y: 5,
      });
      const before = structuredOf(created) as unknown as TextResult;
      const started = Date.now();
      const refused = await text({
        image,
        op: 'set_box',
        layer_id: before.layer_id,
        box: { width: 400 },
        font_size: 1296,
      });
      expect(refused.isError).toBe(true);
      expect(Date.now() - started).toBeLessThan(30_000);
      const after = await textNode(image, before.layer_id);
      expect(after.font_size).toBeCloseTo(before.font_size, 1);
    });

    it('fit refuses a box past 16 MP and the text-box area cap bounds create / set_box', async () => {
      const image = await newDoc(400, 300);
      const before = await layerTree(image);
      const fit = await text({
        image,
        op: 'create',
        text: 'x',
        box: { width: 5000, height: 4000 },
        fit: true,
      });
      expect(fit.isError).toBe(true);
      expect(errorText(fit)).toMatch(/fit supports a box of at most 16 MP/);
      const area = await text({
        image,
        op: 'create',
        text: 'x',
        box: { width: 10000, height: 7000 },
      });
      expect(area.isError).toBe(true);
      expect(errorText(area)).toMatch(/text box|MP/);
      expect(await layerTree(image)).toEqual(before);

      const small = await text({ image, op: 'create', text: 'x', font_size: 12 });
      const id = (structuredOf(small) as unknown as TextResult).layer_id;
      const tree = await layerTree(image);
      const setArea = await text({
        image,
        op: 'set_box',
        layer_id: id,
        box: { width: 10000, height: 7000 },
      });
      expect(setArea.isError).toBe(true);
      expect(await layerTree(image)).toEqual(tree);
    });

    it('fit treats a glyph wider than the box as not fitting', async () => {
      const image = await newDoc(400, 300);
      const created = await text({
        image,
        op: 'create',
        text: 'WWW',
        font_size: 60,
        box: { width: 8, height: 400 },
        fit: true,
        min_size: 40,
      });
      expect(created.isError, errorText(created)).toBeFalsy();
      const r = structuredOf(created) as unknown as TextResult;
      expect(r.fitted).toBe(false);
      expect(r.font_size_px).toBeCloseTo(40, 0);
    });

    it('refuses bad box and fit arguments without changing the document', async () => {
      const image = await newDoc();
      const before = await layerTree(image);
      for (const extra of [
        { box: { width: 0 } },
        { box: { width: 30001 } },
        { box: { width: 100, height: 0 } },
        { box: { height: 100 } },
        { fit: true },
        { fit: true, box: { width: 100 } },
        { min_size: 10 },
        { box: { width: 30000, height: 30000 } },
      ]) {
        const refused = await text({ image, op: 'create', text: 'x', ...extra });
        expect(refused.isError, JSON.stringify(extra)).toBe(true);
      }
      expect(await layerTree(image)).toEqual(before);
    });
  });
});
