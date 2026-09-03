import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isArchived } from '../helpers/archived-docs.ts';

/**
 * `isArchived` decides which docs the Node and macOS floor guards are allowed
 * to skip. Too loose and a live doc stops being checked — which is how a stale
 * floor ships. So the exemption gets pinned as precisely as the guards it feeds.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('isArchived', () => {
  it('exempts entries under archive/, with either separator', () => {
    // readdirSync(recursive) yields backslashes on Windows and slashes on POSIX;
    // the guards run on both, so neither form may leak through.
    expect(isArchived('archive/old-description.md')).toBe(true);
    expect(isArchived('archive\\old-description.md')).toBe(true);
    expect(isArchived('archive/2026/nested/deeper.md')).toBe(true);
  });

  it('keeps every live doc, including ones merely mentioning archive', () => {
    expect(isArchived('installation.md')).toBe(false);
    expect(isArchived('launch/product-description.md')).toBe(false);
    expect(isArchived('engineering/tool-design.md')).toBe(false);
    // The outbound copy that a stale macOS floor was actually found in.
    expect(isArchived('launch/product-description.md')).toBe(false);
  });

  it('matches a whole path segment, not a prefix', () => {
    // `archive` as a prefix of a longer name is a different directory, and a
    // startsWith() implementation would silently stop checking it.
    expect(isArchived('archived-notes/plan.md')).toBe(false);
    expect(isArchived('archive-2025/plan.md')).toBe(false);
    // Only the FIRST segment is the archive root; a nested one is still live.
    expect(isArchived('launch/archive/post.md')).toBe(false);
  });

  it('is inert in this repository — the published docs carry no archive', () => {
    // The filter exists for the hydrated commercial overlay. If an archive
    // ever lands here, that is a deliberate decision worth making explicitly
    // rather than discovering as a silently-unchecked doc.
    const entries = readdirSync(join(ROOT, 'docs'), { recursive: true, encoding: 'utf8' });
    expect(entries.filter((f) => isArchived(f))).toEqual([]);
  });
});
