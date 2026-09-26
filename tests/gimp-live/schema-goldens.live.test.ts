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

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-schema-'));
    session = new GimpSession({ install: install!, rootDir: join(workDir, 'session-root') });
    golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  });

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
  ];

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
