import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveToGeometry,
  resolveGatedPlacement,
  resolveExpectedPlacement,
  PLACEMENT_SCHEMA,
  LocateError,
  parseBox,
  SUPPORTED_RELATIONS,
} from '@editmamei/perception/grounding-locate.ts';
import { ValidationError } from '@editmamei/utils/validate.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import {
  FakeDetectionClient,
  CANNED,
  CANNED_MESH,
  EXPORT_RESULT,
} from '../fixtures/fake-detection-client.ts';

/**
 * resolveToGeometry — the shared export→localize→resolve→gate front-end the
 * grounding tools (ps_resolve_placement) and acting tools (ps_shape placement)
 * both run. Exercised end-to-end elsewhere via ps_resolve_placement; here we pin
 * the extracted contract directly: geometry + gate for each target, and the
 * error taxonomy (ValidationError = structural, LocateError = expected failure).
 */

describe('resolveToGeometry', () => {
  let conn: FakePhotoshopConnection;
  beforeEach(() => {
    conn = makeConnection({ result: EXPORT_RESULT });
  });
  const run = (anchors: unknown, relation: unknown, canned = CANNED) =>
    resolveToGeometry(conn.asConnection(), new FakeDetectionClient(canned), { anchors, relation });

  it('resolves a point (centroid of a face) + gate PASS', async () => {
    const loc = await run([{ id: 'a', kind: 'face', pick: 'leftmost' }], {
      type: 'centroid',
      anchor: 'a',
    });
    expect(loc.geom.target).toBe('point');
    expect(loc.geom).toMatchObject({ point: { x: 300, y: 300 } });
    expect(loc.gate.pass).toBe(true);
    expect(loc.docW).toBe(1000);
    expect(loc.anchorMeta.a).toEqual({ kind: 'face', center: { x: 300, y: 300 } });
  });

  it('resolves a region (gap of two dogs) with the expected bbox + gate PASS', async () => {
    const loc = await run(
      [
        { id: 'd0', kind: 'object', label: 'dog', pick: 'leftmost' },
        { id: 'd1', kind: 'object', label: 'dog', pick: 'rightmost' },
      ],
      { type: 'gap', anchors: ['d0', 'd1'] }
    );
    expect(loc.geom.target).toBe('region');
    if (loc.geom.target !== 'region') throw new Error('unreachable');
    const xs = loc.geom.polygon.map((p) => p.x);
    const ys = loc.geom.polygon.map((p) => p.y);
    expect(Math.min(...xs)).toBe(300); // dog0.right
    expect(Math.max(...xs)).toBe(600); // dog1.left
    expect(Math.min(...ys)).toBe(100);
    expect(Math.max(...ys)).toBe(300);
    expect(loc.gate.pass).toBe(true);
  });

  it('resolves a path (along a landmark lower-lid) + skips the edge gate for the trusted mesh', async () => {
    const loc = await run(
      [{ id: 'lid', kind: 'landmark', feature: 'left_eye_lower' }],
      { type: 'along', curve: 'lid' },
      CANNED_MESH
    );
    expect(loc.geom.target).toBe('path');
    if (loc.geom.target !== 'path') throw new Error('unreachable');
    expect(loc.geom.curve[0]).toEqual({ x: 300, y: 200 });
    expect(loc.geom.curve[loc.geom.curve.length - 1]).toEqual({ x: 380, y: 200 });
    expect(loc.gate.pass).toBe(true);
    expect(loc.gate.measured.source).toBe('landmark');
  });

  it('applies pathTransform BEFORE the gate — the gate verifies the ENACTED curve', async () => {
    // The raw landmark `along` curve gates PASS (test above). A transform that shoves
    // it far off-canvas must now FAIL the gate — decisive proof the gate runs on the
    // transformed curve (gate == enact), not the raw resolved one. This is what makes
    // ps_warp_layer_along's curve-smoothing gate-honest.
    const loc = await resolveToGeometry(conn.asConnection(), new FakeDetectionClient(CANNED_MESH), {
      anchors: [{ id: 'lid', kind: 'landmark', feature: 'left_eye_lower' }],
      relation: { type: 'along', curve: 'lid' },
      pathTransform: (c) => c.map((p) => ({ x: p.x + 100000, y: p.y })),
    });
    expect(loc.geom.target).toBe('path');
    if (loc.geom.target !== 'path') throw new Error('unreachable');
    expect(loc.geom.curve[0].x).toBeGreaterThan(100000); // returned curve is transformed
    expect(loc.gate.pass).toBe(false); // and the gate saw it → off canvas → REJECT
  });

  it('ignores pathTransform for non-path (point) geometry', async () => {
    // A point relation never has a curve; the transform must not run (would throw here).
    const loc = await resolveToGeometry(conn.asConnection(), new FakeDetectionClient(CANNED), {
      anchors: [{ id: 'a', kind: 'face', pick: 'leftmost' }],
      relation: { type: 'centroid', anchor: 'a' },
      pathTransform: () => {
        throw new Error('pathTransform must not run for a point target');
      },
    });
    expect(loc.geom.target).toBe('point');
    expect(loc.gate.pass).toBe(true);
  });

  it('throws LocateError (not ValidationError) when an anchor cannot be localized', async () => {
    await expect(
      run([{ id: 'x', kind: 'object', label: 'giraffe' }], { type: 'centroid', anchor: 'x' })
    ).rejects.toBeInstanceOf(LocateError);
  });

  it('throws ValidationError for an unsupported relation type', async () => {
    await expect(
      run([{ id: 'a', kind: 'face' }], { type: 'frobnicate', anchor: 'a' })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError for an empty anchors array', async () => {
    await expect(run([], { type: 'centroid', anchor: 'a' })).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it('SUPPORTED_RELATIONS covers the pure-geometry set', () => {
    expect(SUPPORTED_RELATIONS).toEqual(
      expect.arrayContaining([
        'midpoint',
        'centroid',
        'offset',
        'inside',
        'gap',
        'along',
        'offset-curve',
        'segment',
      ])
    );
  });

  it('parseBox normalizes corner order and rejects malformed input', () => {
    expect(parseBox([30, 40, 10, 20], 'r')).toEqual({ left: 10, top: 20, right: 30, bottom: 40 });
    expect(() => parseBox([1, 2, 3], 'r')).toThrow(ValidationError);
    expect(() => parseBox('nope', 'r')).toThrow(ValidationError);
  });
});

// resolveGatedPlacement — the shared front-end the warp trio + resolveExpectedPlacement
// both run: resolve + enforce gate PASS + enforce target ∈ expect, returning the FULL
// (unrounded) LocateResult incl. the getContextInfo snapshot (which the rounded
// resolveExpectedPlacement convenience drops).
describe('resolveGatedPlacement', () => {
  let conn: FakePhotoshopConnection;
  beforeEach(() => {
    conn = makeConnection({ result: EXPORT_RESULT });
  });
  const client = (canned = CANNED) => new FakeDetectionClient(canned);

  it('returns the full LocateResult (unrounded geom + context) for the expected target', async () => {
    const loc = await resolveGatedPlacement(
      conn.asConnection(),
      client(),
      {
        anchors: [{ id: 'a', kind: 'face', pick: 'leftmost' }],
        relation: { type: 'centroid', anchor: 'a' },
      },
      { expect: 'point', label: 'test' }
    );
    expect(loc.geom.target).toBe('point');
    if (loc.geom.target !== 'point') throw new Error('unreachable');
    expect(loc.geom.point).toEqual({ x: 300, y: 300 });
    // The distinguishing feature vs resolveExpectedPlacement: context is returned.
    expect(loc.context).toEqual({ hasDocument: true });
    expect(loc.gate.pass).toBe(true);
  });

  it('accepts either of a multi-target expect (point OR region) — here a region', async () => {
    const loc = await resolveGatedPlacement(
      conn.asConnection(),
      client(),
      {
        anchors: [
          { id: 'd0', kind: 'object', label: 'dog', pick: 'leftmost' },
          { id: 'd1', kind: 'object', label: 'dog', pick: 'rightmost' },
        ],
        relation: { type: 'gap', anchors: ['d0', 'd1'] },
      },
      { expect: ['point', 'region'], label: 'warp-region' }
    );
    expect(loc.geom.target).toBe('region');
  });

  it('throws LocateError when the resolved target is not in expect', async () => {
    await expect(
      resolveGatedPlacement(
        conn.asConnection(),
        client(),
        {
          anchors: [{ id: 'a', kind: 'face', pick: 'leftmost' }],
          relation: { type: 'centroid', anchor: 'a' },
        },
        { expect: 'path', label: 'warp-along' }
      )
    ).rejects.toThrow(/warp-along placement needs a path relation — resolved a 'point'/);
  });

  it('throws LocateError on a gate REJECT (fail-closed) before returning', async () => {
    await expect(
      resolveGatedPlacement(
        conn.asConnection(),
        client(CANNED_MESH),
        {
          anchors: [
            { id: 'eye', kind: 'landmark', feature: 'left_eye' },
            { id: 'lid', kind: 'landmark', feature: 'left_eye_lower' },
          ],
          relation: {
            type: 'offset-curve',
            curve: 'lid',
            side: 'down',
            distance: { value: 0.5, unit: 'frac-of:eye:h' },
            exclusion: [280, 210, 400, 240],
          },
        },
        { expect: 'path', label: 'warp-along' }
      )
    ).rejects.toBeInstanceOf(LocateError);
  });
});

describe('resolveExpectedPlacement', () => {
  let conn: FakePhotoshopConnection;
  beforeEach(() => {
    conn = makeConnection({ result: EXPORT_RESULT });
  });
  const client = (canned = CANNED) => new FakeDetectionClient(canned);

  it('PLACEMENT_SCHEMA exposes anchors + relation + max_dimension', () => {
    expect(PLACEMENT_SCHEMA.properties?.anchors).toBeDefined();
    expect(PLACEMENT_SCHEMA.properties?.relation).toBeDefined();
    expect(PLACEMENT_SCHEMA.properties?.max_dimension).toBeDefined();
  });

  it('returns a rounded point for an expected point target', async () => {
    const rp = await resolveExpectedPlacement(
      conn.asConnection(),
      client(),
      {
        anchors: [{ id: 'a', kind: 'face', pick: 'leftmost' }],
        relation: { type: 'centroid', anchor: 'a' },
      },
      'point',
      'test'
    );
    expect(rp.target).toBe('point');
    expect(rp.point).toEqual({ x: 300, y: 300 }); // narrowed to the point variant by the generic return
  });

  it('returns a rounded bbox for an expected region target', async () => {
    const rp = await resolveExpectedPlacement(
      conn.asConnection(),
      client(),
      {
        anchors: [
          { id: 'd0', kind: 'object', label: 'dog', pick: 'leftmost' },
          { id: 'd1', kind: 'object', label: 'dog', pick: 'rightmost' },
        ],
        relation: { type: 'gap', anchors: ['d0', 'd1'] },
      },
      'region',
      'test'
    );
    expect(rp.bbox).toEqual({ left: 300, top: 100, right: 600, bottom: 300 });
  });

  it('returns a rounded curve for an expected path target', async () => {
    const rp = await resolveExpectedPlacement(
      conn.asConnection(),
      client(CANNED_MESH),
      {
        anchors: [{ id: 'lid', kind: 'landmark', feature: 'left_eye_lower' }],
        relation: { type: 'along', curve: 'lid' },
      },
      'path',
      'test'
    );
    expect(rp.curve[0]).toEqual({ x: 300, y: 200 });
  });

  it('resolves a 2-point segment path between two anchors (a line/stroke between them)', async () => {
    const rp = await resolveExpectedPlacement(
      conn.asConnection(),
      client(),
      {
        anchors: [
          { id: 'a', kind: 'face', pick: 'leftmost' },
          { id: 'b', kind: 'face', pick: 'rightmost' },
        ],
        relation: { type: 'segment', anchors: ['a', 'b'] },
      },
      'path',
      'test'
    );
    expect(rp.curve).toEqual([
      { x: 300, y: 300 },
      { x: 700, y: 700 },
    ]);
  });

  it('throws LocateError on a target mismatch (expected region, resolved a point)', async () => {
    await expect(
      resolveExpectedPlacement(
        conn.asConnection(),
        client(),
        {
          anchors: [{ id: 'a', kind: 'face', pick: 'leftmost' }],
          relation: { type: 'centroid', anchor: 'a' },
        },
        'region',
        'test'
      )
    ).rejects.toBeInstanceOf(LocateError);
  });

  it('throws LocateError on a gate REJECT (offset-curve into an exclusion)', async () => {
    await expect(
      resolveExpectedPlacement(
        conn.asConnection(),
        client(CANNED_MESH),
        {
          anchors: [
            { id: 'eye', kind: 'landmark', feature: 'left_eye' },
            { id: 'lid', kind: 'landmark', feature: 'left_eye_lower' },
          ],
          relation: {
            type: 'offset-curve',
            curve: 'lid',
            side: 'down',
            distance: { value: 0.5, unit: 'frac-of:eye:h' },
            exclusion: [280, 210, 400, 240],
          },
        },
        'path',
        'test'
      )
    ).rejects.toBeInstanceOf(LocateError);
  });
});
