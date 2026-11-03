/**
 * The cold-start path: measures how long a real GIMP takes to become ready
 * from nothing, through the exact `gimp_starting` retry path a real MCP
 * client hits on a machine that has never run GIMP before (a fresh
 * GitHub Actions runner has none of GIMP's own caches -- font cache,
 * plug-in scan, macOS Gatekeeper -- any more than this session's own root
 * dir does). `readySession` (support.ts) is the retry loop under test here
 * too, but this file's OWN job is the timing + the eventual-readiness
 * assertion, not the pixel/schema checks the rest of `tests/gimp-live`
 * covers.
 *
 * This is only meaningful as the FIRST GIMP launch of a run -- see the CI
 * workflow's own step ordering, which runs this file alone, before the rest
 * of the suite. It still passes on a warm machine (Windows/Linux CI, a
 * developer's own box): `readySession` connects on the first `ping` with no
 * retry needed, and the logged duration is just however long a warm launch
 * takes there.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession, READY_TIMEOUT_MS } from '@editmamei/backends/gimp/session.ts';
import { readySession, LIVE_READY_TIMEOUT_MS } from './support.ts';

const REQUIRE_GIMP = process.env.EDITMAMEI_REQUIRE_GIMP === '1';

const install: GimpInstall | null = await detectGimp();

it('GIMP must actually be detected when EDITMAMEI_REQUIRE_GIMP=1 (cold start)', () => {
  if (!REQUIRE_GIMP) return;
  expect(install, 'EDITMAMEI_REQUIRE_GIMP=1 but detectGimp() found no install').not.toBeNull();
});

describe.skipIf(!install)('GIMP cold start', () => {
  let workDir: string;
  let session: GimpSession;

  afterAll(async () => {
    await session?.shutdown();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it(
    'a brand-new session becomes ready, retrying through gimp_starting if a cold launch outlasts CALL_READY_WAIT_MS, bounded by READY_TIMEOUT_MS',
    async () => {
      workDir = mkdtempSync(join(tmpdir(), 'em-gimp-cold-start-'));
      // A session root nobody has used before -- this suite's own caches (if
      // any) start from nothing here too, same as GIMP's own on a fresh
      // runner.
      session = new GimpSession({ install: install!, rootDir: join(workDir, 'session-root') });

      const startedAt = Date.now();
      await readySession(session);
      const elapsedMs = Date.now() - startedAt;
      // eslint-disable-next-line no-console -- deliberate: this number is the whole point of this job.
      console.log(`[gimp cold start] ready in ${elapsedMs}ms`);

      expect(session.state).toBe('ready');
      // `readySession` itself is bounded by LIVE_READY_TIMEOUT_MS (a margin
      // over READY_TIMEOUT_MS); this is the tighter, meaningful bound —
      // session.ts's own overall start-attempt deadline — since a start that
      // took the full margin on top of it would itself be a regression worth
      // failing on.
      expect(elapsedMs).toBeLessThan(READY_TIMEOUT_MS);
    },
    LIVE_READY_TIMEOUT_MS
  );
});
