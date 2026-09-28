import { describe, it, expect, vi, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { rm } from 'node:fs/promises';
import {
  createGimpCheckpointTools,
  cleanupCheckpointDirs,
  sweepStaleCheckpointDirs,
  maybeSweepSiblingDirs,
  repointSiblings,
  isTrackedForExitCleanup,
  MAX_CHECKPOINTS_PER_IMAGE,
  MAX_CHECKPOINTS_TOTAL,
  type CheckpointStore,
  type CheckpointRecord,
} from '@editmamei/tools/gimp-checkpoint-tools.ts';
import { GimpError } from '@editmamei/backends/gimp/errors.ts';
import { FakeGimpBackend, makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

// Only `rm` (op=delete's own removal call) needs to be interceptable per-test (the path-free
// error message test) — every other test relies on the REAL `rm`/`mkdirSync` working against a
// real scratch directory (see `makeCheckpointBackend` below).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const scratchDir = mkdtempSync(join(tmpdir(), 'gimp-checkpoint-tools-test-'));
afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));

let scratchCounter = 0;

/**
 * A fake backend whose `tempPath()` points under a REAL, isolated directory — this tool's own
 * `mkdirSync`-based store-directory creation needs somewhere real to land, unlike the plain fake's
 * default `/fake/gimp/...` (which nothing here ever actually writes to). Each call gets its own
 * subdirectory so successive fakes across tests never collide. `op='export'` always answers with
 * a plausible result unless the caller's own `throwFor` intercepts it first (matches
 * `FakeGimpBackend`'s own throwFor-before-resultFor ordering).
 */
function makeCheckpointBackend(
  opts: {
    resultFor?: (op: string, args: Record<string, unknown>) => unknown;
    throwFor?: (op: string, args: Record<string, unknown>) => unknown;
    state?: string;
    generation?: number;
  } = {}
): FakeGimpBackend {
  const gimp = makeGimpBackend({
    resultFor: (op, args) => {
      if (op === 'export') return { path: args.path, bytes: 4096 };
      return opts.resultFor?.(op, args);
    },
    throwFor: opts.throwFor,
    state: opts.state,
    generation: opts.generation,
  });
  const base = join(scratchDir, `fake-${scratchCounter++}`);
  gimp.tempPath = (name: string) => join(base, name);
  return gimp;
}

/** A pid that is definitely not alive: a real child process that has already exited by the time
 * this returns (`spawnSync` blocks until it does). */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '1']);
  return result.pid!;
}

