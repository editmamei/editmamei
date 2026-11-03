import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { FIRST_RUN_DISCLOSURE } from '@editmamei/core/server.ts';

/**
 * docs/privacy.md's "First-run notice" blockquote and server.ts's FIRST_RUN_DISCLOSURE
 * constant are hand-maintained in two separate files with nothing else keeping them in
 * sync — this pins them to the same content so an edit to one that forgets the other fails
 * here instead of silently drifting.
 *
 * Comparison is normalized on whitespace (markdown line-wraps the blockquote; the JS string
 * is one line) AND backticks (the doc's blockquote wraps `~/.editmamei/settings.json` in
 * backticks; the server constant does not — a pre-existing, harmless formatting difference
 * this test deliberately tolerates rather than forcing either file to change for it).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

function normalize(s: string): string {
  return s.replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

/** Extract the first-run blockquote: the run of `> `-prefixed lines starting at "> First
 *  run:" and ending at the first line that isn't part of the blockquote. */
function extractFirstRunBlockquote(markdown: string): string {
  const lines = markdown.split('\n');
  const startIdx = lines.findIndex((l) => l.startsWith('> First run:'));
  if (startIdx === -1) {
    throw new Error('first-run blockquote ("> First run:") not found in docs/privacy.md');
  }
  const blockquoteLines: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    if (!lines[i].startsWith('>')) break;
    blockquoteLines.push(lines[i].replace(/^>\s?/, ''));
  }
  return blockquoteLines.join(' ');
}

describe('docs/privacy.md first-run disclosure matches FIRST_RUN_DISCLOSURE', () => {
  it('is word-for-word identical (normalized for whitespace + backticks)', () => {
    const markdown = readFileSync(join(REPO_ROOT, 'docs', 'privacy.md'), 'utf8');
    const docText = extractFirstRunBlockquote(markdown);
    expect(normalize(docText)).toBe(normalize(FIRST_RUN_DISCLOSURE));
  });
});
