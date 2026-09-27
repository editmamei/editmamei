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

vi.setConfig({ testTimeout: 30_000 });

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

interface ChannelEntry {
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
  channels: ChannelEntry[];
}

interface FilterRecord {
  layer: string;
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

      expect(doc.channels).toHaveLength(1);
      expect(doc.channels[0]).toMatchObject({ name: 'HalfMask' });
      expect(doc.channels[0]!.fraction).toBeGreaterThan(0);
      expect(doc.channels[0]!.fraction).toBeLessThanOrEqual(1);

      // ids are canonical: the nested filter's own filter_id round-trips through 'filter'.
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
        name: 'NestedLift',
        source: 'editmamei',
        mask: 'HalfMask',
      });
    } finally {
      await session.call('close', { image });
    }
  });

  it("what='layers' and what='channels' each report just their own half of 'document'", async () => {
    const { image } = await buildFixture();
    try {
      const doc = await session.call<DocumentDescribe>('describe', { image, what: 'document' });
      const layersOnly = await session.call<{ layers: LayerNode[] }>('describe', {
        image,
        what: 'layers',
      });
      const channelsOnly = await session.call<{ channels: ChannelEntry[] }>('describe', {
        image,
        what: 'channels',
      });
      expect(layersOnly).toEqual({ layers: doc.layers });
      expect(channelsOnly).toEqual({ channels: doc.channels });
    } finally {
      await session.call('close', { image });
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