describe('createGimpCheckpointTools', () => {
  it('returns 1 well-formed tool with this name', () => {
    const gimp = makeGimpBackend();
    const tools = createGimpCheckpointTools(gimp.asBackend());
    expect(tools.map((t) => t.tool.name)).toEqual(['gimp_checkpoint']);
    assertToolShape(tools);
  });

  it('requires op', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpCheckpointTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_checkpoint', {});
    expect(result.isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });

  it('refuses an op outside create/restore/list/delete without dispatching', async () => {
    const gimp = makeGimpBackend();
    const tools = createGimpCheckpointTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_checkpoint', { op: 'reorder' });
    expect(result.isError).toBe(true);
    expect(gimp.calls).toHaveLength(0);
  });

  describe('op=create', () => {
    it('requires image, and dispatches no call when missing', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_checkpoint', { op: 'create' });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it("exports into this factory's own checkpoints-<pid>-<uuid> directory, and returns a checkpoint_id, never the path itself", async () => {
      const gimp = makeCheckpointBackend();
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      expect(result.isError).toBeFalsy();
      expect(gimp.lastCall().op).toBe('export');
      expect(gimp.lastCall().args.image).toBe(5);
      const path = gimp.lastCall().args.path as string;
      expect(basename(path)).toMatch(/^[0-9a-f-]{36}\.xcf$/i);
      expect(basename(dirname(path))).toMatch(/^checkpoints-\d+-[0-9a-f-]{36}$/i);
      expect(existsSync(dirname(path))).toBe(true);
      const structured = result.structuredContent as {
        checkpoint_id: string;
        image: number;
        bytes: number;
        created_at: string;
      };
      expect(typeof structured.checkpoint_id).toBe('string');
      expect(structured.checkpoint_id.length).toBeGreaterThan(0);
      expect(structured.image).toBe(5);
      expect(structured.bytes).toBe(4096);
      expect(structured.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // The internal file path never reaches the model.
      const text = (result.content?.[0] as { text: string }).text;
      const allText = JSON.stringify(result);
      expect(allText).not.toContain(path);
      expect(text).toContain(structured.checkpoint_id);
    });

    it('a create whose export throws registers nothing and leaves no file on disk', async () => {
      // A bare throw with no file ever written would pass this trivially regardless of whether
      // the create handler actually cleans up — writing a PARTIAL file first (the realistic
      // shape of an export that fails partway through) is what actually exercises the cleanup.
      const gimp = makeCheckpointBackend({
        throwFor: (op, args) => {
          if (op !== 'export') return undefined;
          writeFileSync(args.path as string, 'partial xcf bytes');
          return new GimpError('gimp_op_failed', 'disk full');
        },
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      expect(result.isError).toBe(true);
      // By the time the call resolves, the handler's own cleanup (awaited before it rethrows)
      // has already removed the partial file written above.
      const path = gimp.lastCall().args.path as string;
      expect(existsSync(path)).toBe(false);
      const listed = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      expect((listed.structuredContent as { checkpoints: unknown[] }).checkpoints).toEqual([]);
    });

    it('refuses a 6th checkpoint for the same image without dispatching, and says how to free a slot', async () => {
      const gimp = makeCheckpointBackend();
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const ids: string[] = [];
      for (let i = 0; i < MAX_CHECKPOINTS_PER_IMAGE; i++) {
        const r = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
        expect(r.isError).toBeFalsy();
        ids.push((r.structuredContent as { checkpoint_id: string }).checkpoint_id);
      }
      expect(gimp.allOps().filter((o) => o === 'export')).toHaveLength(MAX_CHECKPOINTS_PER_IMAGE);

      const refused = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
      expect(refused.isError).toBe(true);
      expect(gimp.allOps().filter((o) => o === 'export')).toHaveLength(MAX_CHECKPOINTS_PER_IMAGE);
      const refusedText = (refused.content?.[0] as { text: string }).text;
      expect(refusedText).toMatch(/already has 5 checkpoints/);
      expect(refusedText).toMatch(/op=delete/);
      for (const id of ids) expect(refusedText).toContain(id);

      const otherImage = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 2 });
      expect(otherImage.isError).toBeFalsy();
    });

    it('refuses a create once the store holds the overall total cap, even spread evenly across several DIFFERENT images each under their own per-image cap', async () => {
      const gimp = makeCheckpointBackend();
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const perImage = MAX_CHECKPOINTS_TOTAL / MAX_CHECKPOINTS_PER_IMAGE;
      for (let image = 1; image <= perImage; image++) {
        for (let i = 0; i < MAX_CHECKPOINTS_PER_IMAGE; i++) {
          const r = await callTool(tools, 'gimp_checkpoint', { op: 'create', image });
          expect(r.isError).toBeFalsy();
        }
      }
      expect(gimp.allOps().filter((o) => o === 'export')).toHaveLength(MAX_CHECKPOINTS_TOTAL);

      // A brand-new image, nowhere near ITS OWN per-image cap, still gets refused by the
      // store-wide total.
      const refused = await callTool(tools, 'gimp_checkpoint', {
        op: 'create',
        image: perImage + 1,
      });
      expect(refused.isError).toBe(true);
      const text = (refused.content?.[0] as { text: string }).text;
      expect(text).toMatch(new RegExp(`already holds ${MAX_CHECKPOINTS_TOTAL} checkpoints`));
      expect(text).toMatch(/op=delete/);
      expect(gimp.allOps().filter((o) => o === 'export')).toHaveLength(MAX_CHECKPOINTS_TOTAL);
    });

    it('the total cap counts records whose image has since closed too -- disk usage, not open-image count, is what it bounds', async () => {
      // Ping always reports image 1 as no longer open -- every record created for it flips to
      // open: false by the time the NEXT create's own refreshOpenness runs, so the per-image cap
      // (which only counts open ones) never fills. This isolates the total cap: it must still
      // refuse once the registry holds MAX_CHECKPOINTS_TOTAL records, even though none of them
      // are "open" by the time the refusal fires.
      const gimp = makeCheckpointBackend({
        resultFor: (op) => (op === 'ping' ? { images: [] } : undefined),
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      for (let i = 0; i < MAX_CHECKPOINTS_TOTAL; i++) {
        const r = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
        expect(r.isError).toBeFalsy();
      }
      const refused = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 2 });
      expect(refused.isError).toBe(true);
      expect((refused.content?.[0] as { text: string }).text).toMatch(
        new RegExp(`already holds ${MAX_CHECKPOINTS_TOTAL} checkpoints`)
      );
    });

    it('concurrent creates for the same image never exceed the cap (the check-then-reserve is synchronous)', async () => {
      const gimp = makeCheckpointBackend();
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const attempts = MAX_CHECKPOINTS_PER_IMAGE + 3;
      const results = await Promise.all(
        Array.from({ length: attempts }, () =>
          callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 })
        )
      );
      const succeeded = results.filter((r) => !r.isError);
      const refused = results.filter((r) => r.isError);
      expect(succeeded).toHaveLength(MAX_CHECKPOINTS_PER_IMAGE);
      expect(refused).toHaveLength(attempts - MAX_CHECKPOINTS_PER_IMAGE);
    });

    it("a stale (closed-elsewhere) record is excluded from its image's cap and scoped list, but still appears (open: false) in the unscoped list", async () => {
      let pingImages: number[] = [1];
      const gimp = makeCheckpointBackend({
        resultFor: (op) => (op === 'ping' ? { images: pingImages } : undefined),
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const ids: string[] = [];
      for (let i = 0; i < MAX_CHECKPOINTS_PER_IMAGE; i++) {
        const r = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
        expect(r.isError).toBeFalsy();
        ids.push((r.structuredContent as { checkpoint_id: string }).checkpoint_id);
      }

      pingImages = []; // image 1 is closed elsewhere (e.g. gimp_close_document)
      const scopedBefore = await callTool(tools, 'gimp_checkpoint', { op: 'list', image: 1 });
      expect((scopedBefore.structuredContent as { checkpoints: unknown[] }).checkpoints).toEqual(
        []
      );
      const unscoped = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      const all = (unscoped.structuredContent as { checkpoints: Array<{ open: boolean }> })
        .checkpoints;
      expect(all).toHaveLength(MAX_CHECKPOINTS_PER_IMAGE);
      expect(all.every((c) => c.open === false)).toBe(true);

      pingImages = [1]; // a DIFFERENT image later reuses the same number
      const sixth = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
      expect(sixth.isError).toBeFalsy();
      const sixthId = (sixth.structuredContent as { checkpoint_id: string }).checkpoint_id;

      const scopedAfter = await callTool(tools, 'gimp_checkpoint', { op: 'list', image: 1 });
      const scopedList = (
        scopedAfter.structuredContent as { checkpoints: Array<{ checkpoint_id: string }> }
      ).checkpoints;
      expect(scopedList).toHaveLength(1);
      expect(scopedList[0]!.checkpoint_id).toBe(sixthId);
    });

    it('a failing ping during a later create does not fail the create itself', async () => {
      const gimp = makeCheckpointBackend({
        throwFor: (op) =>
          op === 'ping' ? new GimpError('gimp_timeout', 'ping timed out') : undefined,
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const first = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
      expect(first.isError).toBeFalsy();
      // registry.size > 0 now, so THIS create's refreshOpenness attempts (and gets) the failing ping.
      const second = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 2 });
      expect(second.isError).toBeFalsy();
    });

    it('a failing ping re-checks generation with the fresh value afterward, since the failure itself may have bumped it', async () => {
      let gimp!: FakeGimpBackend;
      gimp = makeCheckpointBackend({
        generation: 1,
        throwFor: (op) => {
          if (op !== 'ping') return undefined;
          gimp.generation = 2; // the failing ping call itself discovers the restart
          return new GimpError('gimp_timeout', 'ping timed out');
        },
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      expect(created.isError).toBeFalsy();
      const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;

      // At list time, the FIRST (generation) check inside refreshOpenness runs with
      // gimp.generation still 1 — equal to the record's own stamped generation, so it does
      // nothing yet. Only the ping call itself (which fails, bumping generation as a side
      // effect) reveals the restart.
      const listed = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      expect(listed.isError).toBeFalsy();
      const record = (
        listed.structuredContent as {
          checkpoints: Array<{ checkpoint_id: string; open: boolean }>;
        }
      ).checkpoints.find((c) => c.checkpoint_id === id)!;
      expect(record.open).toBe(false);
    });
  });

  describe('op=list', () => {
    it('reports every checkpoint when no image is given, scoped when one is', async () => {
      const gimp = makeCheckpointBackend();
      const tools = createGimpCheckpointTools(gimp.asBackend());
      await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
      await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 2 });

      const all = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      expect((all.structuredContent as { checkpoints: unknown[] }).checkpoints).toHaveLength(2);

      const scoped = await callTool(tools, 'gimp_checkpoint', { op: 'list', image: 1 });
      const scopedList = (scoped.structuredContent as { checkpoints: Array<{ image: number }> })
        .checkpoints;
      expect(scopedList).toHaveLength(1);
      expect(scopedList[0]!.image).toBe(1);
    });

    it('reports zero checkpoints, not an error, when none exist', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { checkpoints: unknown[] }).checkpoints).toEqual([]);
    });

    it('never pings when no GIMP session is already running — a read must never cold-start GIMP', async () => {
      const gimp = makeCheckpointBackend({ state: 'idle' });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      expect(created.isError).toBeFalsy();
      const opsBefore = gimp.calls.length;
      await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      expect(gimp.allOps().slice(opsBefore)).not.toContain('ping');
    });
  });

  describe('op=restore', () => {
    it('requires checkpoint_id, and dispatches no call when missing', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_checkpoint', { op: 'restore' });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('refuses an unknown checkpoint_id, listing every known id', async () => {
      const gimp = makeCheckpointBackend();
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
      const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;

      const result = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: 'not-a-real-id',
      });
      expect(result.isError).toBe(true);
      const text = (result.content?.[0] as { text: string }).text;
      expect(text).toMatch(/unknown checkpoint_id/);
      expect(text).toContain(id);
    });

    it('says plainly that no checkpoints exist yet when the registry is empty', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: 'anything',
      });
      expect((result.content?.[0] as { text: string }).text).toMatch(/No checkpoints exist yet/);
    });

    it('restore where open() itself throws (for a reason other than a missing file) never dispatches close, and the record is unchanged', async () => {
      const gimp = makeCheckpointBackend({
        throwFor: (op) =>
          op === 'open'
            ? new GimpError('gimp_op_failed', 'GIMP could not read that file')
            : undefined,
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;
      const restored = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: id,
      });
      expect(restored.isError).toBe(true);
      expect(gimp.allOps()).not.toContain('close');

      const listed = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      const record = (
        listed.structuredContent as {
          checkpoints: Array<{ checkpoint_id: string; image: number }>;
        }
      ).checkpoints.find((c) => c.checkpoint_id === id)!;
      expect(record.image).toBe(5);
    });

    it('restore hitting a missing checkpoint file drops the record and says so, without forwarding the raw path-bearing bridge message', async () => {
      const gimp = makeCheckpointBackend({
        throwFor: (op) =>
          op === 'open' ? new GimpError('file_not_found', 'no file at <redacted-path>') : undefined,
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;

      const restored = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: id,
      });
      expect(restored.isError).toBe(true);
      const text = (restored.content?.[0] as { text: string }).text;
      expect(text).toMatch(/no longer be restored/);
      expect(text).not.toContain('<redacted-path>');

      const again = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: id,
      });
      expect(again.isError).toBe(true);
      expect((again.content?.[0] as { text: string }).text).toMatch(/unknown checkpoint_id/);
    });

    it('a file_not_found from open, when the file demonstrably still exists on disk, keeps the record and asks for a retry rather than dropping it', async () => {
      const gimp = makeCheckpointBackend({
        throwFor: (op) =>
          op === 'open' ? new GimpError('file_not_found', 'no file at <redacted-path>') : undefined,
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;
      const path = gimp.lastCall().args.path as string;
      // The fake `export` never actually writes anything -- write the file for real here so
      // `existsSync(record.path)` inside restore genuinely observes it present.
      writeFileSync(path, 'a real checkpoint file');

      const restored = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: id,
      });
      expect(restored.isError).toBe(true);
      const text = (restored.content?.[0] as { text: string }).text;
      expect(text).toMatch(/retry gimp_checkpoint op=restore/);
      expect(text).not.toContain('<redacted-path>');

      // The record is NOT dropped -- both list and a further restore attempt still find it.
      const listed = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      expect(
        (listed.structuredContent as { checkpoints: Array<{ checkpoint_id: string }> }).checkpoints
      ).toEqual([expect.objectContaining({ checkpoint_id: id })]);

      const retried = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: id,
      });
      expect(retried.isError).toBe(true);
      expect((retried.content?.[0] as { text: string }).text).toMatch(
        /retry gimp_checkpoint op=restore/
      );
      expect((retried.content?.[0] as { text: string }).text).not.toMatch(/unknown checkpoint_id/);
    });

    it('never closes when the freshly reopened image reuses the exact id restore remembers as old (the one case detectable without a GIMP process generation signal)', async () => {
      const gimp = makeCheckpointBackend({
        resultFor: (op) => (op === 'open' ? { image: 5, width: 1, height: 1 } : undefined),
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;

      const restored = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: id,
      });
      expect(restored.isError).toBeFalsy();
      expect(gimp.allOps()).not.toContain('close');
      const structured = restored.structuredContent as { old_image: number; image: number };
      expect(structured.old_image).toBe(5);
      expect(structured.image).toBe(5);
      expect((restored.content?.[0] as { text: string }).text).toMatch(/nothing to close/);
    });

    it('opens the checkpoint file, closes the OLD image, and returns the NEW one — the old id is then gone from later restores of the same checkpoint', async () => {
      let nextImage = 100;
      const gimp = makeCheckpointBackend({
        resultFor: (op) =>
          op === 'open'
            ? {
                image: ++nextImage,
                width: 64,
                height: 48,
                base_type: 'RGB',
                precision: 'U8 non-linear',
                layers: ['Background'],
              }
            : undefined,
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;

      const restored = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: id,
      });
      expect(restored.isError).toBeFalsy();
      const structured = restored.structuredContent as {
        checkpoint_id: string;
        old_image: number;
        image: number;
        width: number;
        height: number;
        base_type: string;
        precision: string;
        layers: string[];
        close_failed: boolean;
      };
      expect(structured.old_image).toBe(5);
      expect(structured.image).toBe(101);
      expect(structured.close_failed).toBe(false);
      // The full describe() result from open is forwarded, the same as gimp_open_document does.
      expect(structured.base_type).toBe('RGB');
      expect(structured.precision).toBe('U8 non-linear');
      expect(structured.layers).toEqual(['Background']);
      const text = (restored.content?.[0] as { text: string }).text;
      expect(text).toMatch(/image 5 closed/);
      expect(text).toMatch(/restored as image 101/);
      expect(text).toMatch(/use 101 from now on/);
      const ops = gimp.calls.slice(-2);
      expect(ops[0]).toMatchObject({ op: 'open' });
      expect(ops[1]).toMatchObject({ op: 'close', args: { image: 5 } });

      const restoredAgain = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: id,
      });
      const secondClose = gimp.calls[gimp.calls.length - 1]!;
      expect(secondClose).toMatchObject({ op: 'close', args: { image: 101 } });
      expect((restoredAgain.structuredContent as { old_image: number }).old_image).toBe(101);
    });

    it('sibling re-pointing: restoring one of two checkpoints from the same image moves BOTH records to the new image', async () => {
      let nextImage = 100;
      const gimp = makeCheckpointBackend({
        resultFor: (op) =>
          op === 'open' ? { image: ++nextImage, width: 10, height: 10 } : undefined,
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const c1 = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      const c2 = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      const id1 = (c1.structuredContent as { checkpoint_id: string }).checkpoint_id;
      const id2 = (c2.structuredContent as { checkpoint_id: string }).checkpoint_id;

      const restored1 = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: id1,
      });
      expect((restored1.structuredContent as { image: number }).image).toBe(101);

      const listed = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      const checkpoints = (
        listed.structuredContent as {
          checkpoints: Array<{ checkpoint_id: string; image: number; open: boolean }>;
        }
      ).checkpoints;
      const c2Record = checkpoints.find((c) => c.checkpoint_id === id2)!;
      expect(c2Record.image).toBe(101);
      expect(c2Record.open).toBe(true);

      const restored2 = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: id2,
      });
      const restored2Structured = restored2.structuredContent as {
        old_image: number;
        image: number;
      };
      expect(restored2Structured.old_image).toBe(101);
      expect(restored2Structured.image).toBe(102);
      const closeCalls = gimp.calls.filter((c) => c.op === 'close');
      expect(closeCalls.at(-1)!.args.image).toBe(101);

      const listedAgain = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      const finalCheckpoints = (
        listedAgain.structuredContent as {
          checkpoints: Array<{ checkpoint_id: string; image: number }>;
        }
      ).checkpoints;
      expect(finalCheckpoints.find((c) => c.checkpoint_id === id1)!.image).toBe(102);
      expect(finalCheckpoints.find((c) => c.checkpoint_id === id2)!.image).toBe(102);
    });

    it('a close that reports the session actually restarted uses restart wording (matched by error CODE)', async () => {
      const gimp = makeCheckpointBackend({
        resultFor: (op) => (op === 'open' ? { image: 200, width: 10, height: 10 } : undefined),
        throwFor: (op) =>
          op === 'close'
            ? new GimpError(
                'gimp_session_restarted',
                'that image id is not open. The GIMP session restarted, so every open image and unsaved filter is gone.'
              )
            : undefined,
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;

      const restored = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: id,
      });
      expect(restored.isError).toBeFalsy();
      const text = (restored.content?.[0] as { text: string }).text;
      expect(text).toMatch(/already gone/);
      expect(text).toMatch(/session had restarted/);
      expect(text).toMatch(/restored as image 200/);
    });

    it('a close that reports a plain "no open image" (no restart involved) says merely "already closed", not "session had restarted"', async () => {
      const gimp = makeCheckpointBackend({
        resultFor: (op) => (op === 'open' ? { image: 200, width: 10, height: 10 } : undefined),
        throwFor: (op) =>
          op === 'close' ? new GimpError('invalid_argument', 'no open image with id 5') : undefined,
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;

      const restored = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: id,
      });
      expect(restored.isError).toBeFalsy();
      const text = (restored.content?.[0] as { text: string }).text;
      expect(text).toMatch(/already closed/);
      expect(text).not.toMatch(/session had restarted/);
      expect(text).toMatch(/restored as image 200/);
    });

    it('a close failure that is NOT the already-gone pattern still reports the new image id — assert state, not just isError', async () => {
      const gimp = makeCheckpointBackend({
        resultFor: (op) => (op === 'open' ? { image: 9, width: 1, height: 1 } : undefined),
        throwFor: (op) =>
          op === 'close' ? new GimpError('gimp_op_failed', 'disk went away') : undefined,
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;
      const restored = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: id,
      });
      expect(restored.isError).toBeFalsy();
      const structured = restored.structuredContent as {
        old_image: number;
        image: number;
        close_failed: boolean;
      };
      expect(structured.old_image).toBe(5);
      expect(structured.image).toBe(9);
      expect(structured.close_failed).toBe(true);
      const text = (restored.content?.[0] as { text: string }).text;
      expect(text).toMatch(/disk went away/);
      expect(text).toMatch(/restored as image 9/);
    });

    it('a close failure that is NOT the already-gone pattern leaves a sibling checkpoint untouched -- the failure gives no information about whether oldImage is really gone', async () => {
      const gimp = makeCheckpointBackend({
        resultFor: (op) => (op === 'open' ? { image: 9, width: 1, height: 1 } : undefined),
        throwFor: (op) =>
          op === 'close' ? new GimpError('gimp_op_failed', 'disk went away') : undefined,
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const c1 = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      const c2 = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      const id2 = (c2.structuredContent as { checkpoint_id: string }).checkpoint_id;

      const restored = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: (c1.structuredContent as { checkpoint_id: string }).checkpoint_id,
      });
      expect((restored.structuredContent as { close_failed: boolean }).close_failed).toBe(true);

      const listed = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      const c2Record = (
        listed.structuredContent as {
          checkpoints: Array<{ checkpoint_id: string; open: boolean; image: number }>;
        }
      ).checkpoints.find((c) => c.checkpoint_id === id2)!;
      expect(c2Record.open).toBe(true);
      expect(c2Record.image).toBe(5);
    });

    describe('a close failure accompanied by a generation bump always refuses, regardless of the close error code', () => {
      it.each([
        ['gimp_session_restarted', 'restarted'] as const,
        ['gimp_timeout', 'close timed out'] as const,
      ])('close throws %s', async (code, message) => {
        let gimp!: FakeGimpBackend;
        gimp = makeCheckpointBackend({
          generation: 1,
          resultFor: (op) => (op === 'open' ? { image: 101, width: 1, height: 1 } : undefined),
          throwFor: (op) => {
            if (op !== 'close') return undefined;
            gimp.generation = 2; // the process died between the open and this close attempt
            return new GimpError(code, message);
          },
        });
        const tools = createGimpCheckpointTools(gimp.asBackend());
        const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
        const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;

        const restored = await callTool(tools, 'gimp_checkpoint', {
          op: 'restore',
          checkpoint_id: id,
        });
        expect(restored.isError).toBe(true);
        expect((restored.content?.[0] as { text: string }).text).toMatch(
          /retry gimp_checkpoint op=restore/
        );

        const listed = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
        const record = (
          listed.structuredContent as {
            checkpoints: Array<{ checkpoint_id: string; image: number }>;
          }
        ).checkpoints.find((c) => c.checkpoint_id === id)!;
        expect(record.image).toBe(5); // unchanged — NOT stamped with the (possibly stale) 101
      });
    });

    describe('markSiblingsGone fires for every tolerated close outcome', () => {
      it('a tolerated "session restarted" close marks a same-generation sibling gone (not re-pointed)', async () => {
        const gimp = makeCheckpointBackend({
          generation: 1,
          resultFor: (op) => (op === 'open' ? { image: 200, width: 1, height: 1 } : undefined),
          throwFor: (op) =>
            op === 'close' ? new GimpError('gimp_session_restarted', 'restarted') : undefined,
        });
        const tools = createGimpCheckpointTools(gimp.asBackend());
        const c1 = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
        const c2 = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
        const id2 = (c2.structuredContent as { checkpoint_id: string }).checkpoint_id;

        await callTool(tools, 'gimp_checkpoint', {
          op: 'restore',
          checkpoint_id: (c1.structuredContent as { checkpoint_id: string }).checkpoint_id,
        });
        const listed = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
        const c2Record = (
          listed.structuredContent as {
            checkpoints: Array<{ checkpoint_id: string; open: boolean; image: number }>;
          }
        ).checkpoints.find((c) => c.checkpoint_id === id2)!;
        expect(c2Record.open).toBe(false);
        expect(c2Record.image).toBe(5);
      });

      it('a tolerated "already closed" close marks a same-generation sibling gone (not re-pointed)', async () => {
        const gimp = makeCheckpointBackend({
          generation: 1,
          resultFor: (op) => (op === 'open' ? { image: 200, width: 1, height: 1 } : undefined),
          throwFor: (op) =>
            op === 'close'
              ? new GimpError('invalid_argument', 'no open image with id 5')
              : undefined,
        });
        const tools = createGimpCheckpointTools(gimp.asBackend());
        const c1 = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
        const c2 = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
        const id2 = (c2.structuredContent as { checkpoint_id: string }).checkpoint_id;

        await callTool(tools, 'gimp_checkpoint', {
          op: 'restore',
          checkpoint_id: (c1.structuredContent as { checkpoint_id: string }).checkpoint_id,
        });
        const listed = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
        const c2Record = (
          listed.structuredContent as {
            checkpoints: Array<{ checkpoint_id: string; open: boolean; image: number }>;
          }
        ).checkpoints.find((c) => c.checkpoint_id === id2)!;
        expect(c2Record.open).toBe(false);
        expect(c2Record.image).toBe(5);
      });

      it('a confirmed generationChanged (no close attempted) marks a same-generation sibling gone (not re-pointed)', async () => {
        const gimp = makeCheckpointBackend({
          generation: 1,
          resultFor: (op) => (op === 'open' ? { image: 300, width: 1, height: 1 } : undefined),
        });
        const tools = createGimpCheckpointTools(gimp.asBackend());
        const c1 = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
        const c2 = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
        const id2 = (c2.structuredContent as { checkpoint_id: string }).checkpoint_id;

        gimp.generation = 2; // a restart happened before restore runs
        const restored = await callTool(tools, 'gimp_checkpoint', {
          op: 'restore',
          checkpoint_id: (c1.structuredContent as { checkpoint_id: string }).checkpoint_id,
        });
        expect(restored.isError).toBeFalsy();
        expect(gimp.allOps()).not.toContain('close');

        const listed = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
        const c2Record = (
          listed.structuredContent as {
            checkpoints: Array<{ checkpoint_id: string; open: boolean; image: number }>;
          }
        ).checkpoints.find((c) => c.checkpoint_id === id2)!;
        expect(c2Record.open).toBe(false);
        expect(c2Record.image).toBe(5);
      });
    });

    it('a different-generation record sharing the same stale image number is neither re-pointed nor marked gone', async () => {
      const gimp = makeCheckpointBackend({
        generation: 1,
        resultFor: (op) => (op === 'open' ? { image: 101, width: 1, height: 1 } : undefined),
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const c1 = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      const id1 = (c1.structuredContent as { checkpoint_id: string }).checkpoint_id;

      gimp.generation = 2; // a restart happens between the two creates
      const c2 = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      const id2 = (c2.structuredContent as { checkpoint_id: string }).checkpoint_id;

      const restored = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: id1,
      });
      expect(restored.isError).toBeFalsy();

      const listed = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      const c2Record = (
        listed.structuredContent as {
          checkpoints: Array<{ checkpoint_id: string; open: boolean; image: number }>;
        }
      ).checkpoints.find((c) => c.checkpoint_id === id2)!;
      expect(c2Record.open).toBe(true);
      expect(c2Record.image).toBe(5);
    });

    describe('generation known on only one side falls back to the pre-generation baseline (attempts the close)', () => {
      it('record.generation defined, gimp.generation undefined at restore time', async () => {
        const gimp = makeCheckpointBackend({
          generation: 1,
          resultFor: (op) => (op === 'open' ? { image: 101, width: 1, height: 1 } : undefined),
        });
        const tools = createGimpCheckpointTools(gimp.asBackend());
        const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
        const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;
        gimp.generation = undefined;
        const restored = await callTool(tools, 'gimp_checkpoint', {
          op: 'restore',
          checkpoint_id: id,
        });
        expect(restored.isError).toBeFalsy();
        const closeCall = gimp.calls.find((c) => c.op === 'close');
        expect(closeCall?.args.image).toBe(5);
      });

      it('record.generation undefined, gimp.generation defined at restore time', async () => {
        const gimp = makeCheckpointBackend({
          resultFor: (op) => (op === 'open' ? { image: 101, width: 1, height: 1 } : undefined),
        });
        const tools = createGimpCheckpointTools(gimp.asBackend());
        const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
        const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;
        gimp.generation = 9;
        const restored = await callTool(tools, 'gimp_checkpoint', {
          op: 'restore',
          checkpoint_id: id,
        });
        expect(restored.isError).toBeFalsy();
        const closeCall = gimp.calls.find((c) => c.op === 'close');
        expect(closeCall?.args.image).toBe(5);
      });
    });
  });

  describe('op=delete', () => {
    it('requires checkpoint_id, and dispatches no call when missing', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_checkpoint', { op: 'delete' });
      expect(result.isError).toBe(true);
      expect(gimp.calls).toHaveLength(0);
    });

    it('refuses an unknown checkpoint_id', async () => {
      const gimp = makeGimpBackend();
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_checkpoint', {
        op: 'delete',
        checkpoint_id: 'ghost',
      });
      expect(result.isError).toBe(true);
    });

    it('removes the entry so list no longer reports it and a later restore/delete refuses it', async () => {
      const gimp = makeCheckpointBackend();
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;

      const deleted = await callTool(tools, 'gimp_checkpoint', { op: 'delete', checkpoint_id: id });
      expect(deleted.isError).toBeFalsy();
      expect(deleted.structuredContent).toEqual({ checkpoint_id: id, deleted: true });

      const list = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      expect((list.structuredContent as { checkpoints: unknown[] }).checkpoints).toEqual([]);

      const secondDelete = await callTool(tools, 'gimp_checkpoint', {
        op: 'delete',
        checkpoint_id: id,
      });
      expect(secondDelete.isError).toBe(true);

      const restoreAfterDelete = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: id,
      });
      expect(restoreAfterDelete.isError).toBe(true);
    });

    it('frees a slot so a 6th create succeeds after a delete', async () => {
      const gimp = makeCheckpointBackend();
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const ids: string[] = [];
      for (let i = 0; i < MAX_CHECKPOINTS_PER_IMAGE; i++) {
        const r = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
        ids.push((r.structuredContent as { checkpoint_id: string }).checkpoint_id);
      }
      await callTool(tools, 'gimp_checkpoint', { op: 'delete', checkpoint_id: ids[0]! });
      const afterFree = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
      expect(afterFree.isError).toBeFalsy();
    });

    it('a delete rm failure (EPERM/EBUSY) is reported without leaking the absolute path', async () => {
      const gimp = makeCheckpointBackend();
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;
      const path = gimp.lastCall().args.path as string;

      vi.mocked(rm).mockRejectedValueOnce(
        new Error(`EPERM: operation not permitted, unlink '${path}'`)
      );
      const result = await callTool(tools, 'gimp_checkpoint', { op: 'delete', checkpoint_id: id });
      expect(result.isError).toBe(true);
      const text = (result.content?.[0] as { text: string }).text;
      expect(text).not.toContain(path);
      expect(text).toMatch(/could not delete checkpoint/);
    });
  });

  describe('a pending checkpoint (export still in flight)', () => {
    it('is not restorable/deletable, and list reports it as pending', async () => {
      let resolveExport!: (value: { bytes: number }) => void;
      const exportPromise = new Promise<{ bytes: number }>((resolve) => {
        resolveExport = resolve;
      });
      const gimp = makeGimpBackend({
        resultFor: (op) => (op === 'export' ? exportPromise : {}),
      });
      const base = join(scratchDir, `fake-${scratchCounter++}`);
      gimp.tempPath = (name: string) => join(base, name);
      const tools = createGimpCheckpointTools(gimp.asBackend());

      const createPromise = callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      // Yield until every microtask that CAN run without the export resolving has run — the
      // create call is now suspended purely on `exportPromise`, with its reservation already
      // visible in the registry.
      await new Promise((r) => setTimeout(r, 0));

      const midFlight = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      const pendingEntries = (
        midFlight.structuredContent as {
          checkpoints: Array<{ checkpoint_id: string; pending: boolean }>;
        }
      ).checkpoints;
      expect(pendingEntries).toHaveLength(1);
      expect(pendingEntries[0]!.pending).toBe(true);
      const id = pendingEntries[0]!.checkpoint_id;

      const restoreAttempt = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: id,
      });
      expect(restoreAttempt.isError).toBe(true);
      expect((restoreAttempt.content?.[0] as { text: string }).text).toMatch(/still being created/);

      const deleteAttempt = await callTool(tools, 'gimp_checkpoint', {
        op: 'delete',
        checkpoint_id: id,
      });
      expect(deleteAttempt.isError).toBe(true);
      expect((deleteAttempt.content?.[0] as { text: string }).text).toMatch(/still being created/);

      resolveExport({ bytes: 123 });
      const created = await createPromise;
      expect(created.isError).toBeFalsy();

      const after = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      const afterEntry = (after.structuredContent as { checkpoints: Array<{ pending: boolean }> })
        .checkpoints[0]!;
      expect(afterEntry.pending).toBe(false);
    });
  });
});

