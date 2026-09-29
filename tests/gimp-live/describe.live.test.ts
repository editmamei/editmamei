/**
 * `gimp_inspect`'s describe-by-id targets (document/layers/channels/filter), against real
 * headless GIMP: a layer group with a nested layer, a text layer, a mask channel, and a masked
 * filter on the nested layer -- the shapes `ops.py`'s `op_describe` must report correctly, and
 * the same fixture `foreign-and-nested.live.test.ts` builds nested state from (`test_wrap_in_group`).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import { writeGrayRamp, readySession, LIVE_READY_TIMEOUT_MS, TEST_OPS_PY } from './support.ts';

// 60 s like the other multi-step live files: this file's fixture adds a text layer, and GIMP's first text
// layer can load fonts for well over 30 s when the whole live suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

const REQUIRE_GIMP = process.env.EDITMAMEI_REQUIRE_GIMP === '1';

// Top-level await, not a beforeAll -- see session.live.test.ts's identical comment: describe.skipIf's
// condition is read at collection time, synchronously.
const install: GimpInstall | null = await detectGimp();

// Un-gated on purpose -- every other test below lives inside describe.skipIf(!install), which
// would otherwise let this file go quietly green on a run that never touched real GIMP.
it('GIMP must actually be detected when EDITMAMEI_REQUIRE_GIMP=1 (describe)', () => {
  if (!REQUIRE_GIMP) return;
  expect(install, 'EDITMAMEI_REQUIRE_GIMP=1 but detectGimp() found no install').not.toBeNull();
});

interface LayerNode {
  layer_id: number;
  name: string;
  opacity: number;
  mode: string;
  visible: boolean;
  offsets: { x: number; y: number };
  has_alpha: boolean;
  is_group: boolean;
  is_text_layer: boolean;
  children: LayerNode[];
}

/** `document`'s cheap channel listing -- id/name only, no coverage (see `ChannelCoverage`). */
interface ChannelSummary {
  channel_id: number;
  name: string;
}

/** `channels`' own listing -- the coverage stat `document` deliberately skips. */
interface ChannelCoverage {
  channel_id: number;
  name: string;
  selected_pixels: number;
  fraction: number;
}

interface DocumentDescribe {
  image: number;
  width: number;
  height: number;
  base_type: string;
  precision: string;
  resolution: { x: number; y: number };
  layers: LayerNode[];
  truncated: boolean;
  top_level_count: number;
  total_nodes: number;
  channels: ChannelSummary[];
}

interface LayersDescribe {
  layers: LayerNode[];
  truncated: boolean;
  top_level_count: number;
  total_nodes: number;
}

interface FilterRecord {
  layer: string;
  layer_id: number;
  filter_id: number;
  name: string;
  operation: string;
  type: string | null;
  visible: boolean;
  source: string;
  mask: string | null;
  params: Record<string, unknown>;
}

