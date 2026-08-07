import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANNOTATED_PREVIEW_JPEG_QUALITY } from '@editmamei/utils/jpeg-quality.ts';

/**
 * Perf-audit M5/M6 — the four annotated-preview `encode()` call sites
 * (ps_detect, ps_read_scene, ps_detect_landmarks, ps_resolve_placement) used to
 * each hand-pick their own jpeg-js quality literal (88/88/90/90). This is a
 * SOURCE-level guard (not a behavioral one — jpeg-js quality isn't recoverable
 * from re-decoding the output) pinning that all four sites import and use the ONE
 * shared constant instead of a private literal, so a future edit can't silently
 * reintroduce per-site drift. Mirrors the style of helpers-mirror-guard.test.ts /
 * readme-leak-guard.test.ts — read the source text directly, assert on it.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const SITES = [
  { file: 'src/tools/detection-tools.ts', fn: 'drawBoxes' },
  { file: 'src/tools/scene-tools.ts', fn: 'annotateScene' },
] as const;

// detect-landmarks-tools-pro.ts and grounding-tools-pro.ts are Pro tool
// sources, which aren't part of every checkout of this repo (Pro ships as a
// separate module). Gate the assertions that read them behind their
// presence instead of failing to open files that don't exist here.
const PRO_SITES = [
  { file: 'src/tools/detect-landmarks-tools-pro.ts', fn: 'drawPoints' },
  { file: 'src/tools/grounding-tools-pro.ts', fn: 'resolvePlacement (review-crop encode)' },
] as const;
const PRO_SOURCES_PRESENT = existsSync(join(REPO_ROOT, 'src', 'modules', 'pro', 'index.ts'));
const proIt = PRO_SOURCES_PRESENT ? it : it.skip;

describe('annotation-quality-guard', () => {
  it('the shared constant is quality 80 on the jpeg-js 0-100 scale', () => {
    expect(ANNOTATED_PREVIEW_JPEG_QUALITY).toBe(80);
  });

  it.each(SITES)(
    '$file ($fn) imports the shared ANNOTATED_PREVIEW_JPEG_QUALITY const',
    ({ file }) => {
      const src = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(src).toMatch(
        /import\s*\{\s*ANNOTATED_PREVIEW_JPEG_QUALITY\s*\}\s*from\s*['"].*jpeg-quality\.js['"]/
      );
    }
  );
  proIt.each(PRO_SITES)(
    '$file ($fn) imports the shared ANNOTATED_PREVIEW_JPEG_QUALITY const',
    ({ file }) => {
      const src = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(src).toMatch(
        /import\s*\{\s*ANNOTATED_PREVIEW_JPEG_QUALITY\s*\}\s*from\s*['"].*jpeg-quality\.js['"]/
      );
    }
  );

  it.each(SITES)(
    '$file ($fn) passes the shared const (not a numeric literal) to encode()',
    ({ file }) => {
      const src = readFileSync(join(REPO_ROOT, file), 'utf8');
      // Every encode(...) call's quality argument is the identifier, never a bare
      // number — this is what would silently reintroduce per-site drift.
      const encodeCalls = [...src.matchAll(/encode\(\s*\{[\s\S]*?\},\s*([^)]+)\)/g)];
      expect(encodeCalls.length).toBeGreaterThan(0);
      for (const m of encodeCalls) {
        expect(m[1].trim()).toBe('ANNOTATED_PREVIEW_JPEG_QUALITY');
      }
    }
  );
  proIt.each(PRO_SITES)(
    '$file ($fn) passes the shared const (not a numeric literal) to encode()',
    ({ file }) => {
      const src = readFileSync(join(REPO_ROOT, file), 'utf8');
      const encodeCalls = [...src.matchAll(/encode\(\s*\{[\s\S]*?\},\s*([^)]+)\)/g)];
      expect(encodeCalls.length).toBeGreaterThan(0);
      for (const m of encodeCalls) {
        expect(m[1].trim()).toBe('ANNOTATED_PREVIEW_JPEG_QUALITY');
      }
    }
  );

  it('none of the CE sites still hand-picks the old 88/90 literals as an encode quality', () => {
    for (const { file } of SITES) {
      const src = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(src).not.toMatch(/encode\(\s*\{[\s\S]*?\},\s*(88|90)\s*\)/);
    }
  });
  proIt(
    'none of the Pro sites still hand-picks the old 88/90 literals as an encode quality',
    () => {
      for (const { file } of PRO_SITES) {
        const src = readFileSync(join(REPO_ROOT, file), 'utf8');
        expect(src).not.toMatch(/encode\(\s*\{[\s\S]*?\},\s*(88|90)\s*\)/);
      }
    }
  );
});