describe('repointSiblings', () => {
  function makeRecord(overrides: Partial<CheckpointRecord>): CheckpointRecord {
    return {
      id: 'id',
      image: 5,
      open: true,
      generation: undefined,
      pending: false,
      path: '/fake/checkpoint.xcf',
      bytes: 0,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('when generation is unknown, a sibling already marked open: false is left untouched rather than incorrectly revived onto the new image', () => {
    const registry = new Map<string, CheckpointRecord>();
    registry.set('open-sibling', makeRecord({ id: 'open-sibling', image: 5, open: true }));
    registry.set('closed-sibling', makeRecord({ id: 'closed-sibling', image: 5, open: false }));
    registry.set('other-image', makeRecord({ id: 'other-image', image: 9, open: true }));

    repointSiblings(registry, 5, 101, undefined, undefined);

    expect(registry.get('open-sibling')).toMatchObject({ image: 101, open: true });
    expect(registry.get('closed-sibling')).toMatchObject({ image: 5, open: false });
    expect(registry.get('other-image')).toMatchObject({ image: 9, open: true });
  });
});

describe('sweepStaleCheckpointDirs', () => {
  it('removes a dead-pid directory only once old enough, keeps a live-pid directory, a too-young dead-pid one, and its own directory, and ignores non-matching names', () => {
    const parent = mkdtempSync(join(tmpdir(), 'gimp-checkpoint-sweep-'));
    try {
      const ownDir = join(parent, `checkpoints-${process.pid}-${randomUUID()}`);
      mkdirSync(ownDir);
      const otherLiveDir = join(parent, `checkpoints-${process.pid}-${randomUUID()}`);
      mkdirSync(otherLiveDir);
      const dead = deadPid();
      const deadDirYoung = join(parent, `checkpoints-${dead}-${randomUUID()}`);
      mkdirSync(deadDirYoung); // dead pid, freshly created — the age floor protects it
      const deadDirOld = join(parent, `checkpoints-${dead}-${randomUUID()}`);
      mkdirSync(deadDirOld);
      const oldTimeSec = (Date.now() - 2 * 60 * 60 * 1000) / 1000; // 2h old
      utimesSync(deadDirOld, oldTimeSec, oldTimeSec);
      const nonMatching = join(parent, 'not-a-checkpoint-dir');
      mkdirSync(nonMatching);

      sweepStaleCheckpointDirs(parent, ownDir, new Set());

      expect(existsSync(ownDir)).toBe(true);
      expect(existsSync(otherLiveDir)).toBe(true);
      expect(existsSync(nonMatching)).toBe(true);
      expect(existsSync(deadDirYoung)).toBe(true);
      expect(existsSync(deadDirOld)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("keeps a LIVE sibling process's directory, and sweeps it once that process is dead", async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gimp-checkpoint-sweep-live-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });
      const pid = child.pid!;
      const dir = join(parent, `checkpoints-${pid}-${randomUUID()}`);
      mkdirSync(dir);
      const oldTimeSec = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
      utimesSync(dir, oldTimeSec, oldTimeSec); // old enough that only liveness protects it now
      const ownDir = join(parent, `checkpoints-${process.pid}-${randomUUID()}`);
      mkdirSync(ownDir);

      sweepStaleCheckpointDirs(parent, ownDir, new Set());
      expect(existsSync(dir)).toBe(true); // sibling process still alive — untouched regardless of age

      child.kill();
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));

      sweepStaleCheckpointDirs(parent, ownDir, new Set());
      expect(existsSync(dir)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  describe('the container-pid-1 leak: a directory sharing OUR OWN pid', () => {
    // `processStartedAt` is the 4th, test-only injectable parameter — a directory's real
    // filesystem birthtime can't be faked from a test, but WHEN this process is considered to
    // have started can, which is exactly the comparison this rule needs proved out.
    it('is reclaimed when untracked and it predates this process', () => {
      const parent = mkdtempSync(join(tmpdir(), 'gimp-checkpoint-sweep-pid1-leak-'));
      try {
        const leftover = join(parent, `checkpoints-${process.pid}-${randomUUID()}`);
        mkdirSync(leftover); // real birthtime: "now"
        const afterCreation = Date.now() + 60_000; // this process "started" AFTER leftover's birth
        sweepStaleCheckpointDirs(parent, join(parent, 'own-nonexistent'), new Set(), afterCreation);
        expect(existsSync(leftover)).toBe(false);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });

    it('is kept when it IS tracked, even though it would otherwise look like a leak', () => {
      const parent = mkdtempSync(join(tmpdir(), 'gimp-checkpoint-sweep-pid1-tracked-'));
      try {
        const ours = join(parent, `checkpoints-${process.pid}-${randomUUID()}`);
        mkdirSync(ours);
        const afterCreation = Date.now() + 60_000;
        sweepStaleCheckpointDirs(
          parent,
          join(parent, 'own-nonexistent'),
          new Set([ours]),
          afterCreation
        );
        expect(existsSync(ours)).toBe(true);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });

    it('is kept when it was genuinely created during this run (birthtime after processStartedAt)', () => {
      const parent = mkdtempSync(join(tmpdir(), 'gimp-checkpoint-sweep-pid1-fresh-'));
      try {
        const fresh = join(parent, `checkpoints-${process.pid}-${randomUUID()}`);
        mkdirSync(fresh); // real birthtime: "now"
        const beforeCreation = Date.now() - 60_000; // this process started BEFORE fresh's birth
        sweepStaleCheckpointDirs(
          parent,
          join(parent, 'own-nonexistent'),
          new Set(),
          beforeCreation
        );
        expect(existsSync(fresh)).toBe(true);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });
  });

  it('does not follow a symlink even if its name matches the pattern', () => {
    const parent = mkdtempSync(join(tmpdir(), 'gimp-checkpoint-sweep-symlink-'));
    try {
      const target = join(parent, 'real-target');
      mkdirSync(target);
      const dead = deadPid();
      const linkPath = join(parent, `checkpoints-${dead}-${randomUUID()}`);
      try {
        symlinkSync(target, linkPath, 'junction');
      } catch {
        return; // cannot create a symlink/junction in this environment — nothing to assert
      }
      sweepStaleCheckpointDirs(parent, join(parent, 'own-nonexistent'), new Set());
      expect(existsSync(linkPath)).toBe(true);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("propagates a failure to read the parent directory itself (the caller's job to catch and retry)", () => {
    expect(() =>
      sweepStaleCheckpointDirs(
        join(tmpdir(), `gimp-checkpoint-sweep-does-not-exist-${randomUUID()}`),
        'unused',
        new Set()
      )
    ).toThrow();
  });
});

describe('maybeSweepSiblingDirs', () => {
  it('swallows a sweep failure and does not mark it done, so the next call retries it; a later successful sweep marks it done', () => {
    const store: CheckpointStore = {
      registry: new Map(),
      dir: undefined,
      dirPromise: undefined,
      sweepDone: false,
    };
    const badDir = join(
      tmpdir(),
      `gimp-checkpoint-does-not-exist-${randomUUID()}`,
      'nested-checkpoints-dir'
    );
    expect(() => maybeSweepSiblingDirs(store, badDir)).not.toThrow();
    expect(store.sweepDone).toBe(false);

    const realParent = mkdtempSync(join(tmpdir(), 'gimp-checkpoint-sweep-retry-'));
    try {
      const realDir = join(realParent, `checkpoints-${process.pid}-${randomUUID()}`);
      mkdirSync(realDir);
      maybeSweepSiblingDirs(store, realDir);
      expect(store.sweepDone).toBe(true);
    } finally {
      rmSync(realParent, { recursive: true, force: true });
    }
  });
});

describe('cleanupCheckpointDirs', () => {
  it('removes every directory given to it', () => {
    const parent = mkdtempSync(join(tmpdir(), 'gimp-checkpoint-cleanup-'));
    try {
      const a = join(parent, 'a');
      const b = join(parent, 'b');
      mkdirSync(a);
      mkdirSync(b);
      cleanupCheckpointDirs([a, b]);
      expect(existsSync(a)).toBe(false);
      expect(existsSync(b)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('exit-hook registration (module-scoped, once per process)', () => {
  it('creating many factory instances and creating a checkpoint in each never adds more than one net-new "exit" listener for the whole process', async () => {
    // The module-level "registered" flag this relies on may already have been set by an earlier
    // test in this same file/process (most of them call `create` too), so this can't assert an
    // exact before/after delta — only the invariant that actually matters: 3 factory instances
    // never add 3 listeners (one per instance), which is what would eventually trip Node's own
    // MaxListenersExceededWarning for a long-lived host that builds this factory many times over.
    const before = process.listenerCount('exit');
    for (let i = 0; i < 3; i++) {
      const gimp = makeCheckpointBackend();
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
      expect(result.isError).toBeFalsy();
    }
    const after = process.listenerCount('exit');
    expect(after - before).toBeLessThanOrEqual(1);
    expect(after).toBeGreaterThanOrEqual(1);
  });

  it("a directory made by create is removed once the shared exit hook's own cleanup runs against its tracked set", async () => {
    const gimp = makeCheckpointBackend();
    const tools = createGimpCheckpointTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
    expect(result.isError).toBeFalsy();
    const dir = dirname(gimp.lastCall().args.path as string);
    expect(existsSync(dir)).toBe(true);
    // Exercise the exact cleanup function the exit listener calls, against a set that includes
    // this directory — proving it really is one of the tracked ones an exit would remove, without
    // firing a real process 'exit' event in this shared test run (this file's test process has
    // its own other exit listeners, e.g. from other test files/modules, that a real 'exit' would
    // also trigger mid-run).
    cleanupCheckpointDirs([dir]);
    expect(existsSync(dir)).toBe(false);
  });

  it('a directory made by create is a member of the SAME tracked set the shared exit hook sweeps, not just independently cleanable', async () => {
    const gimp = makeCheckpointBackend();
    const tools = createGimpCheckpointTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
    expect(result.isError).toBeFalsy();
    const dir = dirname(gimp.lastCall().args.path as string);
    expect(isTrackedForExitCleanup(dir)).toBe(true);
  });
});

describe('store-directory creation', () => {
  it('a creation failure (mkdir under an existing FILE) is reported without leaking the path', async () => {
    const fileNotDir = join(scratchDir, `not-a-directory-${scratchCounter++}.txt`);
    writeFileSync(fileNotDir, 'x');
    const gimp = makeCheckpointBackend();
    gimp.tempPath = (name: string) => join(fileNotDir, name); // a path SEGMENT is a plain file
    const tools = createGimpCheckpointTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text: string }).text;
    expect(text).toMatch(/could not create the checkpoint storage directory/);
    expect(JSON.stringify(result)).not.toContain(fileNotDir);
  });

  it('creates the leaf non-recursively, so a pre-existing directory at that exact path throws EEXIST rather than being silently adopted', async () => {
    const fixedDir = join(scratchDir, `fake-${scratchCounter++}`, 'checkpoints-fixed');
    mkdirSync(fixedDir, { recursive: true }); // pre-exists BEFORE create ever runs
    const gimp = makeCheckpointBackend();
    gimp.tempPath = () => fixedDir; // every call resolves to this SAME, already-existing leaf
    const tools = createGimpCheckpointTools(gimp.asBackend());
    const result = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toMatch(
      /could not create the checkpoint storage directory/
    );
  });

  it('two concurrent first creates share ONE store directory, not two', async () => {
    const gimp = makeCheckpointBackend();
    const tools = createGimpCheckpointTools(gimp.asBackend());
    const [first, second] = await Promise.all([
      callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 }),
      callTool(tools, 'gimp_checkpoint', { op: 'create', image: 2 }),
    ]);
    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    const exportCalls = gimp.calls.filter((c) => c.op === 'export');
    expect(exportCalls).toHaveLength(2);
    const dir1 = dirname(exportCalls[0]!.args.path as string);
    const dir2 = dirname(exportCalls[1]!.args.path as string);
    expect(dir1).toBe(dir2);
  });
});

describe('list/delete/restore never touch the filesystem or GIMP on a fresh (never-created) store', () => {
  it('list never calls prepare or creates a directory', async () => {
    const gimp = makeCheckpointBackend();
    const tools = createGimpCheckpointTools(gimp.asBackend());
    const prepareSpy = vi.spyOn(gimp, 'prepare');
    const tempPathSpy = vi.spyOn(gimp, 'tempPath');
    const result = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
    expect(result.isError).toBeFalsy();
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(tempPathSpy).not.toHaveBeenCalled();
  });

  it('delete on an unknown id never calls prepare or creates a directory', async () => {
    const gimp = makeCheckpointBackend();
    const tools = createGimpCheckpointTools(gimp.asBackend());
    const prepareSpy = vi.spyOn(gimp, 'prepare');
    const tempPathSpy = vi.spyOn(gimp, 'tempPath');
    const result = await callTool(tools, 'gimp_checkpoint', {
      op: 'delete',
      checkpoint_id: 'ghost',
    });
    expect(result.isError).toBe(true);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(tempPathSpy).not.toHaveBeenCalled();
  });

  it('restore on an unknown id never calls prepare or creates a directory', async () => {
    const gimp = makeCheckpointBackend();
    const tools = createGimpCheckpointTools(gimp.asBackend());
    const prepareSpy = vi.spyOn(gimp, 'prepare');
    const tempPathSpy = vi.spyOn(gimp, 'tempPath');
    const result = await callTool(tools, 'gimp_checkpoint', {
      op: 'restore',
      checkpoint_id: 'ghost',
    });
    expect(result.isError).toBe(true);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(tempPathSpy).not.toHaveBeenCalled();
  });
});