describe.skipIf(!install)('gimp_inspect describe-by-id', () => {
  let workDir: string;
  let session: GimpSession;
  let rampPath: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-describe-'));
    session = new GimpSession({
      install: install!,
      rootDir: join(workDir, 'session-root'),
      opsPyPath: TEST_OPS_PY,
    });
    await readySession(session);
    rampPath = join(workDir, 'ramp.png');
    writeGrayRamp(rampPath, 64, 32);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  /** Builds: a group ('Group') containing a nested layer ('Nested'), a text layer at the top of
   * the stack, a named mask channel ('HalfMask'), and a brightness_contrast filter on 'Nested'
   * confined to that mask -- one fixture exercising every field `document`'s describe reports. */
  async function buildFixture() {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    const image = opened.image;
    await session.call('test_wrap_in_group', { image });
    await session.call('create_mask', {
      image,
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 32,
      height: 32,
      name: 'HalfMask',
    });
    const filter = await session.call<{ filter_id: number; name: string }>('adjust', {
      image,
      type: 'brightness_contrast',
      brightness: 40,
      layer: 'Nested',
      mask: 'HalfMask',
      name: 'NestedLift',
    });
    const text = await session.call<{ layer_id: number; name: string }>('test_add_text_layer', {
      image,
      text: 'Hi',
    });
    return { image, filterId: filter.filter_id, textLayerId: text.layer_id };
  }

  it("what='document' reports dims/base_type/precision/resolution plus the full layer tree and channels", async () => {
    const { image, filterId, textLayerId } = await buildFixture();
    try {
      const doc = await session.call<DocumentDescribe>('describe', { image, what: 'document' });
      expect(doc.image).toBe(image);
      expect(doc.width).toBe(64);
      expect(doc.height).toBe(32);
      expect(doc.base_type).toBe('rgb');
      expect(typeof doc.precision).toBe('string');
      expect(doc.resolution.x).toBeGreaterThan(0);
      expect(doc.resolution.y).toBeGreaterThan(0);

      // Top-of-stack first: the text layer was inserted last (at position 0), then the group
      // (from test_wrap_in_group, also inserted at position 0 before the text layer existed),
      // then the original background layer.
      expect(doc.layers).toHaveLength(3);
      const [textNode, groupNode, backgroundNode] = doc.layers;
      expect(textNode).toMatchObject({
        layer_id: textLayerId,
        is_text_layer: true,
        is_group: false,
        children: [],
      });
      expect(groupNode).toMatchObject({ name: 'Group', is_group: true, is_text_layer: false });
      expect(groupNode!.children).toHaveLength(1);
      expect(groupNode!.children[0]).toMatchObject({
        name: 'Nested',
        is_group: false,
        is_text_layer: false,
        has_alpha: expect.any(Boolean),
      });
      expect(typeof groupNode!.children[0]!.layer_id).toBe('number');
      expect(groupNode!.children[0]!.offsets).toEqual({
        x: expect.any(Number),
        y: expect.any(Number),
      });
      expect(backgroundNode).toMatchObject({ is_group: false, is_text_layer: false });

      // 'document' lists channels by id/name only -- no coverage (that's what='channels' job,
      // asserted in the next test): a small, deliberately fixed-shape fixture, so an unexpected
      // 'selected_pixels'/'fraction' key here would mean the cost 'document' is meant to skip
      // leaked back in.
      expect(doc.truncated).toBe(false);
      // 3 top-level (text, group, background) + 1 nested ('Nested', inside the group) = 4 total.
      expect(doc.top_level_count).toBe(3);
      expect(doc.total_nodes).toBe(4);
      expect(doc.channels).toHaveLength(1);
      expect(doc.channels[0]).toEqual({ channel_id: expect.any(Number), name: 'HalfMask' });

      // ids are canonical: the nested filter's own filter_id round-trips through 'filter', and
      // its layer_id matches the nested layer's own id from the tree above.
      const described = await session.call<FilterRecord>('describe', {
        image,
        what: 'filter',
        filter_id: filterId,
      });
      const listed = await session.call<{ filters: FilterRecord[] }>('filter', {
        image,
        op: 'list',
      });
      const fromList = listed.filters.find((f) => f.filter_id === filterId);
      expect(described).toEqual(fromList);
      expect(described).toMatchObject({
        layer: 'Nested',
        layer_id: groupNode!.children[0]!.layer_id,
        name: 'NestedLift',
        source: 'editmamei',
        mask: 'HalfMask',
      });
    } finally {
      await session.call('close', { image });
    }
  });

  it("what='layers' returns exactly document's own layer tree + truncated flag; what='channels' adds coverage document deliberately skips", async () => {
    const { image } = await buildFixture();
    try {
      const doc = await session.call<DocumentDescribe>('describe', { image, what: 'document' });
      const layersOnly = await session.call<LayersDescribe>('describe', {
        image,
        what: 'layers',
      });
      const channelsOnly = await session.call<{
        channels: ChannelCoverage[];
        truncated: boolean;
        channels_skipped: number;
      }>('describe', { image, what: 'channels' });
      expect(layersOnly).toEqual({
        layers: doc.layers,
        truncated: doc.truncated,
        top_level_count: doc.top_level_count,
        total_nodes: doc.total_nodes,
      });

      // Same channel (by id and name), but 'channels' carries coverage that 'document' left out.
      expect(channelsOnly.channels).toHaveLength(doc.channels.length);
      expect(channelsOnly.channels[0]).toMatchObject({
        channel_id: doc.channels[0]!.channel_id,
        name: doc.channels[0]!.name,
      });
      expect(channelsOnly.channels[0]!.fraction).toBeGreaterThan(0);
      expect(channelsOnly.channels[0]!.fraction).toBeLessThanOrEqual(1);
      expect(typeof channelsOnly.channels[0]!.selected_pixels).toBe('number');
      expect(doc.channels[0]).not.toHaveProperty('fraction');
      expect(doc.channels[0]).not.toHaveProperty('selected_pixels');
      // The default deadline is never hit on a one-channel fixture.
      expect(channelsOnly.truncated).toBe(false);
      expect(channelsOnly.channels_skipped).toBe(0);
    } finally {
      await session.call('close', { image });
    }
  });

  it("what='channels' stops after its own time budget, returning what it already read plus truncated/channels_skipped", async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    const image = opened.image;
    try {
      for (const name of ['A', 'B', 'C']) {
        await session.call('create_mask', {
          image,
          type: 'rectangle',
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          name,
        });
      }
      // test_set_channels_deadline (fixtures/test_ops.py) overrides the module-level
      // CHANNELS_DESCRIBE_DEADLINE_S for the rest of this session; restored in `finally`.
      const prev = await session.call<{ previous: number }>('test_set_channels_deadline', {
        seconds: 0,
      });
      try {
        const result = await session.call<{
          channels: ChannelCoverage[];
          truncated: boolean;
          channels_skipped: number;
        }>('describe', { image, what: 'channels' });
        // A deadline of 0 still reads the first channel unconditionally before checking, so this
        // never comes back with a completely empty list.
        expect(result.channels).toHaveLength(1);
        expect(result.truncated).toBe(true);
        expect(result.channels_skipped).toBe(2);
      } finally {
        await session.call('test_set_channels_deadline', { seconds: prev.previous });
      }
    } finally {
      await session.call('close', { image });
    }
  });

  it("what='document'/'layers' walk group-in-group (2 levels) and an empty group, and the deepest layer's filter is found by what='filter'", async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    const image = opened.image;
    try {
      await session.call('test_nest_groups', { image });
      const filter = await session.call<{ filter_id: number }>('adjust', {
        image,
        type: 'brightness_contrast',
        brightness: 20,
        layer: 'Deepest',
        name: 'DeepLift',
      });

      const doc = await session.call<DocumentDescribe>('describe', { image, what: 'document' });
      expect(doc.truncated).toBe(false);
      // Top-of-stack first: 'Empty' was inserted last (top level), then 'Outer' (also top
      // level, inserted before 'Empty' existed), then the original background layer.
      expect(doc.layers.map((l) => l.name)).toEqual(['Empty', 'Outer', 'Background']);
      const [emptyNode, outerNode] = doc.layers;
      expect(emptyNode).toMatchObject({ is_group: true, children: [] });
      expect(outerNode).toMatchObject({ is_group: true });
      expect(outerNode!.children).toHaveLength(1);
      const innerNode = outerNode!.children[0]!;
      expect(innerNode).toMatchObject({ name: 'Inner', is_group: true });
      expect(innerNode.children).toHaveLength(1);
      const deepestNode = innerNode.children[0]!;
      expect(deepestNode).toMatchObject({ name: 'Deepest', is_group: false, is_text_layer: false });

      const described = await session.call<FilterRecord>('describe', {
        image,
        what: 'filter',
        filter_id: filter.filter_id,
      });
      expect(described).toMatchObject({ layer: 'Deepest', layer_id: deepestNode.layer_id });
    } finally {
      await session.call('close', { image });
    }
  });

  it("_build_layer_tree's max_nodes cap truncates mid-tree (a group at the cutoff is left with missing children) and reports false when the cap exactly matches the tree size", async () => {
    // Test-only probe (test_build_layer_tree, fixtures/test_ops.py): calls _build_layer_tree
    // directly with a small max_nodes, so this doesn't need a 2000+-node fixture to exercise the
    // real cap (MAX_DESCRIBE_LAYER_NODES) would hit. Reuses test_nest_groups' fixture (the same
    // one the group-in-group test above builds): 5 nodes total -- top level 'Empty', 'Outer',
    // 'Background', plus 'Inner' under 'Outer' and 'Deepest' under 'Inner'.
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    const image = opened.image;
    try {
      await session.call('test_nest_groups', { image });

      // max_nodes=2: visited top-of-stack-first, 'Empty' is recorded first (it has no children of
      // its own to push), then 'Outer' -- the cap is hit the instant 'Outer' itself is recorded,
      // so 'Outer's real child ('Inner') was pushed onto the walk's stack but never popped, and
      // 'Background' was never reached at all.
      const capped = await session.call<{
        layers: LayerNode[];
        truncated: boolean;
        total_nodes: number;
      }>('test_build_layer_tree', { image, max_nodes: 2 });
      expect(capped.truncated).toBe(true);
      expect(capped.total_nodes).toBe(2);
      expect(capped.layers.map((l) => l.name)).toEqual(['Empty', 'Outer']);
      expect(capped.layers[1]).toMatchObject({ name: 'Outer', is_group: true, children: [] });

      // max_nodes=5 is exactly the tree's own total node count: the walk's stack empties on its
      // own before the cap is ever checked again, so nothing is missing and truncated is false.
      const exact = await session.call<{
        layers: LayerNode[];
        truncated: boolean;
        total_nodes: number;
      }>('test_build_layer_tree', { image, max_nodes: 5 });
      expect(exact.truncated).toBe(false);
      expect(exact.total_nodes).toBe(5);
      expect(exact.layers.map((l) => l.name)).toEqual(['Empty', 'Outer', 'Background']);
      const outerNode = exact.layers[1]!;
      expect(outerNode.children).toHaveLength(1);
      expect(outerNode.children[0]).toMatchObject({ name: 'Inner' });
      expect(outerNode.children[0]!.children).toHaveLength(1);
      expect(outerNode.children[0]!.children[0]).toMatchObject({ name: 'Deepest' });
    } finally {
      await session.call('close', { image });
    }
  });

  it('_all_layers visits top-of-stack-first, descending into each group before its next sibling', async () => {
    // Same fixture and expected order as the max_nodes test above (its exact.layers walk), but
    // this hits _all_layers directly (test_all_layers_order, fixtures/test_ops.py) rather than
    // _build_layer_tree -- the two are separate functions that need to keep agreeing on order
    // independently.
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    const image = opened.image;
    try {
      await session.call('test_nest_groups', { image });
      const result = await session.call<{ names: string[] }>('test_all_layers_order', { image });
      expect(result.names).toEqual(['Empty', 'Outer', 'Inner', 'Deepest', 'Background']);
    } finally {
      await session.call('close', { image });
    }
  });

  it("what='filter' refuses a filter_id that belongs to a DIFFERENT image, even though the filter really exists", async () => {
    const a = await session.call<{ image: number }>('open', { path: rampPath });
    const b = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const filter = await session.call<{ filter_id: number }>('curves', {
        image: a.image,
        points: [
          [0, 0],
          [255, 255],
        ],
      });
      await expect(
        session.call('describe', { image: b.image, what: 'filter', filter_id: filter.filter_id })
      ).rejects.toMatchObject({
        code: 'invalid_argument',
        message: expect.stringContaining(
          `no filter with id ${filter.filter_id} on image ${b.image}`
        ),
      });
      // Confirms the filter really does exist -- on A, just not on B.
      const onA = await session.call<FilterRecord>('describe', {
        image: a.image,
        what: 'filter',
        filter_id: filter.filter_id,
      });
      expect(onA.filter_id).toBe(filter.filter_id);
    } finally {
      await session.call('close', { image: a.image });
      await session.call('close', { image: b.image });
    }
  });

  it('refuses a describe with no image, naming the field', async () => {
    await expect(session.call('describe', { what: 'document' })).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('image is required'),
    });
  });

  it('refuses what=filter with no filter_id, naming the field', async () => {
    const { image } = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await expect(session.call('describe', { image, what: 'filter' })).rejects.toMatchObject({
        code: 'invalid_argument',
        message: expect.stringContaining('filter_id is required'),
      });
    } finally {
      await session.call('close', { image });
    }
  });

  it('refuses an unknown filter_id, naming the id and image', async () => {
    const { image } = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await expect(
        session.call('describe', { image, what: 'filter', filter_id: 999999 })
      ).rejects.toMatchObject({
        code: 'invalid_argument',
        message: expect.stringContaining('no filter with id 999999'),
      });
    } finally {
      await session.call('close', { image });
    }
  });

  it('refuses an unknown what, even bypassing the tool-layer schema enum', async () => {
    const { image } = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await expect(session.call('describe', { image, what: 'bogus' })).rejects.toMatchObject({
        code: 'invalid_argument',
      });
    } finally {
      await session.call('close', { image });
    }
  });
});
