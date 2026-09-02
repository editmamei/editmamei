import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The sibling of macos-floor-sync: same failure class, different requirement.
// `engines.node` in package.json is the real Node floor, and every prose
// statement of it is a mirror that drifts silently. It already had — the
// requirements list said Node 22+ while the install path a few lines below told
// readers to check for v20, walking a Node 20 user into an install that cannot
// run. npm's engine check is a warning by default, so nothing stopped them.
//
// Only floor CLAIMS are matched — "Node 22+", "Node 22 or newer/later", and the
// `v22` or higher check. Bare mentions and command lines like `node --version`
// are deliberately not, so prose can discuss Node without tripping the guard.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The major from `engines.node` in package.json — the source of truth. */
function requiredMajor(): number {
  const engines: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines
    ?.node;
  const match = /(\d+)/.exec(engines ?? '');
  if (!match) throw new Error(`package.json engines.node is not parseable: ${engines}`);
  return Number(match[1]);
}

const CLAIM_PATTERNS = [
  /Node(?:\.js)? (\d+)(?:\+|\s+or (?:newer|later))/g,
  /`v(\d+)(?:\.x)?` or higher/g,
];

/** Every stated Node floor across the docs a user or contributor reads. */
function claims(): { file: string; major: number }[] {
  const files = [
    join(ROOT, 'README.md'),
    join(ROOT, 'CONTRIBUTING.md'),
    ...readdirSync(join(ROOT, 'docs'), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(ROOT, 'docs', f)),
  ];
  const found: { file: string; major: number }[] = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    for (const pattern of CLAIM_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        found.push({ file: relative(ROOT, path), major: Number(match[1]) });
      }
    }
  }
  return found;
}

describe('Node floor sync', () => {
  it('the docs state a Node floor, and every claim matches engines.node', () => {
    const required = requiredMajor();
    const stated = claims();
    expect(stated.length, 'no doc states a Node version requirement any more').toBeGreaterThan(0);
    for (const { file, major } of stated) {
      expect(
        major,
        `${file} states Node ${major}, but package.json requires >=${required}. ` +
          `npm only warns on an engines mismatch, so a reader who follows this ` +
          `installs something that fails at runtime instead.`
      ).toBe(required);
    }
  });
});
