import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import {
  createGimpCheckpointTools,
  cleanupRegisteredCheckpointFiles,
  sweepStaleCheckpointFiles,
  MAX_CHECKPOINTS_PER_IMAGE,
  type CheckpointRecord,
} from '@editmamei/tools/gimp-checkpoint-tools.ts';
import { GimpError } from '@editmamei/backends/gimp/errors.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

// Only `rm` (op=delete's own removal call) needs to be interceptable per-test (HIGH #6's
// path-free-error test); every other test relies on the REAL `rm` harmlessly no-op'ing against
// the fake backend's made-up paths (they never exist, and `force: true` treats that as success).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

/** `op='export'` (create) always answers with this; `op='open'`/`op='ping'` are per-test via `resultFor`. */
function backendResultFor(overrides: (op: string, args: Record<string, unknown>) => unknown) {
  return makeGimpBackend({
    resultFor: (op, args) => {
      if (op === 'export') return { path: args.path, bytes: 4096 };
      return overrides(op, args);
    },
  });
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

    it('exports to an internal path and returns a checkpoint_id, never the path itself', async () => {
      const gimp = backendResultFor(() => ({}));
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      expect(result.isError).toBeFalsy();
      expect(gimp.lastCall().op).toBe('export');
      expect(gimp.lastCall().args.image).toBe(5);
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
      expect(typeof structured.created_at).toBe('string');
      // ISO-8601 (LOW #10), not a locale-formatted string.
      expect(structured.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // The internal file path never reaches the model.
      const text = (result.content?.[0] as { text: string }).text;
      const allText = JSON.stringify(result);
      expect(allText).not.toContain((gimp.lastCall().args.path as string) ?? '__unreachable__');
      expect(text).toContain(structured.checkpoint_id);
    });

    it('a create whose export throws registers nothing (no file to check in a fake backend, but the registry stays empty)', async () => {
      const gimp = makeGimpBackend({
        throwFor: (op) => {
          if (op === 'export') return new GimpError('gimp_op_failed', 'disk full');
          return undefined;
        },
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const result = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
      expect(result.isError).toBe(true);
      const listed = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      expect((listed.structuredContent as { checkpoints: unknown[] }).checkpoints).toEqual([]);
    });

    it('refuses a 6th checkpoint for the same image without dispatching, and says how to free a slot', async () => {
      const gimp = backendResultFor(() => ({}));
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
      // No new bridge call for the refused attempt.
      expect(gimp.allOps().filter((o) => o === 'export')).toHaveLength(MAX_CHECKPOINTS_PER_IMAGE);
      const refusedText = (refused.content?.[0] as { text: string }).text;
      expect(refusedText).toMatch(/already has 5 checkpoints/);
      expect(refusedText).toMatch(/op=delete/);
      for (const id of ids) expect(refusedText).toContain(id);

      // A DIFFERENT image is unaffected by image 1's cap.
      const otherImage = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 2 });
      expect(otherImage.isError).toBeFalsy();
    });

    it('concurrent creates for the same image never exceed the cap (the check-then-reserve is synchronous)', async () => {
      const gimp = backendResultFor(() => ({}));
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

    it('a stale (closed-elsewhere) record is excluded from its images cap and scoped list, but still appears (open: false) in the unscoped list', async () => {
      let pingImages: number[] = [1];
      const gimp = makeGimpBackend({
        resultFor: (op, args) => {
          if (op === 'export') return { path: args.path, bytes: 10 };
          if (op === 'ping') return { images: pingImages };
          return undefined;
        },
      });
      const tools = createGimpCheckpointTools(gimp.asBackend());
      const ids: string[] = [];
      for (let i = 0; i < MAX_CHECKPOINTS_PER_IMAGE; i++) {
        const r = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
        expect(r.isError).toBeFalsy();
        ids.push((r.structuredContent as { checkpoint_id: string }).checkpoint_id);
      }

      // image 1 is closed elsewhere (e.g. gimp_close_document) — ping stops listing it.
      pingImages = [];
      const scopedBefore = await callTool(tools, 'gimp_checkpoint', { op: 'list', image: 1 });
      expect((scopedBefore.structuredContent as { checkpoints: unknown[] }).checkpoints).toEqual(
        []
      );
      const unscoped = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      const all = (unscoped.structuredContent as { checkpoints: Array<{ open: boolean }> })
        .checkpoints;
      expect(all).toHaveLength(MAX_CHECKPOINTS_PER_IMAGE);
      expect(all.every((c) => c.open === false)).toBe(true);

      // A DIFFERENT image later reuses the same number 1 (ping now reports it open again) — the
      // 5 stale records stay gone (never revived) and no longer count toward the cap.
      pingImages = [1];
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
  });

  describe('op=list', () => {
    it('reports every checkpoint when no image is given, scoped when one is', async () => {
      const gimp = backendResultFor(() => ({}));
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
      const gimp = backendResultFor(() => ({}));
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

    it('restore where open() itself throws never dispatches close, and the record is unchanged', async () => {
      const gimp = makeGimpBackend({
        resultFor: (op, args) => {
          if (op === 'export') return { path: args.path, bytes: 10 };
          return undefined;
        },
        throwFor: (op) => {
          if (op === 'open') return new GimpError('file_not_found', 'no file at that path');
          return undefined;
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
      expect(gimp.allOps()).not.toContain('close');

      const listed = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      const record = (
        listed.structuredContent as { checkpoints: Array<{ checkpoint_id: string; image: number }> }
      ).checkpoints.find((c) => c.checkpoint_id === id)!;
      expect(record.image).toBe(5);
    });

    it('never closes when the freshly reopened image reuses the exact id restore remembers as old (the one case detectable without a GIMP process generation signal)', async () => {
      const gimp = backendResultFor((op) => {
        if (op === 'open') return { image: 5, width: 1, height: 1 }; // SAME id as the source image
        return {};
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
      const gimp = backendResultFor((op) => {
        if (op === 'open') return { image: ++nextImage, width: 64, height: 48 };
        return {};
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
        close_failed: boolean;
      };
      expect(structured.old_image).toBe(5);
      expect(structured.image).toBe(101);
      expect(structured.close_failed).toBe(false);
      const text = (restored.content?.[0] as { text: string }).text;
      expect(text).toMatch(/image 5 closed/);
      expect(text).toMatch(/restored as image 101/);
      expect(text).toMatch(/use 101 from now on/);
      // The bridge saw open, then close on the OLD (pre-restore) image.
      const ops = gimp.calls.slice(-2);
      expect(ops[0]).toMatchObject({ op: 'open' });
      expect(ops[1]).toMatchObject({ op: 'close', args: { image: 5 } });

      // A SECOND restore of the SAME checkpoint closes the image the FIRST
      // restore opened (101), not the original (5) — replace-semantics
      // lineage tracking.
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
      const gimp = backendResultFor((op) => {
        if (op === 'open') return { image: ++nextImage, width: 10, height: 10 };
        return {};
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

      // c2 (not directly restored) has also moved to 101 — it now describes the same
      // transformed lineage image 5 became.
      const listed = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
      const checkpoints = (
        listed.structuredContent as {
          checkpoints: Array<{ checkpoint_id: string; image: number; open: boolean }>;
        }
      ).checkpoints;
      const c2Record = checkpoints.find((c) => c.checkpoint_id === id2)!;
      expect(c2Record.image).toBe(101);
      expect(c2Record.open).toBe(true);

      // Restoring c2 next closes 101 (not the stale original 5) and re-points BOTH again.
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
      const gimp = makeGimpBackend({
        resultFor: (op, args) => {
          if (op === 'export') return { path: args.path, bytes: 10 };
          if (op === 'open') return { image: 200, width: 10, height: 10 };
          return undefined;
        },
        throwFor: (op) => {
          if (op === 'close') {
            return new GimpError(
              'gimp_session_restarted',
              'that image id is not open. The GIMP session restarted, so every open image and unsaved filter is gone.'
            );
          }
          return undefined;
        },
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

    it('a close that reports a plain "no open image" (no restart involved) says merely "already closed", not "session had restarted" (HIGH #8 wording fix)', async () => {
      const gimp = makeGimpBackend({
        resultFor: (op, args) => {
          if (op === 'export') return { path: args.path, bytes: 10 };
          if (op === 'open') return { image: 200, width: 10, height: 10 };
          return undefined;
        },
        throwFor: (op) => {
          if (op === 'close') return new GimpError('invalid_argument', 'no open image with id 5');
          return undefined;
        },
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

    it('a close failure that is NOT the already-gone pattern still reports the new image id — assert state, not just isError (HIGH #5)', async () => {
      const gimp = makeGimpBackend({
        resultFor: (op, args) => {
          if (op === 'export') return { path: args.path, bytes: 10 };
          if (op === 'open') return { image: 9, width: 1, height: 1 };
          return undefined;
        },
        throwFor: (op) => {
          if (op === 'close') return new GimpError('gimp_op_failed', 'disk went away');
          return undefined;
        },
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

    describe('generation-aware close decision', () => {
      it('generation known and equal (no restart) closes as usual', async () => {
        const gimp = backendResultFor((op) => {
          if (op === 'open') return { image: 101, width: 1, height: 1 };
          return {};
        });
        gimp.generation = 7;
        const tools = createGimpCheckpointTools(gimp.asBackend());
        const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
        const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;

        // generation unchanged (still 7) — a normal, same-process restore.
        const restored = await callTool(tools, 'gimp_checkpoint', {
          op: 'restore',
          checkpoint_id: id,
        });
        expect(restored.isError).toBeFalsy();
        const closeCall = gimp.calls.find((c) => c.op === 'close');
        expect(closeCall?.args.image).toBe(5);
      });

      it('generation changed: an unrelated image reusing the old id is left untouched — no close dispatched', async () => {
        const gimp = backendResultFor((op) => {
          if (op === 'open') return { image: 2, width: 1, height: 1 };
          return {};
        });
        gimp.generation = 1;
        const tools = createGimpCheckpointTools(gimp.asBackend());
        const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
        const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;

        // Simulate a restart: a NEW process is now running (generation bumped), and the model
        // has separately opened some OTHER, unrelated image that also happens to land on id 1 in
        // the new process — exactly the scenario the opened==old guard alone cannot catch, since
        // restore's own reopened file gets a DIFFERENT id (2) here.
        gimp.generation = 2;

        const restored = await callTool(tools, 'gimp_checkpoint', {
          op: 'restore',
          checkpoint_id: id,
        });
        expect(restored.isError).toBeFalsy();
        expect(gimp.allOps()).not.toContain('close');
        const structured = restored.structuredContent as { old_image: number; image: number };
        expect(structured.old_image).toBe(1);
        expect(structured.image).toBe(2);
        const text = (restored.content?.[0] as { text: string }).text;
        expect(text).toMatch(/has since restarted/);
        expect(text).toMatch(/left untouched/);
      });

      it('generation undefined on either side falls back to the pre-generation baseline (attempts the close)', async () => {
        let nextImage = 100;
        const gimp = backendResultFor((op) => {
          if (op === 'open') return { image: ++nextImage, width: 1, height: 1 };
          return {};
        });
        // gimp.generation stays undefined throughout — the degraded-shim path.
        const tools = createGimpCheckpointTools(gimp.asBackend());
        const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 5 });
        const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;

        const restored = await callTool(tools, 'gimp_checkpoint', {
          op: 'restore',
          checkpoint_id: id,
        });
        expect(restored.isError).toBeFalsy();
        const closeCall = gimp.calls.find((c) => c.op === 'close');
        expect(closeCall?.args.image).toBe(5);
      });

      it('refreshOpenness marks a record from an older generation gone, exactly, even with no ping-based signal', async () => {
        const gimp = backendResultFor(() => ({})); // 'ping' -> {} (no images array): generation
        // is the only usable signal in this test.
        gimp.generation = 1;
        const tools = createGimpCheckpointTools(gimp.asBackend());
        const created = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
        const id = (created.structuredContent as { checkpoint_id: string }).checkpoint_id;

        gimp.generation = 2; // a restart happened
        const listed = await callTool(tools, 'gimp_checkpoint', { op: 'list' });
        const record = (
          listed.structuredContent as {
            checkpoints: Array<{ checkpoint_id: string; open: boolean }>;
          }
        ).checkpoints.find((c) => c.checkpoint_id === id)!;
        expect(record.open).toBe(false);

        // A NEW image reusing the SAME number 1 in the new generation still gets its own cap.
        const afterRestart = await callTool(tools, 'gimp_checkpoint', { op: 'create', image: 1 });
        expect(afterRestart.isError).toBeFalsy();
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
      const gimp = backendResultFor(() => ({}));
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
      const gimp = backendResultFor(() => ({}));
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

    it('a delete rm failure (EPERM/EBUSY) is reported without leaking the absolute path (HIGH #6)', async () => {
      const gimp = backendResultFor(() => ({}));
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
});

describe('cleanupRegisteredCheckpointFiles (the exit-hook cleanup, called directly)', () => {
  it('removes every file the registry still references', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gimp-checkpoint-cleanup-'));
    try {
      const pathA = join(dir, 'checkpoint-a.xcf');
      const pathB = join(dir, 'checkpoint-b.xcf');
      writeFileSync(pathA, 'x');
      writeFileSync(pathB, 'x');
      const registry = new Map<string, CheckpointRecord>([
        [
          'a',
          { id: 'a', image: 1, path: pathA, bytes: 1, createdAt: '', open: true, generation: 0 },
        ],
        [
          'b',
          { id: 'b', image: 2, path: pathB, bytes: 1, createdAt: '', open: true, generation: 0 },
        ],
      ]);
      cleanupRegisteredCheckpointFiles(registry);
      expect(existsSync(pathA)).toBe(false);
      expect(existsSync(pathB)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sweepStaleCheckpointFiles (the 24h crash-leftover sweep, called directly)', () => {
  it('removes checkpoint files older than 24h but leaves young ones and non-matching names alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gimp-checkpoint-sweep-'));
    try {
      const old = join(dir, 'checkpoint-old.xcf');
      const young = join(dir, 'checkpoint-young.xcf');
      const other = join(dir, 'not-a-checkpoint.xcf');
      writeFileSync(old, 'x');
      writeFileSync(young, 'x');
      writeFileSync(other, 'x');
      const now = Date.now();
      const oldTimeSec = (now - 25 * 60 * 60 * 1000) / 1000;
      utimesSync(old, oldTimeSec, oldTimeSec);
      sweepStaleCheckpointFiles(dir, () => now);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(young)).toBe(true);
      expect(existsSync(other)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing (does not throw) when the directory does not exist', () => {
    expect(() =>
      sweepStaleCheckpointFiles(join(tmpdir(), 'gimp-checkpoint-sweep-does-not-exist'))
    ).not.toThrow();
  });
});
