/**
 * The bridge's own preview proxies are real GIMP images, but `ping` must list only the documents
 * the caller opened: a preview (which builds a proxy) never adds an id.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import { writeGrayRamp, readySession, LIVE_READY_TIMEOUT_MS } from './support.ts';

const install: GimpInstall | null = await detectGimp();

describe.skipIf(!install)('ping lists only real documents', () => {
  let workDir: string;
  let session: GimpSession;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-docs-'));
    session = new GimpSession({ install: install!, rootDir: join(workDir, 'session-root') });
    await readySession(session);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session?.shutdown();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('excludes preview proxies before and after a preview', async () => {
    const png = join(workDir, 'ramp.png');
    writeGrayRamp(png, 256, 32);
    const first = await session.call<{ image: number }>('open', { path: png });
    const ids = async () => (await session.call<{ images: number[] }>('ping', {})).images;
    expect(await ids()).toEqual([first.image]);

    await session.call('preview', {
      image: first.image,
      max_px: 512,
      out_path: join(workDir, 'p.jpg'),
    });
    expect(await ids()).toEqual([first.image]);

    const second = await session.call<{ image: number }>('open', { path: png });
    expect((await ids()).sort((a, b) => a - b)).toEqual(
      [first.image, second.image].sort((a, b) => a - b)
    );

    await session.call('close', { image: second.image });
    await session.call('close', { image: first.image });
    expect(await ids()).toEqual([]);
  }, 60_000);
});
