import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGimpDocumentTools,
  EXPORT_SCHEMA_FOR_TESTS,
  EXPORT_FORMAT_EXTENSIONS,
} from '@editmamei/tools/gimp-document-tools.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const scratchDir = mkdtempSync(join(tmpdir(), 'gimp-document-tools-test-'));
afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));

/**
 * `requireAbsoluteGimpPath` (the tool layer's absolute-path gate every
 * gimp_* handler calls) defaults to `process.platform` when the handler
 * doesn't pass one explicitly — a real GIMP session only ever runs on the
 * host it started on, so there's no `platform` param to inject through a
 * tool schema the way `tool-helpers.test.ts` can inject it directly. These
 * tests exercise that gate through the real tool handlers, so every example
 * path must be absolute on WHATEVER platform the suite is actually running
 * on — a hardcoded Windows-style `C:/...` literal is not absolute under
 * POSIX and fails every one of these on a macOS CI runner.
 */
const absPath = (suffix: string): string =>
  process.platform === 'win32' ? `C:/${suffix}` : `/${suffix}`;

describe('createGimpDocumentTools', () => {
  it('returns 4 well-formed tools with these names', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpDocumentTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name).sort()).toEqual([
      'gimp_close_document',
      'gimp_export',
      'gimp_open_document',
      'gimp_save_xcf',
    ]);
    assertToolShape(tools);
  });

  describe('gimp_open_document', () => {
    it('requires file_path', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpDocumentTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_open_document', {});
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('rejects a relative path before dispatching', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpDocumentTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_open_document', { file_path: 'photo.jpg' });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]).toMatchObject({ type: 'text' });
      expect((result.content?.[0] as { text: string }).text).toMatch(/absolute/);
      expect(gimp.calls).toHaveLength(0);
    });

    it('dispatches open with path + precision, and reports the returned shape', async () => {
      const gimp = makeGimpBackend({
        result: {
          image: 7,
          width: 800,
          height: 600,
          base_type: 'rgb',
          precision: 'u8-non-linear',
          layers: ['Background'],
        },
      });
      const tools = createGimpDocumentTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_open_document', {
        file_path: absPath('photos/dog.jpg'),
        precision: '16',
      });
      expect(gimp.lastCall()).toEqual({
        op: 'open',
        args: { path: absPath('photos/dog.jpg'), precision: '16' },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ image: 7, width: 800, height: 600 });
    });

    it('maps a gimp_unsupported_file bridge error through toolGimpErrorResult', async () => {
      const gimp = makeGimpBackend({
        throwFor: () =>
          new Error('gimp_unsupported_file: GIMP could not open this .dng file (no raw loader)'),
      });
      const tools = createGimpDocumentTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_open_document', {
        file_path: absPath('photos/raw.dng'),
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('gimp_unsupported_file');
    });
  });

  describe('gimp_close_document', () => {
    it('requires image', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpDocumentTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_close_document', {});
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('dispatches close with image', async () => {
      const gimp = makeGimpBackend({ result: { closed: 3 } });
      const tools = createGimpDocumentTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_close_document', { image: 3 });
      expect(gimp.lastCall()).toEqual({ op: 'close', args: { image: 3 } });
      expect(result.structuredContent).toEqual({ closed: 3 });
    });
  });

  describe('gimp_save_xcf', () => {
    it('requires image and file_path', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpDocumentTools(gimp.asBackend());
      expect(
        (await callTool(tools, 'gimp_save_xcf', { file_path: absPath('out.xcf') })).isError
      ).toBe(true);
      expect((await callTool(tools, 'gimp_save_xcf', { image: 1 })).isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('rejects a non-.xcf extension', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpDocumentTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_save_xcf', {
        image: 1,
        file_path: absPath('out.psd'),
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toMatch(/\.xcf/);
      expect(gimp.calls).toHaveLength(0);
    });

    it("dispatches op 'export' with the .xcf path", async () => {
      const gimp = makeGimpBackend({ result: { path: absPath('out.xcf'), bytes: 1234 } });
      const tools = createGimpDocumentTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_save_xcf', {
        image: 1,
        file_path: absPath('out.xcf'),
      });
      expect(gimp.lastCall()).toEqual({
        op: 'export',
        args: { image: 1, path: absPath('out.xcf') },
      });
      expect(result.structuredContent).toEqual({ path: absPath('out.xcf'), bytes: 1234 });
    });

    it('refuses to overwrite an existing file unless overwrite: true', async () => {
      const existingPath = join(scratchDir, 'existing.xcf');
      writeFileSync(existingPath, 'x');
      const gimp = makeGimpBackend({ result: { path: existingPath, bytes: 1 } });
      const tools = createGimpDocumentTools(gimp.asBackend());
      const refused = await callTool(tools, 'gimp_save_xcf', { image: 1, file_path: existingPath });
      expect(refused.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
      const allowed = await callTool(tools, 'gimp_save_xcf', {
        image: 1,
        file_path: existingPath,
        overwrite: true,
      });
      expect(allowed.isError).toBeFalsy();
      expect(gimp.calls).toHaveLength(1);
    });
  });

  describe('gimp_export', () => {
    it('requires file_path (image given alone)', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpDocumentTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_export', { image: 1 });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('requires image (file_path given alone)', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpDocumentTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_export', { file_path: absPath('out.jpg') });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it("refuses a .xcf file_path (that is gimp_save_xcf's job)", async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpDocumentTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_export', {
        image: 1,
        file_path: absPath('out.xcf'),
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toMatch(/gimp_save_xcf/);
      expect(gimp.calls).toHaveLength(0);
    });

    it('forwards only jpeg-relevant options for a .jpg path', async () => {
      const gimp = makeGimpBackend({ result: { path: absPath('out.jpg'), bytes: 500 } });
      const tools = createGimpDocumentTools(gimp.asBackend());
      await callTool(tools, 'gimp_export', {
        image: 1,
        file_path: absPath('out.jpg'),
        quality: 80,
        png_compression: 9, // should be dropped — irrelevant to jpeg
      });
      expect(gimp.lastCall()).toEqual({
        op: 'export',
        args: { image: 1, path: absPath('out.jpg'), quality: 80 },
      });
    });

    it('forwards only png-relevant options (compression + bit_depth) for a .png path', async () => {
      const gimp = makeGimpBackend({ result: { path: absPath('out.png'), bytes: 500 } });
      const tools = createGimpDocumentTools(gimp.asBackend());
      await callTool(tools, 'gimp_export', {
        image: 1,
        file_path: absPath('out.png'),
        png_compression: 5,
        bit_depth: 16,
        quality: 50, // irrelevant to png — should be dropped
      });
      expect(gimp.lastCall()).toEqual({
        op: 'export',
        args: { image: 1, path: absPath('out.png'), compression: 5, bit_depth: 16 },
      });
    });

    it('forwards only tiff-relevant options (compression enum + bit_depth) for a .tif path', async () => {
      const gimp = makeGimpBackend({ result: { path: absPath('out.tif'), bytes: 500 } });
      const tools = createGimpDocumentTools(gimp.asBackend());
      await callTool(tools, 'gimp_export', {
        image: 1,
        file_path: absPath('out.tif'),
        tiff_compression: 'lzw',
        bit_depth: 8,
      });
      expect(gimp.lastCall()).toEqual({
        op: 'export',
        args: { image: 1, path: absPath('out.tif'), compression: 'lzw', bit_depth: 8 },
      });
    });

    it('forwards only webp-relevant options (quality + lossless) for a .webp path', async () => {
      const gimp = makeGimpBackend({ result: { path: absPath('out.webp'), bytes: 500 } });
      const tools = createGimpDocumentTools(gimp.asBackend());
      await callTool(tools, 'gimp_export', {
        image: 1,
        file_path: absPath('out.webp'),
        quality: 70,
        lossless: true,
      });
      expect(gimp.lastCall()).toEqual({
        op: 'export',
        args: { image: 1, path: absPath('out.webp'), quality: 70, lossless: true },
      });
    });

    it('refuses to overwrite an existing file unless overwrite: true', async () => {
      const existingPath = join(scratchDir, 'existing.jpg');
      writeFileSync(existingPath, 'x');
      const gimp = makeGimpBackend({ result: { path: existingPath, bytes: 1 } });
      const tools = createGimpDocumentTools(gimp.asBackend());
      const refused = await callTool(tools, 'gimp_export', { image: 1, file_path: existingPath });
      expect(refused.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('reports format in structuredContent, derived from the extension (not the bridge)', async () => {
      const gimp = makeGimpBackend({ result: { path: absPath('out.png'), bytes: 500 } });
      const tools = createGimpDocumentTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_export', {
        image: 1,
        file_path: absPath('out.png'),
      });
      expect(result.structuredContent).toEqual({
        path: absPath('out.png'),
        bytes: 500,
        format: 'png',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// gimp_export schema-bounds drift test — cross-checks the TS schema's export
// option bounds/enums against bridge/lib.py's constants and bridge/ops.py's
// `_export_stripped` validators, read as source text (the bridge is Python;
// this suite can't import it directly). Mirrors gimp-adjustment-tools.test.ts's
// drift test for the adjustment schema.
// ---------------------------------------------------------------------------
describe('gimp_export schema matches the bridge export options exactly', () => {
  const LIB_PY = readFileSync(
    join(REPO_ROOT, 'src', 'backends', 'gimp', 'bridge', 'lib.py'),
    'utf8'
  );
  const OPS_PY = readFileSync(
    join(REPO_ROOT, 'src', 'backends', 'gimp', 'bridge', 'ops.py'),
    'utf8'
  );

  it("EXPORT_FORMAT_EXTENSIONS matches lib.py EXPORT_FORMATS' keys exactly (both directions)", () => {
    const match = LIB_PY.match(/EXPORT_FORMATS = \{([^}]+)\}/s);
    expect(match, 'EXPORT_FORMATS not found in lib.py').toBeTruthy();
    const extensions = [...match![1].matchAll(/'(\.[a-z]+)':/g)].map((m) => m[1]);
    expect(extensions.length).toBeGreaterThan(0);
    expect([...EXPORT_FORMAT_EXTENSIONS].sort()).toEqual([...extensions].sort());
  });

  it('bit_depth schema enum matches lib.py BIT_DEPTHS exactly', () => {
    expect(LIB_PY).toMatch(/BIT_DEPTHS = \(8, 16\)/);
    expect(EXPORT_SCHEMA_FOR_TESTS.properties?.bit_depth?.enum).toEqual([8, 16]);
  });

  it('tiff_compression schema enum matches lib.py TIFF_COMPRESSIONS exactly', () => {
    const match = LIB_PY.match(/TIFF_COMPRESSIONS = \(([^)]+)\)/);
    expect(match, 'TIFF_COMPRESSIONS not found in lib.py').toBeTruthy();
    const values = match![1].match(/'([a-z0-9_]+)'/g)!.map((s) => s.slice(1, -1));
    expect(values.length).toBeGreaterThan(0);
    expect(EXPORT_SCHEMA_FOR_TESTS.properties?.tiff_compression?.enum).toEqual(values);
  });

  it("png_compression bounds (0..9) match ops.py's validate_int_range for the png export branch", () => {
    expect(OPS_PY).toMatch(
      /validate_int_range\('compression', options\.get\('compression', 3\), 0, 9\)/
    );
    expect(EXPORT_SCHEMA_FOR_TESTS.properties?.png_compression?.minimum).toBe(0);
    expect(EXPORT_SCHEMA_FOR_TESTS.properties?.png_compression?.maximum).toBe(9);
  });

  it("quality bounds (1..100) match ops.py's JPEG branch (the tighter of the two formats that share this field)", () => {
    expect(OPS_PY).toMatch(/pct_to_unit\('quality', options\.get\('quality', 90\), 1\.0, 100\.0\)/);
    // WebP's own bound is looser (0..100) — the schema intentionally uses the
    // tighter JPEG bound (see the quality field's own description).
    expect(OPS_PY).toMatch(
      /validate_range\('quality', options\.get\('quality', 90\), 0\.0, 100\.0\)/
    );
    expect(EXPORT_SCHEMA_FOR_TESTS.properties?.quality?.minimum).toBe(1);
    expect(EXPORT_SCHEMA_FOR_TESTS.properties?.quality?.maximum).toBe(100);
  });

  it('lossless is a boolean schema field (webp-only; bridge reads it via a bare bool())', () => {
    expect(OPS_PY).toMatch(/bool\(options\.get\('lossless', False\)\)/);
    expect(EXPORT_SCHEMA_FOR_TESTS.properties?.lossless?.type).toBe('boolean');
  });
});
