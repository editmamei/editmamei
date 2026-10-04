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
  color: { red: number; green: number; blue: number };
  alignment: string | null;
  bounds: { x: number; y: number; width: number; height: number };
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
});
