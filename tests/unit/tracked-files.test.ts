import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { trackedFiles } from '../helpers/tracked-files.ts';

let dir: string;

function git(...args: string[]): void {
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    stdio: 'ignore',
  });
}

function write(rel: string): string {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, 'x');
  return full;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tracked-files-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('trackedFiles', () => {
  it('includes tracked files and excludes untracked and gitignored ones', () => {
    git('init', '-q');
    const tracked = write('docs/a.md');
    const nested = write('docs/deep/b.md');
    write('docs/untracked.md');
    write('docs/frames/f1.png');
    writeFileSync(join(dir, '.gitignore'), 'docs/frames/\n');
    git('add', 'docs/a.md', 'docs/deep/b.md', '.gitignore');
    git('commit', '-q', '-m', 'init');

    const all = trackedFiles(dir, 'docs').sort();
    expect(all).toEqual([tracked, nested].sort());
  });

  it('includes files listed literally in info/exclude, not globs or unlisted ones', () => {
    git('init', '-q');
    const tracked = write('docs/a.md');
    git('add', 'docs/a.md');
    git('commit', '-q', '-m', 'init');
    const hydrated = write('docs/x.md');
    write('docs/notes/scratch.md');
    write('docs/ignored.md');
    write('docs/frames/f1.png');
    writeFileSync(join(dir, '.gitignore'), 'docs/ignored.md\n');
    writeFileSync(
      join(dir, '.git', 'info', 'exclude'),
      '# hydrated\n/docs/x.md\n/docs/notes/*\n/docs/frames/\n/docs/missing.md\n'
    );

    expect(trackedFiles(dir, 'docs').sort()).toEqual([tracked, hydrated].sort());
    expect(trackedFiles(dir, 'other')).toEqual([]);
  });

  it('skips a tracked file deleted from the work tree', () => {
    git('init', '-q');
    const keep = write('docs/keep.md');
    const gone = write('docs/gone.md');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    rmSync(gone);
    expect(trackedFiles(dir, 'docs')).toEqual([keep]);
  });

  it('falls back to the full walk outside a git work tree', () => {
    const a = write('docs/a.md');
    const b = write('docs/deep/b.md');
    expect(trackedFiles(dir, 'docs').sort()).toEqual([a, b].sort());
  });

  it('returns nothing for a missing subdirectory', () => {
    expect(trackedFiles(dir, 'nope')).toEqual([]);
  });
});
