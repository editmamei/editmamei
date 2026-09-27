import { describe, it, expect } from 'vitest';
import {
  createGimpCheckpointTools,
  MAX_CHECKPOINTS_PER_IMAGE,
} from '@editmamei/tools/gimp-checkpoint-tools.ts';
import { GimpError } from '@editmamei/backends/gimp/errors.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';
import { callTool, assertToolShape } from '../fixtures/tool-helpers.ts';

/** `op='export'` (create) always answers with this; `op='open'` (restore) is per-test via `resultFor`. */
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
      // The internal file path never reaches the model.
      const text = (result.content?.[0] as { text: string }).text;
      const allText = JSON.stringify(result);
      expect(allText).not.toContain((gimp.lastCall().args.path as string) ?? '__unreachable__');
      expect(text).toContain(structured.checkpoint_id);
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
      };
      expect(structured.old_image).toBe(5);
      expect(structured.image).toBe(101);
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

    it('tolerates the old image already being gone (a GIMP session restart) instead of failing', async () => {
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
      expect(text).toMatch(/already gone/);
      expect(text).toMatch(/session had restarted/);
      expect(text).toMatch(/restored as image 200/);
    });

    it('propagates a close failure that is NOT the already-gone pattern', async () => {
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
      expect(restored.isError).toBe(true);
      expect((restored.content?.[0] as { text: string }).text).toMatch(/disk went away/);
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
  });
});
