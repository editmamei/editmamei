/**
 * GEGL/GIMP operation schema goldens: `describe_operation` for every operation the engine's
 * `adjust` types use, compared to a committed golden (`fixtures/gegl-ops.golden.json`). This is
 * the drift tripwire for a GIMP upgrade changing a property's range or default out from under
 * `lib.ADJUST_PARAM_BUILDERS`' validation -- a change here means re-verify the affected adjust
 * type's user-facing range against the real GIMP install before updating the golden, not just
 * regenerate it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import { readySession, LIVE_READY_TIMEOUT_MS } from './support.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(__dirname, 'fixtures', 'gegl-ops.golden.json');

// This file alone, not the project default -- see adjust.live.test.ts's identical comment.
vi.setConfig({ testTimeout: 30_000 });

const install: GimpInstall | null = await detectGimp();

describe.skipIf(!install)('GEGL/GIMP operation schema goldens', () => {
  let workDir: string;
  let session: GimpSession;
  let golden: Record<
    string,
    Array<{ name: string; type: string; minimum: unknown; maximum: unknown; default: unknown }>
  >;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-schema-'));
    session = new GimpSession({ install: install!, rootDir: join(workDir, 'session-root') });
    await readySession(session);
    golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  const operations = [
    'gimp:curves',
    'gimp:levels',
    'gegl:exposure',
    'gimp:brightness-contrast',
    'gimp:hue-saturation',
    'gimp:color-balance',
    'gegl:color-temperature',
    'gegl:shadows-highlights',
    'gegl:saturation',
    'gegl:vibrance',
    'gegl:unsharp-mask',
    'gegl:noise-reduction',
    'gegl:gaussian-blur',
  ];

  it("covers exactly lib.py's ADJUST_OPERATIONS (a new adjust type needs its golden)", () => {
    const libPy = readFileSync(
      join(__dirname, '..', '..', 'src', 'backends', 'gimp', 'bridge', 'lib.py'),
      'utf8'
    );
    const block = libPy.match(/ADJUST_OPERATIONS = \{([\s\S]*?)\n\}/);
    expect(block, 'ADJUST_OPERATIONS not found in lib.py').toBeTruthy();
    const libOps = [...block![1].matchAll(/:\s*'([a-z]+:[a-z-]+)'/g)].map((m) => m[1]);
    expect([...operations].sort()).toEqual([...libOps].sort());
  });

  it('the golden fixture covers every operation the engine uses', () => {
    for (const op of operations) {
      expect(golden, `missing golden entry for ${op}`).toHaveProperty(op);
    }
  });

  it.each(operations)('%s matches its committed schema golden', async (operation) => {
    const result = await session.call<{
      properties: Array<{
        name: string;
        type: string;
        minimum: unknown;
        maximum: unknown;
        default: unknown;
      }>;
    }>('describe_operation', { operation });
    expect(result.properties).toEqual(golden[operation]);
  });

  // ---- gimp_filter op=apply's allow-listed GEGL effects (lib.FILTER_OPERATIONS) --------------
  // Deliberately excludes gegl:gaussian-blur (already golden'd above as the `adjust` type
  // gaussian_blur) and gegl:c2g (measured live at ~35s for a full-res 24 MP export -- over the
  // ~30s budget this PR was scoped to, so it was never allow-listed).

  const filterOperations = [
    'gegl:vignette',
    'gegl:mono-mixer',
    'gegl:motion-blur-linear',
    'gegl:focus-blur',
    'gegl:noise-rgb',
    'gegl:dropshadow',
  ];

  it("covers exactly lib.py's FILTER_OPERATIONS (a new filter effect needs its golden)", () => {
    const libPy = readFileSync(
      join(__dirname, '..', '..', 'src', 'backends', 'gimp', 'bridge', 'lib.py'),
      'utf8'
    );
    const block = libPy.match(/FILTER_OPERATIONS = \{([\s\S]*?)\n\}/);
    expect(block, 'FILTER_OPERATIONS not found in lib.py').toBeTruthy();
    const libOps = [...block![1].matchAll(/:\s*'([a-z]+:[a-z-]+)'/g)].map((m) => m[1]);
    expect([...filterOperations].sort()).toEqual([...libOps].sort());
  });

  it('the golden fixture covers every filter operation the engine uses', () => {
    for (const op of filterOperations) {
      expect(golden, `missing golden entry for ${op}`).toHaveProperty(op);
    }
  });

  it.each(filterOperations)('%s matches its committed schema golden', async (operation) => {
    const result = await session.call<{
      properties: Array<{
        name: string;
        type: string;
        minimum: unknown;
        maximum: unknown;
        default: unknown;
      }>;
    }>('describe_operation', { operation });
    expect(result.properties).toEqual(golden[operation]);
  });

  it('an unknown operation name is refused as invalid_argument, not a crash', async () => {
    await expect(
      session.call('describe_operation', { operation: 'gegl:this-does-not-exist' })
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('a real GEGL operation this engine does not use is still refused (the probe is allow-listed, not open to any operation name)', async () => {
    // gegl:invert genuinely exists in this GIMP install (unlike the made-up name above) -- the
    // probe must still refuse it, since `describe_operation` is scoped to the operations this
    // engine's adjust types actually use, not "any operation GIMP happens to ship".
    await expect(
      session.call('describe_operation', { operation: 'gegl:invert' })
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('describe_operation requires the operation field, naming it', async () => {
    await expect(session.call('describe_operation', {})).rejects.toMatchObject({
      code: 'invalid_argument',
    });
  });
});
