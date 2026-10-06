import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Every regular file under `start`, absolute, via an iterative walk. */
function walkFiles(start: string): string[] {
  const out: string[] = [];
  const pending = [start];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

/**
 * The files a guard about published content should scan: only what git tracks
 * under `root/subdir`, as absolute paths. Untracked and ignored files (local
 * render output, scratch notes) are skipped, which also keeps the scan fast in
 * a checkout whose docs/ holds thousands of them.
 *
 * Falls back to a full walk when git is unavailable, `root` is not a work tree
 * (an npm tarball), or git tracks nothing there.
 */
export function trackedFiles(root: string, subdir = '.'): string[] {
  const base = resolve(root);
  try {
    const raw = execFileSync('git', ['-C', base, 'ls-files', '-z', '--', subdir], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = raw
      .split('\0')
      .filter((f) => f.length > 0)
      .map((f) => join(base, f))
      .filter((f) => existsSync(f));
    if (files.length > 0) return files;
  } catch {
    // git missing or not a work tree: fall through to the walk
  }
  const start = join(base, subdir);
  return existsSync(start) ? walkFiles(start) : [];
}
