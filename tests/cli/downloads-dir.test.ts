import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectDownloadsDir } from '@editmamei/cli/downloads-dir.ts';

describe('detectDownloadsDir', () => {
  it('honors $XDG_DOWNLOAD_DIR when it points to an existing directory', () => {
    const xdg = join(tmpdir(), `dl-test-${process.pid}-${Date.now()}`);
    mkdirSync(xdg, { recursive: true });
    try {
      const result = detectDownloadsDir({ XDG_DOWNLOAD_DIR: xdg });
      expect(result.kind).toBe('xdg');
      expect(result.path).toBe(xdg);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  it('falls back to ~/Downloads when XDG is missing or invalid', () => {
    const result = detectDownloadsDir({});
    expect(result.kind).toBe('home-downloads');
    expect(result.path.endsWith('Downloads')).toBe(true);
  });

  it('ignores $XDG_DOWNLOAD_DIR that points to a nonexistent path', () => {
    const result = detectDownloadsDir({
      XDG_DOWNLOAD_DIR: '/this/path/does/not/exist/anywhere-on-earth',
    });
    expect(result.kind).not.toBe('xdg');
    expect(result.path.endsWith('Downloads')).toBe(true);
  });
});
