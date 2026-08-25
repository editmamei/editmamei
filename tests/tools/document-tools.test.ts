import { describe, it, expect, beforeEach } from 'vitest';
import { createDocumentTools } from '@editmamei/tools/document-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool, indexTools, textOf } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

describe('createDocumentTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection();
    snippetClient = makeSnippetClient();
  });

  it('returns 6 well-formed tools with expected names', () => {
    // 2026-06-20 Phase 1: export_jpeg + export_png consolidated into one
    // ps_export(format) tool. 2026-08-25: ps_document added at tier 'dev'.
    const tools = createDocumentTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    const names = tools.map((t) => t.tool.name);
    expect(names).toEqual([
      'ps_create_document',
      'ps_document',
      'ps_close_document',
      'ps_open_document',
      'ps_save_psd',
      'ps_export',
    ]);
  });

  // ---------- ps_document ----------

  it('document(op=list) reports every open document and which one is active', async () => {
    const listConn = makeConnection({
      resultFor: () => ({
        count: 2,
        documents: [
          {
            index: 0,
            id: 11,
            name: 'a.psd',
            path: 'C:/a.psd',
            saved: true,
            active: false,
            width_px: 100,
            height_px: 50,
          },
          {
            index: 1,
            id: 12,
            name: 'b.jpg',
            path: null,
            saved: false,
            active: true,
            width_px: 20,
            height_px: 30,
          },
        ],
        context: { hasDocument: true },
      }),
    });
    const tools = createDocumentTools(listConn.asConnection(), snippetClient);
    const res = await callTool(tools, 'ps_document', { op: 'list' });
    expect(snippetClient.lastBuild().name).toBe('listDocuments');
    const sc = res.structuredContent as { count: number; documents: Array<{ name: string }> };
    expect(sc.count).toBe(2);
    expect(sc.documents.map((d) => d.name)).toEqual(['a.psd', 'b.jpg']);
    // The summary has to surface the two things a recovering caller needs.
    expect(textOf(res)).toContain('ACTIVE');
    expect(textOf(res)).toContain('unsaved changes');
  });

  it('document(op=list) answers plainly when NOTHING is open — the recovery case', async () => {
    // The whole reason this op exists. Every other document snippet throws "No
    // document is open"; reporting the same error here would leave the caller
    // exactly as stuck as the failure that sent it here.
    const emptyConn = makeConnection({
      resultFor: () => ({ count: 0, documents: [], context: { hasDocument: false } }),
    });
    const tools = createDocumentTools(emptyConn.asConnection(), snippetClient);
    const res = await callTool(tools, 'ps_document', { op: 'list' });
    expect(res.isError).toBeUndefined();
    expect((res.structuredContent as { count: number }).count).toBe(0);
    expect(textOf(res)).toContain('No documents are open');
  });

  it('document(op=activate) forwards the selector to the snippet', async () => {
    const actConn = makeConnection({
      resultFor: () => ({ activated: true, id: 12, name: 'b.jpg', context: {} }),
    });
    const tools = createDocumentTools(actConn.asConnection(), snippetClient);
    await callTool(tools, 'ps_document', { op: 'activate', name: 'b.jpg' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('activateDocument');
    expect(build.params).toMatchObject({ name: 'b.jpg' });
  });

  it('document(op=activate) without a selector is a clean error, not a silent no-op', async () => {
    const tools = createDocumentTools(conn.asConnection(), snippetClient);
    const res = await callTool(tools, 'ps_document', { op: 'activate' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('needs a name or an id');
    // Nothing was dispatched to Photoshop.
    expect(conn.executions).toHaveLength(0);
  });

  it('close_document REFUSES an empty name rather than closing the active document', async () => {
    // The dangerous asymmetry: dropping an empty name downgrades "close the
    // document I named" into "close whatever is active", on a destructive op.
    // An agent that computed the name from a failed lookup would close the
    // user's working document.
    const tools = createDocumentTools(conn.asConnection(), snippetClient);
    const res = await callTool(tools, 'ps_close_document', { save: false, name: '' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('empty string');
    expect(conn.executions).toHaveLength(0);
  });

  it('document(op=activate) refuses an empty name too — same rule, both ops', async () => {
    const tools = createDocumentTools(conn.asConnection(), snippetClient);
    const res = await callTool(tools, 'ps_document', { op: 'activate', name: '' });
    expect(res.isError).toBe(true);
    // Assert the SPECIFIC message: activate would already error on a missing
    // selector, so `isError` alone passes with or without the empty-name check
    // and would not notice it being removed.
    expect(textOf(res)).toContain('empty string');
    expect(conn.executions).toHaveLength(0);
  });

  it('an activate failure names the operation that failed, not "reading documents"', async () => {
    const boomConn = makeConnection({
      resultFor: () => {
        throw new Error('No open document matches name "b.jpg". Open documents: a.psd');
      },
    });
    const tools = createDocumentTools(boomConn.asConnection(), snippetClient);
    const res = await callTool(tools, 'ps_document', { op: 'activate', name: 'b.jpg' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Error activating document');
  });

  it('close_document forwards a target when given one, and omits the keys when not', async () => {
    const tools = createDocumentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_close_document', { save: false, name: 'a.psd' });
    expect(snippetClient.lastBuild().params).toMatchObject({ save: false, name: 'a.psd' });

    await callTool(tools, 'ps_close_document', { save: false });
    // The key must be ABSENT, not undefined: a present key flips the Go emitter
    // from "close the active document" to "resolve a target".
    expect(snippetClient.lastBuild().params).not.toHaveProperty('name');
    expect(snippetClient.lastBuild().params).not.toHaveProperty('id');
  });

  it('create_document dispatches a script that creates a doc with the requested dimensions', async () => {
    const tools = createDocumentTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_create_document', {
      width: 1920,
      height: 1080,
      resolution: 144,
      color_mode: 'RGB',
    });
    expect(conn.executions).toHaveLength(1);
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('newDocument');
    expect(build.params.width).toBe(1920);
    expect(build.params.height).toBe(1080);
    expect(build.params.resolution).toBe(144);
    expect(build.params.colorMode).toBe('NewDocumentMode.RGB');
    expect(textOf(result)).toMatch(/Document created.*1920x1080.*144dpi.*RGB/);
  });

  it('create_document maps CMYK and Grayscale color modes', async () => {
    const tools = createDocumentTools(conn.asConnection(), snippetClient);

    await callTool(tools, 'ps_create_document', {
      width: 10,
      height: 10,
      color_mode: 'CMYK',
    });
    expect(snippetClient.lastBuild().params.colorMode).toBe('NewDocumentMode.CMYK');

    await callTool(tools, 'ps_create_document', {
      width: 10,
      height: 10,
      color_mode: 'Grayscale',
    });
    expect(snippetClient.lastBuild().params.colorMode).toBe('NewDocumentMode.GRAYSCALE');
  });

  it('close_document encodes the save flag', async () => {
    const tools = createDocumentTools(conn.asConnection(), snippetClient);

    await callTool(tools, 'ps_close_document', { save: true });
    expect(snippetClient.lastBuild().params.save).toBe(true);

    await callTool(tools, 'ps_close_document', { save: false });
    expect(snippetClient.lastBuild().params.save).toBe(false);
  });

  it('returns an error result when the connection throws', async () => {
    const failing = makeConnection({ throwOnExecute: new Error('detector boom') });
    const tools = createDocumentTools(failing.asConnection(), makeSnippetClient());
    const result = await callTool(tools, 'ps_create_document', { width: 1, height: 1 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('detector boom');
  });

  // Phase 3c — ps_open_document gets an explicit 120s budget (centralized in
  // src/utils/operation-timeouts.ts) instead of the bare 30s executor
  // default that was silently truncating slow first-Camera-Raw-init opens.
  it('open_document passes a 120s timeout budget to the executor', async () => {
    const tools = createDocumentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_open_document', { file_path: 'C:/test.jpg' });
    expect(conn.lastTimeout()).toBe(120000);
  });

  // Phase 3b — post-timeout success re-probe. A timeout on the initial open
  // no longer means Photoshop failed: the cscript child was killed, but PS
  // is a separate process that may have finished the open anyway. These
  // pin the re-probe's TS-side wiring; the JSX matching semantics
  // (fullName vs name, the per-doc try/catch, path normalization) are
  // pinned in go-core/probe_open_document_test.go.
  describe('open_document timeout re-probe (Phase 3b)', () => {
    const TIMEOUT_MSG =
      'Script execution timeout after 120000ms (cscript wrapper.vbs). The child process was ' +
      'killed, but Photoshop runs as a separate process and may have kept executing — the ' +
      "operation could still have completed. Check Photoshop's actual state before retrying.";

    it('returns success when the probe finds the file open, and never surfaces isError', async () => {
      const probing = makeConnection({
        resultFor: (script: string) => {
          if (script.includes('"__snippet":"openDocumentPipeline"')) {
            throw new Error(TIMEOUT_MSG);
          }
          if (script.includes('"__snippet":"probeOpenDocument"')) {
            return {
              success: true,
              reprobed: true,
              document_name: 'IMG_9265.DNG',
              width_px: 6000,
              height_px: 4000,
              resolution: 300,
              color_mode: 'RGBColor',
              bits_per_channel: 16,
              is_raw_source: true,
              file_path: 'E:/iCloudDrive/PhotosInbox/Owasco-26/IMG_9265.DNG',
              context: {},
            };
          }
          throw new Error(`unexpected script: ${script}`);
        },
      });
      const sc = makeSnippetClient();
      const tools = createDocumentTools(probing.asConnection(), sc);

      const result = await callTool(tools, 'ps_open_document', {
        file_path: 'E:/iCloudDrive/PhotosInbox/Owasco-26/IMG_9265.DNG',
      });

      expect(result.isError).not.toBe(true);
      // Two scripts sent: the original open, then the probe.
      expect(probing.executions.length).toBe(2);
      expect(sc.allBuilds()[0].name).toBe('openDocumentPipeline');
      expect(sc.allBuilds()[1].name).toBe('probeOpenDocument');
      expect(sc.allBuilds()[1].params.filePath).toBe(
        'E:/iCloudDrive/PhotosInbox/Owasco-26/IMG_9265.DNG'
      );
      // The probe runs on its own short, separately-bounded budget.
      expect(probing.executions[1].timeout).toBe(10000);

      const sContent = result.structuredContent as Record<string, unknown>;
      expect(sContent.success).toBe(true);
      expect(sContent.reprobed).toBe(true);
      expect(sContent.document_name).toBe('IMG_9265.DNG');
      expect(textOf(result)).toContain('post-timeout check confirmed');
    });

    it('does NOT fire on a non-timeout error — one script sent, original message preserved', async () => {
      const failing = makeConnection({ throwOnExecute: new Error('File not found: E:/nope.DNG') });
      const sc = makeSnippetClient();
      const tools = createDocumentTools(failing.asConnection(), sc);

      const result = await callTool(tools, 'ps_open_document', { file_path: 'E:/nope.DNG' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('File not found: E:/nope.DNG');
      expect(failing.executions.length).toBe(1);
    });

    it('falls back to the original timeout error when the probe completes but the file genuinely is not open', async () => {
      const probing = makeConnection({
        resultFor: (script: string) => {
          if (script.includes('"__snippet":"openDocumentPipeline"')) {
            throw new Error(TIMEOUT_MSG);
          }
          if (script.includes('"__snippet":"probeOpenDocument"')) {
            return { success: false };
          }
          throw new Error(`unexpected script: ${script}`);
        },
      });
      const sc = makeSnippetClient();
      const tools = createDocumentTools(probing.asConnection(), sc);

      const result = await callTool(tools, 'ps_open_document', { file_path: 'E:/photo.DNG' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Script execution timeout');
      expect(probing.executions.length).toBe(2); // the probe WAS attempted
    });

    // On macOS, a genuinely slow open can surface as
    // AppleScript's own Apple Event timeout ("AppleEvent timed out (-1712)")
    // instead of run-child.ts's "Script execution timeout" message. Before
    // the isScriptTimeoutError matcher was broadened, this message never
    // triggered the re-probe, so Phase 3b's fix was a no-op on the exact
    // slow-RAW case it was built for on macOS.
    it('fires the re-probe on a macOS AppleEvent timeout message, not just the Windows message', async () => {
      const probing = makeConnection({
        resultFor: (script: string) => {
          if (script.includes('"__snippet":"openDocumentPipeline"')) {
            throw new Error(
              'osascript exited with code 1: execution error: Photoshop got an error: AppleEvent timed out. (-1712)'
            );
          }
          if (script.includes('"__snippet":"probeOpenDocument"')) {
            return {
              success: true,
              reprobed: true,
              document_name: 'IMG_9265.DNG',
              file_path: 'E:/iCloudDrive/PhotosInbox/Owasco-26/IMG_9265.DNG',
              context: {},
            };
          }
          throw new Error(`unexpected script: ${script}`);
        },
      });
      const sc = makeSnippetClient();
      const tools = createDocumentTools(probing.asConnection(), sc);

      const result = await callTool(tools, 'ps_open_document', {
        file_path: 'E:/iCloudDrive/PhotosInbox/Owasco-26/IMG_9265.DNG',
      });

      expect(result.isError).not.toBe(true);
      expect(probing.executions.length).toBe(2);
      const sContent = result.structuredContent as Record<string, unknown>;
      expect(sContent.success).toBe(true);
      expect(sContent.reprobed).toBe(true);
    });

    // S1 (2026-07-27 QA review) — the -1712 alternative used to match bare,
    // anywhere in the message. A plain "could not open" failure naming a file
    // whose NAME contains those digits was misread as a timeout, fired the
    // re-probe, and would report a false success if a file of that path
    // happened to be open already. The probe must not run at all here.
    it('does not fire the re-probe when -1712 appears only inside a file path', async () => {
      const probing = makeConnection({
        resultFor: (script: string) => {
          if (script.includes('"__snippet":"openDocumentPipeline"')) {
            throw new Error(
              'Could not open E:/iCloudDrive/PhotosInbox/IMG-1712.dng: file is not a valid document'
            );
          }
          throw new Error(`unexpected script: ${script}`);
        },
      });
      const sc = makeSnippetClient();
      const tools = createDocumentTools(probing.asConnection(), sc);

      const result = await callTool(tools, 'ps_open_document', {
        file_path: 'E:/iCloudDrive/PhotosInbox/IMG-1712.dng',
      });

      expect(result.isError).toBe(true);
      // One execution: the open. NO probe.
      expect(probing.executions.length).toBe(1);
      expect(textOf(result)).toContain('not a valid document');
    });

    it('falls back to the original timeout error when the probe itself times out', async () => {
      const probing = makeConnection({
        resultFor: (script: string) => {
          if (script.includes('"__snippet":"openDocumentPipeline"')) {
            throw new Error(TIMEOUT_MSG);
          }
          throw new Error('Script execution timeout after 10000ms (cscript wrapper.vbs).');
        },
      });
      const sc = makeSnippetClient();
      const tools = createDocumentTools(probing.asConnection(), sc);

      const result = await callTool(tools, 'ps_open_document', { file_path: 'E:/photo.DNG' });

      expect(result.isError).toBe(true);
      // The ORIGINAL timeout error surfaces, not the probe's own timeout.
      expect(textOf(result)).toContain('120000ms');
    });
  });

  it('exposes required fields in inputSchema', () => {
    const tools = createDocumentTools(conn.asConnection(), snippetClient);
    const idx = indexTools(tools);
    expect(idx.get('ps_create_document')!.tool.inputSchema.required).toEqual(['width', 'height']);
    expect(idx.get('ps_open_document')!.tool.inputSchema.required).toEqual(['file_path']);
  });

  it('export defaults to nothing without a format (format is required)', async () => {
    const tools = createDocumentTools(conn.asConnection(), snippetClient);
    const r = await callTool(tools, 'ps_export', { output_path: 'C:/out/test.jpg' });
    expect(r.isError).toBe(true);
  });

  it('export format=png dispatches the PNG pipeline', async () => {
    const tools = createDocumentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_export', {
      format: 'png',
      output_path: 'C:/out/test.png',
      transparent_background: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('exportPngPipeline');
    expect(build.params.transparentBg).toBe(true);
  });

  // export quality scale (2026-06-13 session fix), now reached via
  // ps_export(format:'jpeg'): public input is 0-100 (the JPEG dialog
  // scale), normalized to Photoshop's 0-12 JPEGSaveOptions scale before the
  // Go core snippet.
  describe('export format=jpeg quality 0-100 → 0-12 mapping', () => {
    const exportArgs = (quality?: number): Record<string, unknown> => ({
      format: 'jpeg',
      output_path: 'C:/out/test.jpg',
      ...(quality === undefined ? {} : { quality }),
    });

    it('maps quality 100 → PS scale 12 and echoes both scales', async () => {
      const tools = createDocumentTools(conn.asConnection(), snippetClient);
      const r = await callTool(tools, 'ps_export', exportArgs(100));
      expect(snippetClient.lastBuild().params.quality).toBe(12);
      const sc = r.structuredContent as Record<string, unknown>;
      expect(sc.quality).toBe(100); // public value echoed, not silently swapped to 12
      expect(sc.quality_ps_scale).toBe(12);
    });

    it('default (no quality arg) maps to PS scale 11 (preserves old 11 default)', async () => {
      const tools = createDocumentTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_export', exportArgs());
      expect(snippetClient.lastBuild().params.quality).toBe(11);
    });

    it('pins the rounding: 0→0, 50→6, 90→11', async () => {
      const tools = createDocumentTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_export', exportArgs(0));
      expect(snippetClient.lastBuild().params.quality).toBe(0);
      await callTool(tools, 'ps_export', exportArgs(50));
      expect(snippetClient.lastBuild().params.quality).toBe(6);
      await callTool(tools, 'ps_export', exportArgs(90));
      expect(snippetClient.lastBuild().params.quality).toBe(11);
    });

    it('rejects quality > 100 (schema maximum is 100, not 12)', async () => {
      const tools = createDocumentTools(conn.asConnection(), snippetClient);
      const r = await callTool(tools, 'ps_export', exportArgs(101));
      expect(r.isError).toBe(true);
    });

    it('advertises the 0-100 scale in the schema description (pins the contract)', () => {
      const tools = createDocumentTools(conn.asConnection(), snippetClient);
      const schema = indexTools(tools).get('ps_export')!.tool.inputSchema as unknown as {
        properties: { quality: { description: string } };
      };
      expect(schema.properties.quality.description).toContain('0-100');
    });
  });
});

describe('ps_save_psd scene-channel purge (2026-08-01)', () => {
  // ps_read_scene's managed scene:* channels are DERIVED full-resolution masks
  // (~51MB each on a 51MP doc; ~771MB measured live 2026-07-30). Baking them
  // into the user's .psd is pure bloat, so save purges them by default.
  const purgeScript = (scripts: string[]) => scripts.find((x) => x.includes('var removed = 0;'));

  it('purges by default and reports how many went', async () => {
    const conn = makeConnection({
      resultFor: (script: string) =>
        script.includes('var removed = 0;') ? { removed: 4 } : { ok: true },
    });
    const tools = createDocumentTools(conn.asConnection(), makeSnippetClient());
    const res = await callTool(tools, 'ps_save_psd', { output_path: 'C:/out.psd' });
    expect(purgeScript(conn.allScripts())).toBeDefined();
    expect(
      (res.structuredContent as { scene_channels_purged?: number }).scene_channels_purged
    ).toBe(4);
  });

  it('keep_scene_channels:true skips the purge entirely', async () => {
    const conn = makeConnection({ result: { ok: true } });
    const tools = createDocumentTools(conn.asConnection(), makeSnippetClient());
    await callTool(tools, 'ps_save_psd', {
      output_path: 'C:/out.psd',
      keep_scene_channels: true,
    });
    // The opt-out protects user intent — nothing may be deleted.
    expect(purgeScript(conn.allScripts())).toBeUndefined();
  });

  it('warns that the scene: prefix is RESERVED', () => {
    // This description is the only user-facing warning for a real data-loss
    // hazard (the purge matches on the prefix alone, so a hand-made channel
    // named scene:mine goes with the derived ones). Pin it so a future
    // description trim can't quietly drop it.
    const tools = createDocumentTools(makeConnection().asConnection(), makeSnippetClient());
    // The SDK types inputSchema's properties as a passthrough index signature,
    // so the shape has to come back through `unknown`.
    const schema = tools.find((t) => t.tool.name === 'ps_save_psd')?.tool
      .inputSchema as unknown as {
      properties: { keep_scene_channels: { description: string } };
    };
    expect(schema.properties.keep_scene_channels.description).toContain('RESERVED');
  });

  it('honours keep_scene_channels sent as the STRING "true"', async () => {
    // The validator deliberately coerces stringified booleans because LLM
    // clients send them. Gating the purge on the RAW bag therefore let
    // keep_scene_channels:"true" validate cleanly and then purge anyway —
    // destroying the exact channels the caller asked to keep, and reporting
    // scene_channels_purged as though it had been asked for.
    const conn = makeConnection({ result: { ok: true } });
    const tools = createDocumentTools(conn.asConnection(), makeSnippetClient());
    const res = await callTool(tools, 'ps_save_psd', {
      output_path: 'C:/out.psd',
      keep_scene_channels: 'true',
    });
    expect(res.isError).not.toBe(true);
    expect(purgeScript(conn.allScripts())).toBeUndefined();
  });

  it('rejects invalid args BEFORE purging anything', async () => {
    // The purge is a real mutation of the OPEN document. Running it ahead of
    // validation destroyed derived channels on behalf of a save that was then
    // rejected — the user lost the masks AND got no file.
    const conn = makeConnection({ result: { ok: true } });
    const tools = createDocumentTools(conn.asConnection(), makeSnippetClient());
    const res = await callTool(tools, 'ps_save_psd', {}); // output_path is required
    expect(res.isError).toBe(true);
    expect(purgeScript(conn.allScripts())).toBeUndefined();
    expect(conn.allScripts().some((x) => x.includes('savePsdAsCopy'))).toBe(false);
  });

  it('still saves when the purge itself fails', async () => {
    const conn = makeConnection({
      resultFor: (script: string) => {
        if (script.includes('var removed = 0;')) throw new Error('no active document');
        return { ok: true };
      },
    });
    const tools = createDocumentTools(conn.asConnection(), makeSnippetClient());
    const res = await callTool(tools, 'ps_save_psd', { output_path: 'C:/out.psd' });
    // Best-effort: a failed cleanup must never block the save the user asked for.
    expect(res.isError).not.toBe(true);
    expect(conn.allScripts().some((x) => x.includes('savePsdAsCopy'))).toBe(true);
  });
});
