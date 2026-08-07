import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Source hygiene for published code.
 *
 * This repository's source is public, so a comment is a published artifact. The
 * rules below are the ones that are cheap to state and expensive to notice by
 * eye: a reference to something a reader cannot open, a name that means nothing
 * outside the project, or wording inherited from another codebase.
 *
 * Deliberately self-contained — it reads the tree and nothing else. That is
 * what lets it run unchanged in any checkout, including one that carries the
 * commercial module alongside.
 */

/**
 * Every TypeScript file under `src/`, read from the filesystem.
 *
 * Deliberately NOT `git ls-files`: that reports the index, which can disagree
 * with what is actually on disk, and a guard that scans a stale list is worse
 * than no guard. It also means this works in a checkout with no git at all —
 * an unpacked tarball, a vendored copy, a CI cache — and that a contributor's
 * brand-new file is checked before it is ever staged, which is the moment the
 * feedback is cheapest.
 *
 * Scope note: `src/` only, not `tests/`. `src/` is the code a reader actually
 * reads, so a dead reference or an unexplainable name costs the most there. And
 * a guard necessarily contains every pattern it bans, so scanning the directory
 * it lives in makes it trip over itself and over sibling test infrastructure
 * that exists to police these same rules. Widening to `tests/` needs an
 * exemption mechanism first; without one it teaches people to weaken patterns.
 */
function walkTs(dir: string, rel = 'src'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkTs(join(dir, entry.name), childRel));
    else if (entry.name.endsWith('.ts')) out.push(childRel);
  }
  return out;
}

function publicSources(): string[] {
  return walkTs(join(REPO_ROOT, 'src')).filter((p) => !NON_PUBLIC.some((re) => re.test(p)));
}

/**
 * Paths that exist only in a checkout carrying the commercial module. A clone of
 * this repository alone has none of them, so this list is inert here; it exists
 * so the same file passes in a combined checkout, where that module's sources
 * are not held to the public-surface rules.
 *
 * This file also excludes itself: it necessarily contains every pattern it
 * bans.
 */
const NON_PUBLIC = [/-pro\.ts$/, /(^|\/)modules\/pro\//, /^src\/templates\//];

const SOURCES = publicSources();
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

describe('source hygiene', () => {
  it('scans a non-trivial number of files (an empty scan would pass everything)', () => {
    expect(SOURCES.length).toBeGreaterThan(200);
  });

  it('no source points at a document this repository does not contain', () => {
    // `docs/` here would be a dead link for every reader. The one legitimate
    // form is a full URL into a published repository.
    const offenders: string[] = [];
    for (const rel of SOURCES) {
      for (const line of read(rel).split(/\r?\n/)) {
        if (!/docs\//.test(line)) continue;
        if (line.includes('editmamei-wiki')) continue;
        offenders.push(`${rel}: ${line.trim().slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no source carries an internal workstream codename', () => {
    // "Bundle Q", "F2", "PR-1", "slice 3" identify planning artifacts that no
    // reader of this repository can resolve. Describe the change instead.
    // `bundle-[a-z]` is bounded so it never catches the delivery-bundle
    // vocabulary, which is real domain language here.
    const re =
      /\bBundle [A-Z]\b|\bbundle-[a-z]\b|\bF[123]\b(?! *[-–] *)|\bPR-1\b|\bslices? \d[a-z]?\b/g;
    const offenders: string[] = [];
    for (const rel of SOURCES) {
      for (const m of read(rel).matchAll(re)) offenders.push(`${rel}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('no source carries a maintainer account name', () => {
    // Synthetic names in fixtures are fine and load-bearing for the redaction
    // tests; a real one is a personal detail nobody chose to publish.
    const offenders: string[] = [];
    for (const rel of SOURCES) {
      for (const m of read(rel).matchAll(/\bABEAL\b|\babeal\b/g)) offenders.push(`${rel}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('no source carries wording inherited from another project', () => {
    // Editmamei began as a fork. The spine was rebuilt so that no inherited
    // text remains, and these are the exact strings a 2026-08-06 file-level
    // audit found at the time. They regress quietly: reading another
    // implementation of the same domain problem is a normal thing to do, and
    // phrasing follows the reader home.
    //
    // This is not a claim that no shared code exists — two projects driving
    // Photoshop from TypeScript will always share mechanics. It pins the known
    // findings so a closed question cannot silently reopen.
    const inherited = [
      'Initializing session',
      'Connecting to Photoshop',
      'Successfully connected to Photoshop',
      'Failed to connect to Photoshop',
      'Disconnecting session',
      'already registered, overwriting',
      'Unsupported platform: ${platformType}',
      'Detecting Photoshop on Windows',
      'Photoshop not found on this system',
      'Try environment variable first',
      'Registry detection failed',
      'Using environment variable',
      'Adobe Photoshop 2025',
      'Execute the JSX script',
      'Failed to launch Photoshop',
      'determineAPIType',
      'UXPPhotoshopAPI',
      'IMPORTANT: MCP uses stdout for protocol communication',
      'All logs must go to stderr to avoid corrupting the JSON-RPC protocol',
    ];
    const offenders: string[] = [];
    for (const rel of SOURCES) {
      const text = read(rel);
      for (const s of inherited) if (text.includes(s)) offenders.push(`${rel}: ${s}`);
    }
    expect(offenders).toEqual([]);
  });
});
