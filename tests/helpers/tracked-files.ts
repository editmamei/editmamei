import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

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
 * Literal file paths a checkout lists in `info/exclude` (`/docs/faq.md`). A
 * hydrated overlay copies published files in and hides them this way, so git
 * does not report them as tracked even though they are the files to check.
 * Globs, negations, comments and directories are ignored.
 */
function excludedLiteralFiles(base: string): string[] {
  const gitPath = execFileSync('git', ['-C', base, 'rev-parse', '--git-path', 'info/exclude'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const file = isAbsolute(gitPath) ? gitPath : join(base, gitPath);
  if (!existsSync(file)) return [];
  const out: string[] = [];
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('/') || /[*?[!]/.test(line)) continue;
    const full = join(base, line.slice(1));
    if (existsSync(full) && statSync(full).isFile()) out.push(full);
  }
  return out;
}

/**
 * The files a guard about published content should scan: only what git tracks
 * under `root/subdir`, as absolute paths, plus files an overlay hydrated in and
 * hid via literal `info/exclude` entries. Other untracked and ignored files
 * (local render output, scratch notes) are skipped, which also keeps the scan
 * fast in a checkout whose docs/ holds thousands of them.
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
    const scope = join(base, subdir);
    const listed = raw
      .split('\0')
      .filter((f) => f.length > 0)
      .map((f) => join(base, f))
      .filter((f) => existsSync(f));
    const hydrated = excludedLiteralFiles(base).filter((f) => {
      const rel = relative(scope, f);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    });
    const files = [...new Set([...listed, ...hydrated])];
    if (files.length > 0) return files;
  } catch {
    // git missing or not a work tree: fall through to the walk
  }
  const start = join(base, subdir);
  return existsSync(start) ? walkFiles(start) : [];
}
