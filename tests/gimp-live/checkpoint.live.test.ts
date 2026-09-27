/**
 * Live coverage for gimp_checkpoint against real headless GIMP, driven through the actual tool
 * handlers and a real `GimpBackend`/`GimpSession` — same "drive the TOOLS, not the bridge" posture
 * as `registry-e2e.test.ts`, but without the full `EditmameiServer` (gimp_checkpoint has no bridge
 * op of its own, so there's nothing here that needs the whole server boot matrix).
 *
 * Two things this file exists to prove that a fake session can't:
 *  - the round trip through a REAL `.xcf` export/reopen is pixel-identical and the filter stays
 *    re-editable by its listed id (the fake session never actually renders anything);
 *  - restore genuinely recovers after a REAL forced GIMP process kill, not a simulated one — the
 *    whole reason the checkpoint file lives on disk rather than in GIMP's own memory.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpBackend } from '@editmamei/backends/gimp/backend.ts';
import { createGimpCoreTools } from '@editmamei/tools/gimp-core-tools.ts';
import { createGimpDocumentTools } from '@editmamei/tools/gimp-document-tools.ts';
import { createGimpAdjustmentTools } from '@editmamei/tools/gimp-adjustment-tools.ts';
import { createGimpFilterTools } from '@editmamei/tools/gimp-filter-tools.ts';
import { createGimpGeometryTools } from '@editmamei/tools/gimp-geometry-tools.ts';
import { createGimpCheckpointTools } from '@editmamei/tools/gimp-checkpoint-tools.ts';
import type { ToolDefinition } from '@editmamei/core/tool-registry.ts';
import { callTool } from '../fixtures/tool-helpers.ts';
import {
  writeGrayRamp,
  readPng,
  maxAbsDiff,
  readyGimpRegistry,
  LIVE_READY_TIMEOUT_MS,
} from './support.ts';

// This file alone, not the project default -- see adjust.live.test.ts's identical comment.
vi.setConfig({ testTimeout: 60_000 });

const REQUIRE_GIMP = process.env.EDITMAMEI_REQUIRE_GIMP === '1';

const install: GimpInstall | null = await detectGimp();

it('GIMP must actually be detected when EDITMAMEI_REQUIRE_GIMP=1 (checkpoint)', () => {
  if (!REQUIRE_GIMP) return;
  expect(install, 'EDITMAMEI_REQUIRE_GIMP=1 but detectGimp() found no install').not.toBeNull();
});

describe.skipIf(!install)('gimp_checkpoint against real headless GIMP', () => {
  let workDir: string;
  let backend: GimpBackend;
  let tools: ToolDefinition[];

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-checkpoint-'));
    backend = new GimpBackend(install, {
      sessionOptions: { rootDir: join(workDir, 'session-root') },
    });
    tools = [
      ...createGimpCoreTools(backend),
      ...createGimpDocumentTools(backend),
      ...createGimpAdjustmentTools(backend),
      ...createGimpFilterTools(backend),
      ...createGimpGeometryTools(backend),
      ...createGimpCheckpointTools(backend),
    ];
    // A cold GIMP launch can outlast CALL_READY_WAIT_MS -- this file drives GIMP through the tool
    // layer, so a slow first launch surfaces as gimp_ping's `starting: true`, not a rejection.
    await readyGimpRegistry((name, args) => callTool(tools, name, args));
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await backend.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('checkpoint -> destructive crop -> restore renders pixel-identical to the checkpoint moment, and the filter is re-editable by its listed id', async () => {
    const pngPath = join(workDir, 'roundtrip-fixture.png');
    writeGrayRamp(pngPath, 64, 64);
    const opened = await callTool(tools, 'gimp_open_document', { file_path: pngPath });
    expect(opened.isError, JSON.stringify(opened.content)).toBeFalsy();
    const image = (opened.structuredContent as { image: number }).image;

    const adjust = await callTool(tools, 'gimp_add_adjustment', {
      image,
      type: 'curves',
      points: [
        [0, 40],
        [255, 215],
      ],
      name: 'Lift',
    });
    expect(adjust.isError, JSON.stringify(adjust.content)).toBeFalsy();

    const checkpointMomentPath = join(workDir, 'checkpoint-moment.png');
    await callTool(tools, 'gimp_export', { image, file_path: checkpointMomentPath });
    const checkpointMoment = readPng(checkpointMomentPath);

    const checkpoint = await callTool(tools, 'gimp_checkpoint', { op: 'create', image });
    expect(checkpoint.isError, JSON.stringify(checkpoint.content)).toBeFalsy();
    const checkpointId = (checkpoint.structuredContent as { checkpoint_id: string }).checkpoint_id;

    // Destructive, irreversible in-session — exactly the situation gimp_checkpoint exists for.
    const cropped = await callTool(tools, 'gimp_crop_document', {
      image,
      left: 0,
      top: 0,
      width: 16,
      height: 16,
    });
    expect(cropped.isError, JSON.stringify(cropped.content)).toBeFalsy();

    const restored = await callTool(tools, 'gimp_checkpoint', {
      op: 'restore',
      checkpoint_id: checkpointId,
    });
    expect(restored.isError, JSON.stringify(restored.content)).toBeFalsy();
    const restoredStructured = restored.structuredContent as {
      old_image: number;
      image: number;
    };
    expect(restoredStructured.old_image).toBe(image);
    const newImage = restoredStructured.image;
    expect(newImage).not.toBe(image);
    expect((restored.content?.[0] as { text: string }).text).toMatch(
      new RegExp(`restored as image ${newImage}\\b`)
    );

    const restoredExportPath = join(workDir, 'restored.png');
    await callTool(tools, 'gimp_export', { image: newImage, file_path: restoredExportPath });
    const restoredRender = readPng(restoredExportPath);
    expect(maxAbsDiff(checkpointMoment, restoredRender)).toBe(0);

    // Re-editable by its listed id: the ledger, not a lossy GIMP-side readback, survived the
    // export -> reopen round trip the checkpoint file just took.
    const listed = await callTool(tools, 'gimp_filter', { image: newImage, op: 'list' });
    const filters = (
      listed.structuredContent as {
        filters: Array<{ filter_id: number; name: string; source: string }>;
      }
    ).filters;
    const lift = filters.find((f) => f.name === 'Lift');
    expect(lift).toBeDefined();
    expect(lift!.source).toBe('editmamei');

    await callTool(tools, 'gimp_add_adjustment', {
      image: newImage,
      type: 'curves',
      filter_id: lift!.filter_id,
      points: [
        [0, 0],
        [255, 128],
      ],
    });
    const reeditedPath = join(workDir, 'reedited.png');
    await callTool(tools, 'gimp_export', { image: newImage, file_path: reeditedPath });
    expect(maxAbsDiff(restoredRender, readPng(reeditedPath))).toBeGreaterThan(0);

    await callTool(tools, 'gimp_close_document', { image: newImage });
  }, 60_000);

  it('restore still recovers after a REAL forced GIMP session restart (timeout -> gimp_session_restarted -> restore)', async () => {
    const pngPath = join(workDir, 'kill-fixture.png');
    writeGrayRamp(pngPath, 64, 64);
    const opened = await callTool(tools, 'gimp_open_document', { file_path: pngPath });
    expect(opened.isError, JSON.stringify(opened.content)).toBeFalsy();
    const image = (opened.structuredContent as { image: number }).image;

    await callTool(tools, 'gimp_add_adjustment', {
      image,
      type: 'exposure',
      exposure: 0.4,
      name: 'PreKillLift',
    });
    const referencePath = join(workDir, 'kill-reference.png');
    await callTool(tools, 'gimp_export', { image, file_path: referencePath });
    const reference = readPng(referencePath);

    const checkpoint = await callTool(tools, 'gimp_checkpoint', { op: 'create', image });
    expect(checkpoint.isError, JSON.stringify(checkpoint.content)).toBeFalsy();
    const checkpointId = (checkpoint.structuredContent as { checkpoint_id: string }).checkpoint_id;

    // Force a REAL timeout: a 1ms budget cannot be met by a real bridge round trip (the
    // Python-side serve loop itself only wakes every 5ms — bridge/ops.py's `serve(poll_s=0.005)`
    // — so the response file cannot exist yet), which genuinely tree-kills the live GIMP
    // process. Same deadline branch (session.ts's `#send`) any real slow-op timeout takes.
    await expect(backend.call('ping', {}, 1)).rejects.toMatchObject({ code: 'gimp_timeout' });

    // The NEXT call referencing the now-gone image surfaces the restart to the model
    // explicitly: `#joinOrStart` spawns a fresh GIMP for THIS call (no open images in it), and
    // the bridge's "no open image" answer for the stale id is what session.ts converts to
    // `gimp_session_restarted`.
    const staleCall = await callTool(tools, 'gimp_export', {
      image,
      file_path: join(workDir, 'never-written.jpg'),
    });
    expect(staleCall.isError).toBe(true);
    expect((staleCall.content?.[0] as { text: string }).text).toMatch(/gimp_session_restarted/);

    // Restore reopens the FILE, independent of the process that just died — the whole point of
    // a disk-backed checkpoint.
    const restored = await callTool(tools, 'gimp_checkpoint', {
      op: 'restore',
      checkpoint_id: checkpointId,
    });
    expect(restored.isError, JSON.stringify(restored.content)).toBeFalsy();
    const newImage = (restored.structuredContent as { image: number }).image;

    const restoredPath = join(workDir, 'kill-restored.png');
    await callTool(tools, 'gimp_export', { image: newImage, file_path: restoredPath });
    expect(maxAbsDiff(reference, readPng(restoredPath))).toBe(0);

    await callTool(tools, 'gimp_close_document', { image: newImage });
  }, 60_000);
});
